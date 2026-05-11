/**
 * POST /api/cron/[id]/trigger
 *
 * Operator-control endpoint for the Phase 17 cron control panel.
 * Wraps the Phase 9/10 `runClassifierOnce` and `runSettlerOnce` core
 * functions so the operator can fire a tick from the UI, capture
 * stdout into a JSONL log, and surface a one-line summary back to
 * `/crons`.
 *
 * Body: ignored (params come from the URL).
 * Response (200): { ok, durationMs, summary, signatures, logs }
 * Response (400): unknown id, including `fetcher` (Phase 18).
 * Response (409): another tick of the same cron is already running.
 *
 * Posture: public-unauth, same as `/api/faucet/mint`. Document
 * shared-secret hardening as a follow-up before mainnet.
 */

import { NextResponse } from 'next/server';
import {
  AccountRole,
  address as kitAddress,
  type Address,
  type Instruction,
} from '@solana/kit';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey as Web3Pubkey } from '@solana/web3.js';

import { runClassifierOnce } from '@executor/core/flight_classifier';
import { runSettlerOnce } from '@executor/core/settlement_executor';
import { runFetcherOnce } from '@executor/core/flight_data_fetcher';
import { createAeroApiClient, type AeroApiClient } from '@executor/core/aeroapi_client';
import {
  createSolanaClient,
  type ActiveFlightEntry,
  type SolanaClient,
} from '@executor/core/solana_client';
import {
  type AeroFlight,
  type FetcherAction,
  type DeploymentArtifact,
} from '@executor/core/types';
import { getClassifyFlightsInstructionAsync } from '@executor/clients/controller/src/generated/index';
import { getExecuteSettlementsInstructionAsync } from '@executor/clients/controller/src/generated/index';
import {
  getSetCancelledInstructionAsync,
  getSetEstimatedArrivalInstructionAsync,
  getSetLandedInstructionAsync,
} from '@executor/clients/oracle_aggregator/src/generated/index';

import {
  appendRun,
  newRunId,
  type CronId,
  type CronRunRecord,
} from '@/lib/cron-runs';
import {
  activeCluster,
  repoRoot,
  resolveKeeperKeypairPath,
} from '@/lib/cron-keypair';

export const runtime = 'nodejs';

// ─── Per-cron mutex (process-local) ──────────────────────────────────────

// Phase 23 added 'repricer' to CronId. The repricer trigger is a sibling
// route at /api/cron/repricer/trigger (NOT this one), so this map's
// 'repricer' slot is unused — present only to satisfy the typed Record.
const RUNNING: Record<CronId, boolean> = {
  classifier: false,
  settler: false,
  fetcher: false,
  repricer: false,
};

// ─── Compute-budget hand-roll ────────────────────────────────────────────

const COMPUTE_BUDGET_PROGRAM: Address = kitAddress(
  'ComputeBudget111111111111111111111111111111',
);
function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 0x02;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

// ─── PDA helpers (Codama-free, copied from run-classifier/run-settler) ──

