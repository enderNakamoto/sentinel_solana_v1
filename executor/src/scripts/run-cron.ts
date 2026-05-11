/**
 * executor/scripts/run-cron.ts
 *
 * Phase 25 — Render Web Service entry point. One Node process running:
 *   - Express HTTP server (/api/health, /api/logs, /api/config/:job,
 *     /api/trigger/:job) — see executor/src/server.ts
 *   - node-cron scheduler firing all four crons on schedule
 *
 * Both surfaces share the same `run_log` ring buffer and the same
 * `SolanaClient` (one keypair signs everything — the production model is
 * to run `pnpm rotate-keeper` + `pnpm rotate-oracle` so the deployer
 * keypair becomes the authority for both keeper and oracle CPIs).
 *
 * Required env:
 *   CLUSTER             — surfpool | devnet | testnet | mainnet
 *   One of:
 *     CRON_KEEPER_BASE58  — base58-encoded 64-byte secret key (Render)
 *     KEEPER_KEYPAIR      — path to keypair JSON (local)
 *
 * Optional env:
 *   SOLANA_RPC_URL      — overrides deployment artifact rpcUrl
 *   HEALTH_PORT         — Express server port (default 8080)
 *   AEROAPI_KEY         — enables fetcher live mode
 *   AEROAPI_MOCK=1      — forces fetcher mock mode
 *   AEROAPI_MOCK_SCENARIO=on_time|delayed|cancelled|scheduled|not_found
 *   XAI_API_KEY         — enables repricer Grok live mode
 *   GROK_MOCK=1         — forces repricer Grok mock mode
 *   GROK_MOCK_VERDICT=ok|raise:1.5|raise:2.0|disable
 *   AGENT_BASE_URL      — Phase 22 agent endpoint (live)
 *   AGENT_MOCK=1        — agent mock
 *   AGENT_MOCK_PREMIUM_USDC=2.5
 *   EXECUTOR_TRIGGER_SECRET — gate POST /api/trigger/*
 *   REPRICER_DRY_RUN=1  — decide actions but skip on-chain txs
 *
 *   FETCHER_CRON       — default '0 *\/2 * * *'
 *   CLASSIFIER_CRON    — default '0 * * * *'
 *   SETTLER_CRON       — default '*\/5 * * * *'
 *   REPRICER_CRON      — default '0 0 * * *' (daily 00:00 UTC)
 *   RUN_AT_BOOT=1      — fire all 4 schedules once on startup
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as dotenvConfig } from 'dotenv';
import { getBase58Encoder } from '@solana/kit';
import cron from 'node-cron';

// Load `executor/.env` regardless of CWD or bundling. Walks up from the
// current file location looking for `@sentinel/executor`'s package.json
// and reads `.env` from that directory. Falls back to dotenv's default
// (CWD `.env`) when not found — Render sets env vars in the dashboard,
// so a missing file is harmless there.
function loadExecutorEnv(): void {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = resolve(cur, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf-8')) as {
          name?: string;
        };
        if (parsed.name === '@sentinel/executor') {
          const envPath = resolve(cur, '.env');
          if (existsSync(envPath)) {
            dotenvConfig({ path: envPath });
            return;
          }
          break;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  dotenvConfig();
}
loadExecutorEnv();

import { createSolanaClient } from '../core/solana_client.ts';
import type { JobName } from '../core/types.ts';
import { buildServer, runJobTick } from '../server.ts';

// ─── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_FETCHER_CRON = '0 */2 * * *'; // every 2h
const DEFAULT_CLASSIFIER_CRON = '0 * * * *'; // every 1h
const DEFAULT_SETTLER_CRON = '*/5 * * * *'; // every 5min
const DEFAULT_REPRICER_CRON = '0 0 * * *'; // daily 00:00 UTC

// ─── Keypair loader (base58 → temp file, or explicit path) ──────────────

let cachedTempPath: string | null = null;

