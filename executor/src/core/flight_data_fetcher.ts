/**
 * executor/core/flight_data_fetcher.ts
 *
 * Phase 8 — FlightDataFetcher cron logic.
 *
 * Two pieces:
 *   1. `decideFetcherActions` — pure function. Inputs: latest AeroAPI flight
 *      object + current on-chain FlightStatus. Output: a `FetcherAction`
 *      describing what tx (if any) to send. No RPC, no I/O — fully testable.
 *
 *   2. `runFetcherOnce` — runner. Reads the controller's ActiveFlightList
 *      from chain, fetches each flight from AeroAPI, calls
 *      `decideFetcherActions`, and submits the resulting ix(es) signed by
 *      the `authorized_oracle` keypair. Logs per-flight outcomes.
 *
 * Design constraints (from Phase 8 plan):
 *   - **No contract changes.** The state machine handles all cases via
 *     correct ix ordering.
 *   - **Boolean-only AeroAPI checks.** `cancelled` (boolean) and
 *     `actual_in !== null` (null-check). NEVER branch on the human-
 *     readable `status` string.
 *   - **Two-ix-in-one-tx for cancel/land-before-ETA.** If AeroAPI says
 *     cancelled or landed but on-chain is still NotInitiated, bundle
 *     `[set_estimated_arrival(scheduled_in), set_cancelled|set_landed]`
 *     in a single tx so the state machine traverses cleanly.
 *   - **ETA source = `scheduled_in`** (original published schedule), not
 *     `estimated_in` (airline's drifting running estimate). The classifier
 *     later computes `delay = actual - estimated` against `pool.delay_hours`,
 *     so what we write here defines the delay reference.
 */

import {
  type AeroFlight,
  type FetcherAction,
  FlightStatus,
  isoToUnixSec,
} from './types.ts';

// ─── 1. Pure decision function ───────────────────────────────────────────

/**
 * Decide what action (if any) the cron should take for one flight, given
 * the latest AeroAPI response and the current on-chain FlightStatus.
 *
 * Decision tree (boolean-only, status-string ignored):
 *
 *   if (currentStatus is terminal/post-Landed): skip (already past us)
 *
 *   if (cancelled):
 *     if (currentStatus == NotInitiated && scheduled_in present):
 *       → set_estimated_arrival_then_cancelled  (two-ix-in-one-tx)
 *     if (currentStatus == Active):
 *       → set_cancelled
 *     else: skip
 *
 *   if (actual_in !== null):
 *     if (currentStatus == NotInitiated && scheduled_in present):
 *       → set_estimated_arrival_then_landed  (two-ix-in-one-tx)
 *     if (currentStatus == Active):
 *       → set_landed
 *     else: skip
 *
 *   else (in-flight, unresolved):
 *     if (currentStatus == NotInitiated && scheduled_in present):
 *       → set_estimated_arrival
 *     else: skip (already on Active or no ETA available)
 */
export function decideFetcherActions(
  flight: AeroFlight,
  currentStatus: FlightStatus,
): FetcherAction {
  // (1) Terminal / post-Landed states — fetcher has nothing to do.
  if (
    currentStatus === FlightStatus.Landed ||
    currentStatus === FlightStatus.Cancelled ||
    currentStatus === FlightStatus.ToBeSettledOnTime ||
    currentStatus === FlightStatus.ToBeSettledDelayed ||
    currentStatus === FlightStatus.ToBeSettledCancelled ||
    currentStatus === FlightStatus.Settled
  ) {
    return { kind: 'skip', reason: `current status ${FlightStatus[currentStatus]} is terminal/past Landed` };
  }

  const etaUnixSec = isoToUnixSec(flight.scheduled_in);
  const actualUnixSec = isoToUnixSec(flight.actual_in);

  // (2) Cancelled branch. `cancelled` is the canonical boolean signal.
  if (flight.cancelled === true) {
    if (currentStatus === FlightStatus.NotInitiated) {
      if (etaUnixSec === null) {
        // Can't write set_estimated_arrival without an ETA, and the
        // contract requires Active before Cancelled. Skip + retry.
        return { kind: 'skip', reason: 'cancelled but no scheduled_in to seed ETA from NotInitiated' };
      }
      return { kind: 'set_estimated_arrival_then_cancelled', etaUnixSec };
    }
    if (currentStatus === FlightStatus.Active) {
      return { kind: 'set_cancelled' };
    }
    // Defensive: any other status (covered by the terminal check above)
    return { kind: 'skip', reason: `cancelled but unhandled current status ${FlightStatus[currentStatus]}` };
  }

  // (3) Landed branch. `actual_in !== null` is the boolean signal —
  //     ignore the human-readable `status` field entirely.
  if (actualUnixSec !== null) {
    if (currentStatus === FlightStatus.NotInitiated) {
      if (etaUnixSec === null) {
        return { kind: 'skip', reason: 'actual_in present but no scheduled_in to seed ETA from NotInitiated' };
      }
      return {
        kind: 'set_estimated_arrival_then_landed',
        etaUnixSec,
        actualArrivalUnixSec: actualUnixSec,
      };
    }
    if (currentStatus === FlightStatus.Active) {
      return { kind: 'set_landed', actualArrivalUnixSec: actualUnixSec };
    }
    return { kind: 'skip', reason: `actual_in present but unhandled current status ${FlightStatus[currentStatus]}` };
  }

  // (4) In-flight (not cancelled, not landed yet). The only useful work
  //     is seeding ETA on first tick — beyond that, wait for a state change.
  if (currentStatus === FlightStatus.NotInitiated) {
    if (etaUnixSec === null) {
      return { kind: 'skip', reason: 'NotInitiated and no scheduled_in available yet' };
    }
    return { kind: 'set_estimated_arrival', etaUnixSec };
  }

  // currentStatus === Active and flight is still in progress — nothing to do.
  return { kind: 'skip', reason: `in-flight (Active) and no resolution yet (cancelled=false, actual_in=null)` };
}