function deriveFlightDataPda(
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

function deriveFlightPoolPda(
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

function deriveSnapshotRecordPda(vaultProgram: string, day: bigint): Address {
  const dayBytes = Buffer.alloc(8);
  dayBytes.writeBigUInt64LE(day);
  const [pda] = Web3Pubkey.findProgramAddressSync(
    [Buffer.from('snapshot'), dayBytes],
    new Web3Pubkey(vaultProgram),
  );
  return kitAddress(pda.toBase58());
}

function deriveAta(mint: string, owner: string): Address {
  const ata = getAssociatedTokenAddressSync(
    new Web3Pubkey(mint),
    new Web3Pubkey(owner),
    true,
  );
  return kitAddress(ata.toBase58());
}

const TOKEN_PROGRAM_ADDRESS_KIT: Address = kitAddress(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

// ─── Batch builders ──────────────────────────────────────────────────────

async function buildClassifyBatchIxs(
  solana: SolanaClient,
  batch: ActiveFlightEntry[],
): Promise<Instruction[]> {
  if (batch.length === 0) return [];
  const dep = solana.deployment;
  const baseIx = await getClassifyFlightsInstructionAsync({
    controllerConfig: kitAddress(dep.pdas.controllerConfig),
    oracleProgram: kitAddress(dep.programs.oracle_aggregator),
    oracleConfig: kitAddress(dep.pdas.oracleConfig),
    keeper: solana.signer,
  });
  const extra: { address: Address; role: AccountRole }[] = [];
  for (const entry of batch) {
    extra.push({
      address: deriveFlightDataPda(dep.programs.oracle_aggregator, entry),
      role: AccountRole.WRITABLE,
    });
    extra.push({
      address: deriveFlightPoolPda(dep.programs.flight_pool, entry),
      role: AccountRole.READONLY,
    });
  }
  return [
    setComputeUnitLimitIx(1_400_000),
    { ...baseIx, accounts: [...baseIx.accounts, ...extra] },
  ];
}

async function buildSettleBatchIxs(
  solana: SolanaClient,
  batch: ActiveFlightEntry[],
  claimables: Address[],
  day: bigint,
): Promise<Instruction[]> {
  const dep = solana.deployment;
  const snapshotRecord = deriveSnapshotRecordPda(dep.programs.vault, day);
  const vaultTokenAccount = deriveAta(dep.stableMint, dep.pdas.vaultState);
  const poolTreasury = deriveAta(dep.stableMint, dep.pdas.poolTreasuryAuthority);

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
    stableMint: kitAddress(dep.stableMint),
    keeper: solana.signer,
    stableTokenProgram: kitAddress('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
    day,
    nFlights: batch.length,
  });

  const extra: { address: Address; role: AccountRole }[] = [];
  for (const entry of batch) {
    extra.push({
      address: deriveFlightDataPda(dep.programs.oracle_aggregator, entry),
      role: AccountRole.WRITABLE,
    });
    extra.push({
      address: deriveFlightPoolPda(dep.programs.flight_pool, entry),
      role: AccountRole.WRITABLE,
    });
  }
  for (const c of claimables) {
    extra.push({ address: c, role: AccountRole.WRITABLE });
  }

  return [
    setComputeUnitLimitIx(1_400_000),
    { ...baseIx, accounts: [...baseIx.accounts, ...extra] },
  ];
}

// ─── Fetcher: AeroAPI client builder (live or mock) ──────────────────────
//
// Mock mode is first-class so hackathon demos don't burn FlightAware
// quota. Env knobs:
//   AEROAPI_MOCK=1                     → swap to in-process stub
//   AEROAPI_MOCK_SCENARIO=on_time      → one of:
//     on_time | delayed | cancelled | scheduled | not_found
//     (default: on_time)
// Real mode requires AEROAPI_KEY.
//
// The mock returns AeroFlight values whose `scheduled_in` / `actual_in`
// timestamps are anchored to the active flight's on-chain `date` (days
// since epoch, treated as noon UTC on that calendar day) so
// decideFetcherActions produces the matching FetcherAction without any
// hardcoded times. The on-chain forward-only state machine handles the
// pre-ETA vs post-ETA dispatch for cancellations.

export type MockScenario =
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

/**
 * Build a deterministic AeroFlight for a given (ident, date) under the
 * requested scenario. `dateIso` is `YYYY-MM-DD`; we anchor scheduled_in
 * at noon UTC on that day for stable timestamps.
 */
function mockFlightForScenario(
  ident: string,
  dateIso: string,
  scenario: MockScenario,
): AeroFlight | null {
  if (scenario === 'not_found') return null;

  const scheduledMs = Date.parse(`${dateIso}T12:00:00Z`);
  const scheduledIso = new Date(scheduledMs).toISOString();

  if (scenario === 'cancelled') {
    return {
      ident,
      cancelled: true,
      scheduled_in: scheduledIso,
      actual_in: null,
    };
  }
  if (scenario === 'scheduled') {
    return {
      ident,
      cancelled: false,
      scheduled_in: scheduledIso,
      actual_in: null,
    };
  }
  // on_time: actual ≈ scheduled (5 min early)
  // delayed: actual = scheduled + 2h (well past the 45-min threshold)
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

/**
 * Resolve the effective fetcher mode given an optional per-request
 * override and the env defaults. Precedence:
 *   1. explicit override ('mock' / 'live')
 *   2. AEROAPI_MOCK=1 → mock
 *   3. AEROAPI_KEY set → live
 *   4. neither → throw / 400
 */
export function resolveFetcherMode(
  override?: string | null,
): 'mock' | 'live' | 'unconfigured' {
  if (override === 'mock' || override === 'live') return override;
  if (process.env.AEROAPI_MOCK === '1') return 'mock';
  if (process.env.AEROAPI_KEY) return 'live';
  return 'unconfigured';
}

interface FetcherConfigResolved {
  client: AeroApiClient;
  mode: 'mock' | 'live';
  scenario?: MockScenario;
}

function buildAeroClient(opts?: {
  mode?: string | null;
  scenario?: string | null;
}): FetcherConfigResolved {
  const mode = resolveFetcherMode(opts?.mode);
  if (mode === 'unconfigured') {
    throw new Error(
      'Fetcher requires either AEROAPI_KEY (live mode) or AEROAPI_MOCK=1 ' +
        '(mock mode, optional AEROAPI_MOCK_SCENARIO=on_time|delayed|cancelled|scheduled|not_found).',
    );
  }

  if (mode === 'mock') {
    const scenario = readMockScenario(opts?.scenario);
    const client: AeroApiClient = {
      async fetchFlightsForDay(ident, dateIso) {
        const f = mockFlightForScenario(ident, dateIso, scenario);
        return f ? [f] : null;
      },
    };
    return { client, mode: 'mock', scenario };
  }

  // Live mode — explicit override or env default.
  const apiKey = process.env.AEROAPI_KEY;
  if (!apiKey) {
    throw new Error(
      'Live mode requires AEROAPI_KEY in env. Set it in frontend/.env.local ' +
        'and restart the dev server, or pass ?mode=mock for the in-process stub.',
    );
  }
  return { client: createAeroApiClient({ apiKey }), mode: 'live' };
}

// ─── Fetcher: action → instruction translator ────────────────────────────
//
// Lifted from executor/src/scripts/run-fetcher.ts. Same shape, same
// callsite — keeping it inline mirrors Phase 17's batch builders.

function deriveFlightDataPdaForFetcher(
  oracleProgram: string,
  entry: ActiveFlightEntry,
): Address {
  return deriveFlightDataPda(oracleProgram, entry);
}

async function fetcherActionToIxs(
  deployment: DeploymentArtifact,
  signer: SolanaClient['signer'],
  entry: ActiveFlightEntry,
  action: FetcherAction,
): Promise<Instruction[]> {
  const fdPda = deriveFlightDataPdaForFetcher(deployment.programs.oracle_aggregator, entry);
  switch (action.kind) {
    case 'skip':
      return [];
    case 'set_estimated_arrival':
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: fdPda,
          authority: signer,
          flightId: entry.flightId,
          date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
      ];
    case 'set_landed':
      return [
        (await getSetLandedInstructionAsync({
          flightData: fdPda,
          authority: signer,
          flightId: entry.flightId,
          date: entry.date,
          actualArrival: BigInt(action.actualArrivalUnixSec),
        })) as unknown as Instruction,
      ];
    case 'set_cancelled':
      return [
        (await getSetCancelledInstructionAsync({
          flightData: fdPda,
          authority: signer,
          flightId: entry.flightId,
          date: entry.date,
        })) as unknown as Instruction,
      ];
    case 'set_estimated_arrival_then_cancelled':
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: fdPda,
          authority: signer,
          flightId: entry.flightId,
          date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
        (await getSetCancelledInstructionAsync({
          flightData: fdPda,
          authority: signer,
          flightId: entry.flightId,
          date: entry.date,
        })) as unknown as Instruction,
      ];
    case 'set_estimated_arrival_then_landed':
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: fdPda,
          authority: signer,
          flightId: entry.flightId,
          date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
        (await getSetLandedInstructionAsync({
          flightData: fdPda,
          authority: signer,
          flightId: entry.flightId,
          date: entry.date,
          actualArrival: BigInt(action.actualArrivalUnixSec),
        })) as unknown as Instruction,
      ];
  }
}

