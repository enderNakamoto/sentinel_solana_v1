/**
 * Unit tests for the pure `decideSettlementBatches` function.
 *
 * Coverage:
 *   - empty input → []
 *   - all-skip (no ToBeSettled) → []
 *   - filters only ToBeSettled variants (OnTime/Delayed/Cancelled)
 *   - excludes Landed/Cancelled (those are pre-classify)
 *   - excludes Settled (already past us)
 *   - excludes NotInitiated/Active
 *   - chunking at MAX_FLIGHTS_PER_TX boundary
 *   - mix of all three ToBeSettled variants combined into one queue
 */

import { describe, it, expect } from 'vitest';
import {
  decideSettlementBatches,
  type SettlementFlightView,
} from '../src/core/settlement_executor.ts';
import { FlightStatus } from '../src/core/types.ts';

function v(flightId: string, date: number, status: FlightStatus): SettlementFlightView {
  return { entry: { flightId, date: BigInt(date) }, status };
}

describe('decideSettlementBatches — basic', () => {
  it('empty input returns []', () => {
    expect(decideSettlementBatches([])).toEqual([]);
  });

  it('all-skip (NotInitiated/Active/Landed/Cancelled/Settled) returns []', () => {
    const views = [
      v('A1', 1, FlightStatus.NotInitiated),
      v('A2', 1, FlightStatus.Active),
      v('A3', 1, FlightStatus.Landed),       // pre-classify, settler skips
      v('A4', 1, FlightStatus.Cancelled),    // pre-classify, settler skips
      v('A5', 1, FlightStatus.Settled),      // past, settler skips
    ];
    expect(decideSettlementBatches(views)).toEqual([]);
  });

  it('Landed alone does not get settled by the settler (must go through classifier first)', () => {
    expect(
      decideSettlementBatches([v('A1', 1, FlightStatus.Landed)]),
    ).toEqual([]);
  });
});

describe('decideSettlementBatches — ToBeSettled filtering', () => {
  it('ToBeSettledOnTime is settleable', () => {
    const batches = decideSettlementBatches([
      v('A1', 1, FlightStatus.ToBeSettledOnTime),
    ]);
    expect(batches.length).toBe(1);
    expect(batches[0][0].flightId).toBe('A1');
  });

  it('ToBeSettledDelayed is settleable', () => {
    const batches = decideSettlementBatches([
      v('A1', 1, FlightStatus.ToBeSettledDelayed),
    ]);
    expect(batches.length).toBe(1);
  });

  it('ToBeSettledCancelled is settleable', () => {
    const batches = decideSettlementBatches([
      v('A1', 1, FlightStatus.ToBeSettledCancelled),
    ]);
    expect(batches.length).toBe(1);
  });

  it('mix of all three ToBeSettled variants combined into one queue', () => {
    const views = [
      v('A1', 1, FlightStatus.ToBeSettledOnTime),
      v('A2', 1, FlightStatus.ToBeSettledDelayed),
      v('A3', 1, FlightStatus.ToBeSettledCancelled),
    ];
    const batches = decideSettlementBatches(views);
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
    expect(batches.flat().map((e) => e.flightId)).toEqual(['A1', 'A2', 'A3']);
  });

  it('preserves order across mixed-status filtering', () => {
    const views = [
      v('A1', 1, FlightStatus.Settled),                // skip
      v('A2', 1, FlightStatus.ToBeSettledDelayed),     // keep
      v('A3', 1, FlightStatus.Landed),                 // skip (pre-classify)
      v('A4', 1, FlightStatus.ToBeSettledOnTime),      // keep
    ];
    const batches = decideSettlementBatches(views);
    expect(batches.flat().map((e) => e.flightId)).toEqual(['A2', 'A4']);
  });
});

describe('decideSettlementBatches — chunking', () => {
  it('chunks at MAX_FLIGHTS_PER_TX boundary (3 → [2,1])', () => {
    const views = Array.from({ length: 3 }, (_, i) =>
      v(`A${i}`, 1, FlightStatus.ToBeSettledOnTime),
    );
    const batches = decideSettlementBatches(views);
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it('chunks 5 → [2,2,1]', () => {
    const views = Array.from({ length: 5 }, (_, i) =>
      v(`A${i}`, 1, FlightStatus.ToBeSettledDelayed),
    );
    const batches = decideSettlementBatches(views);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('custom maxPerTx=1 produces one-per-batch', () => {
    const views = Array.from({ length: 3 }, (_, i) =>
      v(`A${i}`, 1, FlightStatus.ToBeSettledOnTime),
    );
    const batches = decideSettlementBatches(views, 1);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
  });

  it('invalid maxPerTx throws', () => {
    expect(() => decideSettlementBatches([], 0)).toThrow();
  });
});
