/**
 * Unit tests for the pure `decideClassifierBatches` function.
 *
 * Coverage:
 *   - empty input → []
 *   - all-skip (no Landed/Cancelled) → []
 *   - single classifiable → 1 batch of size 1
 *   - mixed-status filtering preserves order, drops non-classifiable
 *   - batch chunking at boundary: 3 → [2,1], 4 → [2,2], 5 → [2,2,1]
 *   - custom maxPerTx
 *   - invalid maxPerTx throws
 */

import { describe, it, expect } from 'vitest';
import {
  decideClassifierBatches,
  MAX_FLIGHTS_PER_TX,
  type ClassifierFlightView,
} from '../src/core/flight_classifier.ts';
import { FlightStatus } from '../src/core/types.ts';

function v(flightId: string, date: number, status: FlightStatus): ClassifierFlightView {
  return { entry: { flightId, date: BigInt(date) }, status };
}

describe('decideClassifierBatches — basic', () => {
  it('empty input returns []', () => {
    expect(decideClassifierBatches([])).toEqual([]);
  });

  it('MAX_FLIGHTS_PER_TX matches the on-chain controller constant (=2)', () => {
    expect(MAX_FLIGHTS_PER_TX).toBe(2);
  });

  it('all-skip (NotInitiated/Active/Settled/ToBeSettled*) returns []', () => {
    const views = [
      v('AA1', 50000, FlightStatus.NotInitiated),
      v('AA2', 50000, FlightStatus.Active),
      v('AA3', 50000, FlightStatus.ToBeSettledOnTime),
      v('AA4', 50000, FlightStatus.ToBeSettledDelayed),
      v('AA5', 50000, FlightStatus.ToBeSettledCancelled),
      v('AA6', 50000, FlightStatus.Settled),
    ];
    expect(decideClassifierBatches(views)).toEqual([]);
  });

  it('single classifiable produces 1 batch of size 1', () => {
    const views = [v('AA1', 50000, FlightStatus.Landed)];
    const batches = decideClassifierBatches(views);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(1);
    expect(batches[0][0].flightId).toBe('AA1');
  });

  it('mixed-status filtering preserves order and drops non-classifiable', () => {
    const views = [
      v('AA1', 50000, FlightStatus.Active),     // skip
      v('AA2', 50000, FlightStatus.Landed),     // keep
      v('AA3', 50000, FlightStatus.NotInitiated), // skip
      v('AA4', 50000, FlightStatus.Cancelled),  // keep
      v('AA5', 50000, FlightStatus.Settled),    // skip
    ];
    const batches = decideClassifierBatches(views);
    expect(batches.length).toBe(1); // 2 entries, fits in one batch of 2
    expect(batches[0].map((e) => e.flightId)).toEqual(['AA2', 'AA4']);
  });
});

describe('decideClassifierBatches — chunking at MAX_FLIGHTS_PER_TX boundary', () => {
  it('3 classifiable → batches of 2,1', () => {
    const views = Array.from({ length: 3 }, (_, i) =>
      v(`AA${i}`, 50000, FlightStatus.Landed),
    );
    const batches = decideClassifierBatches(views);
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
    expect(batches[0].map((e) => e.flightId)).toEqual(['AA0', 'AA1']);
    expect(batches[1].map((e) => e.flightId)).toEqual(['AA2']);
  });

  it('4 classifiable → batches of 2,2', () => {
    const views = Array.from({ length: 4 }, (_, i) =>
      v(`AA${i}`, 50000, FlightStatus.Landed),
    );
    const batches = decideClassifierBatches(views);
    expect(batches.map((b) => b.length)).toEqual([2, 2]);
  });

  it('5 classifiable → batches of 2,2,1', () => {
    const views = Array.from({ length: 5 }, (_, i) =>
      v(`AA${i}`, 50000, FlightStatus.Landed),
    );
    const batches = decideClassifierBatches(views);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('mix of Landed and Cancelled is treated as one combined queue', () => {
    const views = [
      v('AA1', 50000, FlightStatus.Landed),
      v('AA2', 50000, FlightStatus.Cancelled),
      v('AA3', 50000, FlightStatus.Landed),
    ];
    const batches = decideClassifierBatches(views);
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
    expect(batches.flat().map((e) => e.flightId)).toEqual(['AA1', 'AA2', 'AA3']);
  });
});

describe('decideClassifierBatches — custom maxPerTx', () => {
  it('maxPerTx=1 produces one-per-batch chunks', () => {
    const views = [
      v('AA1', 50000, FlightStatus.Landed),
      v('AA2', 50000, FlightStatus.Landed),
      v('AA3', 50000, FlightStatus.Cancelled),
    ];
    const batches = decideClassifierBatches(views, 1);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
  });

  it('maxPerTx=10 keeps everything in one batch', () => {
    const views = Array.from({ length: 5 }, (_, i) =>
      v(`AA${i}`, 50000, FlightStatus.Landed),
    );
    const batches = decideClassifierBatches(views, 10);
    expect(batches.map((b) => b.length)).toEqual([5]);
  });

  it('maxPerTx < 1 throws', () => {
    expect(() => decideClassifierBatches([], 0)).toThrow();
    expect(() => decideClassifierBatches([], -1)).toThrow();
  });
});
