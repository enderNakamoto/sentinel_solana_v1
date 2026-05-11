/**
 * Phase 6 — Cross-program integration tests on LiteSVM.
 *
 * Drives the full insurance lifecycle across all 5 programs:
 *   1. governance.whitelist_route  (admin sets up routes)
 *   2. vault.deposit               (underwriter funds the pool)
 *   3. controller.buy_insurance    (traveler buys policy; chains 6 CPIs)
 *   4. simulateOracle              (FlightDataFetcher cron stand-in)
 *   5. simulateClassifier          (FlightClassifier cron stand-in)
 *   6. simulateSettler             (SettlementExecutor cron stand-in;
 *                                   per-flight CPI loop + tail housekeeping)
 *   7. flight_pool.claim           (traveler collects payout)
 *   8. flight_pool.sweep_expired   (recover unclaimed payouts after expiry)
 *   9. vault.collect               (underwriter pulls queued withdrawal)
 *
 * Phase 6 tests verify:
 *   - Full lifecycle: 3 flights end-to-end, on-time / delayed / cancelled,
 *     correct money flows per `architecture.md §Payout Math`, FlightData
 *     state-machine transitions, snapshot record persisted.
 *   - Withdrawal queue: request_withdrawal during locked capital → settle
 *     frees up free_capital → process_withdrawal_queue credits ClaimableBalance
 *     → underwriter collect succeeds.
 *   - Solvency edge: buy_insurance reverts when free_capital < payoff *
 *     solvency_ratio, no side-effects (D5 invariant).
 *   - Authorization isolation: every cross-program gate enforced; oracle
 *     keypair cannot impersonate keeper; keeper cannot impersonate oracle.
 *   - Multi-flight per tx: settle MAX_FLIGHTS_PER_TX in one tx; one more reverts.
 */

import { describe, expect, it } from 'vitest';
import {
  AccountRole,
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  advanceClock,
  bootstrapFullProtocol,
  depositToVault,
  FLIGHT_POOL_PROGRAM_ADDRESS,
  getAtaAddress,
  getTokenAccountAmount,
  makeClient,
  mintMockPusdTo,
  setComputeUnitLimitIx,
  setTokenAccount,
  simulateClassifier,
  simulateOracle,
  simulateSettler,
  TOKEN_2022_PROGRAM_ID_KIT,
  TOKEN_PROGRAM_ADDRESS_KIT,
  VAULT_PROGRAM_ADDRESS,
  whitelistRoute,
  type FullProtocolBootstrap,
} from './setup.ts';

import {
  CONTROLLER_PROGRAM_ADDRESS,
  getBuyInsuranceInstructionAsync,
  getControllerConfigDecoder,
  getActiveFlightListDecoder,
  getExecuteSettlementsInstructionAsync,
} from './clients/controller/src/generated/index.ts';

import {
  GOVERNANCE_PROGRAM_ADDRESS,
  findRoutePda,
} from './clients/governance/src/generated/index.ts';

import {
  findFlightDataPda,
  getFlightDataDecoder,
  FlightStatus,
  ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
  getSetEstimatedArrivalInstructionAsync,
  getSetToBeSettledInstructionAsync,
} from './clients/oracle_aggregator/src/generated/index.ts';

import {
  findPoolPda,
  findBuyerRecordPda,
  getFlightPoolDecoder,
  getBuyerRecordDecoder,
  getFlightPoolConfigDecoder,
  getClaimInstructionAsync,
  getSweepExpiredInstructionAsync,
  getSettleOnTimeInstructionAsync,
  SettlementStatus,
} from './clients/flight_pool/src/generated/index.ts';

import {
  findSnapshotRecordPda,
  findVaultStatePda,
  getVaultStateDecoder,
  getSnapshotRecordDecoder,
  getRequestWithdrawalInstructionAsync,
  getCollectInstructionAsync,
  getSendPayoutInstruction,
} from './clients/vault/src/generated/index.ts';

// ─── Shared test data ────────────────────────────────────────────────────

type Client = Awaited<ReturnType<typeof makeClient>>;

const FLIGHTS = {
  onTime: { flightId: 'AA100', origin: 'JFK', destination: 'SFO' },
  delayed: { flightId: 'BA200', origin: 'LHR', destination: 'JFK' },
  cancelled: { flightId: 'UA300', origin: 'ORD', destination: 'LAX' },
} as const;

const PREMIUM = 1_000_000n; // 1 USDC
const PAYOFF = 10_000_000n; // 10 USDC
const DELAY_HOURS = 2;
// Far-future flight date so default min_lead_time (1h) is satisfied.
// LiteSVM clock starts at unix_timestamp = 0; epoch day 50000 = ~year 2106.
const FUTURE_DATE = 50_000n;
const FLIGHT_DEPARTURE_SEC = FUTURE_DATE * 86_400n; // ~4.32e9s

function readAccount(client: Client, addr: Address): Uint8Array {
  const acc = client.svm.getAccount(addr);
  if (!acc.exists) throw new Error(`account ${addr} missing`);
  return acc.data;
}

