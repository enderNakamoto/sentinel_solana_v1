/**
 * frontend/tests/helpers/cronTick.ts
 *
 * Drive the on-chain side of the three cron stages (oracle → classifier
 * → settler) directly from a Playwright test, against a running
 * Surfpool ledger. Mirrors `contracts/tests/setup.ts::simulate{Oracle,
 * Classifier, Settler}` (Phase 6) but uses the Kit RPC and the
 * surfpool-* keypairs on disk instead of LiteSVM.
 *
 * Why "directly" rather than the executor's `runFetcherOnce`/etc?
 * For Phase 16 we want deterministic single-flight transitions, not
 * the full active-list scan + AeroAPI mock pipeline (Phase 11 already
 * proved that path). Calling the IXs directly is ~150 lines and
 * gives the test exact control over the flight-by-flight scenario.
 *
 * Pre-conditions:
 *   - Surfpool running at http://127.0.0.1:8899.
 *   - `keys/surfpool-oracle.json` + `keys/surfpool-keeper.json` exist
 *     and match the on-chain ORACLE_AUTHORITY / KEEPER_AUTHORITY (set
 *     during `pnpm test:e2e:bootstrap`).
 *   - The flight has been bought into the active list via `controller
 *     .buy_insurance` (i.e. the test has already driven a /buy flow).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AccountRole,
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
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import {
  findFlightDataPda,
  getSetCancelledInstructionAsync,
  getSetEstimatedArrivalInstructionAsync,
  getSetLandedInstructionAsync,
  ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
} from '@/clients/oracle_aggregator/src/generated';
import {
  findPoolPda,
  FLIGHT_POOL_PROGRAM_ADDRESS,
} from '@/clients/flight_pool/src/generated';
import {
  findSnapshotRecordPda,
  VAULT_PROGRAM_ADDRESS,
} from '@/clients/vault/src/generated';
import {
  getClassifyFlightsInstructionAsync,
  getExecuteSettlementsInstructionAsync,
} from '@/clients/controller/src/generated';
import { PDAS } from '@/config/devnet';

const SURFPOOL_RPC = 'http://127.0.0.1:8899';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ORACLE_KEYPAIR_PATH = resolve(REPO_ROOT, 'keys', 'surfpool-oracle.json');
const KEEPER_KEYPAIR_PATH = resolve(REPO_ROOT, 'keys', 'surfpool-keeper.json');

// ─── Lazy keypair loader ─────────────────────────────────────────────────

let oracleSigner: KeyPairSigner | null = null;
let keeperSigner: KeyPairSigner | null = null;

async function loadKeypair(path: string): Promise<KeyPairSigner> {
  const bytes = JSON.parse(readFileSync(path, 'utf-8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

async function getOracle(): Promise<KeyPairSigner> {
  if (!oracleSigner) oracleSigner = await loadKeypair(ORACLE_KEYPAIR_PATH);
  return oracleSigner;
}

async function getKeeper(): Promise<KeyPairSigner> {
  if (!keeperSigner) keeperSigner = await loadKeypair(KEEPER_KEYPAIR_PATH);
  return keeperSigner;
}

function getRpc(): Rpc<SolanaRpcApi> {
  return createSolanaRpc(SURFPOOL_RPC) as Rpc<SolanaRpcApi>;
}

// ─── Compute-budget hand-roll (matches lib/compute-budget.ts) ────────────

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111' as Address;

function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 0x02; // SetComputeUnitLimit discriminator
  new DataView(data.buffer).setUint32(1, units, true);
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data,
  };
}

// ─── Send + confirm helper ───────────────────────────────────────────────

async function sendAndConfirm(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(signed);
  const wireTx = getBase64EncodedWireTransaction(signed);

  await rpc
    .sendTransaction(wireTx, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();

  // Poll until confirmed (max 30s).
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const { value } = await rpc.getSignatureStatuses([sig as Signature]).send();
    const status = value[0];
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      if (status.err) {
        throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
      }
      return sig;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tx ${sig} confirmation timeout after 30s`);
}

// ─── Public API: per-stage helpers ───────────────────────────────────────

/**
 * Drive the oracle stage for `(flightId, date)`:
 *   - set_estimated_arrival (NotInitiated → Active)
 *   - set_landed with `actualArrivalUnixSec` (Active → Landed)
 * Use this for the on-time and delayed scenarios. For cancelled, use
 * `oracleCancel` instead.
 */
async function oracleLand(
  flightId: string,
  date: bigint,
  scheduledEtaUnixSec: bigint,
  actualArrivalUnixSec: bigint,
): Promise<void> {
  const rpc = getRpc();
  const oracle = await getOracle();
  const [flightDataPda] = await findFlightDataPda({ flightId, date });

  await sendAndConfirm(rpc, oracle, [
    await getSetEstimatedArrivalInstructionAsync({
      flightData: flightDataPda,
      authority: oracle,
      flightId,
      date,
      eta: scheduledEtaUnixSec,
    }),
  ]);

  await sendAndConfirm(rpc, oracle, [
    await getSetLandedInstructionAsync({
      flightData: flightDataPda,
      authority: oracle,
      flightId,
      date,
      actualArrival: actualArrivalUnixSec,
    }),
  ]);
}

async function oracleCancel(flightId: string, date: bigint): Promise<void> {
  const rpc = getRpc();
  const oracle = await getOracle();
  const [flightDataPda] = await findFlightDataPda({ flightId, date });

  // Cancel can fire from NotInitiated; no need to set ETA first.
  await sendAndConfirm(rpc, oracle, [
    await getSetCancelledInstructionAsync({
      flightData: flightDataPda,
      authority: oracle,
      flightId,
      date,
    }),
  ]);
}

