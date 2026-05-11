/**
 * executor/core/types.ts
 *
 * Shared types for the off-chain cron stack (FlightDataFetcher,
 * FlightClassifier, SettlementExecutor). Kept narrow and dependency-free
 * so unit tests can exercise pure decision functions without spinning
 * up RPC clients or AeroAPI HTTP.
 *
 * The on-chain `FlightStatus` lives at `oracle_aggregator/src/lib.rs`
 * and is regenerated into `executor/src/clients/oracle_aggregator/...`
 * via Codama. This file mirrors the discriminant values so pure
 * functions can compare without importing the Codama-generated module.
 */

/**
 * Mirrors `oracle_aggregator::FlightStatus`. Numeric values match the
 * on-chain Borsh discriminants 0..7.
 */
export enum FlightStatus {
  NotInitiated = 0,
  Active = 1,
  Landed = 2,
  Cancelled = 3,
  ToBeSettledOnTime = 4,
  ToBeSettledDelayed = 5,
  ToBeSettledCancelled = 6,
  Settled = 7,
}

// ─── AeroAPI response types ──────────────────────────────────────────────
//
// Captures only the fields the cron actually reads. Everything else from
// the FlightAware response is allowed via the `[key: string]: unknown`
// index signature, but never branched on. This keeps the cron resilient
// to upstream schema additions.

