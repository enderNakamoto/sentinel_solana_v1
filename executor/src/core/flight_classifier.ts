/**
 * executor/core/flight_classifier.ts
 *
 * Phase 9 — FlightClassifier cron logic.
 *
 * No AeroAPI. The cron reads `ActiveFlightList` + each flight's on-chain
 * `FlightData.status`, filters to entries in `Landed`/`Cancelled`, and
 * batches them into `controller.classify_flights()` calls of ≤ MAX_FLIGHTS_PER_TX
 * (= 2 per the controller program). The on-chain handler does the
 * delay-vs-threshold calculation and writes `ToBeSettled*` via CPI to oracle.
 *
 * Decision logic = pure batching. Runner = RPC reads + per-batch ix call.
 */

import type { ActiveFlightEntry, SolanaClient } from './solana_client.ts';
import { FlightStatus } from './types.ts';

/**
 * Hard-coded to match the controller program's `MAX_FLIGHTS_PER_TX`
 * constant. Both must move together if either ever changes.
 */
export const MAX_FLIGHTS_PER_TX = 2;

export interface ClassifierFlightView {
  entry: ActiveFlightEntry;
  status: FlightStatus;
}

/**
 * Pure batching function — given a snapshot of flights with their on-chain
 * statuses, return the list of batches the runner should classify.
 *
 *   - Filters to entries in `Landed` or `Cancelled` (the only states
 *     `classify_flights` can transition to `ToBeSettled` variants).
 *   - Drops entries in any other state (NotInitiated/Active are not yet
 *     resolved; the `ToBeSettled` variants and Settled are already past
 *     us — both cases are no-ops in the on-chain handler too).
 *   - Chunks into batches of `maxPerTx` (default 2).
 *
 * Order is preserved (stable filter + slice).
 */
export function decideClassifierBatches(
  flights: ClassifierFlightView[],
  maxPerTx: number = MAX_FLIGHTS_PER_TX,
): ActiveFlightEntry[][] {
  if (maxPerTx < 1) {
    throw new Error(`maxPerTx must be >= 1; got ${maxPerTx}`);
  }
  const classifiable = flights
    .filter(
      (f) =>
        f.status === FlightStatus.Landed || f.status === FlightStatus.Cancelled,
    )
    .map((f) => f.entry);

  const batches: ActiveFlightEntry[][] = [];
  for (let i = 0; i < classifiable.length; i += maxPerTx) {
    batches.push(classifiable.slice(i, i + maxPerTx));
  }
  return batches;
}

// ─── Runner (impure: RPC reads + delegates per-batch ix dispatch) ────────

export interface RunClassifierOnceOpts {
  solana: SolanaClient;
  /**
   * Called per batch. The runner-supplied implementation builds the
   * `controller.classify_flights` ix with the right remaining_accounts
   * shape and submits via `solana.sendIxs(...)`. Throws bubble up to the
   * cron, which logs + continues to the next batch.
   */
  applyBatch: (batch: ActiveFlightEntry[]) => Promise<void>;
  log?: (msg: string) => void;
  /** Override `MAX_FLIGHTS_PER_TX` — useful for tests. */
  maxPerTx?: number;
}

export interface RunClassifierOnceResult {
  totalFlights: number;
  classifiable: number;
  batchesSent: number;
  batchesFailed: number;
}

export async function runClassifierOnce(
  opts: RunClassifierOnceOpts,
): Promise<RunClassifierOnceResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const flights = await opts.solana.readActiveFlightList();
  log(`[classifier] tick: ${flights.length} active flight(s) on chain`);

  // Read each flight's status in parallel — small fan-out (active list
  // expected to be short, MAX_FLIGHTS_PER_TX=2 caps per-tx work).
  const views: ClassifierFlightView[] = await Promise.all(
    flights.map(async (entry) => {
      const status =
        (await opts.solana.readFlightDataStatus(entry.flightId, entry.date)) ??
        FlightStatus.NotInitiated;
      return { entry, status };
    }),
  );

  const batches = decideClassifierBatches(views, opts.maxPerTx);
  const classifiable = batches.reduce((sum, b) => sum + b.length, 0);
  log(
    `[classifier] classifiable: ${classifiable} flight(s) in ${batches.length} batch(es)`,
  );

  let batchesSent = 0;
  let batchesFailed = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const summary = batch.map((e) => `${e.flightId}@${e.date}`).join(', ');
    try {
      await opts.applyBatch(batch);
      log(`[classifier] batch ${i + 1}/${batches.length} ✓ (${summary})`);
      batchesSent++;
    } catch (err) {
      log(
        `[classifier] batch ${i + 1}/${batches.length} FAILED (${summary}): ${
          (err as Error).message ?? err
        }`,
      );
      batchesFailed++;
    }
  }

  log(
    `[classifier] tick complete: ${batchesSent}/${batches.length} batch(es) sent, ${batchesFailed} failed`,
  );
  return {
    totalFlights: flights.length,
    classifiable,
    batchesSent,
    batchesFailed,
  };
}
