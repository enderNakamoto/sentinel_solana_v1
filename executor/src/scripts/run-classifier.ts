/**
 * executor/scripts/run-classifier.ts
 *
 * Phase 9 — One-shot runner for the FlightClassifier cron. Reads
 * ActiveFlightList, batches Landed/Cancelled flights into ≤2-per-tx
 * groups, calls `controller.classify_flights` per batch.
 *
 * Required env:
 *   CLUSTER          — surfpool | devnet | testnet | mainnet
 *   KEEPER_KEYPAIR   — path to the authorized_keeper keypair file
 * Optional env:
 *   SOLANA_RPC_URL   — overrides deployment artifact rpcUrl
 */

import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AccountRole,
  address as kitAddress,
  type Address,
  type Instruction,
} from '@solana/kit';

import { runClassifierOnce } from '../core/flight_classifier.ts';
import {
  createSolanaClient,
  type ActiveFlightEntry,
  type SolanaClient,
} from '../core/solana_client.ts';

import { getClassifyFlightsInstructionAsync } from '../clients/controller/src/generated/index.ts';

// ─── ComputeBudget ix (matches Phase 6 setup.ts pattern) ─────────────────
//
// Heavy CPI chains in classify_flights blow past the default 200K CU.
// Phase 5 D-Phase5-3 confirmed 1.4M CU is the project standard for any
// controller ix that fans out to oracle CPIs.

const COMPUTE_BUDGET_PROGRAM: Address = kitAddress(
  'ComputeBudget111111111111111111111111111111',
);
function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 0x02;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

// ─── Batch → ix translation ──────────────────────────────────────────────

async function buildClassifyBatchIx(
  solana: SolanaClient,
  batch: ActiveFlightEntry[],
): Promise<Instruction[]> {
  if (batch.length === 0) return [];

  const baseIx = await getClassifyFlightsInstructionAsync({
    controllerConfig: kitAddress(solana.deployment.pdas.controllerConfig),
    oracleProgram: kitAddress(solana.deployment.programs.oracle_aggregator),
    oracleConfig: kitAddress(solana.deployment.pdas.oracleConfig),
    keeper: solana.signer,
  });

  // remaining_accounts = [(FlightData mut, FlightPool readonly), ...]
  const extra: { address: Address; role: AccountRole }[] = [];
  for (const entry of batch) {
    const fd = await deriveFlightDataPda(
      solana.deployment.programs.oracle_aggregator,
      entry,
    );
    const pool = await deriveFlightPoolPda(
      solana.deployment.programs.flight_pool,
      entry,
    );
    extra.push({ address: fd, role: AccountRole.WRITABLE });
    extra.push({ address: pool, role: AccountRole.READONLY });
  }

  const classifyIx: Instruction = {
    ...baseIx,
    accounts: [...baseIx.accounts, ...extra],
  };
  return [setComputeUnitLimitIx(1_400_000), classifyIx];
}

async function deriveFlightDataPda(
  oracleProgram: string,
  entry: ActiveFlightEntry,
): Promise<Address> {
  const { PublicKey } = await import('@solana/web3.js');
  const dateBytes = Buffer.alloc(8);
  dateBytes.writeBigUInt64LE(entry.date);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('flight'), Buffer.from(entry.flightId, 'utf-8'), dateBytes],
    new PublicKey(oracleProgram),
  );
  return kitAddress(pda.toBase58());
}

async function deriveFlightPoolPda(
  flightPoolProgram: string,
  entry: ActiveFlightEntry,
): Promise<Address> {
  const { PublicKey } = await import('@solana/web3.js');
  const dateBytes = Buffer.alloc(8);
  dateBytes.writeBigUInt64LE(entry.date);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), Buffer.from(entry.flightId, 'utf-8'), dateBytes],
    new PublicKey(flightPoolProgram),
  );
  return kitAddress(pda.toBase58());
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const cluster = requireEnv('CLUSTER');
  const keeperKeypair = requireEnv('KEEPER_KEYPAIR');
  const rpcUrl = process.env.SOLANA_RPC_URL;

  const repoRoot = findRepoRoot();
  const solana = await createSolanaClient({
    cluster,
    repoRoot,
    keypairPath: keeperKeypair,
    rpcUrl,
  });

  console.log(
    `[run-classifier] cluster=${cluster} rpc=${solana.rpcUrl} ` +
      `keeper=${solana.signer.address}`,
  );

  await runClassifierOnce({
    solana,
    applyBatch: async (batch) => {
      const ixs = await buildClassifyBatchIx(solana, batch);
      if (ixs.length > 0) {
        await solana.sendIxs(ixs);
      }
    },
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[run-classifier] missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function findRepoRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let cur = start;
  for (let i = 0; i < 10; i++) {
    const pkg = resolve(cur, 'package.json');
    try {
      const txt = require('node:fs').readFileSync(pkg, 'utf-8');
      const parsed = JSON.parse(txt) as { name?: string };
      if (parsed.name === 'sentinel-solana') return cur;
    } catch {
      /* keep walking */
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

const isMain = /\/run-classifier\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[run-classifier] failed:', (err as Error).message ?? err);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  });
}

export { buildClassifyBatchIx, runClassifierOnce };
