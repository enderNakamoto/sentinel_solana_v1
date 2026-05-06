/**
 * executor/scripts/run-settler.ts
 *
 * Phase 10 — One-shot runner for the SettlementExecutor cron. Reads
 * ActiveFlightList + WithdrawalQueue, batches ToBeSettled* flights into
 * MAX_FLIGHTS_PER_TX-sized groups, calls `controller.execute_settlements`
 * per batch with the claimable PDAs as the trailing remaining_accounts.
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
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey as Web3Pubkey } from '@solana/web3.js';

import { runSettlerOnce } from '../core/settlement_executor.ts';
import {
  createSolanaClient,
  type ActiveFlightEntry,
  type SolanaClient,
} from '../core/solana_client.ts';
import { getExecuteSettlementsInstructionAsync } from '../clients/controller/src/generated/index.ts';

// ─── ComputeBudget helper ────────────────────────────────────────────────

const COMPUTE_BUDGET_PROGRAM: Address = kitAddress(
  'ComputeBudget111111111111111111111111111111',
);
function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 0x02;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

// ─── Snapshot day derivation ─────────────────────────────────────────────
//
// `vault.snapshot` derives a `SnapshotRecord` PDA via seed `[b"snapshot",
// day.to_le_bytes()]`. The cron must compute today's day index and pass it
// to `execute_settlements` so the controller's CPI to `vault.snapshot`
// references the right PDA.

async function currentDay(solana: SolanaClient): Promise<bigint> {
  const slot = await solana.rpc.getSlot().send();
  const blockTime = await solana.rpc.getBlockTime(slot).send();
  if (blockTime === null) {
    // Fallback: use wall clock. Surfpool occasionally returns null
    // immediately after startup.
    return BigInt(Math.floor(Date.now() / 1000 / 86_400));
  }
  return BigInt(Math.floor(Number(blockTime) / 86_400));
}

// ─── PDA derivations ─────────────────────────────────────────────────────

function deriveSnapshotRecordPda(
  vaultProgram: string,
  day: bigint,
): Address {
  const dayBytes = Buffer.alloc(8);
  dayBytes.writeBigUInt64LE(day);
  const [pda] = Web3Pubkey.findProgramAddressSync(
    [Buffer.from('snapshot'), dayBytes],
    new Web3Pubkey(vaultProgram),
  );
  return kitAddress(pda.toBase58());
}

function deriveFlightDataPdaSync(
  oracleProgram: string,
  entry: ActiveFlightEntry,
): Address {
  const dateBytes = Buffer.alloc(8);
  dateBytes.writeBigUInt64LE(entry.date);
  const [pda] = Web3Pubkey.findProgramAddressSync(
    [Buffer.from('flight'), Buffer.from(entry.flightId, 'utf-8'), dateBytes],
    new Web3Pubkey(oracleProgram),
  );
  return kitAddress(pda.toBase58());
}

function deriveFlightPoolPdaSync(
  flightPoolProgram: string,
  entry: ActiveFlightEntry,
): Address {
  const dateBytes = Buffer.alloc(8);
  dateBytes.writeBigUInt64LE(entry.date);
  const [pda] = Web3Pubkey.findProgramAddressSync(
    [Buffer.from('pool'), Buffer.from(entry.flightId, 'utf-8'), dateBytes],
    new Web3Pubkey(flightPoolProgram),
  );
  return kitAddress(pda.toBase58());
}

function deriveAtaSync(mint: string, owner: string): Address {
  const ata = getAssociatedTokenAddressSync(
    new Web3Pubkey(mint),
    new Web3Pubkey(owner),
    true, // allowOwnerOffCurve — vault PDA + treasury PDA are off-curve
  );
  return kitAddress(ata.toBase58());
}

// ─── Batch → ix translation ──────────────────────────────────────────────

const TOKEN_PROGRAM_ADDRESS_KIT: Address = kitAddress(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

async function buildSettleBatchIxs(
  solana: SolanaClient,
  batch: ActiveFlightEntry[],
  claimables: Address[],
  day: bigint,
): Promise<Instruction[]> {
  const dep = solana.deployment;
  const snapshotRecord = deriveSnapshotRecordPda(dep.programs.vault, day);
  const vaultTokenAccount = deriveAtaSync(dep.usdcMint, dep.pdas.vaultState);
  const poolTreasury = deriveAtaSync(dep.usdcMint, dep.pdas.poolTreasuryAuthority);

  const baseIx = await getExecuteSettlementsInstructionAsync({
    controllerConfig: kitAddress(dep.pdas.controllerConfig),
    activeFlightList: kitAddress(dep.pdas.activeFlightList),
    vaultProgram: kitAddress(dep.programs.vault),
    flightPoolProgram: kitAddress(dep.programs.flight_pool),
    oracleProgram: kitAddress(dep.programs.oracle_aggregator),
    flightPoolConfig: kitAddress(dep.pdas.flightPoolConfig),
    oracleConfig: kitAddress(dep.pdas.oracleConfig),
    vaultState: kitAddress(dep.pdas.vaultState),
    vaultTokenAccount,
    withdrawalQueue: kitAddress(dep.pdas.withdrawalQueue),
    shareMint: kitAddress(dep.pdas.shareMint),
    snapshotRecord,
    poolTreasury,
    treasuryAuthority: kitAddress(dep.pdas.poolTreasuryAuthority),
    keeper: solana.signer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS_KIT,
    day,
    nFlights: batch.length,
  });

  // remaining_accounts: [(FlightData WRITABLE, FlightPool WRITABLE) × n_flights, ClaimableBalance WRITABLE × m]
  const extra: { address: Address; role: AccountRole }[] = [];
  for (const entry of batch) {
    extra.push({
      address: deriveFlightDataPdaSync(dep.programs.oracle_aggregator, entry),
      role: AccountRole.WRITABLE,
    });
    extra.push({
      address: deriveFlightPoolPdaSync(dep.programs.flight_pool, entry),
      role: AccountRole.WRITABLE,
    });
  }
  for (const c of claimables) {
    extra.push({ address: c, role: AccountRole.WRITABLE });
  }

  const settleIx: Instruction = {
    ...baseIx,
    accounts: [...baseIx.accounts, ...extra],
  };
  return [setComputeUnitLimitIx(1_400_000), settleIx];
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
    `[run-settler] cluster=${cluster} rpc=${solana.rpcUrl} ` +
      `keeper=${solana.signer.address}`,
  );

  const day = await currentDay(solana);
  console.log(`[run-settler] day index = ${day}`);

  await runSettlerOnce({
    solana,
    applyBatch: async (batch, claimables) => {
      const ixs = await buildSettleBatchIxs(solana, batch, claimables, day);
      if (ixs.length > 0) {
        await solana.sendIxs(ixs);
      }
    },
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[run-settler] missing env var: ${name}`);
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

const isMain = /\/run-settler\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[run-settler] failed:', (err as Error).message ?? err);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  });
}

export { buildSettleBatchIxs, currentDay, runSettlerOnce };
