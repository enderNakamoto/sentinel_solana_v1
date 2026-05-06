/**
 * executor/backends/cron/index.ts
 *
 * Phase 10 — node-cron backend wiring all 3 cron jobs into a single
 * deployable daemon. Schedules per `spec/architecture.md`:
 *
 *   FlightDataFetcher   — every 2h     `0 *\/2 * * *`
 *   FlightClassifier    — every 1h     `0 * * * *`
 *   SettlementExecutor  — every 5min   `*\/5 * * * *`
 *
 * Single shared SolanaClient + AeroApiClient + health server. Each
 * schedule's tick is wrapped in try/catch + updates the health state
 * regardless of outcome — orchestrators (Docker HEALTHCHECK, k8s probes)
 * can see stuck schedules via /health.
 *
 * Required env (mirrors the per-cron runners):
 *   CLUSTER          — surfpool | devnet | testnet | mainnet
 *   ORACLE_KEYPAIR   — path to authorized_oracle keypair
 *   KEEPER_KEYPAIR   — path to authorized_keeper keypair
 *   AEROAPI_KEY      — FlightAware AeroAPI key
 *
 * Optional env:
 *   SOLANA_RPC_URL    — overrides deployment artifact rpcUrl
 *   AEROAPI_BASE_URL  — overrides AeroAPI base
 *   HEALTH_PORT       — /health server port (default 8080)
 *   FETCHER_CRON      — overrides cron expression (default '0 *\/2 * * *')
 *   CLASSIFIER_CRON   — default '0 * * * *'
 *   SETTLER_CRON      — default '*\/5 * * * *'
 *   RUN_AT_BOOT       — '1' to fire each schedule once on startup before
 *                       waiting for the cron tick. Useful for testing.
 */

import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

import { createAeroApiClient } from '../../core/aeroapi_client.ts';
import { runFetcherOnce, decideFetcherActions } from '../../core/flight_data_fetcher.ts';
import { runClassifierOnce } from '../../core/flight_classifier.ts';
import { runSettlerOnce } from '../../core/settlement_executor.ts';
import { createSolanaClient } from '../../core/solana_client.ts';
import {
  emptyHealthState,
  recordTick,
  startHealthServer,
} from './health.ts';

import { actionToIxs as fetcherActionToIxs } from '../../scripts/run-fetcher.ts';
import { buildClassifyBatchIx } from '../../scripts/run-classifier.ts';
import { buildSettleBatchIxs, currentDay } from '../../scripts/run-settler.ts';

void decideFetcherActions; // re-export for convenience

const DEFAULT_FETCHER_CRON = '0 */2 * * *';
const DEFAULT_CLASSIFIER_CRON = '0 * * * *';
const DEFAULT_SETTLER_CRON = '*/5 * * * *';