export interface AeroAirport {
  code: string;
  code_icao?: string;
  code_iata?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Minimum subset of FlightAware AeroAPI's flight object the cron reads.
 * Boolean + null-checkable fields ONLY — we never branch on the
 * human-readable `status` string per the Phase 8 design constraints.
 */
export interface AeroFlight {
  ident: string;
  ident_icao?: string;
  ident_iata?: string;
  /** True if the flight was cancelled — primary cancel signal. */
  cancelled: boolean;
  /** True if the flight was diverted — out of scope for Phase 8 (treat as in-progress). */
  diverted?: boolean;
  /**
   * Original published gate-arrival time (ISO 8601 UTC).
   * The cron writes this as `estimated_arrival_time` on-chain — the
   * "passenger-experience" delay reference, not the airline's running
   * estimate (`estimated_in`).
   */
  scheduled_in: string | null;
  /** Airline's current estimate — read for sanity, NOT written on-chain. */
  estimated_in?: string | null;
  /**
   * Actual gate-arrival time (ISO 8601 UTC).
   * Non-null = flight has arrived at the gate. Null = still in progress
   * or never arrived.
   */
  actual_in: string | null;
  origin?: AeroAirport;
  destination?: AeroAirport;
  [key: string]: unknown;
}

export interface AeroFlightsResponse {
  flights: AeroFlight[];
  num_pages?: number;
  links?: { next?: string };
  [key: string]: unknown;
}

/**
 * AeroAPI 4xx error envelope. Returned by the API on bad requests
 * (invalid params, unknown ident, expired key, rate limit, etc.).
 *
 * Shape per FlightAware docs:
 *   { "title": "string", "reason": "string", "detail": "string", "status": 0 }
 *
 * The `status` field on the envelope mirrors the HTTP status code; we
 * use it for redundancy when logging — operators can correlate the
 * envelope's `reason` with the rate-limit / quota / auth diagnosis.
 */
export interface AeroApiError {
  title: string;
  reason: string;
  detail: string;
  status: number;
}

// ─── Cron decision types ─────────────────────────────────────────────────
//
// `FetcherAction` represents the abstract action the fetcher decided to
// take — independent of the on-chain ix encoding. The runner module then
// translates these into actual Codama-generated instructions and sends
// them. Keeping it as data (not closures) makes the decision function
// pure and trivially testable.

export type FetcherAction =
  | { kind: 'skip'; reason: string }
  | { kind: 'set_estimated_arrival'; etaUnixSec: number }
  | { kind: 'set_landed'; actualArrivalUnixSec: number }
  | { kind: 'set_cancelled' }
  /**
   * Atomic transition NotInitiated → Active → Cancelled in one tx
   * (cancel-before-ETA edge case). The runner submits both ixs in a
   * single transaction so the state machine traverses cleanly.
   */
  | { kind: 'set_estimated_arrival_then_cancelled'; etaUnixSec: number }
  /**
   * Atomic transition NotInitiated → Active → Landed in one tx
   * (land-before-ETA edge case).
   */
  | { kind: 'set_estimated_arrival_then_landed'; etaUnixSec: number; actualArrivalUnixSec: number };

// ─── Deployment artifact shape ───────────────────────────────────────────
//
// Mirrors what `scripts/deploy.ts` writes to
// `deployments/<cluster>-latest.json`. The cron loads this at startup
// to know program IDs + config PDAs without re-deriving them.

export interface DeploymentArtifact {
  cluster: string;
  rpcUrl: string;
  deployer: string;
  owner: string;
  authorities: { oracle: string; keeper: string };
  keypairPaths: { oracle: string | null; keeper: string | null };
  stableMint: string;
  programs: {
    governance: string;
    vault: string;
    oracle_aggregator: string;
    flight_pool: string;
    controller: string;
  };
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
  deployedAt: string;
  deployedAtUnix: number;
}

/**
 * Convert an ISO 8601 UTC timestamp to Unix seconds. Returns null if the
 * input is null/undefined or not a valid date.
 */
export function isoToUnixSec(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

// ─── Phase 25 — In-memory ring-buffer log types ──────────────────────────
//
// The executor holds the last MAX_ENTRIES runs per job in module-scope
// state (see `core/run_log.ts`). Frontend reads this via the Express
// surface and renders the existing `/crons` activity feed unchanged —
// so the entry shape mirrors frontend's `CronRunRecord` field-for-field.
// Restart wipes history (D-Phase25-3); audit lives on chain.

/** The four crons that run inside the Render Web Service. */
export type JobName = 'fetcher' | 'classifier' | 'settler' | 'repricer';

/**
 * Per-route decision detail recorded by the repricer cron. Mirrors
 * frontend `RepricerDecision` shape so JSON moves through the proxy
 * verbatim. The `action` field is the SerializedRouteAction from
 * route_repricer.ts (bigints stringified).
 */
export interface RepricerDecisionRecord {
  routePda: string;
  flightId: string;
  origin: string;
  destination: string;
  carrier: string;
  baselinePremiumBaseUnits: string;
  baselinePremiumUsdc: number;
  grokAction: string;
  grokMultiplier: number;
  grokReason: string;
  action: unknown;
  txSignature?: string;
  error?: string;
}

/**
 * One entry per cron tick. Matches frontend's `CronRunRecord` 1:1 so the
 * `/crons` UI renders both manual triggers and scheduled ticks from the
 * same shape — the proxy is a pure pass-through.
 */
export interface RunLogEntry {
  /** Random per-record id for stable UI keys. */
  id: string;
  /** Which cron produced this record. */
  cron: JobName;
  /** ISO timestamp at tick start. */
  ts: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True if every batch landed; false on any failure or pre-flight error. */
  ok: boolean;
  /**
   * Single concise human-readable line. The activity feed renders this
   * by default:
   *   - OK:       "3 acted, 5 skipped · 1.2s"
   *   - repricer: "5 noop · 2 update · 1 disable · 0 reenable · 0.8s"
   *   - FAILED:   "tx failed: insufficient funds for rent"
   */
  summary: string;
  /** Tx signatures that landed during this tick. */
  signatures: string[];
  /** Captured stdout, newline-joined. Used by the "View log" details. */
  logs: string;
  /** Concise error message when ok=false. */
  error?: string;

  // ─── Repricer-specific fields (optional on every record) ─────────
  decisions?: RepricerDecisionRecord[];
  histogram?: { noop: number; update: number; disable: number; reenable: number };
  newlyDisabledPdas?: string[];
  dryRun?: boolean;
}

/** Returned by `GET /api/health`. */
export interface HealthStatus {
  uptime_seconds: number;
  started_at: string;
  last_run: Record<JobName, RunLogEntry | null>;
}

/** Returned by `GET /api/config/:job`. Shape mirrors the previous frontend config endpoints. */
export interface JobConfigStatus {
  ok: true;
  job: JobName;
  /** True when this cron has the env vars to run in live mode. */
  liveAvailable: boolean;
  /** Default mode the executor would pick if no `?mode=` is passed. */
  defaultMode: 'mock' | 'live';
  /** Fetcher only: default mock scenario. */
  defaultScenario?: string;
  /** Fetcher only: enumerated scenarios. */
  scenarios?: readonly string[];
  /** Repricer only: agent reachability + base URL. */
  agentReachable?: boolean;
  agentBaseUrl?: string | null;
  /** Repricer only: default grok mock verdict. */
  defaultGrokVerdict?: string;
  grokMockVerdicts?: readonly string[];
}
