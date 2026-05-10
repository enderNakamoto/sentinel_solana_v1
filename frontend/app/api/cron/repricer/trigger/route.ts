/**
 * POST /api/cron/repricer/trigger
 *
 * Phase 23 RouteRepricer cron — operator-triggered. Iterates every
 * whitelisted RouteAccount on the active cluster, calls the Phase 22
 * agent for a baseline premium per route, asks Grok (xAI Live Search)
 * for a geopolitical risk verdict, decides on a governance action, and
 * sends the resulting tx signed by the deployer.
 *
 * Query params:
 *   ?mode=mock|live   — overrides env (XAI_API_KEY/AGENT_BASE_URL → live; GROK_MOCK/AGENT_MOCK → mock)
 *   ?dryRun=1         — decide actions but skip applying them
 *
 * Response (200): { ok, durationMs, summary, signatures, decisions, histogram, dryRun, logs }
 * Response (400): unconfigured env or invalid params
 * Response (409): another tick already running
 * Response (503): agent unreachable in live mode
 *
 * Posture: public-unauth, same as the existing classifier/settler/fetcher
 * triggers. Document `X-CRON-TOKEN` shared-secret as a mainnet follow-up.
 */

import { NextResponse } from 'next/server';
import {
  type Address,
  type Instruction,
  type TransactionSigner,
  address as kitAddress,
} from '@solana/kit';

import { createSolanaClient } from '@executor/core/solana_client';
import {
  createAgentClient,
  createMockAgentClient,
  type AgentClient,
} from '@executor/core/agent_client';
import {
  createGrokClient,
  createMockGrokClient,
  type GrokClient,
} from '@executor/core/grok_client';
import {
  type RouteAction,
  runRepricerOnce,
} from '@executor/core/route_repricer';
import {
  GOVERNANCE_PROGRAM_ADDRESS,
  getDisableRouteInstructionAsync,
  getUpdateRouteTermsInstructionAsync,
  getWhitelistRouteInstructionAsync,
} from '@executor/clients/governance/src/generated/index';

import {
  appendRun,
  newRunId,
  readDisabledByRepricer,
  type CronRunRecord,
} from '@/lib/cron-runs';
import {
  activeCluster,
  repoRoot,
  resolveKeeperKeypairPath,
} from '@/lib/cron-keypair';

export const runtime = 'nodejs';

// ─── Per-cron mutex (process-local) ──────────────────────────────────────

const RUNNING = { repricer: false };

// ─── Mode resolution ─────────────────────────────────────────────────────

type ModeOverride = 'mock' | 'live' | null;

function isValidModeOverride(v: string | null): v is 'mock' | 'live' | null {
  return v === null || v === 'mock' || v === 'live';
}

function resolveAgentMode(override: ModeOverride): 'mock' | 'live' | 'unconfigured' {
  if (override === 'mock' || override === 'live') return override;
  if (process.env.AGENT_MOCK === '1') return 'mock';
  if (process.env.AGENT_BASE_URL) return 'live';
  return 'unconfigured';
}

function resolveGrokMode(override: ModeOverride): 'mock' | 'live' | 'unconfigured' {
  if (override === 'mock' || override === 'live') return override;
  if (process.env.GROK_MOCK === '1') return 'mock';
  if (process.env.XAI_API_KEY) return 'live';
  return 'unconfigured';
}

function buildAgentClient(mode: 'mock' | 'live'): AgentClient {
  if (mode === 'mock') {
    const fixed = Number(process.env.AGENT_MOCK_PREMIUM_USDC ?? '2.5');
    return createMockAgentClient({ fixedPremiumUsdc: fixed });
  }
  if (!process.env.AGENT_BASE_URL) {
    throw new Error(
      'Live agent mode requested but AGENT_BASE_URL is not set in frontend/.env.local.',
    );
  }
  return createAgentClient({ baseUrl: process.env.AGENT_BASE_URL });
}