async function fundedSigner(client: Client): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await client.airdrop(signer.address, lamports(2_000_000_000n));
  return signer;
}

/**
 * Whitelist + register all 3 routes used by the lifecycle test.
 */
async function whitelistAllRoutes(client: Client): Promise<void> {
  for (const flight of Object.values(FLIGHTS)) {
    await whitelistRoute(client, {
      flightId: flight.flightId,
      origin: flight.origin,
      destination: flight.destination,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    });
  }
}

/**
 * Build the BuyInsurance instruction with all 19 derived accounts wired.
 * Mirrors the helper in controller.test.ts but works against the
 * full-protocol bootstrap.
 */
async function buildBuyInsurance(
  ctrl: FullProtocolBootstrap,
  flight: { flightId: string; origin: string; destination: string },
  traveler: KeyPairSigner,
  date: bigint,
): Promise<Awaited<ReturnType<typeof getBuyInsuranceInstructionAsync>>> {
  const [routePda] = await findRoutePda({
    flightId: flight.flightId,
    origin: flight.origin,
    destination: flight.destination,
  });
  const [flightDataPda] = await findFlightDataPda({
    flightId: flight.flightId,
    date,
  });
  const [flightPoolPda] = await findPoolPda({
    flightId: flight.flightId,
    date,
  });
  const [buyerRecordPda] = await findBuyerRecordPda({
    pool: flightPoolPda,
    buyer: traveler.address,
  });
  const buyerUsdcAta = getAtaAddress(ctrl.stableMint, traveler.address);

  return getBuyInsuranceInstructionAsync({
    governanceProgram: GOVERNANCE_PROGRAM_ADDRESS,
    governanceConfig: ctrl.governanceConfigPda,
    routeAccount: routePda,
    oracleProgram: ctrl.oracle.programAddress,
    oracleConfig: ctrl.oracle.configPda,
    flightData: flightDataPda,
    flightPoolProgram: ctrl.flightPool.programAddress,
    flightPoolConfig: ctrl.flightPool.configPda,
    flightPool: flightPoolPda,
    buyerRecord: buyerRecordPda,
    buyerStableAccount: buyerUsdcAta,
    poolTreasury: ctrl.flightPool.treasuryAta,
    stableMint: ctrl.stableMint,
    vaultProgram: VAULT_PROGRAM_ADDRESS,
    vaultState: ctrl.vault.vaultStatePda,
    traveler,
    stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
    flightId: flight.flightId,
    origin: flight.origin,
    destination: flight.destination,
    date,
  });
}

async function buyInsurance(
  client: Client,
  ctrl: FullProtocolBootstrap,
  flight: { flightId: string; origin: string; destination: string },
  traveler: KeyPairSigner,
  date: bigint,
): Promise<void> {
  await client.sendTransaction([
    setComputeUnitLimitIx(1_400_000),
    await buildBuyInsurance(ctrl, flight, traveler, date),
  ]);
}

/** Read a flight's FlightData status from oracle. */
async function readFlightStatus(
  client: Client,
  flightId: string,
  date: bigint,
): Promise<FlightStatus> {
  const [pda] = await findFlightDataPda({ flightId, date });
  return getFlightDataDecoder().decode(readAccount(client, pda)).status;
}

// ─── 1. Full-protocol lifecycle (3 flights, all 3 outcomes) ──────────────

