/**
 * executor/src/server.ts
 *
 * Phase 25 — Express HTTP surface for the cron daemon. Exposes:
 *
 *   GET  /api/health           — uptime + last run per job
 *   GET  /api/logs[?cron=&limit=]
 *                              — recent run records from the in-memory buffer
 *   GET  /api/config/:job      — per-cron config (liveAvailable, defaultMode, ...)
 *   POST /api/trigger/:job?mode=&scenario=&verdict=&dryRun=
 *                              — fire one tick for `job`, append to buffer, return entry
 *
 * Shared with the node-cron scheduler so scheduled + manual ticks land
 * in the same `run_log` buffer. The Vercel frontend proxies through to
 * this server — never runs the cron core fns itself.
 *
 * Auth: optional. If `EXECUTOR_TRIGGER_SECRET` is set, requests to
 * `POST /api/trigger/*` must carry `X-Trigger-Secret` with the matching
 * value. GET endpoints are always public (read-only).
 *
 * The factory `buildServer({ solana })` takes a single shared SolanaClient
 * — the daemon constructs it once at startup so every request reuses the
 * RPC + signer rather than rebuilding per tick.
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  AccountRole,
  address as kitAddress,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey as Web3Pubkey } from '@solana/web3.js';

import { runFetcherOnce } from './core/flight_data_fetcher.ts';
import { runClassifierOnce } from './core/flight_classifier.ts';
import { runSettlerOnce } from './core/settlement_executor.ts';
import { runRepricerOnce } from './core/route_repricer.ts';
import {
  createAeroApiClient,
  type AeroApiClient,
} from './core/aeroapi_client.ts';
import {
  FlightStatus,
  type AeroFlight,
  type JobName,
  type RunLogEntry,
} from './core/types.ts';
import type {
  ActiveFlightEntry,
  SolanaClient,
} from './core/solana_client.ts';
import {
  getHealth,
  logRun,
  newRunId,
  readDisabledByRepricer,
  readRecentRuns,
} from './core/run_log.ts';

import { actionToIxs as fetcherActionToIxs } from './scripts/run-fetcher.ts';
import { buildClassifyBatchIx } from './scripts/run-classifier.ts';
import {
  buildSettleBatchIxs,
  currentDay,
} from './scripts/run-settler.ts';
import {
  buildAgentClient,
  buildGrokClient,
  resolveAgentMode,
  resolveGrokMode,
  routeActionToIxs,
} from './scripts/run-repricer.ts';

// ─── Per-cron mutex (process-local) ──────────────────────────────────────

const RUNNING: Record<JobName, boolean> = {
  fetcher: false,
  classifier: false,
  settler: false,
  repricer: false,
};

const VALID_JOBS: ReadonlySet<JobName> = new Set([
  'fetcher',
  'classifier',
  'settler',
  'repricer',
]);

function isJob(s: string): s is JobName {
  return VALID_JOBS.has(s as JobName);
}

// ─── Console capture ─────────────────────────────────────────────────────

function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  const sink =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(
        `[${level}] ` +
          args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
      );
    };
  console.log = sink('log');
  console.info = sink('info');
  console.warn = sink('warn');
  console.error = sink('error');
  return fn()
    .then((result) => ({ result, logs: lines.join('\n') }))
    .finally(() => {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
    });
}

function conciseError(e: unknown): string {
  if (e instanceof Error && e.message) {
    const first = e.message.split('\n').find((s) => s.trim());
    return (first ?? 'Unknown error').slice(0, 240);
  }
  if (typeof e === 'string') return e.slice(0, 240);
  try {
    return JSON.stringify(e).slice(0, 240);
  } catch {
    return 'Unknown error';
  }
}

// ─── Fetcher: AeroAPI mock builder ───────────────────────────────────────
//
// Lifted from frontend/app/api/cron/[id]/trigger/route.ts. Mock mode lets
// hackathon demos run without burning FlightAware quota.

type MockScenario =
  | 'on_time'
  | 'delayed'
  | 'cancelled'
  | 'scheduled'
  | 'not_found';

const MOCK_SCENARIOS: readonly MockScenario[] = [
  'on_time',
  'delayed',
  'cancelled',
  'scheduled',
  'not_found',
];

function isMockScenario(v: string): v is MockScenario {
  return (MOCK_SCENARIOS as readonly string[]).includes(v);
}

function readMockScenario(override?: string | null): MockScenario {
  const raw = (override ?? process.env.AEROAPI_MOCK_SCENARIO ?? 'on_time').toLowerCase();
  return isMockScenario(raw) ? raw : 'on_time';
}

function mockFlightForScenario(
  ident: string,
  dateIso: string,
  scenario: MockScenario,
): AeroFlight | null {
  if (scenario === 'not_found') return null;
  const scheduledMs = Date.parse(`${dateIso}T12:00:00Z`);
  const scheduledIso = new Date(scheduledMs).toISOString();
  if (scenario === 'cancelled') {
    return { ident, cancelled: true, scheduled_in: scheduledIso, actual_in: null };
  }
  if (scenario === 'scheduled') {
    return { ident, cancelled: false, scheduled_in: scheduledIso, actual_in: null };
  }
  const actualOffsetMs =
    scenario === 'delayed' ? 2 * 60 * 60 * 1000 : -5 * 60 * 1000;
  const actualIso = new Date(scheduledMs + actualOffsetMs).toISOString();
  return {
    ident,
    cancelled: false,
    scheduled_in: scheduledIso,
    actual_in: actualIso,
  };
}

function resolveFetcherMode(
  override?: string | null,
): 'mock' | 'live' | 'unconfigured' {
  if (override === 'mock' || override === 'live') return override;
  if (process.env.AEROAPI_MOCK === '1') return 'mock';
  if (process.env.AEROAPI_KEY) return 'live';
  return 'unconfigured';
}

function buildAeroClient(opts: {
  mode?: string | null;
  scenario?: string | null;
}): { client: AeroApiClient; mode: 'mock' | 'live'; scenario?: MockScenario } {
  const mode = resolveFetcherMode(opts.mode);
  if (mode === 'unconfigured') {
    throw new Error(
      'Fetcher requires AEROAPI_KEY (live) or AEROAPI_MOCK=1 (mock).',
    );
  }
  if (mode === 'mock') {
    const scenario = readMockScenario(opts.scenario);
    const client: AeroApiClient = {
      async fetchFlightsForDay(ident, dateIso) {
        const f = mockFlightForScenario(ident, dateIso, scenario);
        return f ? [f] : null;
      },
    };
    return { client, mode: 'mock', scenario };
  }
  const apiKey = process.env.AEROAPI_KEY;
  if (!apiKey) throw new Error('Live mode requires AEROAPI_KEY.');
  return { client: createAeroApiClient({ apiKey }), mode: 'live' };
}

// ─── Per-job tick runners ────────────────────────────────────────────────

interface TickContext {
  solana: SolanaClient;
  query: {
    mode?: string | null;
    scenario?: string | null;
    verdict?: string | null;
    dryRun?: boolean;
  };
}

async function tickFetcher(ctx: TickContext) {
  const aero = buildAeroClient({
    mode: ctx.query.mode,
    scenario: ctx.query.scenario,
  });
  console.log(
    `[fetcher] aero mode=${aero.mode}${aero.scenario ? ` scenario=${aero.scenario}` : ''}`,
  );
  const signatures: string[] = [];
  const r = await runFetcherOnce({
    solana: ctx.solana,
    aero: aero.client,
    applyAction: async (entry, action) => {
      const ixs = await fetcherActionToIxs(ctx.solana, entry, action);
      if (ixs.length > 0) {
        const sig = await ctx.solana.sendIxs(ixs as Instruction[]);
        signatures.push(sig);
      }
    },
  });
  return {
    signatures,
    summary: `${r.acted} acted, ${r.skipped} skipped`,
    extras: {} as Partial<RunLogEntry>,
  };
}

async function tickClassifier(ctx: TickContext) {
  const signatures: string[] = [];
  const r = await runClassifierOnce({
    solana: ctx.solana,
    applyBatch: async (batch: ActiveFlightEntry[]) => {
      const ixs = await buildClassifyBatchIx(ctx.solana, batch);
      if (ixs.length > 0) {
        const sig = await ctx.solana.sendIxs(ixs);
        signatures.push(sig);
      }
    },
  });
  return {
    signatures,
    summary: `${r.classifiable} acted, ${r.totalFlights - r.classifiable} skipped`,
    extras: {} as Partial<RunLogEntry>,
  };
}

async function tickSettler(ctx: TickContext) {
  const day = await currentDay(ctx.solana);
  console.log(`[settler] day index = ${day}`);
  const signatures: string[] = [];
  const r = await runSettlerOnce({
    solana: ctx.solana,
    applyBatch: async (batch, claimables) => {
      const ixs = await buildSettleBatchIxs(ctx.solana, batch, claimables, day);
      if (ixs.length > 0) {
        const sig = await ctx.solana.sendIxs(ixs);
        signatures.push(sig);
      }
    },
  });
  return {
    signatures,
    summary: `${r.settleable} acted, ${r.totalFlights - r.settleable} skipped`,
    extras: {} as Partial<RunLogEntry>,
  };
}

async function tickRepricer(ctx: TickContext) {
  // Mode resolution per-request (the trigger UI flips mock/live).
  const modeOverride = (ctx.query.mode === 'mock' || ctx.query.mode === 'live')
    ? ctx.query.mode
    : null;
  const dryRun =
    ctx.query.dryRun === true || process.env.REPRICER_DRY_RUN === '1';

  const agentMode = resolveAgentMode(modeOverride);
  const grokMode = resolveGrokMode(modeOverride);
  if (agentMode === 'unconfigured') {
    throw new Error('Agent not configured (set AGENT_BASE_URL or AGENT_MOCK=1).');
  }
  if (grokMode === 'unconfigured') {
    throw new Error('Grok not configured (set XAI_API_KEY or GROK_MOCK=1).');
  }
  const agent = buildAgentClient(agentMode);
  const grok = buildGrokClient(grokMode);

  if (agentMode === 'live') {
    const health = await agent.healthz();
    if (!health.ok) {
      const err = new Error(
        `Agent at ${process.env.AGENT_BASE_URL} unreachable: ${
          health.error ?? 'no model'
        }`,
      );
      // Tagged so the route handler returns 503 instead of 500.
      (err as Error & { __status?: number }).__status = 503;
      throw err;
    }
  }

  console.log(
    `[repricer] agent=${agentMode} grok=${grokMode} dryRun=${dryRun}`,
  );

  const recentDisables = readDisabledByRepricer();
  console.log(
    `[repricer] disabledByRepricer (recent runs): ${recentDisables.size}`,
  );

  const result = await runRepricerOnce({
    rpc: ctx.solana.rpc,
    agent,
    grok,
    governanceProgramId: kitAddress(ctx.solana.deployment.programs.governance),
    recentDisablesByRepricer: recentDisables,
    dryRun,
    applyAction: async (action) => {
      const ixs = await routeActionToIxs(action, ctx.solana.signer);
      if (ixs.length === 0) return '';
      return ctx.solana.sendIxs(ixs);
    },
  });

  const h = result.histogram;
  const summary =
    `${h.noop} noop · ${h.update} update · ${h.disable} disable · ${h.reenable} reenable` +
    (dryRun ? ' (dry run)' : '');

  return {
    signatures: result.signatures,
    summary,
    extras: {
      decisions: result.decisions,
      histogram: result.histogram,
      newlyDisabledPdas: result.newlyDisabledPdas,
      dryRun,
    } as Partial<RunLogEntry>,
  };
}

const TICK_FNS: Record<JobName, (ctx: TickContext) => Promise<{
  signatures: string[];
  summary: string;
  extras: Partial<RunLogEntry>;
}>> = {
  fetcher: tickFetcher,
  classifier: tickClassifier,
  settler: tickSettler,
  repricer: tickRepricer,
};

/**
 * The shared tick runner used by both `POST /api/trigger/:job` and the
 * node-cron scheduler in `scripts/run-cron.ts`. Captures stdout into
 * the entry's `logs`, wraps in try/catch, calls `logRun`, returns the
 * entry. Caller decides what HTTP status (or no HTTP at all, for the
 * scheduler) to map onto the result.
 */