/**
 * Drive `controller.classify_flights` with the supplied flight in
 * `remaining_accounts`. Idempotent — if the flight is already in a
 * ToBeSettled* state, the program no-ops.
 */
async function classifierTick(flightId: string, date: bigint): Promise<void> {
  const rpc = getRpc();
  const keeper = await getKeeper();
  const [flightDataPda] = await findFlightDataPda({ flightId, date });
  const [poolPda] = await findPoolPda({ flightId, date });

  const baseIx = await getClassifyFlightsInstructionAsync({
    oracleProgram: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
    oracleConfig: PDAS.oracleConfig,
    keeper,
  });

  const ix: Instruction = {
    ...baseIx,
    accounts: [
      ...baseIx.accounts,
      { address: flightDataPda, role: AccountRole.WRITABLE },
      { address: poolPda, role: AccountRole.READONLY },
    ],
  };
  await sendAndConfirm(rpc, keeper, [setComputeUnitLimitIx(1_400_000), ix]);
}

/**
 * Drive `controller.execute_settlements` for one flight. Per Phase 6
 * D-Phase6-1 the ix walks the per-flight CPI chain (vault.lock_accounting
 * → flight_pool.process_settlement → oracle.set_settled) then optionally
 * housekeeps the withdrawal queue (we pass [] claimables here — we don't
 * exercise queued-withdrawal interactions in Phase 16's three scenarios).
 *
 * The treasury ATA is derived as ATA(`PDAS.poolTreasuryAuthority`,
 * mock-USDC) — same shape as the controller's on-chain expectation.
 */
async function settlerTick(flightId: string, date: bigint): Promise<void> {
  const rpc = getRpc();
  const keeper = await getKeeper();

  const day = BigInt(Math.floor(Date.now() / 1000 / 86_400));
  const [snapshotRecordPda] = await findSnapshotRecordPda({ day });
  const [flightDataPda] = await findFlightDataPda({ flightId, date });
  const [poolPda] = await findPoolPda({ flightId, date });

  // Vault USDC ATA + pool treasury ATA — both are
  // ATA(authorityPda, MOCK_USDC_MINT). Mock USDC mint addresses are
  // fixed across clusters (see config/devnet.ts).
  const { findAssociatedTokenPda } = await import('@solana-program/token');
  const { MOCK_USDC_MINT } = await import('@/config/devnet');

  const [vaultTokenAccount] = await findAssociatedTokenPda({
    owner: PDAS.vaultState,
    mint: MOCK_USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [poolTreasury] = await findAssociatedTokenPda({
    owner: PDAS.poolTreasuryAuthority,
    mint: MOCK_USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const baseIx = await getExecuteSettlementsInstructionAsync({
    vaultProgram: VAULT_PROGRAM_ADDRESS,
    flightPoolProgram: FLIGHT_POOL_PROGRAM_ADDRESS,
    oracleProgram: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
    flightPoolConfig: PDAS.flightPoolConfig,
    oracleConfig: PDAS.oracleConfig,
    vaultState: PDAS.vaultState,
    vaultTokenAccount,
    withdrawalQueue: PDAS.withdrawalQueue,
    shareMint: PDAS.shareMint,
    snapshotRecord: snapshotRecordPda,
    poolTreasury,
    treasuryAuthority: PDAS.poolTreasuryAuthority,
    keeper,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    day,
    nFlights: 1,
  });

  const ix: Instruction = {
    ...baseIx,
    accounts: [
      ...baseIx.accounts,
      { address: flightDataPda, role: AccountRole.WRITABLE },
      { address: poolPda, role: AccountRole.WRITABLE },
    ],
  };
  await sendAndConfirm(rpc, keeper, [setComputeUnitLimitIx(1_400_000), ix]);
}

// ─── Public API: full scenario drivers ───────────────────────────────────

export interface FlightSimArgs {
  flightId: string;
  date: bigint; // unix-day-seconds, already aligned to 00:00 UTC
  scheduledEtaUnixSec: bigint;
}

/**
 * Drive an "on-time landing" scenario through all three cron stages.
 * After this returns, the flight has been settled in the on-time branch:
 * no payouts, no ClaimableBalance written.
 */
export async function simulateOnTime(args: FlightSimArgs): Promise<void> {
  // `actual = scheduled` → no delay.
  await oracleLand(
    args.flightId,
    args.date,
    args.scheduledEtaUnixSec,
    args.scheduledEtaUnixSec,
  );
  await classifierTick(args.flightId, args.date);
  await settlerTick(args.flightId, args.date);
}

/**
 * Drive a "delayed landing" scenario. `delayMinutes` is added to the
 * scheduled ETA to compute actual_arrival; the flight pool's threshold
 * is read on-chain by the classifier.
 */
export async function simulateDelayed(
  args: FlightSimArgs & { delayMinutes: number },
): Promise<void> {
  const actual = args.scheduledEtaUnixSec + BigInt(args.delayMinutes * 60);
  await oracleLand(args.flightId, args.date, args.scheduledEtaUnixSec, actual);
  await classifierTick(args.flightId, args.date);
  await settlerTick(args.flightId, args.date);
}

/**
 * Drive a "cancelled before ETA" scenario. Per controller.execute_settlements,
 * cancellation always pays out (no threshold gate).
 */
export async function simulateCancelled(args: FlightSimArgs): Promise<void> {
  await oracleCancel(args.flightId, args.date);
  await classifierTick(args.flightId, args.date);
  await settlerTick(args.flightId, args.date);
}