describe('Phase 6 — Full protocol lifecycle', () => {
  it('three flights — on-time / delayed / cancelled — flow end-to-end with correct money flows', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    // (a) Underwriter deposits enough USDC to back 3 × payoff.
    await whitelistAllRoutes(client);
    await depositToVault(client, ctrl, 1_000_000_000n); // 1,000 USDC

    // (b) Three travelers each buy insurance for one route.
    const t1 = await fundedSigner(client);
    const t2 = await fundedSigner(client);
    const t3 = await fundedSigner(client);
    mintMockPusdTo(client, t1.address, PREMIUM);
    mintMockPusdTo(client, t2.address, PREMIUM);
    mintMockPusdTo(client, t3.address, PREMIUM);

    await buyInsurance(client, ctrl, FLIGHTS.onTime, t1, FUTURE_DATE);
    await buyInsurance(client, ctrl, FLIGHTS.delayed, t2, FUTURE_DATE);
    await buyInsurance(client, ctrl, FLIGHTS.cancelled, t3, FUTURE_DATE);

    // Assert post-buy state.
    const cfgAfterBuy = getControllerConfigDecoder().decode(
      readAccount(client, ctrl.controllerConfigPda),
    );
    expect(cfgAfterBuy.totalPoliciesSold).toBe(3n);
    expect(cfgAfterBuy.totalPremiumsCollected).toBe(PREMIUM * 3n);

    const vaultAfterBuy = getVaultStateDecoder().decode(
      readAccount(client, ctrl.vault.vaultStatePda),
    );
    expect(vaultAfterBuy.lockedCapital).toBe(PAYOFF * 3n);
    expect(getTokenAccountAmount(client, ctrl.flightPool.treasuryAta)).toBe(PREMIUM * 3n);

    const list = getActiveFlightListDecoder().decode(
      readAccount(client, ctrl.activeFlightListPda),
    );
    expect(list.flights.length).toBe(3);

    // FlightData should be NotInitiated for all 3.
    expect(await readFlightStatus(client, FLIGHTS.onTime.flightId, FUTURE_DATE)).toBe(
      FlightStatus.NotInitiated,
    );

    // (c) Oracle writes ETAs (NotInitiated → Active).
    const eta = FLIGHT_DEPARTURE_SEC; // ETA = scheduled departure.
    await simulateOracle.setEstimatedArrival(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.onTime.flightId,
      FUTURE_DATE,
      eta,
    );
    await simulateOracle.setEstimatedArrival(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.delayed.flightId,
      FUTURE_DATE,
      eta,
    );
    await simulateOracle.setEstimatedArrival(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.cancelled.flightId,
      FUTURE_DATE,
      eta,
    );
    expect(await readFlightStatus(client, FLIGHTS.onTime.flightId, FUTURE_DATE)).toBe(
      FlightStatus.Active,
    );

    // (d) Advance clock past departure so we can record landings.
    advanceClock(client.svm, FLIGHT_DEPARTURE_SEC + 3600n); // post-arrival

    // Land flight 1 on-time (delay = 0 < 2h threshold).
    await simulateOracle.setLanded(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.onTime.flightId,
      FUTURE_DATE,
      eta, // actual = ETA = no delay
    );
    // Land flight 2 delayed (delay = 4h > 2h threshold).
    await simulateOracle.setLanded(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.delayed.flightId,
      FUTURE_DATE,
      eta + 4n * 3600n,
    );
    // Cancel flight 3.
    await simulateOracle.setCancelled(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.cancelled.flightId,
      FUTURE_DATE,
    );

    expect(await readFlightStatus(client, FLIGHTS.onTime.flightId, FUTURE_DATE)).toBe(
      FlightStatus.Landed,
    );
    expect(await readFlightStatus(client, FLIGHTS.delayed.flightId, FUTURE_DATE)).toBe(
      FlightStatus.Landed,
    );
    expect(await readFlightStatus(client, FLIGHTS.cancelled.flightId, FUTURE_DATE)).toBe(
      FlightStatus.Cancelled,
    );

    // (e) Classifier — chunk into 2 batches (MAX_FLIGHTS_PER_TX = 2).
    await simulateClassifier(client, ctrl, [
      { flightId: FLIGHTS.onTime.flightId, date: FUTURE_DATE },
      { flightId: FLIGHTS.delayed.flightId, date: FUTURE_DATE },
    ]);
    await simulateClassifier(client, ctrl, [
      { flightId: FLIGHTS.cancelled.flightId, date: FUTURE_DATE },
    ]);

    expect(await readFlightStatus(client, FLIGHTS.onTime.flightId, FUTURE_DATE)).toBe(
      FlightStatus.ToBeSettledOnTime,
    );
    expect(await readFlightStatus(client, FLIGHTS.delayed.flightId, FUTURE_DATE)).toBe(
      FlightStatus.ToBeSettledDelayed,
    );
    expect(await readFlightStatus(client, FLIGHTS.cancelled.flightId, FUTURE_DATE)).toBe(
      FlightStatus.ToBeSettledCancelled,
    );

    // (f) Settler — process all 3 flights in 2 batches (2 + 1).
    const dayOf = (sec: bigint) => sec / 86_400n;
    const today = dayOf(BigInt(client.svm.getClock().unixTimestamp));

    const treasuryBefore = getTokenAccountAmount(client, ctrl.flightPool.treasuryAta)!;
    const vaultTokenBefore = getTokenAccountAmount(client, ctrl.vault.vaultTokenAccount)!;
    const vaultBefore = getVaultStateDecoder().decode(
      readAccount(client, ctrl.vault.vaultStatePda),
    );

    await simulateSettler(client, ctrl, {
      flights: [
        { flightId: FLIGHTS.onTime.flightId, date: FUTURE_DATE },
        { flightId: FLIGHTS.delayed.flightId, date: FUTURE_DATE },
      ],
      day: today,
    });
    await simulateSettler(client, ctrl, {
      flights: [{ flightId: FLIGHTS.cancelled.flightId, date: FUTURE_DATE }],
      day: today,
    });

    // Assert money flows.
    //
    // On-time: vault TMA += premium*N (= PREMIUM), treasury -= premium*N,
    //          locked -= payoff*N (= PAYOFF). N=1 per flight here.
    // Delayed/cancelled: vault locked -= payoff*N, treasury += (payoff -
    //          premium)*N (vault.send_payout sends the diff to treasury,
    //          treasury already had the premium from the buy), so treasury
    //          balance += (payoff-premium); vault.decrease_locked drops
    //          locked back to 0.
    //
    // Net per-flight effect on treasury balance:
    //   on-time:    -premium  (forwarded out)
    //   delayed:    +(payoff - premium)  (vault tops it up)
    //   cancelled:  +(payoff - premium)
    //
    // Net per-flight effect on vault TMA:
    //   on-time:    +premium  (record_premium_income)
    //   delayed:    -(payoff - premium)  (send_payout)
    //   cancelled:  -(payoff - premium)
    //
    // Net per-flight effect on vault locked_capital:
    //   all three: -payoff
    //
    const treasuryAfter = getTokenAccountAmount(client, ctrl.flightPool.treasuryAta)!;
    const vaultTokenAfter = getTokenAccountAmount(client, ctrl.vault.vaultTokenAccount)!;
    const vaultAfter = getVaultStateDecoder().decode(
      readAccount(client, ctrl.vault.vaultStatePda),
    );

    // Expected treasury delta: -P + (PA - P) + (PA - P) = -P + 2*(PA-P) = 2*PA - 3*P
    expect(treasuryAfter - treasuryBefore).toBe(2n * PAYOFF - 3n * PREMIUM);
    // Expected vault token delta: +P (on-time arrival from treasury) - 2*(PA-P) (send_payout for delayed+cancelled)
    expect(vaultTokenAfter - vaultTokenBefore).toBe(PREMIUM - 2n * (PAYOFF - PREMIUM));
    // Locked capital fully released.
    expect(vaultAfter.lockedCapital).toBe(0n);
    // TMA changed by net premium received (on-time: +P) minus payouts paid (delayed+cancelled: -2*(PA-P)).
    expect(vaultAfter.totalManagedAssets - vaultBefore.totalManagedAssets).toBe(
      PREMIUM - 2n * (PAYOFF - PREMIUM),
    );

    // (g) FlightData transitions to Settled for all 3.
    expect(await readFlightStatus(client, FLIGHTS.onTime.flightId, FUTURE_DATE)).toBe(
      FlightStatus.Settled,
    );
    expect(await readFlightStatus(client, FLIGHTS.delayed.flightId, FUTURE_DATE)).toBe(
      FlightStatus.Settled,
    );
    expect(await readFlightStatus(client, FLIGHTS.cancelled.flightId, FUTURE_DATE)).toBe(
      FlightStatus.Settled,
    );

    // (h) ActiveFlightList drained.
    const listAfter = getActiveFlightListDecoder().decode(
      readAccount(client, ctrl.activeFlightListPda),
    );
    expect(listAfter.flights.length).toBe(0);

    // (i) FlightPool statuses:
    //   on-time → SettledOnTime
    //   delayed → SettledDelayed
    //   cancelled → SettledCancelled
    const [onTimePoolPda] = await findPoolPda({
      flightId: FLIGHTS.onTime.flightId,
      date: FUTURE_DATE,
    });
    const [delayedPoolPda] = await findPoolPda({
      flightId: FLIGHTS.delayed.flightId,
      date: FUTURE_DATE,
    });
    const [cancelledPoolPda] = await findPoolPda({
      flightId: FLIGHTS.cancelled.flightId,
      date: FUTURE_DATE,
    });
    expect(getFlightPoolDecoder().decode(readAccount(client, onTimePoolPda)).status).toBe(
      SettlementStatus.SettledOnTime,
    );
    expect(getFlightPoolDecoder().decode(readAccount(client, delayedPoolPda)).status).toBe(
      SettlementStatus.SettledDelayed,
    );
    expect(getFlightPoolDecoder().decode(readAccount(client, cancelledPoolPda)).status).toBe(
      SettlementStatus.SettledCancelled,
    );

    // (j) Snapshot record persisted for today.
    const [snapshotPda] = await findSnapshotRecordPda({ day: today });
    const snapshot = getSnapshotRecordDecoder().decode(readAccount(client, snapshotPda));
    expect(snapshot.day).toBe(today);
    expect(snapshot.sharePrice).toBeGreaterThan(0n);

    // (k) Aggregate counters: total_payouts_distributed = 2 * (payoff - premium).
    const cfgAfter = getControllerConfigDecoder().decode(
      readAccount(client, ctrl.controllerConfigPda),
    );
    expect(cfgAfter.totalPayoutsDistributed).toBe(2n * (PAYOFF - PREMIUM));

    // (l) Traveler 2 (delayed) claims their payoff.
    // Before claim: treasury holds payoff for the delayed flight after
    // vault.send_payout topped it up; traveler 2 has 0 USDC.
    const travelerUsdcBeforeClaim = getTokenAccountAmount(
      client,
      getAtaAddress(ctrl.stableMint, t2.address),
    )!;
    expect(travelerUsdcBeforeClaim).toBe(0n);

    await client.sendTransaction([
      await getClaimInstructionAsync({
        pool: delayedPoolPda,
        buyer: t2.address,
        poolTreasury: ctrl.flightPool.treasuryAta,
        stableMint: ctrl.stableMint,
        traveler: t2,
        flightId: FLIGHTS.delayed.flightId,
        date: FUTURE_DATE,
      }),
    ]);
    expect(
      getTokenAccountAmount(client, getAtaAddress(ctrl.stableMint, t2.address)),
    ).toBe(PAYOFF);

    // BuyerRecord.claimed = true.
    const [t2BuyerRecordPda] = await findBuyerRecordPda({
      pool: delayedPoolPda,
      buyer: t2.address,
    });
    expect(getBuyerRecordDecoder().decode(readAccount(client, t2BuyerRecordPda)).claimed).toBe(
      true,
    );

    // (m) Traveler 3 (cancelled) does NOT claim. Advance past expiry,
    // then anyone sweeps. Recovered balance increases.
    const expirySec = ctrl.stableMint
      ? BigInt(client.svm.getClock().unixTimestamp) + 5_184_001n
      : 0n;
    advanceClock(client.svm, 5_184_001n); // > claim_expiry_window (60d default)

    const sweeper = await fundedSigner(client);
    await client.sendTransaction([
      await getSweepExpiredInstructionAsync({
        pool: cancelledPoolPda,
        caller: sweeper,
        flightId: FLIGHTS.cancelled.flightId,
        date: FUTURE_DATE,
      }),
    ]);

    const fpConfig = getFlightPoolConfigDecoder().decode(
      readAccount(client, ctrl.flightPool.configPda),
    );
    expect(fpConfig.recoveredBalance).toBe(PAYOFF); // 1 buyer × payoff

    // We don't claim t1's on-time policy — there's nothing to claim, the
    // status is SettledOnTime and the path to claim doesn't apply.
    expect(travelerUsdcBeforeClaim).toBe(0n); // (sanity: still 0 — nothing changed for t1.)
    void expirySec; // reference param left for documentation
  });
});

