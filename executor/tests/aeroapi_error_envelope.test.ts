/**
 * Phase 11 — Unit tests for the AeroAPI 4xx error envelope decode added
 * to the client. Covers:
 *   - well-formed envelope on each common 4xx status (400/401/403/404/429)
 *   - malformed bodies (partial fields, wrong types, null, non-object)
 *   - non-JSON 4xx bodies → fallthrough to generic log
 *   - 5xx skips envelope decode entirely
 *   - the parseAeroApiError helper in isolation
 *   - structured log line shape (so operators can grep + alert on it)
 *
 * Logging is asserted via the new `logger` injection point on
 * `createAeroApiClient` — no console monkey-patching.
 */

import { describe, it, expect } from 'vitest';
import {
  createAeroApiClient,
  parseAeroApiError,
} from '../src/core/aeroapi_client.ts';
import type { AeroApiError } from '../src/core/types.ts';

// ─── Test helpers ────────────────────────────────────────────────────────

function fakeFetch(
  status: number,
  body: unknown,
  opts: { bodyThrows?: boolean; throwBefore?: boolean } = {},
): typeof fetch {
  return (async (_url: unknown, _init: unknown) => {
    if (opts.throwBefore) throw new Error('network failure');
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (opts.bodyThrows) throw new Error('json parse failed');
        return body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

interface CapturedLogger {
  logs: string[];
  fn: (m: string) => void;
}

function captureLogs(): CapturedLogger {
  const logs: string[] = [];
  return { logs, fn: (m: string) => logs.push(m) };
}

const SAMPLE_ENVELOPE: AeroApiError = {
  title: 'Bad Request',
  reason: 'INVALID_PARAM',
  detail: 'Parameter `start` must be ISO 8601 UTC',
  status: 400,
};

// ─── 4xx envelope happy path ─────────────────────────────────────────────

describe('AeroAPI client — 4xx envelope decode', () => {
  it('decodes a well-formed 400 envelope, logs it, returns null', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(400, SAMPLE_ENVELOPE),
      logger: log.fn,
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0]).toContain('[aero] 4xx envelope:');
    expect(log.logs[0]).toContain('status=400');
    expect(log.logs[0]).toContain('title="Bad Request"');
    expect(log.logs[0]).toContain('reason="INVALID_PARAM"');
    expect(log.logs[0]).toContain('detail="Parameter `start` must be ISO 8601 UTC"');
  });

  it.each([401, 403, 404, 429])(
    'decodes envelope on HTTP %i (4xx range)',
    async (httpStatus) => {
      const log = captureLogs();
      const env: AeroApiError = {
        title: 'Forbidden',
        reason: 'TIER_INSUFFICIENT',
        detail: 'Your subscription tier does not include this endpoint',
        status: httpStatus,
      };
      const client = createAeroApiClient({
        apiKey: 'k',
        fetchImpl: fakeFetch(httpStatus, env),
        logger: log.fn,
      });
      const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
      expect(result).toBeNull();
      expect(log.logs).toHaveLength(1);
      expect(log.logs[0]).toContain('[aero] 4xx envelope:');
      expect(log.logs[0]).toContain(`status=${httpStatus}`);
    },
  );
});

// ─── 4xx malformed body fallthrough ──────────────────────────────────────

describe('AeroAPI client — 4xx malformed body falls through to generic log', () => {
  it('partial envelope (missing detail) → generic [aero] HTTP 400', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(400, { title: 'Bad', reason: 'X', status: 400 }),
      logger: log.fn,
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0]).toBe('[aero] HTTP 400');
  });

  it('wrong type for status (string instead of number) → fallthrough', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(400, {
        title: 'Bad',
        reason: 'X',
        detail: 'Y',
        status: '400',
      }),
      logger: log.fn,
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
    expect(log.logs[0]).toBe('[aero] HTTP 400');
  });

  it('non-JSON body (json() throws) → fallthrough', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(404, undefined, { bodyThrows: true }),
      logger: log.fn,
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
    expect(log.logs[0]).toBe('[aero] HTTP 404');
  });

  it('null body → fallthrough', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(429, null),
      logger: log.fn,
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
    expect(log.logs[0]).toBe('[aero] HTTP 429');
  });
});

// ─── 5xx skips envelope decode ───────────────────────────────────────────

describe('AeroAPI client — 5xx skips envelope decode', () => {
  it('500 with envelope-shaped body still uses generic log', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      // Even if the body LOOKS like an envelope, we don't decode on 5xx —
      // the docs say envelope is a 4xx-only schema.
      fetchImpl: fakeFetch(500, SAMPLE_ENVELOPE),
      logger: log.fn,
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0]).toBe('[aero] HTTP 500');
    // Specifically, no envelope log emitted.
    expect(log.logs[0]).not.toContain('4xx envelope');
  });

  it('502 → generic log', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(502, { error: 'bad gateway' }),
      logger: log.fn,
    });
    expect(await client.fetchFlightsForDay('AA100', '2026-06-15')).toBeNull();
    expect(log.logs[0]).toBe('[aero] HTTP 502');
  });
});

// ─── Network + JSON parse failures emit logs ─────────────────────────────

describe('AeroAPI client — non-HTTP failures (network, JSON)', () => {
  it('network exception logs + returns null', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(0, undefined, { throwBefore: true }),
      logger: log.fn,
    });
    expect(await client.fetchFlightsForDay('AA100', '2026-06-15')).toBeNull();
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0]).toContain('[aero] network error:');
    expect(log.logs[0]).toContain('network failure');
  });

  it('2xx with non-JSON body logs + returns null', async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(200, undefined, { bodyThrows: true }),
      logger: log.fn,
    });
    expect(await client.fetchFlightsForDay('AA100', '2026-06-15')).toBeNull();
    expect(log.logs).toHaveLength(1);
    expect(log.logs[0]).toBe('[aero] JSON parse failed on 2xx response');
  });

  it("2xx response missing 'flights' field logs + returns null", async () => {
    const log = captureLogs();
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(200, { num_pages: 0 }),
      logger: log.fn,
    });
    expect(await client.fetchFlightsForDay('AA100', '2026-06-15')).toBeNull();
    expect(log.logs[0]).toBe("[aero] response missing 'flights' field");
  });
});

// ─── parseAeroApiError helper in isolation ───────────────────────────────

describe('parseAeroApiError', () => {
  it('returns the envelope when all 4 fields are correctly typed', () => {
    expect(parseAeroApiError(SAMPLE_ENVELOPE)).toEqual(SAMPLE_ENVELOPE);
  });

  it('returns null when title is missing', () => {
    expect(parseAeroApiError({ reason: 'X', detail: 'Y', status: 400 })).toBeNull();
  });

  it('returns null when status is a string', () => {
    expect(
      parseAeroApiError({ title: 'A', reason: 'B', detail: 'C', status: '400' }),
    ).toBeNull();
  });

  it('returns null for null / undefined / non-object inputs', () => {
    expect(parseAeroApiError(null)).toBeNull();
    expect(parseAeroApiError(undefined)).toBeNull();
    expect(parseAeroApiError('string')).toBeNull();
    expect(parseAeroApiError(42)).toBeNull();
    expect(parseAeroApiError([])).toBeNull();
  });

  it('ignores extra fields beyond the four required', () => {
    const env = parseAeroApiError({
      ...SAMPLE_ENVELOPE,
      extra: 'ignored',
      foreSightAvailable: true,
    });
    expect(env).toEqual(SAMPLE_ENVELOPE);
  });
});