async function main() {
  const cluster = requireEnv('CLUSTER');
  const oracleKeypair = requireEnv('ORACLE_KEYPAIR');
  const keeperKeypair = requireEnv('KEEPER_KEYPAIR');
  const aeroApiKey = requireEnv('AEROAPI_KEY');
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const aeroBaseUrl = process.env.AEROAPI_BASE_URL;
  const healthPort = Number(process.env.HEALTH_PORT ?? 8080);
  const runAtBoot = process.env.RUN_AT_BOOT === '1';
  const fetcherCron = process.env.FETCHER_CRON ?? DEFAULT_FETCHER_CRON;
  const classifierCron = process.env.CLASSIFIER_CRON ?? DEFAULT_CLASSIFIER_CRON;
  const settlerCron = process.env.SETTLER_CRON ?? DEFAULT_SETTLER_CRON;

  const repoRoot = findRepoRoot();

  // Two Solana clients — one for the oracle key, one for the keeper key.
  // They share the same RPC backend (`createSolanaRpc` returns a stateless
  // factory) but hold different signers.
  const oracleSolana = await createSolanaClient({
    cluster,
    repoRoot,
    keypairPath: oracleKeypair,
    rpcUrl,
  });
  const keeperSolana = await createSolanaClient({
    cluster,
    repoRoot,
    keypairPath: keeperKeypair,
    rpcUrl,
  });
  const aero = createAeroApiClient({ apiKey: aeroApiKey, baseUrl: aeroBaseUrl });

  console.log(`[cron] cluster=${cluster} rpc=${oracleSolana.rpcUrl}`);
  console.log(`[cron] oracle=${oracleSolana.signer.address}`);
  console.log(`[cron] keeper=${keeperSolana.signer.address}`);

  // Health endpoint.
  const health = emptyHealthState();
  const healthServer = startHealthServer(health, healthPort);
  console.log(`[cron] /health listening on :${healthServer.port}`);

  // ─── Tick functions ──────────────────────────────────────────────
  async function fetcherTick() {
    try {
      console.log('[cron] fetcher tick start');
      await runFetcherOnce({
        solana: oracleSolana,
        aero,
        applyAction: async (entry, action) => {
          const ixs = await fetcherActionToIxs(oracleSolana, entry, action);
          if (ixs.length > 0) await oracleSolana.sendIxs(ixs);
        },
      });
      recordTick(health, 'fetcher', 'ok');
    } catch (err) {
      console.error('[cron] fetcher tick failed:', (err as Error).message ?? err);
      recordTick(health, 'fetcher', 'failed');
    }
  }

  async function classifierTick() {
    try {
      console.log('[cron] classifier tick start');
      await runClassifierOnce({
        solana: keeperSolana,
        applyBatch: async (batch) => {
          const ixs = await buildClassifyBatchIx(keeperSolana, batch);
          if (ixs.length > 0) await keeperSolana.sendIxs(ixs);
        },
      });
      recordTick(health, 'classifier', 'ok');
    } catch (err) {
      console.error('[cron] classifier tick failed:', (err as Error).message ?? err);
      recordTick(health, 'classifier', 'failed');
    }
  }

  async function settlerTick() {
    try {
      console.log('[cron] settler tick start');
      const day = await currentDay(keeperSolana);
      await runSettlerOnce({
        solana: keeperSolana,
        applyBatch: async (batch, claimables) => {
          const ixs = await buildSettleBatchIxs(keeperSolana, batch, claimables, day);
          if (ixs.length > 0) await keeperSolana.sendIxs(ixs);
        },
      });
      recordTick(health, 'settler', 'ok');
    } catch (err) {
      console.error('[cron] settler tick failed:', (err as Error).message ?? err);
      recordTick(health, 'settler', 'failed');
    }
  }

  // ─── Schedule ────────────────────────────────────────────────────
  cron.schedule(fetcherCron, fetcherTick);
  console.log(`[cron] scheduled fetcher    at "${fetcherCron}"`);
  cron.schedule(classifierCron, classifierTick);
  console.log(`[cron] scheduled classifier at "${classifierCron}"`);
  cron.schedule(settlerCron, settlerTick);
  console.log(`[cron] scheduled settler    at "${settlerCron}"`);

  if (runAtBoot) {
    console.log('[cron] RUN_AT_BOOT=1 — firing all 3 schedules once now');
    await fetcherTick();
    await classifierTick();
    await settlerTick();
  }

  // Idle forever (node-cron keeps the event loop alive).
  console.log('[cron] daemon ready');

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    console.log(`[cron] received ${signal}; shutting down`);
    await healthServer.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[cron] missing env var: ${name}`);
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

// Detect entry: matches any of `cron/index`, `run-cron`, or any
// dist-bundled equivalent. The cron daemon may be invoked through the
// thin `executor/src/scripts/run-cron.ts` shim (which lets the shared
// `scripts/run.sh` wrapper bundle it) OR directly when running against
// the source via `node --import tsx index.ts` for ad-hoc debugging.
const argv1 = process.argv[1] ?? '';
const isMain =
  /\/(index|run-cron)\.(ts|mjs|js)$/.test(argv1) ||
  /\/cron\/index\.(ts|mjs|js)$/.test(argv1);

if (isMain) {
  main().catch((err) => {
    console.error('[cron] fatal:', (err as Error).message ?? err);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  });
}
