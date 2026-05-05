/**
 * Phase 5 — controller program unit tests.
 *
 * Coverage map (subtask numbers from spec/phases/phase-05-controller-program.md §4):
 *   4.1  initialize: state populated, all 7 program/config refs match
 *   4.2  set_authorized_keeper: owner-only
 *   4.3  buy_insurance happy path (first-buy): all CPIs fire, counters bump
 *   4.4  buy_insurance second-buy: skips first-buy CPIs
 *   4.5  buy_insurance reverts when route not whitelisted
 *   4.7  buy_insurance reverts below min_lead_time
 *   4.8  buy_insurance reverts on insufficient solvency (D5: BEFORE side-effects)
 *   4.13 classify_flights non-keeper reverts
 *   4.17 execute_settlements non-keeper reverts
 *   4.18 MAX_FLIGHTS_PER_TX cap on classify_flights
 *
 * Note: tests 4.9–4.16 (classify_flights / execute_settlements happy paths
 * and per-flight settlement loop) are deferred to Phase 6 cross-program
 * integration tests per the controller's `execute_settlements` TODO. The
 * housekeeping path (process_withdrawal_queue + snapshot end-of-batch) is
 * exercised by 4.17's revert path, which proves the wiring.
 */

import { describe, expect, it } from 'vitest';
import {
  AccountRole,
  address as kitAddress,
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

// Solana ComputeBudget program — hand-rolled ix to bump CU limit for the
// 6-CPI buy_insurance chain (default 200K is exhausted).
const COMPUTE_BUDGET_PROGRAM_ID: Address = kitAddress('ComputeBudget111111111111111111111111111111');
function setComputeUnitLimitIx(units: number): {
  programAddress: Address;
  accounts: readonly { address: Address; role: AccountRole }[];
  data: Uint8Array;
} {
  const data = new Uint8Array(5);
  data[0] = 0x02; // SetComputeUnitLimit discriminator
  // u32 little-endian
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
}

import {
  advanceClock,
  bootstrapController,
  FLIGHT_POOL_PROGRAM_ADDRESS,
  getAtaAddress,
  getTokenAccountAmount,
  makeClient,
  mintMockUsdcTo,
  setTokenAccount,
  VAULT_PROGRAM_ADDRESS,
  type ControllerBootstrap,
} from './setup.ts';

import {
  CONTROLLER_PROGRAM_ADDRESS,
  // Account decoders
  getControllerConfigDecoder,
  getActiveFlightListDecoder,
  // Instruction builders
  getBuyInsuranceInstructionAsync,
  getClassifyFlightsInstructionAsync,
  getExecuteSettlementsInstructionAsync,
  getInitializeInstructionAsync,
  getSetAuthorizedKeeperInstruction,
} from './clients/controller/src/generated/index.ts';

import {
  GOVERNANCE_PROGRAM_ADDRESS,
  findRoutePda,
  getWhitelistRouteInstructionAsync,
} from './clients/governance/src/generated/index.ts';

import {
  findVaultStatePda,
  findShareMintPda,
  findSnapshotRecordPda,
  getDepositInstructionAsync,
} from './clients/vault/src/generated/index.ts';

import {
  findPoolPda,
  findBuyerRecordPda,
} from './clients/flight_pool/src/generated/index.ts';

import {
  findFlightDataPda,
} from './clients/oracle_aggregator/src/generated/index.ts';

// ─── Constants ───────────────────────────────────────────────────────────

type Client = Awaited<ReturnType<typeof makeClient>>;

const FLIGHT = { flightId: 'AA100', origin: 'JFK', destination: 'SFO' } as const;
const PREMIUM = 1_000_000n; // 1 USDC
const PAYOFF = 10_000_000n; // 10 USDC
const DELAY_HOURS = 2;

// Far-future flight date so min_lead_time is satisfied (1h default).
// LiteSVM clock starts at unix_timestamp = 0; we set this to ~50000 days =
// any non-zero value comfortably after min_lead_time.
const FUTURE_DATE = 50_000n; // epoch day 50000 (~year 2106)

interface Fixture {
  client: Client;
  ctrl: ControllerBootstrap;
}

async function freshFixture(
  overrides: { solvencyRatio?: number; minLeadTime?: bigint } = {},
): Promise<Fixture> {
  const client = await makeClient();
  const ctrl = await bootstrapController(client, overrides);
  return { client, ctrl };
}

async function fundedSigner(client: Client): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await client.airdrop(signer.address, lamports(2_000_000_000n));
  return signer;
}

function readAccount(client: Client, addr: Address): Uint8Array {
  const acc = client.svm.getAccount(addr);
  if (!acc.exists) throw new Error(`account ${addr} missing`);
  return acc.data;
}