export async function runJobTick(
  job: JobName,
  ctx: TickContext,
): Promise<RunLogEntry> {
  const startedAt = new Date();
  const startedMs = Date.now();
  try {
    const { result, logs } = await captureConsole(() => TICK_FNS[job](ctx));
    const durationMs = Date.now() - startedMs;
    const entry: RunLogEntry = {
      id: newRunId(),
      cron: job,
      ts: startedAt.toISOString(),
      durationMs,
      ok: true,
      summary: `${result.summary} · ${(durationMs / 1000).toFixed(1)}s`,
      signatures: result.signatures,
      logs,
      ...result.extras,
    };
    logRun(entry);
    return entry;
  } catch (e) {
    const durationMs = Date.now() - startedMs;
    const error = conciseError(e);
    const logs = e instanceof Error && e.stack ? e.stack : String(e);
    const entry: RunLogEntry = {
      id: newRunId(),
      cron: job,
      ts: startedAt.toISOString(),
      durationMs,
      ok: false,
      summary: error,
      signatures: [],
      logs,
      error,
    };
    logRun(entry);
    if ((e as Error & { __status?: number }).__status) {
      (entry as RunLogEntry & { __status?: number }).__status = (
        e as Error & { __status?: number }
      ).__status;
    }
    return entry;
  }
}