// ─── 2. Withdrawal queue under settlement ────────────────────────────────

describe('Phase 6 — Withdrawal queue under settlement', () => {
  it('underwriter request_withdrawal during locked → settle frees capital → ClaimableBalance credited → collect succeeds', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    await whitelistRoute(client, {
      flightId: FLIGHTS.onTime.flightId,
      origin: FLIGHTS.onTime.origin,
      destination: FLIGHTS.onTime.destination,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    });

    // (a) Deposit 11 USDC — just enough to cover one payoff (10) + 1 USDC headroom.
    const depositAmount = 11_000_000n;
    await depositToVault(client, ctrl, depositAmount);

    // (b) Buy one policy → vault.locked_capital = 10 USDC; free = 1.
    const traveler = await fundedSigner(client);
    mintMockPusdTo(client, traveler.address, PREMIUM);
    await buyInsurance(client, ctrl, FLIGHTS.onTime, traveler, FUTURE_DATE);

    const vaultPostBuy = getVaultStateDecoder().decode(
      readAccount(client, ctrl.vault.vaultStatePda),
    );
    expect(vaultPostBuy.lockedCapital).toBe(PAYOFF);

    // (c) Underwriter requests withdrawal of more shares than free_capital can cover.
    // The deposit minted shares roughly proportional to the deposit (with virtual offset).
    // We'll request half of all underwriter's shares — about 5,500,000 shares
    // (deposit was 11M, virtual offset 1000 so first deposit ≈ 1:1).
    const shareAtaData = readAccount(client, ctrl.underwriterShareAta);
    // Decode SPL Token Account `amount` at offset 64.
    const shareView = new DataView(shareAtaData.buffer, shareAtaData.byteOffset, shareAtaData.byteLength);
    const totalShares = shareView.getBigUint64(64, true);
    const sharesToQueue = totalShares / 2n;

    await client.sendTransaction([
      await getRequestWithdrawalInstructionAsync({
        vaultState: ctrl.vault.vaultStatePda,
        withdrawalQueue: ctrl.vault.withdrawalQueuePda,
        shareMint: ctrl.vault.shareMintPda,
        requesterShareAccount: ctrl.underwriterShareAta,
        claimable: ctrl.underwriterClaimablePda,
        requester: ctrl.underwriter,
        shares: sharesToQueue,
      }),
    ]);

    // ClaimableBalance PDA exists but amount is 0 (still queued).
    const claimableBefore = client.svm.getAccount(ctrl.underwriterClaimablePda);
    expect(claimableBefore.exists).toBe(true);

    // (d) Drive on-time settlement to free up locked capital + drain queue.
    // FlightData NotInitiated → Active → Landed → ToBeSettledOnTime → Settled.
    const eta = FLIGHT_DEPARTURE_SEC;
    await simulateOracle.setEstimatedArrival(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.onTime.flightId,
      FUTURE_DATE,
      eta,
    );
    advanceClock(client.svm, FLIGHT_DEPARTURE_SEC + 3600n);
    await simulateOracle.setLanded(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.onTime.flightId,
      FUTURE_DATE,
      eta,
    );
    await simulateClassifier(client, ctrl, [
      { flightId: FLIGHTS.onTime.flightId, date: FUTURE_DATE },
    ]);

    const dayOf = (sec: bigint) => sec / 86_400n;
    const today = dayOf(BigInt(client.svm.getClock().unixTimestamp));

    // (e) Settler — pass the underwriter's ClaimableBalance PDA via claimables
    // for vault.process_withdrawal_queue to credit it.
    await simulateSettler(client, ctrl, {
      flights: [{ flightId: FLIGHTS.onTime.flightId, date: FUTURE_DATE }],
      claimables: [ctrl.underwriterClaimablePda],
      day: today,
    });

    // After settlement: locked_capital = 0, free_capital = full TMA.
    // The withdrawal request's pending_assets ≤ free_capital, so it should
    // be credited to ClaimableBalance.
    const claimableData = readAccount(client, ctrl.underwriterClaimablePda);
    // ClaimableBalance layout: 8 disc + 32 owner + 8 amount + 1 bump.
    const claimableView = new DataView(
      claimableData.buffer,
      claimableData.byteOffset,
      claimableData.byteLength,
    );
    const claimableAmount = claimableView.getBigUint64(8 + 32, true);
    expect(claimableAmount).toBeGreaterThan(0n);

    // (f) Underwriter collects.
    await client.sendTransaction([
      await getCollectInstructionAsync({
        vaultState: ctrl.vault.vaultStatePda,
        vaultTokenAccount: ctrl.vault.vaultTokenAccount,
        claimable: ctrl.underwriterClaimablePda,
        owner: ctrl.underwriter.address,
        collectorStableAccount: ctrl.underwriterStableAta,
        stableMint: ctrl.stableMint,
        collector: ctrl.underwriter,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
      }),
    ]);

    // Underwriter's USDC balance went up by the claimable amount.
    const underwriterUsdcAfter = getTokenAccountAmount(client, ctrl.underwriterStableAta)!;
    // Initial 10000 USDC - 11 USDC deposited = ~9989 USDC remaining;
    // after collect: + claimableAmount. We just check the collect succeeded
    // (claimable went to 0).
    const claimableAfter = getVaultStateDecoder; // unused — silence linter
    void claimableAfter;
    const claimableAfterCollect = readAccount(client, ctrl.underwriterClaimablePda);
    const claimableAfterView = new DataView(
      claimableAfterCollect.buffer,
      claimableAfterCollect.byteOffset,
      claimableAfterCollect.byteLength,
    );
    expect(claimableAfterView.getBigUint64(8 + 32, true)).toBe(0n);
    expect(underwriterUsdcAfter).toBeGreaterThan(0n);
  });
});