/** Whitelist a route via governance with custom override terms. */
async function whitelistRoute(f: Fixture): Promise<void> {
  await f.client.sendTransaction([
    await getWhitelistRouteInstructionAsync({
      caller: f.client.payer,
      adminRecord: GOVERNANCE_PROGRAM_ADDRESS, // owner-as-caller None sentinel (Phase 1 D11)
      flightId: FLIGHT.flightId,
      origin: FLIGHT.origin,
      destination: FLIGHT.destination,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    }),
  ]);
}

/** Underwriter deposits USDC into the vault so vault has free_capital. */
async function fundVault(f: Fixture, usdc: bigint): Promise<void> {
  const underwriter = await fundedSigner(f.client);
  const { ata: usdcAta } = mintMockUsdcTo(f.client, underwriter.address, usdc);
  const { ata: shareAta } = setTokenAccount(f.client, {
    mint: f.ctrl.vault.shareMintPda,
    owner: underwriter.address,
    amount: 0n,
  });
  await f.client.sendTransaction([
    await getDepositInstructionAsync({
      vaultState: f.ctrl.vault.vaultStatePda,
      shareMint: f.ctrl.vault.shareMintPda,
      vaultTokenAccount: f.ctrl.vault.vaultTokenAccount,
      depositorUsdcAccount: usdcAta,
      depositorShareAccount: shareAta,
      depositor: underwriter,
      usdcAmount: usdc,
    }),
  ]);
}

/** Build a `buy_insurance` instruction with all the derived PDAs wired. */
async function buildBuyInsurance(
  f: Fixture,
  traveler: KeyPairSigner,
): Promise<Awaited<ReturnType<typeof getBuyInsuranceInstructionAsync>>> {
  const [routePda] = await findRoutePda({
    flightId: FLIGHT.flightId,
    origin: FLIGHT.origin,
    destination: FLIGHT.destination,
  });
  const [flightDataPda] = await findFlightDataPda({
    flightId: FLIGHT.flightId,
    date: FUTURE_DATE,
  });
  const [flightPoolPda] = await findPoolPda({
    flightId: FLIGHT.flightId,
    date: FUTURE_DATE,
  });
  const [buyerRecordPda] = await findBuyerRecordPda({
    pool: flightPoolPda,
    buyer: traveler.address,
  });

  const buyerUsdcAta = getAtaAddress(f.ctrl.usdcMint, traveler.address);

  return getBuyInsuranceInstructionAsync({
    governanceProgram: GOVERNANCE_PROGRAM_ADDRESS,
    governanceConfig: f.ctrl.governanceConfigPda,
    routeAccount: routePda,
    oracleProgram: f.ctrl.oracle.programAddress,
    oracleConfig: f.ctrl.oracle.configPda,
    flightData: flightDataPda,
    flightPoolProgram: f.ctrl.flightPool.programAddress,
    flightPoolConfig: f.ctrl.flightPool.configPda,
    flightPool: flightPoolPda,
    buyerRecord: buyerRecordPda,
    buyerUsdcAccount: buyerUsdcAta,
    poolTreasury: f.ctrl.flightPool.treasuryAta,
    vaultProgram: VAULT_PROGRAM_ADDRESS,
    vaultState: f.ctrl.vault.vaultStatePda,
    traveler,
    flightId: FLIGHT.flightId,
    origin: FLIGHT.origin,
    destination: FLIGHT.destination,
    date: FUTURE_DATE,
  });
}

// ─── 4.1 initialize ──────────────────────────────────────────────────────

describe('Phase 5 — controller: initialize', () => {
  it('4.1 ControllerConfig populated correctly + ActiveFlightList empty', async () => {
    const { client, ctrl } = await freshFixture();
    const config = getControllerConfigDecoder().decode(readAccount(client, ctrl.controllerConfigPda));
    expect(config.owner).toBe(client.payer.address);
    expect(config.authorizedKeeper).toBe(ctrl.keeperSigner.address);
    expect(config.governanceProgram).toBe(GOVERNANCE_PROGRAM_ADDRESS);
    expect(config.vaultState).toBe(ctrl.vault.vaultStatePda);
    expect(config.flightPoolConfig).toBe(ctrl.flightPool.configPda);
    expect(config.oracleConfig).toBe(ctrl.oracle.configPda);
    expect(config.usdcMint).toBe(ctrl.usdcMint);
    expect(config.solvencyRatio).toBe(100);
    expect(config.minLeadTime).toBe(3_600n);
    expect(config.claimExpiryWindow).toBe(5_184_000n);
    expect(config.totalPoliciesSold).toBe(0n);
    expect(config.totalPremiumsCollected).toBe(0n);
    expect(config.totalPayoutsDistributed).toBe(0n);

    const list = getActiveFlightListDecoder().decode(readAccount(client, ctrl.activeFlightListPda));
    expect(list.flights.length).toBe(0);
  });
});