// ─── Auth middleware (optional) ──────────────────────────────────────────

function triggerAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.EXECUTOR_TRIGGER_SECRET;
  if (!secret) {
    next();
    return;
  }
  const provided = req.header('X-Trigger-Secret');
  if (provided !== secret) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  next();
}

// ─── Server factory ──────────────────────────────────────────────────────

export interface BuildServerOpts {
  solana: SolanaClient;
}

export function buildServer(opts: BuildServerOpts): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // ─── GET /api/health ───
  app.get('/api/health', (_req, res) => {
    const health = getHealth();
    const allOk = (Object.keys(health.last_run) as JobName[]).every((k) => {
      const r = health.last_run[k];
      return r === null || r.ok === true;
    });
    res.status(allOk ? 200 : 503).json({ ok: allOk, ...health });
  });

  // ─── GET /api/logs ───
  app.get('/api/logs', (req, res) => {
    const cronParam = typeof req.query.cron === 'string' ? req.query.cron : null;
    const limitParam =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
    if (cronParam && !isJob(cronParam)) {
      res.status(400).json({ ok: false, error: `Unknown cron: ${cronParam}` });
      return;
    }
    if (!Number.isFinite(limitParam) || limitParam < 1 || limitParam > 100) {
      res.status(400).json({ ok: false, error: 'limit must be 1..100' });
      return;
    }
    const runs = readRecentRuns(
      cronParam as JobName | undefined,
      Math.floor(limitParam),
    );
    res.json({ ok: true, runs });
  });

  // ─── GET /api/config/:job ───
  app.get('/api/config/:job', (req, res) => {
    const job = req.params.job;
    if (!isJob(job)) {
      res.status(400).json({ ok: false, error: `Unknown job: ${job}` });
      return;
    }
    if (job === 'fetcher') {
      const liveAvailable = Boolean(process.env.AEROAPI_KEY);
      const envMockOn = process.env.AEROAPI_MOCK === '1';
      const defaultMode: 'mock' | 'live' =
        envMockOn ? 'mock' : liveAvailable ? 'live' : 'mock';
      const defaultScenario = (
        process.env.AEROAPI_MOCK_SCENARIO ?? 'on_time'
      ).toLowerCase();
      res.json({
        ok: true,
        job,
        liveAvailable,
        defaultMode,
        defaultScenario: isMockScenario(defaultScenario)
          ? defaultScenario
          : 'on_time',
        scenarios: MOCK_SCENARIOS,
      });
      return;
    }
    if (job === 'repricer') {
      const liveAvailable = Boolean(process.env.XAI_API_KEY);
      const grokMockOn = process.env.GROK_MOCK === '1';
      const agentMockOn = process.env.AGENT_MOCK === '1';
      const agentBaseUrl = process.env.AGENT_BASE_URL ?? '';
      const defaultMode: 'mock' | 'live' =
        grokMockOn || agentMockOn
          ? 'mock'
          : liveAvailable && agentBaseUrl
            ? 'live'
            : 'mock';
      // Probe agent reachability (1s timeout, never throws).
      probeAgent(agentBaseUrl)
        .then((agentReachable) =>
          res.json({
            ok: true,
            job,
            liveAvailable,
            agentReachable,
            agentBaseUrl: agentBaseUrl || null,
            defaultMode,
            defaultGrokVerdict: process.env.GROK_MOCK_VERDICT ?? 'ok',
            grokMockVerdicts: ['ok', 'raise:1.5', 'raise:2.0', 'disable'],
          }),
        )
        .catch(() => {
          res.json({
            ok: true,
            job,
            liveAvailable,
            agentReachable: false,
            agentBaseUrl: agentBaseUrl || null,
            defaultMode,
            defaultGrokVerdict: process.env.GROK_MOCK_VERDICT ?? 'ok',
            grokMockVerdicts: ['ok', 'raise:1.5', 'raise:2.0', 'disable'],
          });
        });
      return;
    }
    // classifier / settler — no live/mock toggle; just confirm they're available.
    res.json({
      ok: true,
      job,
      liveAvailable: true,
      defaultMode: 'live',
    });
  });

  // ─── GET /api/active-flights ───
  // Read-only RPC + decode. Used by the /crons UI to render the "next
  // tick would touch these" panel.
  app.get('/api/active-flights', async (_req, res) => {
    try {
      const entries = await opts.solana.readActiveFlightList();
      const flights = await Promise.all(
        entries.map(async (entry) => {
          const status =
            (await opts.solana.readFlightDataStatus(
              entry.flightId,
              entry.date,
            )) ?? FlightStatus.NotInitiated;
          return {
            flightId: entry.flightId,
            date: entry.date.toString(),
            status: FlightStatus[status] ?? `Unknown(${status})`,
          };
        }),
      );
      res.json({
        ok: true,
        cluster: opts.solana.deployment.cluster,
        rpcUrl: opts.solana.rpcUrl,
        count: flights.length,
        flights,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: message.slice(0, 240) });
    }
  });

  // ─── POST /api/trigger/:job ───
  app.post('/api/trigger/:job', triggerAuth, async (req, res) => {
    const job = req.params.job;
    if (!isJob(job)) {
      res.status(400).json({ ok: false, error: `Unknown job: ${job}` });
      return;
    }
    if (RUNNING[job]) {
      res
        .status(409)
        .json({ ok: false, error: `Another ${job} tick is already running.` });
      return;
    }
    RUNNING[job] = true;
    try {
      const entry = await runJobTick(job, {
        solana: opts.solana,
        query: {
          mode: typeof req.query.mode === 'string' ? req.query.mode : null,
          scenario:
            typeof req.query.scenario === 'string' ? req.query.scenario : null,
          verdict:
            typeof req.query.verdict === 'string' ? req.query.verdict : null,
          dryRun: req.query.dryRun === '1',
        },
      });
      const status = (entry as RunLogEntry & { __status?: number }).__status;
      delete (entry as RunLogEntry & { __status?: number }).__status;
      res.status(status ?? (entry.ok ? 200 : 500)).json(entry);
    } finally {
      RUNNING[job] = false;
    }
  });

  // ─── Fallback ───
  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  return app;
}

async function probeAgent(agentBaseUrl: string): Promise<boolean> {
  if (!agentBaseUrl) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const res = await fetch(
        `${agentBaseUrl.replace(/\/+$/, '')}/healthz`,
        { method: 'GET', signal: controller.signal },
      );
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// Silence unused-warning helpers (kept for parity with frontend route).
void AccountRole;
void getAssociatedTokenAddressSync;
void TOKEN_2022_PROGRAM_ID;
void Web3Pubkey;
void (kitAddress as unknown);
