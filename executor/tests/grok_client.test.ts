/**
 * Unit tests for the Grok client + verdict parsing.
 *
 * Live xAI calls are exercised via a fetch stub, so no network is hit.
 */

import { describe, expect, it } from 'vitest';
import {
  GROK_SAFE_DEFAULT,
  coerceVerdict,
  createGrokClient,
  createMockGrokClient,
  parseMockVerdict,
} from '../src/core/grok_client.ts';

const ROUTE = {
  flightId: 'AA100',
  carrier: 'AA',
  origin: 'ATL',
  destination: 'DFW',
};

describe('parseMockVerdict', () => {
  it('default is "ok" with multiplier 1.0', () => {
    expect(parseMockVerdict(undefined)).toEqual({
      action: 'ok',
      multiplier: 1.0,
      reason: 'mock baseline',
    });
  });

  it('parses "raise:1.5" with multiplier 1.5', () => {
    const v = parseMockVerdict('raise:1.5');
    expect(v.action).toBe('raise');
    expect(v.multiplier).toBe(1.5);
  });

  it('parses "raise:2" with multiplier 2.0', () => {
    expect(parseMockVerdict('raise:2').multiplier).toBe(2.0);
  });

  it('clamps "raise:5" to multiplier 3.0', () => {
    expect(parseMockVerdict('raise:5').multiplier).toBe(3.0);
  });

  it('clamps "raise:0.5" to multiplier 1.0', () => {
    expect(parseMockVerdict('raise:0.5').multiplier).toBe(1.0);
  });

  it('parses "disable"', () => {
    const v = parseMockVerdict('disable');
    expect(v.action).toBe('disable');
    expect(v.multiplier).toBe(1.0);
  });

  it('unknown spec falls back to "ok"', () => {
    expect(parseMockVerdict('totally-not-a-verdict').action).toBe('ok');
  });
});

describe('createMockGrokClient', () => {
  it('returns the parsed verdict for every route', async () => {
    const client = createMockGrokClient({ verdict: 'raise:1.8' });
    const v1 = await client.assess(ROUTE);
    const v2 = await client.assess({ ...ROUTE, origin: 'JFK' });
    expect(v1).toEqual(v2);
    expect(v1.action).toBe('raise');
    expect(v1.multiplier).toBeCloseTo(1.8);
  });
});

describe('coerceVerdict', () => {
  it('returns SAFE_DEFAULT for non-object input', () => {
    expect(coerceVerdict(null)).toEqual(GROK_SAFE_DEFAULT);
    expect(coerceVerdict('string')).toEqual(GROK_SAFE_DEFAULT);
    expect(coerceVerdict(42)).toEqual(GROK_SAFE_DEFAULT);
  });

  it('returns SAFE_DEFAULT for unknown action', () => {
    expect(
      coerceVerdict({ action: 'destroy', multiplier: 2, reason: 'r' }),
    ).toEqual(GROK_SAFE_DEFAULT);
  });

  it('clamps multiplier above 3.0', () => {
    const v = coerceVerdict({ action: 'raise', multiplier: 99, reason: 'r' });
    expect(v.multiplier).toBe(3.0);
  });

  it('clamps multiplier below 1.0', () => {
    const v = coerceVerdict({ action: 'raise', multiplier: 0.5, reason: 'r' });
    expect(v.multiplier).toBe(1.0);
  });

  it('forces multiplier 1.0 when action is "ok"', () => {
    const v = coerceVerdict({ action: 'ok', multiplier: 2.5, reason: 'r' });
    expect(v.multiplier).toBe(1.0);
  });

  it('forces multiplier 1.0 when action is "disable"', () => {
    const v = coerceVerdict({ action: 'disable', multiplier: 2.5, reason: 'r' });
    expect(v.multiplier).toBe(1.0);
  });

  it('truncates reason to 200 chars', () => {
    const long = 'x'.repeat(500);
    const v = coerceVerdict({ action: 'ok', multiplier: 1, reason: long });
    expect(v.reason.length).toBe(200);
  });

  it('falls back to default reason when reason is empty', () => {
    const v = coerceVerdict({ action: 'ok', multiplier: 1, reason: '' });
    expect(v.reason).toBe(GROK_SAFE_DEFAULT.reason);
  });
});

describe('createGrokClient (live mode, with fetch stub)', () => {
  function stubResponse(body: unknown, opts: { status?: number } = {}): typeof fetch {
    return async () =>
      new Response(JSON.stringify(body), {
        status: opts.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  it('parses a well-formed Grok response', async () => {
    const fetchImpl = stubResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: 'raise',
              multiplier: 1.8,
              reason: 'severe weather forecast',
            }),
          },
        },
      ],
    });
    const client = createGrokClient({ apiKey: 'k', fetchImpl });
    const v = await client.assess(ROUTE);
    expect(v.action).toBe('raise');
    expect(v.multiplier).toBeCloseTo(1.8);
    expect(v.reason).toBe('severe weather forecast');
  });

  it('returns safe default on 5xx', async () => {
    const fetchImpl = stubResponse({}, { status: 503 });
    const client = createGrokClient({ apiKey: 'k', fetchImpl });
    const v = await client.assess(ROUTE);
    expect(v.action).toBe('ok');
    expect(v.multiplier).toBe(1.0);
    expect(v.reason).toContain('503');
  });

  it('returns safe default when content is non-JSON', async () => {
    const fetchImpl = stubResponse({
      choices: [{ message: { content: 'not json at all' } }],
    });
    const client = createGrokClient({ apiKey: 'k', fetchImpl });
    const v = await client.assess(ROUTE);
    expect(v).toEqual(GROK_SAFE_DEFAULT);
  });

  it('returns safe default when fetch throws (network error / abort)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network down');
    };
    const client = createGrokClient({ apiKey: 'k', fetchImpl });
    const v = await client.assess(ROUTE);
    expect(v).toEqual(GROK_SAFE_DEFAULT);
  });
});