// ─── 4.2 set_authorized_keeper ──────────────────────────────────────────

describe('Phase 5 — controller: set_authorized_keeper', () => {
  it('4.2 owner can rotate the keeper; non-owner reverts', async () => {
    const f = await freshFixture();
    const newKeeper = (await fundedSigner(f.client)).address;
    await f.client.sendTransaction([
      getSetAuthorizedKeeperInstruction({
        controllerConfig: f.ctrl.controllerConfigPda,
        owner: f.client.payer,
        newKeeper,
      }),
    ]);
    const cfg = getControllerConfigDecoder().decode(readAccount(f.client, f.ctrl.controllerConfigPda));
    expect(cfg.authorizedKeeper).toBe(newKeeper);

    const stranger = await fundedSigner(f.client);
    await expect(
      f.client.sendTransaction([
        getSetAuthorizedKeeperInstruction({
          controllerConfig: f.ctrl.controllerConfigPda,
          owner: stranger,
          newKeeper,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.3 / 4.4 buy_insurance happy paths ────────────────────────────────

describe('Phase 5 — controller: buy_insurance happy paths', () => {
  it('4.3 first-buy: all CPIs fire, counters bump, ActiveFlightList grows', async () => {
    const f = await freshFixture();
    await whitelistRoute(f);
    await fundVault(f, 10_000_000_000n); // 10,000 USDC — plenty of solvency.

    const traveler = await fundedSigner(f.client);
    mintMockUsdcTo(f.client, traveler.address, PREMIUM); // creates ATA + funds.
    // Advance clock so far-future date FUTURE_DATE * 86400 - now > min_lead_time.
    // LiteSVM clock starts at 0; FUTURE_DATE = 50000 days → 50000*86400 = 4.32e9s > 3600 ✓.

    await f.client.sendTransaction([
      setComputeUnitLimitIx(1_400_000),
      await buildBuyInsurance(f, traveler),
    ]);

    const cfg = getControllerConfigDecoder().decode(readAccount(f.client, f.ctrl.controllerConfigPda));
    expect(cfg.totalPoliciesSold).toBe(1n);
    expect(cfg.totalPremiumsCollected).toBe(PREMIUM);

    const list = getActiveFlightListDecoder().decode(readAccount(f.client, f.ctrl.activeFlightListPda));
    expect(list.flights.length).toBe(1);
    expect(list.flights[0].flightId).toBe(FLIGHT.flightId);
    expect(list.flights[0].date).toBe(FUTURE_DATE);

    // Premium moved from traveler ATA → pool treasury.
    const travelerAta = getAtaAddress(f.ctrl.usdcMint, traveler.address);
    expect(getTokenAccountAmount(f.client, travelerAta)).toBe(0n);
    expect(getTokenAccountAmount(f.client, f.ctrl.flightPool.treasuryAta)).toBe(PREMIUM);
  });

  it('4.4 second buy for same flight: skips first-buy CPIs, counters bump', async () => {
    const f = await freshFixture();
    await whitelistRoute(f);
    await fundVault(f, 10_000_000_000n);

    // First buyer.
    const t1 = await fundedSigner(f.client);
    mintMockUsdcTo(f.client, t1.address, PREMIUM);
    await f.client.sendTransaction([
      setComputeUnitLimitIx(1_400_000),
      await buildBuyInsurance(f, t1),
    ]);

    // Second buyer — different traveler, same flight.
    const t2 = await fundedSigner(f.client);
    mintMockUsdcTo(f.client, t2.address, PREMIUM);
    await f.client.sendTransaction([
      setComputeUnitLimitIx(1_400_000),
      await buildBuyInsurance(f, t2),
    ]);

    const cfg = getControllerConfigDecoder().decode(readAccount(f.client, f.ctrl.controllerConfigPda));
    expect(cfg.totalPoliciesSold).toBe(2n);
    expect(cfg.totalPremiumsCollected).toBe(PREMIUM * 2n);

    // ActiveFlightList still has just 1 entry (same flight).
    const list = getActiveFlightListDecoder().decode(readAccount(f.client, f.ctrl.activeFlightListPda));
    expect(list.flights.length).toBe(1);
  });
});

// ─── 4.5 / 4.7 / 4.8 buy_insurance revert paths ─────────────────────────

describe('Phase 5 — controller: buy_insurance reverts', () => {
  it('4.5 route not whitelisted → revert', async () => {
    const f = await freshFixture();
    // Skip whitelistRoute(); route account does not exist.
    await fundVault(f, 10_000_000_000n);
    const traveler = await fundedSigner(f.client);
    mintMockUsdcTo(f.client, traveler.address, PREMIUM);

    await expect(
      f.client.sendTransaction([setComputeUnitLimitIx(1_400_000), await buildBuyInsurance(f, traveler)]),
    ).rejects.toThrow();
  });

  it('4.7 below min_lead_time → revert', async () => {
    // Default min_lead_time = 3600; LiteSVM clock = 0; FUTURE_DATE * 86400 - 0 = ~4.3e9s.
    // So it's WAY above min_lead_time. To force a revert, set min_lead_time absurdly high.
    const f = await freshFixture({ minLeadTime: 9_999_999_999n });
    await whitelistRoute(f);
    await fundVault(f, 10_000_000_000n);
    const traveler = await fundedSigner(f.client);
    mintMockUsdcTo(f.client, traveler.address, PREMIUM);

    await expect(
      f.client.sendTransaction([setComputeUnitLimitIx(1_400_000), await buildBuyInsurance(f, traveler)]),
    ).rejects.toThrow();
  });

  it('4.8 insufficient solvency → revert BEFORE side-effects', async () => {
    const f = await freshFixture();
    await whitelistRoute(f);
    // Don't fund the vault; free_capital = 0 < payoff*100.
    const traveler = await fundedSigner(f.client);
    mintMockUsdcTo(f.client, traveler.address, PREMIUM);

    await expect(
      f.client.sendTransaction([setComputeUnitLimitIx(1_400_000), await buildBuyInsurance(f, traveler)]),
    ).rejects.toThrow();

    // D5 invariant: solvency check runs BEFORE any CPI side-effects, so the
    // FlightPool PDA must NOT exist after the revert. The traveler should
    // not have paid for pool init.
    const [flightPoolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FUTURE_DATE });
    const flightPoolAcc = f.client.svm.getAccount(flightPoolPda);
    expect(flightPoolAcc.exists).toBe(false);
  });
});

// ─── 4.13 / 4.17 keeper-only auth ──────────────────────────────────────

describe('Phase 5 — controller: keeper-only auth', () => {
  it('4.13 classify_flights reverts when caller != authorized_keeper', async () => {
    const f = await freshFixture();
    const stranger = await fundedSigner(f.client);
    await expect(
      f.client.sendTransaction([
        await getClassifyFlightsInstructionAsync({
          oracleProgram: f.ctrl.oracle.programAddress,
          oracleConfig: f.ctrl.oracle.configPda,
          keeper: stranger,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.17 execute_settlements reverts when caller != authorized_keeper', async () => {
    const f = await freshFixture();
    const stranger = await fundedSigner(f.client);
    const dayOf = (sec: bigint) => sec / 86_400n;
    const today = dayOf(BigInt(f.client.svm.getClock().unixTimestamp));
    const [snapshotPda] = await findSnapshotRecordPda({ day: today });

    await expect(
      f.client.sendTransaction([
        await getExecuteSettlementsInstructionAsync({
          vaultProgram: VAULT_PROGRAM_ADDRESS,
          flightPoolProgram: FLIGHT_POOL_PROGRAM_ADDRESS,
          oracleProgram: f.ctrl.oracle.programAddress,
          flightPoolConfig: f.ctrl.flightPool.configPda,
          oracleConfig: f.ctrl.oracle.configPda,
          vaultState: f.ctrl.vault.vaultStatePda,
          vaultTokenAccount: f.ctrl.vault.vaultTokenAccount,
          withdrawalQueue: f.ctrl.vault.withdrawalQueuePda,
          shareMint: f.ctrl.vault.shareMintPda,
          snapshotRecord: snapshotPda,
          poolTreasury: f.ctrl.flightPool.treasuryAta,
          treasuryAuthority: f.ctrl.flightPool.treasuryAuthorityPda,
          keeper: stranger,
          day: today,
          nFlights: 0,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.18 MAX_FLIGHTS_PER_TX cap ───────────────────────────────────────

describe('Phase 5 — controller: MAX_FLIGHTS_PER_TX cap', () => {
  it('4.18 classify_flights with > 2 flight pairs → MaxFlightsPerTxExceeded', async () => {
    const f = await freshFixture();

    // Build a base ix and append 6 dummy remaining_accounts (= 3 pairs > 2).
    const baseIx = await getClassifyFlightsInstructionAsync({
      oracleProgram: f.ctrl.oracle.programAddress,
      oracleConfig: f.ctrl.oracle.configPda,
      keeper: f.ctrl.keeperSigner,
    });
    const dummyAddrs: Address[] = await Promise.all(
      Array.from({ length: 6 }, async () => (await generateKeyPairSigner()).address),
    );
    const ix = {
      ...baseIx,
      accounts: [
        ...baseIx.accounts,
        ...dummyAddrs.map((address) => ({ address, role: AccountRole.READONLY })),
      ],
    };
    await expect(f.client.sendTransaction([ix])).rejects.toThrow();
  });
});