function resolveKeypairPath(): string {
  const base58 = process.env.CRON_KEEPER_BASE58;
  if (base58) {
    if (cachedTempPath && existsSync(cachedTempPath)) return cachedTempPath;
    const bytes = getBase58Encoder().encode(base58.trim());
    if (bytes.length !== 64) {
      throw new Error(
        `CRON_KEEPER_BASE58 must decode to 64 bytes (got ${bytes.length}).`,
      );
    }
    const dir = resolve(tmpdir(), 'sentinel-executor');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `keeper-${process.pid}.json`);
    writeFileSync(path, JSON.stringify(Array.from(bytes)));
    cachedTempPath = path;
    return path;
  }
  const explicit = process.env.KEEPER_KEYPAIR;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`KEEPER_KEYPAIR file not found: ${explicit}`);
    }
    return explicit;
  }
  throw new Error(
    'No signer configured. Set CRON_KEEPER_BASE58 or KEEPER_KEYPAIR.',
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const cluster = requireEnv('CLUSTER');
  const keypairPath = resolveKeypairPath();
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const healthPort = Number(process.env.HEALTH_PORT ?? 8080);
  const runAtBoot = process.env.RUN_AT_BOOT === '1';

  const schedules: Record<JobName, string> = {
    fetcher: process.env.FETCHER_CRON ?? DEFAULT_FETCHER_CRON,
    classifier: process.env.CLASSIFIER_CRON ?? DEFAULT_CLASSIFIER_CRON,
    settler: process.env.SETTLER_CRON ?? DEFAULT_SETTLER_CRON,
    repricer: process.env.REPRICER_CRON ?? DEFAULT_REPRICER_CRON,
  };

  const repoRoot = findRepoRoot();
  const solana = await createSolanaClient({
    cluster,
    repoRoot,
    keypairPath,
    rpcUrl,
  });

  console.log(
    `[executor] cluster=${cluster} rpc=${solana.rpcUrl} signer=${solana.signer.address}`,
  );

  // ─── Mount Express server ─────────────────────────────────────────
  const app = buildServer({ solana });
  const server = app.listen(healthPort, () => {
    console.log(`[executor] HTTP listening on :${healthPort}`);
    console.log(`  GET  /api/health`);
    console.log(`  GET  /api/logs[?cron=&limit=]`);
    console.log(`  GET  /api/config/:job`);
    console.log(`  POST /api/trigger/:job`);
  });

  // ─── Tick wrapper for the scheduler ──────────────────────────────
  // Scheduled ticks share `runJobTick` with manual triggers so both end
  // up in the same `run_log` buffer. No query overrides — schedules use
  // env defaults for mode/scenario/verdict.
  async function tick(job: JobName) {
    console.log(`[cron] ${job} tick start`);
    const entry = await runJobTick(job, { solana, query: {} });
    console.log(`[cron] ${job} tick done (ok=${entry.ok}): ${entry.summary}`);
  }

  // ─── Schedule ────────────────────────────────────────────────────
  cron.schedule(schedules.fetcher, () => void tick('fetcher'));
  console.log(`[cron] scheduled fetcher    at "${schedules.fetcher}"`);
  cron.schedule(schedules.classifier, () => void tick('classifier'));
  console.log(`[cron] scheduled classifier at "${schedules.classifier}"`);
  cron.schedule(schedules.settler, () => void tick('settler'));
  console.log(`[cron] scheduled settler    at "${schedules.settler}"`);
  cron.schedule(schedules.repricer, () => void tick('repricer'));
  console.log(`[cron] scheduled repricer   at "${schedules.repricer}"`);

  if (runAtBoot) {
    console.log('[cron] RUN_AT_BOOT=1 — firing all 4 schedules once now');
    await tick('fetcher');
    await tick('classifier');
    await tick('settler');
    await tick('repricer');
  }

  console.log('[executor] daemon ready');

  // ─── Graceful shutdown ──────────────────────────────────────────
  const shutdown = (signal: string) => {
    console.log(`[executor] received ${signal}; shutting down`);
    server.close(() => process.exit(0));
    // Hard exit after 5s if close() hangs.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[executor] missing env var: ${name}`);
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
      const txt = readFileSync(pkg, 'utf-8');
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

const isMain = /\/run-cron\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[executor] fatal:', (err as Error).message ?? err);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  });
}
