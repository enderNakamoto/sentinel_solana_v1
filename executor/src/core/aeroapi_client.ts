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
 *
 * Phase 11 — extended to decode AeroAPI's 4xx error envelope
 * `{title, reason, detail, status}` and emit a structured log line
 * before returning null. 5xx, network, and JSON-parse failures still
 * fall through to a generic status log + null return. All paths
 * preserve the "never throw" contract.
 */

import {
  type AeroApiError,
  type AeroFlight,
  type AeroFlightsResponse,
} from './types.ts';

export type { AeroApiError, AeroFlight } from './types.ts';

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
  /**
   * Override the structured-log sink. Defaults to `console.error`.
   * Tests use this to capture envelope logs without monkey-patching.
   */
  logger?: (msg: string) => void;
}

export function createAeroApiClient(opts: AeroApiClientOptions): AeroApiClient {
  const baseUrl = opts.baseUrl ?? AEROAPI_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey;
  const logger = opts.logger ?? ((m) => console.error(m));
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
      } catch (err) {
        // Network error — log + swallow per skill guidance. Cron retries next tick.
        logger(`[aero] network error: ${(err as Error)?.message ?? String(err)}`);
        return null;
      }

      if (!res.ok) {
        // Try to decode the 4xx envelope `{title, reason, detail, status}`
        // and emit a structured log. Per AeroAPI docs the envelope is a
        // 4xx-only schema, so we don't attempt decode on 5xx. All paths
        // return null and the cron retries next tick.
        if (res.status >= 400 && res.status < 500) {
          let raw: unknown = null;
          try {
            raw = await res.json();
          } catch {
            // Body wasn't JSON — fallthrough to generic log.
          }
          const envelope = parseAeroApiError(raw);
          if (envelope) {
            logger(
              `[aero] 4xx envelope: status=${envelope.status} ` +
                `title="${envelope.title}" reason="${envelope.reason}" detail="${envelope.detail}"`,
            );
            return null;
          }
        }
        // 5xx, malformed envelope, or non-JSON body. Per aero-api skill error
        // table:
        //   401 = bad key — operator fixes env
        //   403 = endpoint not on tier
        //   404 = flight not found — Unknown
        //   429 = rate limited
        //   5xx = upstream issue
        // Cron's retry semantics are uniform across error classes.
        logger(`[aero] HTTP ${res.status}`);
        return null;
      }

      let body: AeroFlightsResponse;
      try {
        body = (await res.json()) as AeroFlightsResponse;
      } catch {
        logger(`[aero] JSON parse failed on 2xx response`);
        return null;
      }

      if (!body || !Array.isArray(body.flights)) {
        logger(`[aero] response missing 'flights' field`);
        return null;
      }
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

/**
 * Parse a value as the AeroAPI 4xx error envelope. Returns null if the
 * value doesn't conform to the expected shape (all four fields present
 * with correct types).
 *
 * Exported so tests + the mock client can share the same shape check.
 */
export function parseAeroApiError(raw: unknown): AeroApiError | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.title === 'string' &&
    typeof obj.reason === 'string' &&
    typeof obj.detail === 'string' &&
    typeof obj.status === 'number'
  ) {
    return {
      title: obj.title,
      reason: obj.reason,
      detail: obj.detail,
      status: obj.status,
    };
  }
  return null;
}
