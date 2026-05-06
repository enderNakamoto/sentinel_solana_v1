/**
 * Unit tests for the pure `decideFetcherActions` function.
 *
 * These verify the boolean-only AeroAPI → on-chain decision tree without
 * any RPC or network — the function takes (AeroFlight, FlightStatus) and
 * returns a FetcherAction. No surfpool, no mocks needed.
 *
 * Coverage:
 *   - cancelled-from-Active → set_cancelled
 *   - cancelled-from-NotInitiated (with scheduled_in) → two-ix-in-one-tx
 *   - cancelled-from-NotInitiated (no scheduled_in) → skip
 *   - landed-from-Active → set_landed
 *   - landed-from-NotInitiated (with scheduled_in) → two-ix-in-one-tx
 *   - landed-from-NotInitiated (no scheduled_in) → skip
 *   - in-flight, NotInitiated, scheduled_in present → set_estimated_arrival
 *   - in-flight, NotInitiated, no scheduled_in → skip
 *   - in-flight, Active → skip (wait for resolution)
 *   - already past Landed (Landed/Cancelled/Settled/ToBeSettled*) → skip
 *   - status-string is ignored — using only boolean fields
 */

import { describe, it, expect } from 'vitest';
import { decideFetcherActions } from '../src/core/flight_data_fetcher.ts';
import { FlightStatus, type AeroFlight } from '../src/core/types.ts';

const SCHEDULED_IN = '2026-06-15T18:00:00Z';
const ACTUAL_IN = '2026-06-15T18:30:00Z';
const SCHEDULED_UNIX = Math.floor(Date.parse(SCHEDULED_IN) / 1000);
const ACTUAL_UNIX = Math.floor(Date.parse(ACTUAL_IN) / 1000);

function flight(overrides: Partial<AeroFlight> = {}): AeroFlight {
  return {
    ident: 'AA100',
    cancelled: false,
    scheduled_in: SCHEDULED_IN,
    actual_in: null,
    // status field present but should be ignored — set to a misleading value to prove it.
    status: 'Diverted-or-something-misleading',
    ...overrides,
  } as AeroFlight;
}

describe('decideFetcherActions — cancelled branch', () => {
  it('cancelled-from-Active → set_cancelled', () => {
    const action = decideFetcherActions(flight({ cancelled: true }), FlightStatus.Active);
    expect(action).toEqual({ kind: 'set_cancelled' });
  });

  it('cancelled-from-NotInitiated (with scheduled_in) → set_estimated_arrival_then_cancelled', () => {
    const action = decideFetcherActions(
      flight({ cancelled: true }),
      FlightStatus.NotInitiated,
    );
    expect(action).toEqual({
      kind: 'set_estimated_arrival_then_cancelled',
      etaUnixSec: SCHEDULED_UNIX,
    });
  });

  it('cancelled-from-NotInitiated (no scheduled_in) → skip', () => {
    const action = decideFetcherActions(
      flight({ cancelled: true, scheduled_in: null }),
      FlightStatus.NotInitiated,
    );
    expect(action.kind).toBe('skip');
  });
});

describe('decideFetcherActions — landed branch', () => {
  it('landed-from-Active → set_landed with actual_arrival', () => {
    const action = decideFetcherActions(
      flight({ actual_in: ACTUAL_IN }),
      FlightStatus.Active,
    );
    expect(action).toEqual({
      kind: 'set_landed',
      actualArrivalUnixSec: ACTUAL_UNIX,
    });
  });

  it('landed-from-NotInitiated (with scheduled_in) → set_estimated_arrival_then_landed', () => {
    const action = decideFetcherActions(
      flight({ actual_in: ACTUAL_IN }),
      FlightStatus.NotInitiated,
    );
    expect(action).toEqual({
      kind: 'set_estimated_arrival_then_landed',
      etaUnixSec: SCHEDULED_UNIX,
      actualArrivalUnixSec: ACTUAL_UNIX,
    });
  });

  it('landed-from-NotInitiated (no scheduled_in) → skip', () => {
    const action = decideFetcherActions(
      flight({ actual_in: ACTUAL_IN, scheduled_in: null }),
      FlightStatus.NotInitiated,
    );
    expect(action.kind).toBe('skip');
  });

  it('cancelled flag takes precedence over actual_in (defensive — should not happen in practice)', () => {
    const action = decideFetcherActions(
      flight({ cancelled: true, actual_in: ACTUAL_IN }),
      FlightStatus.Active,
    );
    // We expect cancelled to win — protocol-wise, a cancelled+landed
    // result is contradictory but cancelled is the "official" airline
    // verdict.
    expect(action).toEqual({ kind: 'set_cancelled' });
  });
});

describe('decideFetcherActions — in-flight (eta seed) branch', () => {
  it('in-flight, NotInitiated, scheduled_in present → set_estimated_arrival', () => {
    const action = decideFetcherActions(flight({}), FlightStatus.NotInitiated);
    expect(action).toEqual({
      kind: 'set_estimated_arrival',
      etaUnixSec: SCHEDULED_UNIX,
    });
  });

  it('in-flight, NotInitiated, no scheduled_in → skip', () => {
    const action = decideFetcherActions(
      flight({ scheduled_in: null }),
      FlightStatus.NotInitiated,
    );
    expect(action.kind).toBe('skip');
  });

  it('in-flight, Active → skip (waiting for resolution)', () => {
    const action = decideFetcherActions(flight({}), FlightStatus.Active);
    expect(action.kind).toBe('skip');
  });
});

describe('decideFetcherActions — past-Landed branch (terminal)', () => {
  const terminals = [
    FlightStatus.Landed,
    FlightStatus.Cancelled,
    FlightStatus.ToBeSettledOnTime,
    FlightStatus.ToBeSettledDelayed,
    FlightStatus.ToBeSettledCancelled,
    FlightStatus.Settled,
  ];

  for (const status of terminals) {
    it(`status=${FlightStatus[status]} → skip (already past Landed)`, () => {
      const action = decideFetcherActions(
        flight({ cancelled: true, actual_in: ACTUAL_IN }),
        status,
      );
      expect(action.kind).toBe('skip');
    });
  }
});

describe('decideFetcherActions — boolean-only invariant', () => {
  it('arbitrary status-string values do not affect the decision', () => {
    const variants: Array<Partial<AeroFlight>> = [
      { status: 'Landed' },
      { status: 'Cancelled' },
      { status: 'En Route' },
      { status: '' },
      { status: 'Diverted' as unknown as string },
    ];
    for (const variant of variants) {
      // cancelled flag drives this regardless of status string.
      const action = decideFetcherActions(
        flight({ cancelled: true, ...variant }),
        FlightStatus.Active,
      );
      expect(action).toEqual({ kind: 'set_cancelled' });
    }
  });

  it('Unix-second conversion is computed from the ISO timestamp, not parsed from any string field', () => {
    const customIso = '2030-01-01T00:00:00Z';
    const expectedUnix = Math.floor(Date.parse(customIso) / 1000);
    const action = decideFetcherActions(
      flight({ scheduled_in: customIso }),
      FlightStatus.NotInitiated,
    );
    expect(action).toEqual({
      kind: 'set_estimated_arrival',
      etaUnixSec: expectedUnix,
    });
  });

  it('invalid scheduled_in (non-ISO) → null ETA → skip from NotInitiated', () => {
    const action = decideFetcherActions(
      flight({ scheduled_in: 'not-a-date' }),
      FlightStatus.NotInitiated,
    );
    expect(action.kind).toBe('skip');
  });
});