async function currentDay(solana: SolanaClient): Promise<bigint> {
  try {
    const slot = await solana.rpc.getSlot().send();
    const blockTime = await solana.rpc.getBlockTime(slot).send();
    if (blockTime !== null) {
      return BigInt(Math.floor(Number(blockTime) / 86_400));
    }
  } catch {
    /* fall through */
  }
  return BigInt(Math.floor(Date.now() / 1000 / 86_400));
}

// ─── Concise error formatter ─────────────────────────────────────────────

function conciseError(e: unknown): string {
  if (e instanceof Error && e.message) {
    // Take the first non-empty line of the message; strip stack-frame
    // junk that comes after the first newline.
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

// ─── Console capture ─────────────────────────────────────────────────────

function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  const sink = (level: string) => (...args: unknown[]) => {
    lines.push(
      `[${level}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
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

// ─── Route handler ───────────────────────────────────────────────────────

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await params;
  const url = new URL(req.url);
  const modeOverride = url.searchParams.get('mode'); // 'mock' | 'live' | null
  const scenarioOverride = url.searchParams.get('scenario'); // mock scenario or null
  if (
    idParam !== 'classifier' &&
    idParam !== 'settler' &&
    idParam !== 'fetcher'
  ) {
    return NextResponse.json(
      { ok: false, error: `Unknown cron id: ${idParam}` },
      { status: 400 },
    );
  }
  const id: CronId = idParam;

  if (RUNNING[id]) {
    return NextResponse.json(
      { ok: false, error: `Another ${id} tick is already running.` },
      { status: 409 },
    );
  }
  // Pre-flight: fetcher needs AeroAPI env (or a per-request override).
  // Validate BEFORE acquiring the mutex so misconfig returns 400.
  if (id === 'fetcher') {
    if (modeOverride && modeOverride !== 'mock' && modeOverride !== 'live') {
      return NextResponse.json(
        { ok: false, error: `Invalid ?mode=${modeOverride} (allowed: mock | live).` },
        { status: 400 },
      );
    }
    const mode = resolveFetcherMode(modeOverride);
    if (mode === 'unconfigured') {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Fetcher requires either AEROAPI_KEY in frontend/.env.local (live mode) ' +
            'or ?mode=mock on the request URL (mock mode, optional ?scenario=on_time|' +
            'delayed|cancelled|scheduled|not_found).',
        },
        { status: 400 },
      );
    }
    if (mode === 'live' && !process.env.AEROAPI_KEY) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Live mode requested but AEROAPI_KEY is not set. Add it to ' +
            'frontend/.env.local and restart the dev server, or use ?mode=mock.',
        },
        { status: 400 },
      );
    }
  }

  RUNNING[id] = true;

  const startedAt = new Date();
  const startedMs = Date.now();

  try {
    const cluster = activeCluster();
    const keypairPath = resolveKeeperKeypairPath();

    const { result, logs } = await captureConsole(async () => {
      const solana = await createSolanaClient({
        cluster,
        repoRoot: repoRoot(),
        keypairPath,
      });

      console.log(
        `[${id}] cluster=${cluster} rpc=${solana.rpcUrl} keeper=${solana.signer.address}`,
      );

      const signatures: string[] = [];
      let acted = 0;
      let skipped = 0;

      if (id === 'classifier') {
        const r = await runClassifierOnce({
          solana,
          applyBatch: async (batch) => {
            const ixs = await buildClassifyBatchIxs(solana, batch);
            if (ixs.length > 0) {
              const sig = await solana.sendIxs(ixs);
              signatures.push(sig);
            }
          },
        });
        acted = r.classifiable;
        skipped = r.totalFlights - r.classifiable;
        return { signatures, summary: `${acted} acted, ${skipped} skipped` };
      } else if (id === 'settler') {
        const day = await currentDay(solana);
        console.log(`[settler] day index = ${day}`);
        const r = await runSettlerOnce({
          solana,
          applyBatch: async (batch, claimables) => {
            const ixs = await buildSettleBatchIxs(solana, batch, claimables, day);
            if (ixs.length > 0) {
              const sig = await solana.sendIxs(ixs);
              signatures.push(sig);
            }
          },
        });
        acted = r.settleable;
        skipped = r.totalFlights - r.settleable;
        return { signatures, summary: `${acted} acted, ${skipped} skipped` };
      } else {
        // id === 'fetcher'
        const aero = buildAeroClient({
          mode: modeOverride,
          scenario: scenarioOverride,
        });
        console.log(
          `[fetcher] aero mode=${aero.mode}` +
            (aero.scenario ? ` scenario=${aero.scenario}` : ''),
        );
        const r = await runFetcherOnce({
          solana,
          aero: aero.client,
          applyAction: async (entry, action) => {
            const ixs = await fetcherActionToIxs(
              solana.deployment,
              solana.signer,
              entry,
              action,
            );
            if (ixs.length > 0) {
              const sig = await solana.sendIxs(ixs);
              signatures.push(sig);
            }
          },
        });
        acted = r.acted;
        skipped = r.skipped;
        return { signatures, summary: `${acted} acted, ${skipped} skipped` };
      }
    });

    const durationMs = Date.now() - startedMs;
    const record: CronRunRecord = {
      id: newRunId(),
      cron: id,
      ts: startedAt.toISOString(),
      durationMs,
      ok: true,
      summary: `${result.summary} · ${(durationMs / 1000).toFixed(1)}s`,
      signatures: result.signatures,
      logs,
    };
    appendRun(record);
    return NextResponse.json({
      ok: true,
      durationMs,
      summary: record.summary,
      signatures: record.signatures,
      logs,
    });
  } catch (e) {
    const durationMs = Date.now() - startedMs;
    const error = conciseError(e);
    const logs =
      e instanceof Error && e.stack ? e.stack : String(e);
    const record: CronRunRecord = {
      id: newRunId(),
      cron: id,
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
    console.error(`[cron/${id}] failed:`, e);
    return NextResponse.json(
      { ok: false, durationMs, summary: error, error, logs },
      { status: 500 },
    );
  } finally {
    RUNNING[id] = false;
  }
}
