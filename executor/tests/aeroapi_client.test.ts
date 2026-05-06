/**
 * Unit tests for the AeroAPI HTTP client. Uses a fake `fetch` to verify
 * the URL shape, headers, and error swallowing per the skill's guidance:
 * never throw on AeroAPI failure — return null and let the cron retry.
 */

import { describe, it, expect } from 'vitest';
import {
  createAeroApiClient,
  pickLatestFlight,
} from '../src/core/aeroapi_client.ts';

function fakeFetch(
  status: number,
  body?: unknown,
  opts: { throw?: boolean; bodyError?: boolean } = {},
): typeof fetch {
  return (async (_url: unknown, _init: unknown) => {
    if (opts.throw) throw new Error('network error');
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (opts.bodyError) throw new Error('json parse');
        return body ?? {};
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('AeroAPI client — happy path', () => {
  it('builds the correct URL with start/end window and x-apikey header', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: unknown, init: unknown) => {
      capturedUrl = String(url);
      capturedHeaders = (init as { headers: Record<string, string> }).headers;
      return {
        ok: true,
        status: 200,
        async json() {
          return { flights: [{ ident: 'AA100', cancelled: false, scheduled_in: '2026-06-15T18:00:00Z', actual_in: null }] };
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = createAeroApiClient({
      apiKey: 'test-key',
      fetchImpl,
      baseUrl: 'https://example.test/aeroapi',
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).not.toBeNull();
    expect(result![0].ident).toBe('AA100');
    expect(capturedUrl).toBe(
      'https://example.test/aeroapi/flights/AA100?start=2026-06-15T00:00:00Z&end=2026-06-15T23:59:59Z',
    );
    expect(capturedHeaders['x-apikey']).toBe('test-key');
  });

  it('rejects malformed dateIso (not YYYY-MM-DD)', async () => {
    const client = createAeroApiClient({ apiKey: 'k', fetchImpl: fakeFetch(200) });
    await expect(client.fetchFlightsForDay('AA100', '06/15/2026')).rejects.toThrow();
  });
});

describe('AeroAPI client — error swallowing', () => {
  for (const status of [401, 403, 404, 429, 500, 502]) {
    it(`HTTP ${status} → returns null (cron retries next tick)`, async () => {
      const client = createAeroApiClient({
        apiKey: 'k',
        fetchImpl: fakeFetch(status, { error: 'boom' }),
      });
      const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
      expect(result).toBeNull();
    });
  }

  it('network exception → returns null', async () => {
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(0, undefined, { throw: true }),
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
  });

  it('JSON parse error → returns null', async () => {
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(200, undefined, { bodyError: true }),
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
  });

  it('valid response with no flights → returns empty array (NOT null)', async () => {
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(200, { flights: [] }),
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toEqual([]);
  });

  it('response missing the flights field → returns null', async () => {
    const client = createAeroApiClient({
      apiKey: 'k',
      fetchImpl: fakeFetch(200, { num_pages: 0 }),
    });
    const result = await client.fetchFlightsForDay('AA100', '2026-06-15');
    expect(result).toBeNull();
  });
});

describe('pickLatestFlight', () => {
  it('returns null on empty arrays', () => {
    expect(pickLatestFlight([])).toBeNull();
  });

  it('returns the last entry for non-empty arrays', () => {
    const flights = [
      { ident: 'AA100', cancelled: false, scheduled_in: null, actual_in: null },
      { ident: 'AA100', cancelled: false, scheduled_in: '2026-06-15T18:00:00Z', actual_in: null },
    ];
    expect(pickLatestFlight(flights)).toBe(flights[1]);
  });
});

describe('AeroAPI client — constructor validation', () => {
  it('throws if apiKey is empty', () => {
    expect(() => createAeroApiClient({ apiKey: '' })).toThrow();
  });
});