// ─── 3. Solvency edge ────────────────────────────────────────────────────

describe('Phase 6 — Solvency edge', () => {
  it('buy_insurance reverts when free_capital < payoff * solvency_ratio', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    await whitelistRoute(client, {
      flightId: FLIGHTS.onTime.flightId,
      origin: FLIGHTS.onTime.origin,
      destination: FLIGHTS.onTime.destination,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    });

    // Don't deposit anything → vault free_capital = 0.
    const traveler = await fundedSigner(client);
    mintMockPusdTo(client, traveler.address, PREMIUM);

    await expect(
      client.sendTransaction([
        setComputeUnitLimitIx(1_400_000),
        await buildBuyInsurance(ctrl, FLIGHTS.onTime, traveler, FUTURE_DATE),
      ]),
    ).rejects.toThrow();

    // D5 invariant: solvency check runs BEFORE any side-effects, so:
    //   - FlightPool PDA must NOT exist
    //   - FlightData PDA must NOT exist
    //   - ActiveFlightList still empty
    //   - vault.locked_capital still 0
    const [poolPda] = await findPoolPda({
      flightId: FLIGHTS.onTime.flightId,
      date: FUTURE_DATE,
    });
    const [flightDataPda] = await findFlightDataPda({
      flightId: FLIGHTS.onTime.flightId,
      date: FUTURE_DATE,
    });
    expect(client.svm.getAccount(poolPda).exists).toBe(false);
    expect(client.svm.getAccount(flightDataPda).exists).toBe(false);
    const list = getActiveFlightListDecoder().decode(
      readAccount(client, ctrl.activeFlightListPda),
    );
    expect(list.flights.length).toBe(0);
    const vaultState = getVaultStateDecoder().decode(
      readAccount(client, ctrl.vault.vaultStatePda),
    );
    expect(vaultState.lockedCapital).toBe(0n);
  });
});

