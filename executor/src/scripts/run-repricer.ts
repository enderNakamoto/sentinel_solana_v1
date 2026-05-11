/**
 * executor/scripts/run-repricer.ts
 *
 * Phase 25 — One-shot runner for the Phase 23 RouteRepricer cron.
 * Mirrors run-fetcher.ts / run-classifier.ts / run-settler.ts: loads
 * env, builds the Solana client + agent/grok clients, calls
 * `runRepricerOnce`, prints the result.
 *
 * Required env:
 *   CLUSTER          — surfpool | devnet | testnet | mainnet
 *   KEEPER_KEYPAIR   — path to the governance owner / deployer keypair
 *                      (the repricer signs governance ixs as the owner)
 *
 * One of:
 *   AGENT_BASE_URL   — live agent (Phase 22 FastAPI)
 *   AGENT_MOCK=1     — in-process agent stub (fixed premium)
 *
 * One of:
 *   XAI_API_KEY      — live Grok via xAI Live Search
 *   GROK_MOCK=1      — in-process Grok stub (pinned verdict)
 *
 * Optional env:
 *   SOLANA_RPC_URL          — overrides deployment artifact rpcUrl
 *   AGENT_MOCK_PREMIUM_USDC — default 2.5
 *   GROK_MOCK_VERDICT       — one of: ok | raise:1.5 | raise:2.0 | disable
 *   REPRICER_DRY_RUN=1      — decide actions but skip on-chain txs
 */

import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Address,
  type Instruction,
  type TransactionSigner,
  address as kitAddress,
} from '@solana/kit';

import {
  createAgentClient,
  createMockAgentClient,
  type AgentClient,
} from '../core/agent_client.ts';
import {
  createGrokClient,
  createMockGrokClient,
  type GrokClient,
} from '../core/grok_client.ts';
import {
  type RouteAction,
  runRepricerOnce,
} from '../core/route_repricer.ts';
import { createSolanaClient } from '../core/solana_client.ts';
import {
  GOVERNANCE_PROGRAM_ADDRESS,
  getDisableRouteInstructionAsync,
  getUpdateRouteTermsInstructionAsync,
  getWhitelistRouteInstructionAsync,
} from '../clients/governance/src/generated/index.ts';

// ─── Action → ix translator (exported for the daemon + server) ───────────
//
// Lifted verbatim from frontend/app/api/cron/repricer/trigger/route.ts so
// both the one-shot CLI here and the Express server in src/server.ts use
// the same Codama-translation layer. The Codama imports stay in the
// runner — `core/route_repricer.ts` remains Codama-import-free for
// clean unit testing.

export async function routeActionToIxs(
  action: RouteAction,
  caller: TransactionSigner,
): Promise<Instruction[]> {
  // Governance owner calls pass program_id as the "absent" admin_record
  // sentinel (Phase 1 D2). Codama would otherwise derive a real PDA.
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

  return [];
}

// ─── Client builders (shared with the Express trigger handlers) ──────────

export function resolveAgentMode(
  override: 'mock' | 'live' | null,
): 'mock' | 'live' | 'unconfigured' {
  if (override === 'mock' || override === 'live') return override;
  if (process.env.AGENT_MOCK === '1') return 'mock';
  if (process.env.AGENT_BASE_URL) return 'live';
  return 'unconfigured';
}

export function resolveGrokMode(
  override: 'mock' | 'live' | null,
): 'mock' | 'live' | 'unconfigured' {
  if (override === 'mock' || override === 'live') return override;
  if (process.env.GROK_MOCK === '1') return 'mock';
  if (process.env.XAI_API_KEY) return 'live';
  return 'unconfigured';
}

export function buildAgentClient(mode: 'mock' | 'live'): AgentClient {
  if (mode === 'mock') {
    const fixed = Number(process.env.AGENT_MOCK_PREMIUM_USDC ?? '2.5');
    return createMockAgentClient({ fixedPremiumUsdc: fixed });
  }
  if (!process.env.AGENT_BASE_URL) {
    throw new Error('Live agent mode requires AGENT_BASE_URL.');
  }
  return createAgentClient({ baseUrl: process.env.AGENT_BASE_URL });
}

export function buildGrokClient(mode: 'mock' | 'live'): GrokClient {
  if (mode === 'mock') {
    return createMockGrokClient({ verdict: process.env.GROK_MOCK_VERDICT });
  }
  if (!process.env.XAI_API_KEY) {
    throw new Error('Live Grok mode requires XAI_API_KEY.');
  }
  return createGrokClient({ apiKey: process.env.XAI_API_KEY });
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const cluster = requireEnv('CLUSTER');
  const keypairPath = requireEnv('KEEPER_KEYPAIR');
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const dryRun = process.env.REPRICER_DRY_RUN === '1';

  const agentMode = resolveAgentMode(null);
  const grokMode = resolveGrokMode(null);
  if (agentMode === 'unconfigured') {
    console.error(
      '[run-repricer] agent not configured: set AGENT_BASE_URL or AGENT_MOCK=1',
    );
    process.exit(1);
  }
  if (grokMode === 'unconfigured') {
    console.error(
      '[run-repricer] grok not configured: set XAI_API_KEY or GROK_MOCK=1',
    );
    process.exit(1);
  }

  const repoRoot = findRepoRoot();
  const solana = await createSolanaClient({
    cluster,
    repoRoot,
    keypairPath,
    rpcUrl,
  });
  const agent = buildAgentClient(agentMode);
  const grok = buildGrokClient(grokMode);

  console.log(
    `[run-repricer] cluster=${cluster} rpc=${solana.rpcUrl} signer=${solana.signer.address} ` +
      `agent=${agentMode} grok=${grokMode} dryRun=${dryRun}`,
  );

  // Pre-flight agent reachability in live mode.
  if (agentMode === 'live') {
    const health = await agent.healthz();
    if (!health.ok) {
      console.error(
        `[run-repricer] agent at ${process.env.AGENT_BASE_URL} unreachable: ${
          health.error ?? 'no model'
        }`,
      );
      process.exit(1);
    }
  }

  const result = await runRepricerOnce({
    rpc: solana.rpc,
    agent,
    grok,
    governanceProgramId: kitAddress(solana.deployment.programs.governance),
    recentDisablesByRepricer: new Set(),
    dryRun,
    applyAction: async (action) => {
      const ixs = await routeActionToIxs(action, solana.signer);
      if (ixs.length === 0) return '';
      return solana.sendIxs(ixs);
    },
  });

  console.log(
    `[run-repricer] done: ${result.histogram.noop} noop · ${result.histogram.update} update · ` +
      `${result.histogram.disable} disable · ${result.histogram.reenable} reenable`,
  );
  console.log(`[run-repricer] signatures: ${result.signatures.length}`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[run-repricer] missing env var: ${name}`);
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

const isMain = /\/run-repricer\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[run-repricer] failed:', (err as Error).message ?? err);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  });
}
