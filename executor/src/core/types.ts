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
  usdcMint: string;
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
