/**
 * Phase 7 — Full-flow integration test against a deployed Surfpool localnet.
 *
 * Prerequisites (test will skip otherwise):
 *   1. Surfpool is running: `pnpm dev:surfpool`
 *   2. Protocol is deployed: `pnpm run deploy --cluster surfpool --owner <deployer-pubkey>`
 *      (this writes `deployments/surfpool-latest.json` which this test consumes)
 *   3. Test actor keypairs exist: `pnpm bootstrap-test-actors`
 *
 * Test 1 covers the multi-actor lifecycle scenario:
 *   - Investor A deposits mock USDC → vault mints RVS shares
 *   - Buyer A buys insurance for flight 1 (route X, far-future date)
 *   - Oracle posts: ETA → landed-on-time
 *   - Classifier runs (CPI to oracle.set_to_be_settled)
 *   - Settler runs (CPI chain: pool_treasury → vault, drains queue, snapshots)
 *   - Assert state: FlightData=Settled, FlightPool=SettledOnTime,
 *                   vault TMA increased by premium, locked_capital decreased
 *
 * This is a focused single-test version; the broader 3-test (lifecycle +
 * solvency edge + authority isolation) suite mirrors Phase 6 and can be
 * extended here once the foundational test passes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  AccountRole,
  address as kitAddress,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from '@solana/kit';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GOVERNANCE_PROGRAM_ADDRESS,
  findRoutePda,
  getWhitelistRouteInstructionAsync,
} from '../clients/governance/src/generated/index.ts';
import {
  VAULT_PROGRAM_ADDRESS,
  findShareMintPda,
  findVaultStatePda,
  findWithdrawalQueuePda,
  getDepositInstructionAsync,
  getVaultStateDecoder,
} from '../clients/vault/src/generated/index.ts';
import {
  ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
  findFlightDataPda,
  FlightStatus,
  getFlightDataDecoder,
  getSetEstimatedArrivalInstructionAsync,
  getSetLandedInstructionAsync,
} from '../clients/oracle_aggregator/src/generated/index.ts';
import {
  FLIGHT_POOL_PROGRAM_ADDRESS,
  SettlementStatus,
  findBuyerRecordPda,
  findPoolPda,
  findTreasuryAuthorityPda,
  getFlightPoolConfigDecoder,
  getFlightPoolDecoder,
} from '../clients/flight_pool/src/generated/index.ts';
import {
  CONTROLLER_PROGRAM_ADDRESS,
  findActiveFlightListPda,
  findControllerConfigPda,
  getBuyInsuranceInstructionAsync,
  getClassifyFlightsInstructionAsync,
  getControllerConfigDecoder,
  getExecuteSettlementsInstructionAsync,
} from '../clients/controller/src/generated/index.ts';

import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey as Web3Pubkey } from '@solana/web3.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SURFPOOL_RPC = process.env.SURFNET_RPC ?? 'http://127.0.0.1:8899';
const DEPLOYMENT_PATH = resolve(REPO_ROOT, 'deployments/surfpool-latest.json');
const TEST_ACTORS_DIR = resolve(REPO_ROOT, 'keys/test-actors');

const TOKEN_PROGRAM_ADDRESS_KIT: Address = kitAddress(TOKEN_PROGRAM_ID.toBase58());
const TOKEN_2022_PROGRAM_ID_KIT: Address = kitAddress(TOKEN_2022_PROGRAM_ID.toBase58());

// ─── Hand-rolled compute-budget ix (matches Phase 6 setup.ts pattern) ────
const COMPUTE_BUDGET_PROGRAM: Address = kitAddress(
  'ComputeBudget111111111111111111111111111111',
);
function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 0x02;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

// ─── Deployment artifact shape ────────────────────────────────────────────
interface Deployment {
  cluster: string;
  rpcUrl: string;
  deployer: string;
  owner: string;
  authorities: { oracle: string; keeper: string };
  keypairPaths: { oracle: string; keeper: string };
  stableMint: string;
  programs: Record<string, string>;
  pdas: {
    governanceConfig: string;
    vaultState: string;
    shareMint: string;
    withdrawalQueue: string;
    oracleConfig: string;
    flightPoolConfig: string;
    poolTreasuryAuthority: string;
    controllerConfig: string;
    activeFlightList: string;
  };
}

function loadDeployment(): Deployment | null {
  if (!existsSync(DEPLOYMENT_PATH)) return null;
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf-8')) as Deployment;
}

function loadKeypair(path: string): Promise<KeyPairSigner> {
  const bytes = JSON.parse(readFileSync(path, 'utf-8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

function deriveAta(
  mint: Address,
  owner: Address,
  tokenProgram: Web3Pubkey = TOKEN_PROGRAM_ID,
): Address {
  const ataLegacy = getAssociatedTokenAddressSync(
    new Web3Pubkey(mint.toString()),
    new Web3Pubkey(owner.toString()),
    true, // allow off-curve owners (PDAs)
    tokenProgram,
  );
  return kitAddress(ataLegacy.toBase58());
}

// Stable side (PUSD) lives under Token-2022 post-Phase-24.
function deriveStableAta(mint: Address, owner: Address): Address {
  return deriveAta(mint, owner, TOKEN_2022_PROGRAM_ID);
}

// ─── Surfpool airdrop + USDC mint helpers (programmatic, not shell-out) ───

async function rpcAirdrop(recipient: Address, sol: number): Promise<void> {
  const lamports = BigInt(Math.round(sol * 1_000_000_000));
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'requestAirdrop',
    params: [recipient.toString(), Number(lamports)],
  };
  const res = await fetch(SURFPOOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`requestAirdrop: ${json.error.message}`);
}

async function rpcReachable(): Promise<boolean> {
  try {
    const res = await fetch(SURFPOOL_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getBalance(rpc: Rpc<SolanaRpcApi>, addr: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(addr).send();
  return BigInt(value);
}

async function fetchAccount<T>(
  rpc: Rpc<SolanaRpcApi>,
  pubkey: Address,
  decoder: { decode(data: Uint8Array): T },
): Promise<T | null> {
  const { value } = await rpc.getAccountInfo(pubkey, { encoding: 'base64' }).send();
  if (!value) return null;
  const dataB64 = Array.isArray(value.data) ? value.data[0] : (value.data as unknown as string);
  return decoder.decode(Buffer.from(dataB64, 'base64'));
}

async function getTokenBalance(rpc: Rpc<SolanaRpcApi>, ata: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

// ─── Generic tx send helper (build + sign + send + confirm) ──────────────

async function sendIxs(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: TransactionSigner,
  ixs: Instruction[],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  // Poll until confirmed or timeout.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const s = value[0];
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      if (s.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tx ${sig} not confirmed within 30s`);
}

// ─── PUSD mint helpers ───────────────────────────────────────────────────
//
// We don't shell out — we build + send the same `mint_to_checked` ix that
// fund-pusd.ts uses, signed by the mock PUSD authority keypair. The stable
// mint lives under Token-2022 so the CPI must target Token-2022.

async function mintPusdTo(
  rpc: Rpc<SolanaRpcApi>,
  mintAuthority: KeyPairSigner,
  mintPubkey: Address,
  recipient: Address,
  amountPusd: bigint,
): Promise<Address> {
  const { getCreateAssociatedTokenIdempotentInstructionAsync, getMintToCheckedInstruction } =
    await import('@solana-program/token');
  const ata = deriveStableAta(mintPubkey, recipient);
  const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync(
    {
      payer: mintAuthority,
      ata,
      owner: recipient,
      mint: mintPubkey,
      tokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
    },
  );
  const mintToIx = getMintToCheckedInstruction(
    {
      mint: mintPubkey,
      token: ata,
      mintAuthority,
      amount: amountPusd * 1_000_000n, // 6 decimals
      decimals: 6,
    },
    { programAddress: TOKEN_2022_PROGRAM_ID_KIT },
  );
  await sendIxs(rpc, mintAuthority, [createAtaIx, mintToIx]);
  return ata;
}

// ─── Test ─────────────────────────────────────────────────────────────────

describe('Phase 7 — Deployed surfpool full-flow', () => {
  let deployment: Deployment | null = null;
  let rpc: Rpc<SolanaRpcApi>;
  let oracleSigner: KeyPairSigner;
  let keeperSigner: KeyPairSigner;
  let mintAuthoritySigner: KeyPairSigner;
  let investorA: KeyPairSigner;
  let buyerA: KeyPairSigner;
  let stableMint: Address;

  beforeAll(async () => {
    const reachable = await rpcReachable();
    if (!reachable) {
      console.warn(
        '[deployed-test] Surfpool RPC unreachable at ' +
          SURFPOOL_RPC +
          '. Start it with `pnpm dev:surfpool` then re-run.',
      );
      return;
    }
    deployment = loadDeployment();
    if (!deployment) {
      console.warn(
        '[deployed-test] No deployment artifact found at ' +
          DEPLOYMENT_PATH +
          '. Run `pnpm run deploy --cluster surfpool --owner <pubkey>` first.',
      );
      return;
    }

    rpc = createSolanaRpc(SURFPOOL_RPC);
    stableMint = kitAddress(deployment.stableMint);

    oracleSigner = await loadKeypair(resolve(REPO_ROOT, deployment.keypairPaths.oracle));
    keeperSigner = await loadKeypair(resolve(REPO_ROOT, deployment.keypairPaths.keeper));
    mintAuthoritySigner = await loadKeypair(resolve(REPO_ROOT, 'keys/mock-pusd-authority.json'));

    investorA = await loadKeypair(resolve(TEST_ACTORS_DIR, 'investor-a.json'));
    buyerA = await loadKeypair(resolve(TEST_ACTORS_DIR, 'buyer-a.json'));

    // Fund signers with SOL via standard requestAirdrop (unlimited on surfpool).
    for (const signer of [investorA, buyerA, oracleSigner, keeperSigner, mintAuthoritySigner]) {
      const bal = await getBalance(rpc, signer.address);
      if (bal < 1_000_000_000n) {
        await rpcAirdrop(signer.address, 5);
      }
    }
    // Confirmation for airdrops — surfpool finalizes very fast but give it a moment.
    await new Promise((r) => setTimeout(r, 1000));

    // Pre-mint USDC for actors that need it.
    await mintPusdTo(rpc, mintAuthoritySigner, stableMint, investorA.address, 50_000n);
    await mintPusdTo(rpc, mintAuthoritySigner, stableMint, buyerA.address, 100n);
  }, 120_000);

  it('deployed protocol round-trips: deposit → buy → oracle post → classify → settle', async () => {
    if (!deployment) {
      console.warn('[deployed-test] skipping (prereqs not met)');
      return;
    }

    // ─── Step 1: whitelist a route on governance ─────────────────────
    const FLIGHT = { flightId: 'AA100', origin: 'JFK', destination: 'SFO' };
    const PREMIUM = 1_000_000n;
    const PAYOFF = 10_000_000n;
    const DELAY_HOURS = 2;

    // Owner = deployer (per --owner == deployer constraint enforced by deploy.ts).
    const owner = await loadKeypair(`${process.env.HOME}/.config/solana/id.json`);
    expect(owner.address).toBe(deployment.owner as Address);

    const [routePda] = await findRoutePda({
      flightId: FLIGHT.flightId,
      origin: FLIGHT.origin,
      destination: FLIGHT.destination,
    });
    const existingRoute = await rpc.getAccountInfo(routePda, { encoding: 'base64' }).send();
    if (!existingRoute.value) {
      await sendIxs(rpc, owner, [
        await getWhitelistRouteInstructionAsync({
          caller: owner,
          adminRecord: GOVERNANCE_PROGRAM_ADDRESS,
          flightId: FLIGHT.flightId,
          origin: FLIGHT.origin,
          destination: FLIGHT.destination,
          premium: PREMIUM,
          payoff: PAYOFF,
          delayHours: DELAY_HOURS,
        }),
      ]);
    }

    // ─── Step 2: investor deposits to the vault ──────────────────────
    const investorUsdcAta = deriveStableAta(stableMint, investorA.address);
    const investorShareAta = deriveAta(kitAddress(deployment.pdas.shareMint), investorA.address);

    // Pre-create the investor's share ATA (the deposit ix expects it to exist).
    const { getCreateAssociatedTokenIdempotentInstructionAsync } = await import(
      '@solana-program/token'
    );
    const createShareAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: investorA,
      ata: investorShareAta,
      owner: investorA.address,
      mint: kitAddress(deployment.pdas.shareMint),
    });
    await sendIxs(rpc, investorA, [createShareAtaIx]);

    const depositAmount = 1_000_000_000n; // 1,000 USDC
    await sendIxs(rpc, investorA, [
      await getDepositInstructionAsync({
        vaultState: kitAddress(deployment.pdas.vaultState),
        shareMint: kitAddress(deployment.pdas.shareMint),
        vaultTokenAccount: deriveStableAta(stableMint, kitAddress(deployment.pdas.vaultState)),
        depositorStableAccount: investorUsdcAta,
        depositorShareAccount: investorShareAta,
        stableMint,
        depositor: investorA,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        stableAmount: depositAmount,
      }),
    ]);

    const vaultAfterDeposit = await fetchAccount(
      rpc,
      kitAddress(deployment.pdas.vaultState),
      getVaultStateDecoder(),
    );
    expect(vaultAfterDeposit?.totalManagedAssets).toBeGreaterThanOrEqual(depositAmount);

    // ─── Step 3: buyer purchases insurance ───────────────────────────
    // Use a far-future date so min_lead_time (1h) is satisfied.
    const FUTURE_DATE = 50_000n; // unix day 50000 ≈ year 2106
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
      buyer: buyerA.address,
    });
    const buyerUsdcAta = deriveStableAta(stableMint, buyerA.address);

    const buyIx = await getBuyInsuranceInstructionAsync({
      controllerConfig: kitAddress(deployment.pdas.controllerConfig),
      activeFlightList: kitAddress(deployment.pdas.activeFlightList),
      governanceProgram: GOVERNANCE_PROGRAM_ADDRESS,
      governanceConfig: kitAddress(deployment.pdas.governanceConfig),
      routeAccount: routePda,
      oracleProgram: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
      oracleConfig: kitAddress(deployment.pdas.oracleConfig),
      flightData: flightDataPda,
      flightPoolProgram: FLIGHT_POOL_PROGRAM_ADDRESS,
      flightPoolConfig: kitAddress(deployment.pdas.flightPoolConfig),
      flightPool: flightPoolPda,
      buyerRecord: buyerRecordPda,
      buyerStableAccount: buyerUsdcAta,
      poolTreasury: deriveStableAta(stableMint, kitAddress(deployment.pdas.poolTreasuryAuthority)),
      stableMint,
      vaultProgram: VAULT_PROGRAM_ADDRESS,
      vaultState: kitAddress(deployment.pdas.vaultState),
      traveler: buyerA,
      stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
      flightId: FLIGHT.flightId,
      origin: FLIGHT.origin,
      destination: FLIGHT.destination,
      date: FUTURE_DATE,
    });
    await sendIxs(rpc, buyerA, [setComputeUnitLimitIx(1_400_000), buyIx]);

    const ctrlAfterBuy = await fetchAccount(
      rpc,
      kitAddress(deployment.pdas.controllerConfig),
      getControllerConfigDecoder(),
    );
    expect(ctrlAfterBuy?.totalPoliciesSold).toBeGreaterThanOrEqual(1n);

    const vaultAfterBuy = await fetchAccount(
      rpc,
      kitAddress(deployment.pdas.vaultState),
      getVaultStateDecoder(),
    );
    expect(vaultAfterBuy?.lockedCapital).toBeGreaterThanOrEqual(PAYOFF);

    // FlightData should be NotInitiated immediately after first-buy.
    const fdAfterBuy = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fdAfterBuy?.status).toBe(FlightStatus.NotInitiated);

    // ─── Step 4: oracle posts ETA + landed (on-time) ─────────────────
    const ETA = FUTURE_DATE * 86_400n; // unix-seconds at scheduled departure
    await sendIxs(rpc, oracleSigner, [
      await getSetEstimatedArrivalInstructionAsync({
        flightData: flightDataPda,
        authority: oracleSigner,
        flightId: FLIGHT.flightId,
        date: FUTURE_DATE,
        eta: ETA,
      }),
    ]);
    // For on-time landing: actual_arrival = ETA (delay = 0 < threshold).
    await sendIxs(rpc, oracleSigner, [
      await getSetLandedInstructionAsync({
        flightData: flightDataPda,
        authority: oracleSigner,
        flightId: FLIGHT.flightId,
        date: FUTURE_DATE,
        actualArrival: ETA,
      }),
    ]);

    // ─── Step 5: keeper classifies ───────────────────────────────────
    const baseClassifyIx = await getClassifyFlightsInstructionAsync({
      controllerConfig: kitAddress(deployment.pdas.controllerConfig),
      oracleProgram: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
      oracleConfig: kitAddress(deployment.pdas.oracleConfig),
      keeper: keeperSigner,
    });
    const classifyIx: Instruction = {
      ...baseClassifyIx,
      accounts: [
        ...baseClassifyIx.accounts,
        { address: flightDataPda, role: AccountRole.WRITABLE },
        { address: flightPoolPda, role: AccountRole.READONLY },
      ],
    };
    await sendIxs(rpc, keeperSigner, [setComputeUnitLimitIx(1_400_000), classifyIx]);

    const fdAfterClassify = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fdAfterClassify?.status).toBe(FlightStatus.ToBeSettledOnTime);

    // ─── Step 6: keeper executes settlements ────────────────────────
    // Day depends on the surfpool clock; query getBlockTime instead of using
    // a fixed value so SnapshotRecord PDA seed matches.
    const slot = await rpc.getSlot().send();
    const blockTimeRes = await rpc.getBlockTime(slot).send();
    const today = BigInt(Number(blockTimeRes ?? 0)) / 86_400n;

    const { findSnapshotRecordPda } = await import('../clients/vault/src/generated/index.ts');
    const [snapshotRecordPda] = await findSnapshotRecordPda({ day: today });

    const baseSettleIx = await getExecuteSettlementsInstructionAsync({
      controllerConfig: kitAddress(deployment.pdas.controllerConfig),
      activeFlightList: kitAddress(deployment.pdas.activeFlightList),
      vaultProgram: VAULT_PROGRAM_ADDRESS,
      flightPoolProgram: FLIGHT_POOL_PROGRAM_ADDRESS,
      oracleProgram: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
      flightPoolConfig: kitAddress(deployment.pdas.flightPoolConfig),
      oracleConfig: kitAddress(deployment.pdas.oracleConfig),
      vaultState: kitAddress(deployment.pdas.vaultState),
      vaultTokenAccount: deriveStableAta(stableMint, kitAddress(deployment.pdas.vaultState)),
      withdrawalQueue: kitAddress(deployment.pdas.withdrawalQueue),
      shareMint: kitAddress(deployment.pdas.shareMint),
      snapshotRecord: snapshotRecordPda,
      poolTreasury: deriveStableAta(stableMint, kitAddress(deployment.pdas.poolTreasuryAuthority)),
      treasuryAuthority: kitAddress(deployment.pdas.poolTreasuryAuthority),
      stableMint,
      keeper: keeperSigner,
      stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
      day: today,
      nFlights: 1,
    });
    const settleIx: Instruction = {
      ...baseSettleIx,
      accounts: [
        ...baseSettleIx.accounts,
        { address: flightDataPda, role: AccountRole.WRITABLE },
        { address: flightPoolPda, role: AccountRole.WRITABLE },
        // No claimables to drain (investor didn't queue a withdrawal in this minimal test).
      ],
    };
    await sendIxs(rpc, keeperSigner, [setComputeUnitLimitIx(1_400_000), settleIx]);

    // ─── Step 7: assert final state ──────────────────────────────────
    const fdSettled = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fdSettled?.status).toBe(FlightStatus.Settled);

    const poolSettled = await fetchAccount(rpc, flightPoolPda, getFlightPoolDecoder());
    expect(poolSettled?.status).toBe(SettlementStatus.SettledOnTime);

    const vaultSettled = await fetchAccount(
      rpc,
      kitAddress(deployment.pdas.vaultState),
      getVaultStateDecoder(),
    );
    // On-time: vault TMA increased by premium (recorded as premium income),
    // locked_capital decreased back to baseline (could be 0 if first flight).
    expect(vaultSettled?.lockedCapital).toBe(0n);
    expect(vaultSettled?.totalManagedAssets).toBeGreaterThanOrEqual(
      depositAmount + PREMIUM,
    );
  }, 120_000);
});
