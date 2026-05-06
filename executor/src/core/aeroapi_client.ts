/**
 * executor/core/aeroapi_client.ts
 *
 * Minimal typed FlightAware AeroAPI client. Only the one endpoint we
 * actually use:
 *
 *   GET /flights/{ident}?start={date}T00:00:00Z&end={date}T23:59:59Z
 *
 * Auth header: `x-apikey: <AEROAPI_KEY>`.
 *
 * Per the `aero-api` skill: never throw on HTTP errors; return null and
 * let the cron skip + retry on the next tick. The cron's safety boundary
 * is the on-chain forward-only state machine — a dropped fetch never
 * causes incorrect on-chain state, just a deferred update.
 */

import type { AeroFlight, AeroFlightsResponse } from './types.ts';

const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';

export interface AeroApiClient {
  fetchFlightsForDay(ident: string, dateIso: string): Promise<AeroFlight[] | null>;
}

export interface AeroApiClientOptions {
  apiKey: string;
  /** Override base URL — used by tests with a mock fetch. */
  baseUrl?: string;
  /** Override `fetch` — used by tests. */
  fetchImpl?: typeof fetch;
}

export function createAeroApiClient(opts: AeroApiClientOptions): AeroApiClient {
  const baseUrl = opts.baseUrl ?? AEROAPI_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey;
  if (!apiKey) {
    throw new Error('AeroAPI client: apiKey is required');
  }

  return {
    async fetchFlightsForDay(ident, dateIso) {
      // dateIso must be `YYYY-MM-DD` (the calendar day the on-chain
      // FlightPool was registered with). The window is full-day UTC.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
        throw new Error(`AeroAPI client: dateIso must be YYYY-MM-DD; got ${dateIso}`);
      }
      const start = `${dateIso}T00:00:00Z`;
      const end = `${dateIso}T23:59:59Z`;
      const url = `${baseUrl}/flights/${encodeURIComponent(ident)}?start=${start}&end=${end}`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'x-apikey': apiKey, accept: 'application/json' },
        });
      } catch {
        // Network error — swallow per skill guidance. Cron retries next tick.
        return null;
      }

      if (!res.ok) {
        // Per aero-api skill error table:
        //   401 = bad key — log loud, don't crash (operator fixes env)
        //   403 = endpoint not on tier — log + skip
        //   404 = flight not found — treat as Unknown
        //   429 = rate limited — skip
        //   5xx = upstream issue — skip
        // For all of these we return null; the runner logs the status code.
        // We don't differentiate here so the cron's retry semantics are
        // uniform across error classes.
        return null;
      }

      let body: AeroFlightsResponse;
      try {
        body = (await res.json()) as AeroFlightsResponse;
      } catch {
        return null;
      }

      if (!body || !Array.isArray(body.flights)) return null;
      return body.flights;
    },
  };
}

/**
 * Pick the most recent flight entry from the array. AeroAPI returns
 * multiple operations on a callsign across the day window; the last
 * entry is the most recent operation (the one we care about for
 * settlement).
 *
 * Returns null on empty arrays so the caller can skip cleanly.
 */
export function pickLatestFlight(flights: AeroFlight[]): AeroFlight | null {
  if (!flights || flights.length === 0) return null;
  return flights[flights.length - 1];
}
