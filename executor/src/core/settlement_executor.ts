/**
 * executor/core/settlement_executor.ts
 *
 * Phase 10 — SettlementExecutor cron logic.
 *
 * Filters ActiveFlightList to flights in `ToBeSettled*` states, chunks
 * into MAX_FLIGHTS_PER_TX-sized batches, and (in the runner) calls
 * `controller.execute_settlements` per batch with claimable PDAs from
 * the withdrawal queue appended.
 *
 * The on-chain handler does the actual money movement + queue drain +
 * snapshot. The cron is just orchestration.
 */

import type { ActiveFlightEntry, SolanaClient } from './solana_client.ts';
import { FlightStatus } from './types.ts';
import { MAX_FLIGHTS_PER_TX } from './flight_classifier.ts';

export interface SettlementFlightView {
  entry: ActiveFlightEntry;
  status: FlightStatus;
}

/**
 * Pure batching function for settlement.
 *
 *   - Filters to entries in any `ToBeSettled` variant
 *     (OnTime / Delayed / Cancelled).
 *   - Drops everything else (Settled is past us; pre-classify states
 *     wait for the classifier first).
 *   - Chunks into batches of `maxPerTx` (default `MAX_FLIGHTS_PER_TX`).
 */
export function decideSettlementBatches(
  flights: SettlementFlightView[],
  maxPerTx: number = MAX_FLIGHTS_PER_TX,
): ActiveFlightEntry[][] {
  if (maxPerTx < 1) {
    throw new Error(`maxPerTx must be >= 1; got ${maxPerTx}`);
  }
  const settleable = flights
    .filter(
      (f) =>
        f.status === FlightStatus.ToBeSettledOnTime ||
        f.status === FlightStatus.ToBeSettledDelayed ||
        f.status === FlightStatus.ToBeSettledCancelled,
    )
    .map((f) => f.entry);

  const batches: ActiveFlightEntry[][] = [];
  for (let i = 0; i < settleable.length; i += maxPerTx) {
    batches.push(settleable.slice(i, i + maxPerTx));
  }
  return batches;
}

// ─── Runner orchestrator ─────────────────────────────────────────────────

import type { Address } from '@solana/kit';

export interface RunSettlerOnceOpts {
  solana: SolanaClient;
  /**
   * Called per batch. Runner-supplied implementation builds the
   * `execute_settlements` ix with the right `n_flights` arg + the
   * per-flight slice + the `claimables` suffix in remaining_accounts,
   * and submits.
   */
  applyBatch: (batch: ActiveFlightEntry[], claimables: Address[]) => Promise<void>;
  log?: (msg: string) => void;
  maxPerTx?: number;
  /**
   * If true, also fire one `execute_settlements` call with `n_flights=0`
   * when there are no settle-able flights but the withdrawal queue is
   * non-empty — runs the tail housekeeping (queue drain + snapshot)
   * without per-flight work. Default false (cron's other ticks already
   * exercise the queue when settling something).
   */
  runEmptyForHousekeeping?: boolean;
}

export interface RunSettlerOnceResult {
  totalFlights: number;
  settleable: number;
  batchesSent: number;
  batchesFailed: number;
  claimablesCount: number;
}

export async function runSettlerOnce(
  opts: RunSettlerOnceOpts,
): Promise<RunSettlerOnceResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const flights = await opts.solana.readActiveFlightList();
  log(`[settler] tick: ${flights.length} active flight(s) on chain`);

  const views: SettlementFlightView[] = await Promise.all(
    flights.map(async (entry) => {
      const status =
        (await opts.solana.readFlightDataStatus(entry.flightId, entry.date)) ??
        FlightStatus.NotInitiated;
      return { entry, status };
    }),
  );

  const batches = decideSettlementBatches(views, opts.maxPerTx);
  const settleable = batches.reduce((sum, b) => sum + b.length, 0);

  const claimables = await opts.solana.readWithdrawalQueueClaimables();
  log(
    `[settler] settleable: ${settleable} flight(s) in ${batches.length} batch(es); ` +
      `${claimables.length} queued withdrawal(s)`,
  );

  // Optional: fire a 0-flight tick if there's housekeeping to do but
  // nothing to settle. Not enabled by default — the every-5-min cadence
  // means a queued withdrawal gets credited within a few minutes of any
  // settlement event anyway.
  if (batches.length === 0) {
    if (opts.runEmptyForHousekeeping && claimables.length > 0) {
      log(`[settler] no flights to settle but ${claimables.length} claimables — running tail housekeeping tick`);
      try {
        await opts.applyBatch([], claimables);
        return {
          totalFlights: flights.length,
          settleable: 0,
          batchesSent: 1,
          batchesFailed: 0,
          claimablesCount: claimables.length,
        };
      } catch (err) {
        log(`[settler] housekeeping tick FAILED: ${(err as Error).message ?? err}`);
        return {
          totalFlights: flights.length,
          settleable: 0,
          batchesSent: 0,
          batchesFailed: 1,
          claimablesCount: claimables.length,
        };
      }
    }
    log(`[settler] tick complete: nothing to settle`);
    return {
      totalFlights: flights.length,
      settleable: 0,
      batchesSent: 0,
      batchesFailed: 0,
      claimablesCount: claimables.length,
    };
  }

  let batchesSent = 0;
  let batchesFailed = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const summary = batch.map((e) => `${e.flightId}@${e.date}`).join(', ');
    try {
      await opts.applyBatch(batch, claimables);
      log(`[settler] batch ${i + 1}/${batches.length} ✓ (${summary})`);
      batchesSent++;
    } catch (err) {
      log(
        `[settler] batch ${i + 1}/${batches.length} FAILED (${summary}): ${
          (err as Error).message ?? err
        }`,
      );
      batchesFailed++;
    }
  }

  log(
    `[settler] tick complete: ${batchesSent}/${batches.length} batch(es) sent, ${batchesFailed} failed`,
  );
  return {
    totalFlights: flights.length,
    settleable,
    batchesSent,
    batchesFailed,
    claimablesCount: claimables.length,
  };
}
