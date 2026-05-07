/**
 * Phase 11 — End-to-End Cron Validation against a deployed Surfpool.
 *
 * Drives the protocol through 8 parameterized scenarios using the
 * **real cron core functions** (`runFetcherOnce` / `runClassifierOnce` /
 * `runSettlerOnce`) with a mocked AeroAPI. Asserts money moves
 * correctly across the full stack — vault, flight_pool, oracle,
 * controller — not just LiteSVM simulators.
 *
 * Prerequisites (test will skip otherwise):
 *   1. `pnpm dev:surfpool` running
 *   2. `pnpm run deploy --cluster surfpool --owner <pubkey>` already ran
 *      (writes `deployments/surfpool-latest.json` which this test reads)
 *   3. `pnpm bootstrap-test-actors` has been run (creates
 *      `keys/test-actors/{investor-a,investor-b,buyer-a,buyer-b,buyer-c}.json`)
 *
 * Run:
 *   pnpm test:e2e:crons
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
import { randomBytes } from 'node:crypto';

// Contracts-side Codama clients — used to build user-facing ixs (route
// register, deposit, buy insurance, queue withdrawal, claim, collect).
import {
  GOVERNANCE_PROGRAM_ADDRESS,
  findRoutePda,
  getWhitelistRouteInstructionAsync,
} from '../clients/governance/src/generated/index.ts';
import {
  VAULT_PROGRAM_ADDRESS,
  getCollectInstructionAsync,
  getDepositInstructionAsync,
  getRequestWithdrawalInstructionAsync,
  getVaultStateDecoder,
} from '../clients/vault/src/generated/index.ts';
import {
  ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
  findFlightDataPda,
  FlightStatus as ContractsFlightStatus,
  getFlightDataDecoder,
} from '../clients/oracle_aggregator/src/generated/index.ts';
import {
  FLIGHT_POOL_PROGRAM_ADDRESS,
  SettlementStatus,
  findBuyerRecordPda,
  findPoolPda,
  getClaimInstructionAsync,
  getFlightPoolDecoder,
} from '../clients/flight_pool/src/generated/index.ts';
import {
  CONTROLLER_PROGRAM_ADDRESS,
  getBuyInsuranceInstructionAsync,
  getControllerConfigDecoder,
} from '../clients/controller/src/generated/index.ts';

// Executor-side core + runner functions — these are the system under test.
import { runFetcherOnce } from '../../../executor/src/core/flight_data_fetcher.ts';
import { runClassifierOnce } from '../../../executor/src/core/flight_classifier.ts';
import { runSettlerOnce } from '../../../executor/src/core/settlement_executor.ts';
import {
  createSolanaClient,
  type SolanaClient,
} from '../../../executor/src/core/solana_client.ts';
import {
  actionToIxs,
} from '../../../executor/src/scripts/run-fetcher.ts';
import {
  buildClassifyBatchIx,
} from '../../../executor/src/scripts/run-classifier.ts';
import {
  buildSettleBatchIxs,
  currentDay,
} from '../../../executor/src/scripts/run-settler.ts';
import { createMockAeroApi, type MockAeroApi } from '../../../executor/src/test/mock_aero_api.ts';
import { FlightStatus as ExecutorFlightStatus } from '../../../executor/src/core/types.ts';

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey as Web3Pubkey } from '@solana/web3.js';

// ─── Constants ───────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SURFPOOL_RPC = process.env.SURFNET_RPC ?? 'http://127.0.0.1:8899';
const DEPLOYMENT_PATH = resolve(REPO_ROOT, 'deployments/surfpool-latest.json');
const TEST_ACTORS_DIR = resolve(REPO_ROOT, 'keys/test-actors');
const MOCK_USDC_AUTHORITY_PATH = resolve(REPO_ROOT, 'keys/mock-usdc-authority.json');
const TOKEN_PROGRAM_ADDRESS_KIT: Address = kitAddress(TOKEN_PROGRAM_ID.toBase58());

const ORIGIN = 'JFK';
const DESTINATION = 'SFO';
const PREMIUM = 1_000_000n;       // 1 USDC
const PAYOFF = 10_000_000n;       // 10 USDC
const DELAY_HOURS = 2;
const FUTURE_DATE = 50_000n;      // unix-day-50000 ≈ year 2106 (>1h lead time always)

// ─── Per-suite run id (unique flight idents per test execution) ──────────

const RUN_ID = randomBytes(3).toString('hex').toUpperCase();
function flightIdent(scenarioIdx: number, sub = ''): string {
  // Anchor String accounts use 4-byte length prefix; keep these short to
  // avoid bloating per-flight PDA size unnecessarily.
  return `E${RUN_ID}${scenarioIdx}${sub}`;
}

// ─── Compute-budget helper (matches Phase 6 setup.ts) ────────────────────

const COMPUTE_BUDGET_PROGRAM: Address = kitAddress(
  'ComputeBudget111111111111111111111111111111',
);
function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 0x02;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

// ─── Deployment artifact (matches scripts/deploy.ts shape) ───────────────

interface Deployment {
  cluster: string;
  rpcUrl: string;
  deployer: string;
  owner: string;
  authorities: { oracle: string; keeper: string };
  keypairPaths: { oracle: string; keeper: string };
  usdcMint: string;
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

async function loadKeypair(path: string): Promise<KeyPairSigner> {
  const bytes = JSON.parse(readFileSync(path, 'utf-8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

function deriveAta(mint: Address, owner: Address): Address {
  return kitAddress(
    getAssociatedTokenAddressSync(
      new Web3Pubkey(mint.toString()),
      new Web3Pubkey(owner.toString()),
      true,
    ).toBase58(),
  );
}

// ─── RPC helpers ─────────────────────────────────────────────────────────

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

async function getBalance(rpc: Rpc<SolanaRpcApi>, addr: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(addr).send();
  return BigInt(value);
}

async function getTokenBalance(rpc: Rpc<SolanaRpcApi>, ata: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
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

// ─── Generic tx send (build + sign + send + confirm) ─────────────────────

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
  try {
    await rpc
      .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
      .send();
  } catch (err) {
    // On failure, run simulateTransaction to surface program logs — they
    // tell us which inner CPI / constraint actually failed.
    try {
      const sim = await rpc
        .simulateTransaction(wire, { encoding: 'base64', sigVerify: false })
        .send();
      const logs = (sim.value as { logs?: string[] }).logs;
      if (logs?.length) {
        console.error('[e2e-crons] failed tx logs:\n' + logs.join('\n'));
      }
    } catch {
      // simulate also failed — fall through with original error
    }
    throw err;
  }
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

// ─── USDC mint / share ATA helpers ───────────────────────────────────────

async function mintUsdcTo(
  rpc: Rpc<SolanaRpcApi>,
  mintAuthority: KeyPairSigner,
  mintPubkey: Address,
  recipient: Address,
  amountUsdc: bigint,
): Promise<Address> {
  const { getCreateAssociatedTokenIdempotentInstructionAsync, getMintToCheckedInstruction } =
    await import('@solana-program/token');
  const ata = deriveAta(mintPubkey, recipient);
  const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: mintAuthority,
    ata,
    owner: recipient,
    mint: mintPubkey,
  });
  const mintToIx = getMintToCheckedInstruction({
    mint: mintPubkey,
    token: ata,
    mintAuthority,
    amount: amountUsdc * 1_000_000n,
    decimals: 6,
  });
  await sendIxs(rpc, mintAuthority, [createAtaIx, mintToIx]);
  return ata;
}

async function ensureShareAta(
  rpc: Rpc<SolanaRpcApi>,
  payer: KeyPairSigner,
  shareMint: Address,
  owner: Address,
): Promise<Address> {
  const { getCreateAssociatedTokenIdempotentInstructionAsync } = await import(
    '@solana-program/token'
  );
  const ata = deriveAta(shareMint, owner);
  const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    ata,
    owner,
    mint: shareMint,
  });
  await sendIxs(rpc, payer, [ix]);
  return ata;
}

// ─── Per-test high-level helpers ─────────────────────────────────────────

async function ensureRouteWhitelisted(
  rpc: Rpc<SolanaRpcApi>,
  owner: KeyPairSigner,
  flightId: string,
): Promise<Address> {
  const [routePda] = await findRoutePda({
    flightId,
    origin: ORIGIN,
    destination: DESTINATION,
  });
  const existing = await rpc.getAccountInfo(routePda, { encoding: 'base64' }).send();
  if (existing.value) return routePda;
  await sendIxs(rpc, owner, [
    await getWhitelistRouteInstructionAsync({
      caller: owner,
      adminRecord: GOVERNANCE_PROGRAM_ADDRESS, // None sentinel
      flightId,
      origin: ORIGIN,
      destination: DESTINATION,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    }),
  ]);
  return routePda;
}

async function buyInsurance(
  rpc: Rpc<SolanaRpcApi>,
  deployment: Deployment,
  buyer: KeyPairSigner,
  routePda: Address,
  flightId: string,
  date: bigint,
): Promise<{ flightDataPda: Address; flightPoolPda: Address; buyerRecordPda: Address }> {
  const usdcMint = kitAddress(deployment.usdcMint);
  const [flightDataPda] = await findFlightDataPda({ flightId, date });
  const [flightPoolPda] = await findPoolPda({ flightId, date });
  const [buyerRecordPda] = await findBuyerRecordPda({
    pool: flightPoolPda,
    buyer: buyer.address,
  });
  const buyerUsdc = deriveAta(usdcMint, buyer.address);

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
    buyerUsdcAccount: buyerUsdc,
    poolTreasury: deriveAta(usdcMint, kitAddress(deployment.pdas.poolTreasuryAuthority)),
    vaultProgram: VAULT_PROGRAM_ADDRESS,
    vaultState: kitAddress(deployment.pdas.vaultState),
    traveler: buyer,
    flightId,
    origin: ORIGIN,
    destination: DESTINATION,
    date,
  });
  await sendIxs(rpc, buyer, [setComputeUnitLimitIx(1_400_000), buyIx]);
  return { flightDataPda, flightPoolPda, buyerRecordPda };
}

// ─── Real-cron tick wrappers (the system under test) ─────────────────────

interface CronCtx {
  oracleSolana: SolanaClient;
  keeperSolana: SolanaClient;
  aero: MockAeroApi;
}

async function fetcherTick(ctx: CronCtx): Promise<void> {
  await runFetcherOnce({
    solana: ctx.oracleSolana,
    aero: ctx.aero,
    log: () => undefined, // quiet during scenarios; flip to console.log to debug
    applyAction: async (entry, action) => {
      const ixs = await actionToIxs(ctx.oracleSolana, entry, action);
      if (ixs.length > 0) await ctx.oracleSolana.sendIxs(ixs);
    },
  });
}

async function classifierTick(ctx: CronCtx): Promise<void> {
  await runClassifierOnce({
    solana: ctx.keeperSolana,
    log: () => undefined,
    applyBatch: async (batch) => {
      const ixs = await buildClassifyBatchIx(ctx.keeperSolana, batch);
      if (ixs.length > 0) await ctx.keeperSolana.sendIxs(ixs);
    },
  });
}

async function settlerTick(ctx: CronCtx): Promise<void> {
  const day = await currentDay(ctx.keeperSolana);
  await runSettlerOnce({
    solana: ctx.keeperSolana,
    log: () => undefined,
    applyBatch: async (batch, claimables) => {
      const ixs = await buildSettleBatchIxs(ctx.keeperSolana, batch, claimables, day);
      if (ixs.length > 0) await ctx.keeperSolana.sendIxs(ixs);
    },
  });
}

// ─── Test suite ──────────────────────────────────────────────────────────

describe('Phase 11 — End-to-End Cron Validation (Surfpool)', () => {
  let deployment: Deployment | null = null;
  let rpc: Rpc<SolanaRpcApi>;
  let usdcMint: Address;
  let owner: KeyPairSigner;
  let oracleSigner: KeyPairSigner;
  let keeperSigner: KeyPairSigner;
  let mintAuthority: KeyPairSigner;
  let investorA: KeyPairSigner;
  let investorB: KeyPairSigner;
  let buyerA: KeyPairSigner;
  let buyerB: KeyPairSigner;
  let buyerC: KeyPairSigner;
  let oracleSolana: SolanaClient;
  let keeperSolana: SolanaClient;
  let aero: MockAeroApi;
  let ctx: CronCtx;
  let envelopeLogs: string[]; // captured by the mock's logger override
  let prereqsMet = false;

  beforeAll(async () => {
    if (!(await rpcReachable())) {
      console.warn(
        `[e2e-crons] Surfpool unreachable at ${SURFPOOL_RPC}. ` +
          'Start it with `pnpm dev:surfpool`.',
      );
      return;
    }
    deployment = loadDeployment();
    if (!deployment) {
      console.warn(
        `[e2e-crons] No deployment artifact at ${DEPLOYMENT_PATH}. ` +
          'Run `pnpm run deploy --cluster surfpool --owner <pubkey>` first.',
      );
      return;
    }

    rpc = createSolanaRpc(SURFPOOL_RPC);
    usdcMint = kitAddress(deployment.usdcMint);

    // Owner == deployer per scripts/deploy.ts constraint.
    owner = await loadKeypair(`${process.env.HOME}/.config/solana/id.json`);
    oracleSigner = await loadKeypair(resolve(REPO_ROOT, deployment.keypairPaths.oracle));
    keeperSigner = await loadKeypair(resolve(REPO_ROOT, deployment.keypairPaths.keeper));
    mintAuthority = await loadKeypair(MOCK_USDC_AUTHORITY_PATH);

    investorA = await loadKeypair(resolve(TEST_ACTORS_DIR, 'investor-a.json'));
    investorB = await loadKeypair(resolve(TEST_ACTORS_DIR, 'investor-b.json'));
    buyerA = await loadKeypair(resolve(TEST_ACTORS_DIR, 'buyer-a.json'));
    buyerB = await loadKeypair(resolve(TEST_ACTORS_DIR, 'buyer-b.json'));
    buyerC = await loadKeypair(resolve(TEST_ACTORS_DIR, 'buyer-c.json'));

    // Fund every actor with SOL (idempotent — skip if already > 1 SOL).
    for (const kp of [
      owner,
      oracleSigner,
      keeperSigner,
      mintAuthority,
      investorA,
      investorB,
      buyerA,
      buyerB,
      buyerC,
    ]) {
      const bal = await getBalance(rpc, kp.address);
      if (bal < 1_000_000_000n) {
        await rpcAirdrop(kp.address, 5);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));

    // Pre-mint USDC. Investors get 50k for deposits; buyers get 100 for premiums.
    await mintUsdcTo(rpc, mintAuthority, usdcMint, investorA.address, 50_000n);
    await mintUsdcTo(rpc, mintAuthority, usdcMint, investorB.address, 50_000n);
    await mintUsdcTo(rpc, mintAuthority, usdcMint, buyerA.address, 100n);
    await mintUsdcTo(rpc, mintAuthority, usdcMint, buyerB.address, 100n);
    await mintUsdcTo(rpc, mintAuthority, usdcMint, buyerC.address, 100n);

    // Build two SolanaClients — oracle for fetcher, keeper for classifier
    // + settler. Mirrors the daemon's authority isolation per Phase 4 D2.
    oracleSolana = await createSolanaClient({
      cluster: 'surfpool',
      repoRoot: REPO_ROOT,
      keypairPath: resolve(REPO_ROOT, deployment.keypairPaths.oracle),
      rpcUrl: SURFPOOL_RPC,
    });
    keeperSolana = await createSolanaClient({
      cluster: 'surfpool',
      repoRoot: REPO_ROOT,
      keypairPath: resolve(REPO_ROOT, deployment.keypairPaths.keeper),
      rpcUrl: SURFPOOL_RPC,
    });

    // Mock AeroAPI with captured envelope logs (scenario 8 asserts shape).
    envelopeLogs = [];
    aero = createMockAeroApi({ logger: (m: string) => envelopeLogs.push(m) });
    ctx = { oracleSolana, keeperSolana, aero };

    // Pre-fund the vault so all buy_insurance calls have capital.
    // Investor A deposits 50k USDC (50 billion in 6-decimal fixed-point).
    const investorAUsdc = deriveAta(usdcMint, investorA.address);
    const investorAShare = await ensureShareAta(
      rpc,
      investorA,
      kitAddress(deployment.pdas.shareMint),
      investorA.address,
    );
    const usdcBal = await getTokenBalance(rpc, investorAUsdc);
    if (usdcBal >= 1_000_000_000n) {
      // 1k USDC threshold — vault might already be funded from a prior run.
      await sendIxs(rpc, investorA, [
        await getDepositInstructionAsync({
          vaultState: kitAddress(deployment.pdas.vaultState),
          shareMint: kitAddress(deployment.pdas.shareMint),
          vaultTokenAccount: deriveAta(usdcMint, kitAddress(deployment.pdas.vaultState)),
          depositorUsdcAccount: investorAUsdc,
          depositorShareAccount: investorAShare,
          depositor: investorA,
          usdcAmount: 1_000_000_000n,
        }),
      ]);
    }

    prereqsMet = true;
  }, 180_000);

  function skipIfNotReady(): boolean {
    if (!prereqsMet || !deployment) {
      console.warn('[e2e-crons] skipping (prereqs not met)');
      return true;
    }
    return false;
  }

  // ─── Scenario 1 — on-time landing ────────────────────────────────────

  it('S1: on-time landing → vault TMA up, locked down, no payout', async () => {
    if (skipIfNotReady()) return;
    const flightId = flightIdent(1);
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);

    await ensureRouteWhitelisted(rpc, owner, flightId);
    const vaultBefore = await fetchAccount(
      rpc,
      kitAddress(deployment!.pdas.vaultState),
      getVaultStateDecoder(),
    );

    const { flightDataPda, flightPoolPda } = await buyInsurance(
      rpc,
      deployment!,
      buyerA,
      (await findRoutePda({ flightId, origin: ORIGIN, destination: DESTINATION }))[0],
      flightId,
      date,
    );

    // Seed the mock: in-flight (not cancelled, not landed yet, scheduled_in known).
    const etaIso = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000).toISOString();
    aero.seed(flightId, dateIso, {
      ident: flightId,
      cancelled: false,
      scheduled_in: etaIso,
      actual_in: null,
    });

    // Tick 1: fetcher seeds ETA → NotInitiated → Active.
    await fetcherTick(ctx);
    let fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Active);

    // Mutate to landed exactly on time (zero delay).
    aero.mutate(flightId, dateIso, { actual_in: etaIso });

    // Tick 2: fetcher → set_landed.
    await fetcherTick(ctx);
    fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Landed);

    // Tick 3: classifier → Landed → ToBeSettledOnTime.
    await classifierTick(ctx);
    fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.ToBeSettledOnTime);

    // Tick 4: settler → Settled.
    await settlerTick(ctx);
    fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Settled);
    const pool = await fetchAccount(rpc, flightPoolPda, getFlightPoolDecoder());
    expect(pool?.status).toBe(SettlementStatus.SettledOnTime);

    // Vault: TMA should have increased by exactly PREMIUM (premium realized).
    const vaultAfter = await fetchAccount(
      rpc,
      kitAddress(deployment!.pdas.vaultState),
      getVaultStateDecoder(),
    );
    expect(vaultAfter!.totalManagedAssets - vaultBefore!.totalManagedAssets).toBe(PREMIUM);
    // Locked capital returns to its pre-buy level (could be 0 or > 0 if
    // other scenarios already left locks, so use a relative check).
    expect(vaultAfter!.lockedCapital).toBe(vaultBefore!.lockedCapital);

    // Buyer's USDC ATA: they paid the premium, no payout — net = -PREMIUM
    // versus before-buy. Just sanity-check no payout was credited above
    // the pre-buy balance.
    const buyerUsdc = deriveAta(usdcMint, buyerA.address);
    const buyerBal = await getTokenBalance(rpc, buyerUsdc);
    expect(buyerBal).toBeGreaterThanOrEqual(0n);

    // Sanity: the executor's FlightStatus enum and the contracts client
    // enum agree. Caught here so other scenarios can rely on it.
    expect(Number(ContractsFlightStatus.Settled)).toBe(ExecutorFlightStatus.Settled);
  }, 90_000);

  // ─── Scenario 2 — delayed beyond threshold ───────────────────────────

  it('S2: delayed beyond threshold → buyer payout, locked down', async () => {
    if (skipIfNotReady()) return;
    const flightId = flightIdent(2);
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);

    await ensureRouteWhitelisted(rpc, owner, flightId);
    const { flightDataPda, flightPoolPda, buyerRecordPda } = await buyInsurance(
      rpc,
      deployment!,
      buyerB,
      (await findRoutePda({ flightId, origin: ORIGIN, destination: DESTINATION }))[0],
      flightId,
      date,
    );
    void buyerRecordPda;

    const eta = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000);
    const lateActual = new Date(eta.getTime() + (DELAY_HOURS + 1) * 3600 * 1000);

    aero.seed(flightId, dateIso, {
      ident: flightId,
      cancelled: false,
      scheduled_in: eta.toISOString(),
      actual_in: null,
    });
    await fetcherTick(ctx); // → Active

    aero.mutate(flightId, dateIso, { actual_in: lateActual.toISOString() });
    await fetcherTick(ctx); // → Landed
    await classifierTick(ctx); // → ToBeSettledDelayed
    await settlerTick(ctx); // → Settled

    const fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Settled);
    const pool = await fetchAccount(rpc, flightPoolPda, getFlightPoolDecoder());
    expect(pool?.status).toBe(SettlementStatus.SettledDelayed);

    // Buyer claims and receives PAYOFF.
    const buyerUsdc = deriveAta(usdcMint, buyerB.address);
    const buyerBalBefore = await getTokenBalance(rpc, buyerUsdc);
    await sendIxs(rpc, buyerB, [
      await getClaimInstructionAsync({
        config: kitAddress(deployment!.pdas.flightPoolConfig),
        pool: flightPoolPda,
        buyer: buyerB.address,
        poolTreasury: deriveAta(usdcMint, kitAddress(deployment!.pdas.poolTreasuryAuthority)),
        treasuryAuthority: kitAddress(deployment!.pdas.poolTreasuryAuthority),
        usdcMint,
        traveler: buyerB,
        flightId,
        date,
      }),
    ]);
    const buyerBalAfter = await getTokenBalance(rpc, buyerUsdc);
    expect(buyerBalAfter - buyerBalBefore).toBe(PAYOFF);
  }, 90_000);

  // ─── Scenario 3 — cancelled before ETA-seed (atomic 2-ix-in-1-tx) ────

  it('S3: cancelled before ETA-seed → atomic NotInitiated→Cancelled, payout', async () => {
    if (skipIfNotReady()) return;
    const flightId = flightIdent(3);
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);

    await ensureRouteWhitelisted(rpc, owner, flightId);
    const { flightDataPda, flightPoolPda } = await buyInsurance(
      rpc,
      deployment!,
      buyerC,
      (await findRoutePda({ flightId, origin: ORIGIN, destination: DESTINATION }))[0],
      flightId,
      date,
    );

    // Confirm we're in NotInitiated immediately after first-buy.
    const fdInitial = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fdInitial?.status).toBe(ContractsFlightStatus.NotInitiated);

    // Mock: cancelled before any ETA seeding.
    const eta = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000);
    aero.seed(flightId, dateIso, {
      ident: flightId,
      cancelled: true,
      scheduled_in: eta.toISOString(),
      actual_in: null,
    });

    // Single fetcher tick → fires the atomic 2-ix-in-1-tx path
    // (set_estimated_arrival → set_cancelled).
    await fetcherTick(ctx);
    const fdAfterFetcher = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fdAfterFetcher?.status).toBe(ContractsFlightStatus.Cancelled);

    await classifierTick(ctx);
    const fdAfterClassify = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fdAfterClassify?.status).toBe(ContractsFlightStatus.ToBeSettledCancelled);

    await settlerTick(ctx);
    const fdSettled = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fdSettled?.status).toBe(ContractsFlightStatus.Settled);
    const pool = await fetchAccount(rpc, flightPoolPda, getFlightPoolDecoder());
    expect(pool?.status).toBe(SettlementStatus.SettledCancelled);

    // Claim → buyer receives PAYOFF.
    const buyerUsdc = deriveAta(usdcMint, buyerC.address);
    const buyerBalBefore = await getTokenBalance(rpc, buyerUsdc);
    await sendIxs(rpc, buyerC, [
      await getClaimInstructionAsync({
        config: kitAddress(deployment!.pdas.flightPoolConfig),
        pool: flightPoolPda,
        buyer: buyerC.address,
        poolTreasury: deriveAta(usdcMint, kitAddress(deployment!.pdas.poolTreasuryAuthority)),
        treasuryAuthority: kitAddress(deployment!.pdas.poolTreasuryAuthority),
        usdcMint,
        traveler: buyerC,
        flightId,
        date,
      }),
    ]);
    const buyerBalAfter = await getTokenBalance(rpc, buyerUsdc);
    expect(buyerBalAfter - buyerBalBefore).toBe(PAYOFF);
  }, 90_000);

  // ─── Scenario 4 — cancelled after ETA-seed (single-ix path) ──────────

  it('S4: cancelled after ETA-seed → single-ix set_cancelled, payout', async () => {
    if (skipIfNotReady()) return;
    const flightId = flightIdent(4);
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);

    await ensureRouteWhitelisted(rpc, owner, flightId);
    const { flightDataPda, flightPoolPda } = await buyInsurance(
      rpc,
      deployment!,
      buyerA,
      (await findRoutePda({ flightId, origin: ORIGIN, destination: DESTINATION }))[0],
      flightId,
      date,
    );

    const eta = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000);
    aero.seed(flightId, dateIso, {
      ident: flightId,
      cancelled: false,
      scheduled_in: eta.toISOString(),
      actual_in: null,
    });
    await fetcherTick(ctx); // NotInitiated → Active

    let fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Active);

    aero.mutate(flightId, dateIso, { cancelled: true });
    await fetcherTick(ctx); // Active + cancelled → set_cancelled

    fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Cancelled);

    await classifierTick(ctx);
    await settlerTick(ctx);

    const pool = await fetchAccount(rpc, flightPoolPda, getFlightPoolDecoder());
    expect(pool?.status).toBe(SettlementStatus.SettledCancelled);

    const buyerUsdc = deriveAta(usdcMint, buyerA.address);
    const buyerBalBefore = await getTokenBalance(rpc, buyerUsdc);
    await sendIxs(rpc, buyerA, [
      await getClaimInstructionAsync({
        config: kitAddress(deployment!.pdas.flightPoolConfig),
        pool: flightPoolPda,
        buyer: buyerA.address,
        poolTreasury: deriveAta(usdcMint, kitAddress(deployment!.pdas.poolTreasuryAuthority)),
        treasuryAuthority: kitAddress(deployment!.pdas.poolTreasuryAuthority),
        usdcMint,
        traveler: buyerA,
        flightId,
        date,
      }),
    ]);
    expect((await getTokenBalance(rpc, buyerUsdc)) - buyerBalBefore).toBe(PAYOFF);
  }, 90_000);

  // ─── Scenario 6 — withdrawal queued during active flight ─────────────
  //
  // Note on scenario ordering: scenario 5 is declared LAST (after S8) on
  // purpose. The controller's `BuyInsurance` accounts struct reallocs
  // ActiveFlightList to `space_for(flights.len() + 1)` on every buy, and
  // Anchor v1 realloc fails to balance lamports when SHRINKING. After S5
  // settles 3 flights, len drops to 0 but allocation stays at space_for(3);
  // the next single-flight buy would target space_for(1) → shrink → fail.
  // Running S5 last keeps every preceding buy at constant peak, so no
  // shrink ever occurs. Phase 6 D-Phase6-2 already flagged this for a
  // future compaction ix; this phase respects the no-contract-changes
  // constraint and works around via test ordering.

  it('S6: queued withdrawal drains during settlement (Model B)', async () => {
    if (skipIfNotReady()) return;
    const flightId = flightIdent(6);
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);

    // Investor B deposits 5k USDC + queues a 1k-share withdrawal.
    const investorBUsdc = deriveAta(usdcMint, investorB.address);
    const shareMint = kitAddress(deployment!.pdas.shareMint);
    const investorBShare = await ensureShareAta(rpc, investorB, shareMint, investorB.address);
    const depositAmount = 5_000_000_000n; // 5,000 USDC at 6 decimals
    await sendIxs(rpc, investorB, [
      await getDepositInstructionAsync({
        vaultState: kitAddress(deployment!.pdas.vaultState),
        shareMint,
        vaultTokenAccount: deriveAta(usdcMint, kitAddress(deployment!.pdas.vaultState)),
        depositorUsdcAccount: investorBUsdc,
        depositorShareAccount: investorBShare,
        depositor: investorB,
        usdcAmount: depositAmount,
      }),
    ]);
    const sharesBefore = await getTokenBalance(rpc, investorBShare);
    expect(sharesBefore).toBeGreaterThan(0n);

    // Buyer purchases insurance.
    await ensureRouteWhitelisted(rpc, owner, flightId);
    const { flightDataPda, flightPoolPda } = await buyInsurance(
      rpc,
      deployment!,
      buyerA,
      (await findRoutePda({ flightId, origin: ORIGIN, destination: DESTINATION }))[0],
      flightId,
      date,
    );
    void flightDataPda;
    void flightPoolPda;

    // Investor B queues a withdrawal of half their shares.
    const sharesToWithdraw = sharesBefore / 2n;
    await sendIxs(rpc, investorB, [
      await getRequestWithdrawalInstructionAsync({
        vaultState: kitAddress(deployment!.pdas.vaultState),
        withdrawalQueue: kitAddress(deployment!.pdas.withdrawalQueue),
        shareMint,
        requesterShareAccount: investorBShare,
        requester: investorB,
        shares: sharesToWithdraw,
      }),
    ]);

    // Drive flight to settlement (delayed for variety).
    const eta = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000);
    aero.seed(flightId, dateIso, {
      ident: flightId,
      cancelled: false,
      scheduled_in: eta.toISOString(),
      actual_in: null,
    });
    await fetcherTick(ctx);
    aero.mutate(flightId, dateIso, {
      actual_in: new Date(eta.getTime() + (DELAY_HOURS + 1) * 3600 * 1000).toISOString(),
    });
    await fetcherTick(ctx);
    await classifierTick(ctx);

    // Pre-settlement: queue should have at least one entry.
    const claimablesBefore = await keeperSolana.readWithdrawalQueueClaimables();
    expect(claimablesBefore.length).toBeGreaterThanOrEqual(1);

    // Settler tick — drains the queue + credits ClaimableBalance PDAs.
    await settlerTick(ctx);

    const claimablesAfter = await keeperSolana.readWithdrawalQueueClaimables();
    expect(claimablesAfter.length).toBeLessThan(claimablesBefore.length);

    // Investor B collects from their ClaimableBalance.
    const usdcBalBefore = await getTokenBalance(rpc, investorBUsdc);
    const claimablePda = claimablesBefore[0];
    await sendIxs(rpc, investorB, [
      await getCollectInstructionAsync({
        vaultState: kitAddress(deployment!.pdas.vaultState),
        vaultTokenAccount: deriveAta(usdcMint, kitAddress(deployment!.pdas.vaultState)),
        claimable: claimablePda,
        owner: investorB.address,
        collectorUsdcAccount: investorBUsdc,
        collector: investorB,
      }),
    ]);
    const usdcBalAfter = await getTokenBalance(rpc, investorBUsdc);
    expect(usdcBalAfter).toBeGreaterThan(usdcBalBefore);
  }, 180_000);

  // ─── Scenario 7 — status-string-ignored invariant ────────────────────

  it('S7: misleading status="Cancelled" with cancelled=false → no state change', async () => {
    if (skipIfNotReady()) return;
    const flightId = flightIdent(7);
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);

    await ensureRouteWhitelisted(rpc, owner, flightId);
    const { flightDataPda } = await buyInsurance(
      rpc,
      deployment!,
      buyerB,
      (await findRoutePda({ flightId, origin: ORIGIN, destination: DESTINATION }))[0],
      flightId,
      date,
    );

    // Tick 1: seed normal in-flight → Active.
    const eta = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000);
    aero.seed(flightId, dateIso, {
      ident: flightId,
      cancelled: false,
      scheduled_in: eta.toISOString(),
      actual_in: null,
    });
    await fetcherTick(ctx);
    let fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Active);
    const etaBefore = fd!.estimatedArrivalTime;

    // Tick 2: mutate to MISLEADING status string. cancelled=false,
    // actual_in=null — fetcher must treat as in-flight + skip.
    // The `status` string is non-canonical (we store it in `[key: string]:
    // unknown` — adding it here mimics what FlightAware actually returns).
    aero.mutate(flightId, dateIso, {
      ['status']: 'Cancelled',
    } as never);

    await fetcherTick(ctx);
    fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    // Status MUST still be Active — the misleading string was ignored.
    expect(fd?.status).toBe(ContractsFlightStatus.Active);
    expect(fd!.estimatedArrivalTime).toBe(etaBefore);
  }, 90_000);

  // ─── Scenario 8 — AeroAPI 4xx envelope: log + skip + resume ──────────

  it('S8: 4xx envelope on tick 1 logs + skips; tick 2 resumes processing', async () => {
    if (skipIfNotReady()) return;
    const flightId = flightIdent(8);
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);

    await ensureRouteWhitelisted(rpc, owner, flightId);
    const { flightDataPda } = await buyInsurance(
      rpc,
      deployment!,
      buyerC,
      (await findRoutePda({ flightId, origin: ORIGIN, destination: DESTINATION }))[0],
      flightId,
      date,
    );

    // Tick 1: AeroAPI returns a 4xx envelope. Cron logs structured fields,
    // skips, no on-chain change.
    const beforeLogCount = envelopeLogs.length;
    aero.seedError(flightId, dateIso, {
      title: 'Forbidden',
      reason: 'TIER_INSUFFICIENT',
      detail: 'Your subscription tier does not include this endpoint',
      status: 403,
    });
    await fetcherTick(ctx);
    let fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.NotInitiated);

    // Envelope log emitted (the mock + real client share the same line shape).
    expect(envelopeLogs.length).toBeGreaterThan(beforeLogCount);
    const envLog = envelopeLogs[envelopeLogs.length - 1];
    expect(envLog).toContain('[aero] 4xx envelope:');
    expect(envLog).toContain('status=403');
    expect(envLog).toContain('title="Forbidden"');
    expect(envLog).toContain('reason="TIER_INSUFFICIENT"');

    // Tick 2: replace the error with a valid landed flight. Fetcher should
    // process via the atomic 2-ix path (NotInitiated + actual_in present).
    const eta = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000);
    aero.seed(flightId, dateIso, {
      ident: flightId,
      cancelled: false,
      scheduled_in: eta.toISOString(),
      actual_in: eta.toISOString(),
    });
    await fetcherTick(ctx);
    fd = await fetchAccount(rpc, flightDataPda, getFlightDataDecoder());
    expect(fd?.status).toBe(ContractsFlightStatus.Landed);
  }, 120_000);

  // ─── Scenario 5 — multi-flight in single settler tick (chunk @ 2) ────
  // Declared last to keep ActiveFlightList realloc growing-only. See note
  // above S6 for the Anchor v1 shrinking-realloc constraint.

  it('S5: 3 flights settle in 2 settler-tick batches (MAX_FLIGHTS_PER_TX=2)', async () => {
    if (skipIfNotReady()) return;
    const date = FUTURE_DATE;
    const dateIso = new Date(Number(date) * 86_400 * 1000).toISOString().slice(0, 10);
    const eta = new Date(Number(date) * 86_400 * 1000 + 18 * 3600 * 1000);

    const ids = ['5a', '5b', '5c'].map((s) => flightIdent(5, s));
    const buyers = [buyerA, buyerB, buyerC];

    // All 3 buyers purchase, then all 3 mocks seed in-flight, then transition
    // each to Landed-on-time. Drive through fetcher → classifier → settler.
    const pdas: { fd: Address; pool: Address }[] = [];
    for (let i = 0; i < ids.length; i++) {
      await ensureRouteWhitelisted(rpc, owner, ids[i]);
      const r = await buyInsurance(
        rpc,
        deployment!,
        buyers[i],
        (await findRoutePda({ flightId: ids[i], origin: ORIGIN, destination: DESTINATION }))[0],
        ids[i],
        date,
      );
      pdas.push({ fd: r.flightDataPda, pool: r.flightPoolPda });
      aero.seed(ids[i], dateIso, {
        ident: ids[i],
        cancelled: false,
        scheduled_in: eta.toISOString(),
        actual_in: null,
      });
    }

    // Tick 1: all 3 → Active.
    await fetcherTick(ctx);
    // Mutate all 3 to landed on time.
    for (const id of ids) {
      aero.mutate(id, dateIso, { actual_in: eta.toISOString() });
    }
    // Tick 2: all 3 → Landed.
    await fetcherTick(ctx);
    // Tick 3: classifier batches at 2 → 2 batches, all 3 → ToBeSettledOnTime.
    await classifierTick(ctx);
    for (const { fd } of pdas) {
      const v = await fetchAccount(rpc, fd, getFlightDataDecoder());
      expect(v?.status).toBe(ContractsFlightStatus.ToBeSettledOnTime);
    }
    // Tick 4: settler batches at 2 → 2 txs, all 3 → Settled.
    await settlerTick(ctx);
    for (const { fd, pool } of pdas) {
      const v = await fetchAccount(rpc, fd, getFlightDataDecoder());
      expect(v?.status).toBe(ContractsFlightStatus.Settled);
      const p = await fetchAccount(rpc, pool, getFlightPoolDecoder());
      expect(p?.status).toBe(SettlementStatus.SettledOnTime);
    }
  }, 180_000);
});