function buildGrokClient(mode: 'mock' | 'live'): GrokClient {
  if (mode === 'mock') {
    return createMockGrokClient({ verdict: process.env.GROK_MOCK_VERDICT });
  }
  if (!process.env.XAI_API_KEY) {
    throw new Error(
      'Live Grok mode requested but XAI_API_KEY is not set in frontend/.env.local.',
    );
  }
  return createGrokClient({ apiKey: process.env.XAI_API_KEY });
}

// ─── Action → ix translator ──────────────────────────────────────────────
//
// The deployer is the governance owner. Every governance ix takes an
// optional `adminRecord` field — for owner calls we MUST pass
// GOVERNANCE_PROGRAM_ADDRESS as the "absent" sentinel (per Phase 1 D-Phase1
// memo). The async ix builders default to deriving an admin-record PDA
// which would not exist for the owner — so explicit absence is required.

async function routeActionToIxs(
  action: RouteAction,
  caller: TransactionSigner,
): Promise<Instruction[]> {
  const ABSENT_ADMIN: Address = GOVERNANCE_PROGRAM_ADDRESS as unknown as Address;

  switch (action.kind) {
    case 'noop':
      return [];

    case 'update_premium': {
      const ix = await getUpdateRouteTermsInstructionAsync({
        caller,
        adminRecord: ABSENT_ADMIN,
        flightId: action.flightId,
        origin: action.origin,
        destination: action.destination,
        premium: { __kind: 'Set', fields: [action.newPremiumBaseUnits] },
        payoff: { __kind: 'Keep' },
        delayHours: { __kind: 'Keep' },
      });
      return [ix as unknown as Instruction];
    }

    case 'disable': {
      const ix = await getDisableRouteInstructionAsync({
        caller,
        adminRecord: ABSENT_ADMIN,
        flightId: action.flightId,
        origin: action.origin,
        destination: action.destination,
      });
      return [ix as unknown as Instruction];
    }

    case 'reenable_with_terms': {
      // whitelist_route is idempotent — re-applying re-activates the
      // RouteAccount (approved=true) and writes the new premium override.
      // payoff/delayHours stay unchanged via null overrides on the call
      // site (Anchor's `Option<u64>` field with None) — the program
      // updates them only if the caller provides Some.
      const ix = await getWhitelistRouteInstructionAsync({
        caller,
        adminRecord: ABSENT_ADMIN,
        flightId: action.flightId,
        origin: action.origin,
        destination: action.destination,
        premium: action.newPremiumBaseUnits,
        payoff: null,
        delayHours: null,
      });
      return [ix as unknown as Instruction];
    }
  }

  // Exhaustive switch — TS doesn't always narrow well across module boundaries.
  return [];
}

// ─── Console capture (mirror of [id]/trigger/route.ts) ──────────────────

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
          args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
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

// ─── Route handler ───────────────────────────────────────────────────────