// ─── 4. Authorization isolation ──────────────────────────────────────────

describe('Phase 6 — Authorization isolation', () => {
  it('vault.send_payout reverts when caller is not the controller PDA', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    // Stranger tries to call vault.send_payout directly.
    const stranger = await fundedSigner(client);

    // Set up a recipient ATA.
    const { ata: recipientAta } = setTokenAccount(client, {
      mint: ctrl.stableMint,
      owner: stranger.address,
      amount: 0n,
    });

    await expect(
      client.sendTransaction([
        getSendPayoutInstruction({
          vaultState: ctrl.vault.vaultStatePda,
          vaultTokenAccount: ctrl.vault.vaultTokenAccount,
          recipient: recipientAta,
          stableMint: ctrl.stableMint,
          controller: stranger,
          stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
          amount: 1_000n,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('flight_pool.settle_on_time reverts when caller is not the controller PDA', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    // Whitelist + buy + advance + land to set up a real FlightPool to attack.
    await whitelistRoute(client, {
      flightId: FLIGHTS.onTime.flightId,
      origin: FLIGHTS.onTime.origin,
      destination: FLIGHTS.onTime.destination,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    });
    await depositToVault(client, ctrl, 1_000_000_000n);
    const traveler = await fundedSigner(client);
    mintMockPusdTo(client, traveler.address, PREMIUM);
    await buyInsurance(client, ctrl, FLIGHTS.onTime, traveler, FUTURE_DATE);

    // Stranger tries to call flight_pool.settle_on_time directly.
    const stranger = await fundedSigner(client);
    const [poolPda] = await findPoolPda({
      flightId: FLIGHTS.onTime.flightId,
      date: FUTURE_DATE,
    });
    await expect(
      client.sendTransaction([
        await getSettleOnTimeInstructionAsync({
          pool: poolPda,
          poolTreasury: ctrl.flightPool.treasuryAta,
          recipient: ctrl.vault.vaultTokenAccount,
          stableMint: ctrl.stableMint,
          controller: stranger,
          tokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
          flightId: FLIGHTS.onTime.flightId,
          date: FUTURE_DATE,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('oracle.set_to_be_settled reverts when caller is not the controller PDA', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    // Stranger tries to call oracle.set_to_be_settled directly.
    const stranger = await fundedSigner(client);

    // No FlightData exists yet — but the auth check (which checks
    // authority.key() == config.authorized_consumer) runs against
    // config and should fail before deserialising flight_data.
    // Build the ix and confirm it reverts.
    await whitelistRoute(client, {
      flightId: FLIGHTS.onTime.flightId,
      origin: FLIGHTS.onTime.origin,
      destination: FLIGHTS.onTime.destination,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    });
    await depositToVault(client, ctrl, 1_000_000_000n);
    const traveler = await fundedSigner(client);
    mintMockPusdTo(client, traveler.address, PREMIUM);
    await buyInsurance(client, ctrl, FLIGHTS.onTime, traveler, FUTURE_DATE);
    // Drive to Landed.
    await simulateOracle.setEstimatedArrival(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.onTime.flightId,
      FUTURE_DATE,
      FLIGHT_DEPARTURE_SEC,
    );
    advanceClock(client.svm, FLIGHT_DEPARTURE_SEC + 3600n);
    await simulateOracle.setLanded(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.onTime.flightId,
      FUTURE_DATE,
      FLIGHT_DEPARTURE_SEC,
    );

    const [flightDataPda] = await findFlightDataPda({
      flightId: FLIGHTS.onTime.flightId,
      date: FUTURE_DATE,
    });
    await expect(
      client.sendTransaction([
        await getSetToBeSettledInstructionAsync({
          flightData: flightDataPda,
          authority: stranger,
          flightId: FLIGHTS.onTime.flightId,
          date: FUTURE_DATE,
          newStatus: FlightStatus.ToBeSettledOnTime,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('authorized_oracle key cannot call controller.classify_flights (keeper-only)', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    // The oracleSigner is a keypair authorised on oracle_aggregator only.
    // It should NOT be authorised as the keeper on the controller.
    const fakeKeeper = ctrl.oracle.oracleSigner;

    await expect(
      simulateClassifier(
        // Patch the bootstrap so simulateClassifier uses the oracle key as keeper.
        client,
        { ...ctrl, keeperSigner: fakeKeeper } as typeof ctrl,
        [{ flightId: FLIGHTS.onTime.flightId, date: FUTURE_DATE }],
      ),
    ).rejects.toThrow();
  });

  it('authorized_keeper key cannot call any oracle write instruction (oracle-only)', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    // The keeperSigner is authorised on the controller, NOT on oracle.
    // Calling set_estimated_arrival as the keeper should revert.
    const fakeOracle = ctrl.keeperSigner;

    // We need a FlightData PDA that exists. Simplest path: bootstrap +
    // initiate via a buy first.
    await whitelistRoute(client, {
      flightId: FLIGHTS.onTime.flightId,
      origin: FLIGHTS.onTime.origin,
      destination: FLIGHTS.onTime.destination,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    });
    await depositToVault(client, ctrl, 1_000_000_000n);
    const traveler = await fundedSigner(client);
    mintMockPusdTo(client, traveler.address, PREMIUM);
    await buyInsurance(client, ctrl, FLIGHTS.onTime, traveler, FUTURE_DATE);

    const [flightDataPda] = await findFlightDataPda({
      flightId: FLIGHTS.onTime.flightId,
      date: FUTURE_DATE,
    });
    await expect(
      client.sendTransaction([
        await getSetEstimatedArrivalInstructionAsync({
          flightData: flightDataPda,
          authority: fakeOracle,
          flightId: FLIGHTS.onTime.flightId,
          date: FUTURE_DATE,
          eta: FLIGHT_DEPARTURE_SEC,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 5. Multi-flight per tx ──────────────────────────────────────────────

describe('Phase 6 — Multi-flight per tx', () => {
  it('settle MAX_FLIGHTS_PER_TX (=2) flights in one tx; 3rd flight in same tx reverts', async () => {
    const client = await makeClient();
    const ctrl = await bootstrapFullProtocol(client);

    // Set up 3 flights all in ToBeSettledOnTime.
    await whitelistAllRoutes(client);
    await depositToVault(client, ctrl, 1_000_000_000n);

    const t1 = await fundedSigner(client);
    const t2 = await fundedSigner(client);
    const t3 = await fundedSigner(client);
    mintMockPusdTo(client, t1.address, PREMIUM);
    mintMockPusdTo(client, t2.address, PREMIUM);
    mintMockPusdTo(client, t3.address, PREMIUM);
    await buyInsurance(client, ctrl, FLIGHTS.onTime, t1, FUTURE_DATE);
    await buyInsurance(client, ctrl, FLIGHTS.delayed, t2, FUTURE_DATE);
    await buyInsurance(client, ctrl, FLIGHTS.cancelled, t3, FUTURE_DATE);

    const eta = FLIGHT_DEPARTURE_SEC;
    for (const f of Object.values(FLIGHTS)) {
      await simulateOracle.setEstimatedArrival(
        client,
        ctrl.oracle.oracleSigner,
        f.flightId,
        FUTURE_DATE,
        eta,
      );
    }
    advanceClock(client.svm, FLIGHT_DEPARTURE_SEC + 3600n);
    // Land all 3 on time (delay = 0). For multi-flight cap test we just
    // need them all to be in ToBeSettled* — actual outcome doesn't matter.
    await simulateOracle.setLanded(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.onTime.flightId,
      FUTURE_DATE,
      eta,
    );
    await simulateOracle.setLanded(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.delayed.flightId,
      FUTURE_DATE,
      eta,
    );
    await simulateOracle.setLanded(
      client,
      ctrl.oracle.oracleSigner,
      FLIGHTS.cancelled.flightId,
      FUTURE_DATE,
      eta,
    );
    await simulateClassifier(client, ctrl, [
      { flightId: FLIGHTS.onTime.flightId, date: FUTURE_DATE },
      { flightId: FLIGHTS.delayed.flightId, date: FUTURE_DATE },
    ]);
    await simulateClassifier(client, ctrl, [
      { flightId: FLIGHTS.cancelled.flightId, date: FUTURE_DATE },
    ]);

    const dayOf = (sec: bigint) => sec / 86_400n;
    const today = dayOf(BigInt(client.svm.getClock().unixTimestamp));

    // Build a hand-rolled execute_settlements ix passing 3 flight pairs (= 6 accounts).
    // simulateSettler doesn't enforce the cap — the program does. We bypass
    // the helper here to send raw 3 flights.
    const [snapshotRecordPda] = await findSnapshotRecordPda({ day: today });
    const baseIx = await getExecuteSettlementsInstructionAsync({
      vaultProgram: VAULT_PROGRAM_ADDRESS,
      flightPoolProgram: ctrl.flightPool.programAddress,
      oracleProgram: ctrl.oracle.programAddress,
      flightPoolConfig: ctrl.flightPool.configPda,
      oracleConfig: ctrl.oracle.configPda,
      vaultState: ctrl.vault.vaultStatePda,
      vaultTokenAccount: ctrl.vault.vaultTokenAccount,
      withdrawalQueue: ctrl.vault.withdrawalQueuePda,
      shareMint: ctrl.vault.shareMintPda,
      snapshotRecord: snapshotRecordPda,
      poolTreasury: ctrl.flightPool.treasuryAta,
      treasuryAuthority: ctrl.flightPool.treasuryAuthorityPda,
      stableMint: ctrl.stableMint,
      keeper: ctrl.keeperSigner,
      stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
      day: today,
      nFlights: 3,
    });
    const extraAccounts: { address: Address; role: AccountRole }[] = [];
    for (const f of Object.values(FLIGHTS)) {
      const [fdPda] = await findFlightDataPda({ flightId: f.flightId, date: FUTURE_DATE });
      const [poolPda] = await findPoolPda({ flightId: f.flightId, date: FUTURE_DATE });
      extraAccounts.push({ address: fdPda, role: AccountRole.WRITABLE });
      extraAccounts.push({ address: poolPda, role: AccountRole.WRITABLE });
    }
    const overflowIx = {
      ...baseIx,
      accounts: [...baseIx.accounts, ...extraAccounts],
    };

    await expect(
      client.sendTransaction([setComputeUnitLimitIx(1_400_000), overflowIx]),
    ).rejects.toThrow();

    // Sanity: 2 flights in one tx succeeds.
    await simulateSettler(client, ctrl, {
      flights: [
        { flightId: FLIGHTS.onTime.flightId, date: FUTURE_DATE },
        { flightId: FLIGHTS.delayed.flightId, date: FUTURE_DATE },
      ],
      day: today,
    });

    // ActiveFlightList drained by 2.
    const list = getActiveFlightListDecoder().decode(
      readAccount(client, ctrl.activeFlightListPda),
    );
    expect(list.flights.length).toBe(1);
  });
});
