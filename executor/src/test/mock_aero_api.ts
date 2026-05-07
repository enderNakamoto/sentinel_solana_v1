/**
 * executor/src/test/mock_aero_api.ts
 *
 * Phase 11 — Test fixture. Implements `AeroApiClient` against an
 * in-memory state map so integration tests can drive the real cron core
 * functions (`runFetcherOnce` etc.) through scripted scenarios without
 * a live FlightAware HTTP endpoint.
 *
 * Lives under `src/test/` (not `tests/`) so it's importable from both
 * `executor/tests/...` and `contracts/tests/integration/...`.
 *
 * Usage:
 *
 *   const aero = createMockAeroApi();
 *   aero.seed('AA100', '2026-06-15', { ident: 'AA100', cancelled: false,
 *     scheduled_in: '2026-06-15T18:00:00Z', actual_in: null });
 *   await runFetcherOnce({ solana, aero, applyAction });
 *
 *   // Later, drive a state change:
 *   aero.mutate('AA100', '2026-06-15', { actual_in: '2026-06-15T18:05:00Z' });
 *   await runFetcherOnce(...);
 *
 *   // Or simulate an error tick:
 *   aero.seedError('AA100', '2026-06-15', {
 *     title: 'Forbidden', reason: 'TIER_INSUFFICIENT',
 *     detail: 'Upgrade required', status: 403,
 *   });
 *   await runFetcherOnce(...);   // logs envelope, returns null, no on-chain change
 */

import type { AeroApiClient } from '../core/aeroapi_client.ts';
import type { AeroApiError, AeroFlight } from '../core/types.ts';

export type { AeroApiClient } from '../core/aeroapi_client.ts';
export type { AeroApiError, AeroFlight } from '../core/types.ts';

interface FlightEntry {
  kind: 'flight';
  flight: AeroFlight;
}

interface ErrorEntry {
  kind: 'error';
  envelope: AeroApiError;
}

type Entry = FlightEntry | ErrorEntry;

/**
 * Mock client. Extends `AeroApiClient` with state-mutation helpers the
 * test harness uses to script timelines.
 */
export interface MockAeroApi extends AeroApiClient {
  /**
   * Set or replace the flight returned for a given (ident, dateIso).
   * Subsequent `fetchFlightsForDay(ident, dateIso)` calls will return
   * `[flight]`. Overwrites any prior flight or error mode for the key.
   */
  seed(ident: string, dateIso: string, flight: AeroFlight): void;

  /**
   * Apply a partial update to an already-seeded flight. Throws if the
   * key has no prior `seed()` (use `seed` first to set initial state).
   */
  mutate(ident: string, dateIso: string, partial: Partial<AeroFlight>): void;

  /**
   * Mark a key as returning an error. The mock will log the envelope
   * via the same shape as the real client and return null on the next
   * `fetchFlightsForDay(ident, dateIso)` call. Persists across calls
   * until cleared or replaced via `seed()`.
   */
  seedError(ident: string, dateIso: string, envelope: AeroApiError): void;

  /** Remove all seeded state. */
  clear(): void;

  /**
   * Snapshot the current entry for a key — useful for assertions in
   * tests that want to verify the harness mutated the right thing.
   * Returns null if not seeded.
   */
  peek(ident: string, dateIso: string): AeroFlight | AeroApiError | null;
}

export interface MockAeroApiOptions {
  /**
   * Override the structured-log sink. Defaults to `console.error`.
   * Tests use this to capture envelope logs deterministically.
   */
  logger?: (msg: string) => void;
}

/**
 * Build a mock AeroAPI client backed by an in-memory `Map`. Always
 * returns either:
 *   - `[flight]`        for keys seeded via `seed()`
 *   - `null`            for unknown keys (matches real client's "not
 *                       found / 404" behavior)
 *   - `null`            for keys seeded via `seedError()`, after
 *                       emitting the same `[aero] 4xx envelope: ...`
 *                       structured log line as the real client.
 */
export function createMockAeroApi(opts: MockAeroApiOptions = {}): MockAeroApi {
  const state = new Map<string, Entry>();
  const logger = opts.logger ?? ((m) => console.error(m));

  function key(ident: string, dateIso: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      throw new Error(`mock-aero: dateIso must be YYYY-MM-DD; got ${dateIso}`);
    }
    return `${ident}|${dateIso}`;
  }

  return {
    async fetchFlightsForDay(ident: string, dateIso: string) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
        throw new Error(`AeroAPI client: dateIso must be YYYY-MM-DD; got ${dateIso}`);
      }
      const entry = state.get(key(ident, dateIso));
      if (!entry) return null;
      if (entry.kind === 'error') {
        const e = entry.envelope;
        // Mirror the real client's log line verbatim — scenario 8 greps
        // for this string to assert the wiring works end-to-end.
        logger(
          `[aero] 4xx envelope: status=${e.status} ` +
            `title="${e.title}" reason="${e.reason}" detail="${e.detail}"`,
        );
        return null;
      }
      return [entry.flight];
    },

    seed(ident, dateIso, flight) {
      if (flight.ident !== ident) {
        throw new Error(
          `mock-aero: flight.ident="${flight.ident}" must match key ident="${ident}"`,
        );
      }
      state.set(key(ident, dateIso), { kind: 'flight', flight });
    },

    mutate(ident, dateIso, partial) {
      const k = key(ident, dateIso);
      const prior = state.get(k);
      if (!prior || prior.kind !== 'flight') {
        throw new Error(
          `mock-aero: cannot mutate "${ident}|${dateIso}" — not seeded as flight`,
        );
      }
      state.set(k, {
        kind: 'flight',
        flight: { ...prior.flight, ...partial },
      });
    },

    seedError(ident, dateIso, envelope) {
      state.set(key(ident, dateIso), { kind: 'error', envelope });
    },

    clear() {
      state.clear();
    },

    peek(ident, dateIso) {
      const e = state.get(key(ident, dateIso));
      if (!e) return null;
      return e.kind === 'flight' ? e.flight : e.envelope;
    },
  };
}