export async function POST(req: Request) {
  const url = new URL(req.url);
  const modeRaw = url.searchParams.get('mode');
  const dryRun =
    url.searchParams.get('dryRun') === '1' || process.env.REPRICER_DRY_RUN === '1';

  if (!isValidModeOverride(modeRaw)) {
    return NextResponse.json(
      { ok: false, error: `Invalid ?mode=${modeRaw} (allowed: mock | live).` },
      { status: 400 },
    );
  }
  const modeOverride: ModeOverride = modeRaw;

  const grokMode = resolveGrokMode(modeOverride);
  const agentMode = resolveAgentMode(modeOverride);

  if (grokMode === 'unconfigured') {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Repricer requires either XAI_API_KEY in frontend/.env.local (live mode) ' +
          'or ?mode=mock with GROK_MOCK=1 (mock mode, optional GROK_MOCK_VERDICT=ok|raise:1.5|disable).',
      },
      { status: 400 },
    );
  }
  if (agentMode === 'unconfigured') {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Repricer requires either AGENT_BASE_URL in frontend/.env.local (live agent) ' +
          'or AGENT_MOCK=1 (mock agent, optional AGENT_MOCK_PREMIUM_USDC=2.5).',
      },
      { status: 400 },
    );
  }

  if (RUNNING.repricer) {
    return NextResponse.json(
      { ok: false, error: 'Another repricer tick is already running.' },
      { status: 409 },
    );
  }
  RUNNING.repricer = true;

  const startedAt = new Date();
  const startedMs = Date.now();

  try {
    const cluster = activeCluster();
    const keypairPath = resolveKeeperKeypairPath();
    const agentClient = buildAgentClient(agentMode);
    const grokClient = buildGrokClient(grokMode);

    // Pre-flight agent reachability (live agent mode only).
    if (agentMode === 'live') {
      const health = await agentClient.healthz();
      if (!health.ok) {
        RUNNING.repricer = false;
        return NextResponse.json(
          {
            ok: false,
            error: `Agent at ${process.env.AGENT_BASE_URL} unreachable: ${
              health.error ?? 'no model'
            }`,
          },
          { status: 503 },
        );
      }
    }

    const { result, logs } = await captureConsole(async () => {
      const solana = await createSolanaClient({
        cluster,
        repoRoot: repoRoot(),
        keypairPath,
      });
      console.log(
        `[repricer] cluster=${cluster} rpc=${solana.rpcUrl} signer=${solana.signer.address} ` +
          `grok=${grokMode} agent=${agentMode} dryRun=${dryRun}`,
      );

      const recentDisables = readDisabledByRepricer();
      console.log(`[repricer] disabledByRepricer (recent runs): ${recentDisables.size}`);

      return runRepricerOnce({
        rpc: solana.rpc,
        agent: agentClient,
        grok: grokClient,
        governanceProgramId: kitAddress(solana.deployment.programs.governance),
        recentDisablesByRepricer: recentDisables,
        dryRun,
        applyAction: async (action) => {
          const ixs = await routeActionToIxs(action, solana.signer);
          if (ixs.length === 0) return ''; // noop never reaches here
          return solana.sendIxs(ixs);
        },
      });
    });

    const durationMs = Date.now() - startedMs;
    const histogram = result.histogram;
    const summaryHead =
      `${histogram.noop} noop · ${histogram.update} update · ` +
      `${histogram.disable} disable · ${histogram.reenable} reenable`;
    const summary =
      `${summaryHead}${dryRun ? ' (dry run)' : ''} · ${(durationMs / 1000).toFixed(1)}s`;

    const record: CronRunRecord = {
      id: newRunId(),
      cron: 'repricer',
      ts: startedAt.toISOString(),
      durationMs,
      ok: true,
      summary,
      signatures: result.signatures,
      logs,
      decisions: result.decisions,
      histogram,
      newlyDisabledPdas: result.newlyDisabledPdas,
      dryRun,
    };
    appendRun(record);

    return NextResponse.json({
      ok: true,
      durationMs,
      summary,
      signatures: result.signatures,
      decisions: result.decisions,
      histogram,
      newlyDisabledPdas: result.newlyDisabledPdas,
      dryRun,
      logs,
    });
  } catch (e) {
    const durationMs = Date.now() - startedMs;
    const error = conciseError(e);
    const logs = e instanceof Error && e.stack ? e.stack : String(e);
    const record: CronRunRecord = {
      id: newRunId(),
      cron: 'repricer',
      ts: startedAt.toISOString(),
      durationMs,
      ok: false,
      summary: error,
      signatures: [],
      logs,
      error,
    };
    appendRun(record);
    // eslint-disable-next-line no-console
    console.error('[cron/repricer] failed:', e);
    return NextResponse.json(
      { ok: false, durationMs, summary: error, error, logs },
      { status: 500 },
    );
  } finally {
    RUNNING.repricer = false;
  }
}