// ─── 2. Runner (RPC + AeroAPI orchestration) ─────────────────────────────
//
// The runner is intentionally separate from the decision function so that
// the decision logic can be unit-tested in isolation without spinning up
// any RPC clients or HTTP mocks beyond the AeroAPI shape itself.
//
// `runFetcherOnce` is the moral equivalent of one tick of the production
// 2-hour cron. It can be invoked from `executor/src/scripts/run-fetcher.ts`
// for manual operation or wrapped by the node-cron backend in Phase 10.

import type { AeroApiClient } from './aeroapi_client.ts';
import type { SolanaClient, ActiveFlightEntry } from './solana_client.ts';

export interface RunFetcherOnceOpts {
  solana: SolanaClient;
  aero: AeroApiClient;
  /**
   * Called per-flight. The runner provides the abstract action and the
   * Codama-translation layer (which lives in the runner script, not in
   * core, so the core stays Codama-import-free for unit testing) is
   * responsible for sending it.
   */
  applyAction: (entry: ActiveFlightEntry, action: FetcherAction) => Promise<void>;
  log?: (msg: string) => void;
}

export interface RunFetcherOnceResult {
  totalFlights: number;
  acted: number;
  skipped: number;
}

export async function runFetcherOnce(opts: RunFetcherOnceOpts): Promise<RunFetcherOnceResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const flights = await opts.solana.readActiveFlightList();
  log(`[fetcher] tick: ${flights.length} active flight(s) on chain`);

  let acted = 0;
  let skipped = 0;

  for (const entry of flights) {
    const dateIso = unixDayToIso(entry.date);
    const aeroFlights = await opts.aero.fetchFlightsForDay(entry.flightId, dateIso);
    if (aeroFlights === null || aeroFlights.length === 0) {
      log(`[fetcher] ${entry.flightId} ${dateIso}: AeroAPI null/empty — skip`);
      skipped++;
      continue;
    }
    const latest = aeroFlights[aeroFlights.length - 1];

    const onChain = await opts.solana.readFlightDataStatus(entry.flightId, entry.date);
    if (onChain === null) {
      log(`[fetcher] ${entry.flightId} ${dateIso}: FlightData PDA missing — skip`);
      skipped++;
      continue;
    }

    const action = decideFetcherActions(latest, onChain);
    if (action.kind === 'skip') {
      log(`[fetcher] ${entry.flightId} ${dateIso}: skip (${action.reason})`);
      skipped++;
      continue;
    }

    try {
      await opts.applyAction(entry, action);
      log(`[fetcher] ${entry.flightId} ${dateIso}: ${action.kind} ✓`);
      acted++;
    } catch (err) {
      log(
        `[fetcher] ${entry.flightId} ${dateIso}: ${action.kind} FAILED: ` +
          `${(err as Error).message ?? err}`,
      );
      skipped++;
    }
  }

  log(`[fetcher] tick complete: ${acted} acted, ${skipped} skipped, ${flights.length} total`);
  return { totalFlights: flights.length, acted, skipped };
}

/**
 * Convert the on-chain `FlightPool.date` field to an ISO `YYYY-MM-DD`
 * calendar date for AeroAPI.
 *
 * Two encodings are tolerated because the contract treats `date` as an
 * opaque PDA-seed component, and two callers chose differently:
 *   - Phase 11 e2e + bootstrap-test-actors: days-since-Unix-epoch
 *     (e.g. `20582`).
 *   - Frontend `/buy`: Unix seconds (e.g. `1778284800`).
 *
 * Threshold: any value above 1_000_000 is treated as seconds. 1M days
 * = year 4707; 1M seconds = Jan 12 1970. Both real-world flight dates
 * fall comfortably on opposite sides of this line.
 */
export function unixDayToIso(day: bigint): string {
  const n = Number(day);
  const ms = n > 1_000_000 ? n * 1000 : n * 86_400 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`unixDayToIso: bigint ${day} produced an invalid Date`);
  }
  return d.toISOString().slice(0, 10);
}
