/**
 * Unit tests for `decideRouteAction` — the pure decision module that
 * converts (route state, baseline premium, Grok verdict, recent disables)
 * into one of the 4 RouteAction variants.
 *
 * No I/O, no RPC. All inputs are constructed in-memory.
 */

import { describe, expect, it } from 'vitest';
import {
  DRIFT_THRESHOLD_BASE_UNITS,
  MAX_PREMIUM_BASE_UNITS,
  MIN_PREMIUM_BASE_UNITS,
  USDC_BASE_UNITS_PER_USDC,
  clampPremiumBaseUnits,
  decideRouteAction,
  type RouteState,
} from '../src/core/decide_route_actions.ts';
import type { GrokVerdict } from '../src/core/grok_client.ts';

const APPROVED_ROUTE: RouteState = {
  pda: 'Pda1111111111111111111111111111111111111111',
  flightId: 'AA100',
  origin: 'ATL',
  destination: 'DFW',
  currentPremiumBaseUnits: 2_000_000n, // $2.00
  approved: true,
};

const DISABLED_ROUTE: RouteState = {
  ...APPROVED_ROUTE,
  pda: 'Pda2222222222222222222222222222222222222222',
  approved: false,
};

const VERDICT_OK: GrokVerdict = { action: 'ok', multiplier: 1.0, reason: 'ok' };
const VERDICT_RAISE_1_5: GrokVerdict = { action: 'raise', multiplier: 1.5, reason: 'r1.5' };
const VERDICT_RAISE_3: GrokVerdict = { action: 'raise', multiplier: 3.0, reason: 'r3' };
const VERDICT_DISABLE: GrokVerdict = { action: 'disable', multiplier: 1.0, reason: 'closure' };

const NO_DISABLES = new Set<string>();

describe('decideRouteAction — approved route, grok ok', () => {
  it('noop when baseline matches current within drift threshold', () => {
    // current = 2_000_000, baseline = 2_050_000 → delta 50_000 < 100_000
    const action = decideRouteAction(APPROVED_ROUTE, 2_050_000n, VERDICT_OK, NO_DISABLES);
    expect(action.kind).toBe('noop');
  });

  it('update_premium when baseline exceeds drift threshold', () => {
    // current = 2_000_000, baseline = 2_500_000 → delta 500_000 > 100_000
    const action = decideRouteAction(APPROVED_ROUTE, 2_500_000n, VERDICT_OK, NO_DISABLES);
    expect(action.kind).toBe('update_premium');
    if (action.kind !== 'update_premium') throw new Error('unreachable');
    expect(action.newPremiumBaseUnits).toBe(2_500_000n);
  });

  it('update_premium when route has no current premium override', () => {
    const route: RouteState = { ...APPROVED_ROUTE, currentPremiumBaseUnits: null };
    const action = decideRouteAction(route, 2_500_000n, VERDICT_OK, NO_DISABLES);
    expect(action.kind).toBe('update_premium');
  });
});

describe('decideRouteAction — approved route, grok raise', () => {
  it('update_premium with multiplier applied', () => {
    // baseline $2.00 × 1.5 = $3.00
    const action = decideRouteAction(APPROVED_ROUTE, 2_000_000n, VERDICT_RAISE_1_5, NO_DISABLES);
    expect(action.kind).toBe('update_premium');
    if (action.kind !== 'update_premium') throw new Error('unreachable');
    expect(action.newPremiumBaseUnits).toBe(3_000_000n);
  });

  it('clamps to MAX_PREMIUM_BASE_UNITS ($5) when multiplier would exceed', () => {
    // $2 × 3 = $6 → clamps to $5
    const action = decideRouteAction(APPROVED_ROUTE, 2_000_000n, VERDICT_RAISE_3, NO_DISABLES);
    expect(action.kind).toBe('update_premium');
    if (action.kind !== 'update_premium') throw new Error('unreachable');
    expect(action.newPremiumBaseUnits).toBe(MAX_PREMIUM_BASE_UNITS);
  });

  it('respects drift threshold even with raise', () => {
    // baseline $2.04, multiplier 1.0 → still within 10¢ of $2.00
    const action = decideRouteAction(
      APPROVED_ROUTE,
      2_040_000n,
      { action: 'raise', multiplier: 1.0, reason: 'mild' },
      NO_DISABLES,
    );
    expect(action.kind).toBe('noop');
  });
});

describe('decideRouteAction — grok disable', () => {
  it('disables an approved route', () => {
    const action = decideRouteAction(APPROVED_ROUTE, 2_000_000n, VERDICT_DISABLE, NO_DISABLES);
    expect(action.kind).toBe('disable');
    if (action.kind !== 'disable') throw new Error('unreachable');
    expect(action.flightId).toBe('AA100');
    expect(action.reason).toBe('closure');
  });

  it('noop on a route already disabled (cannot double-disable)', () => {
    const action = decideRouteAction(DISABLED_ROUTE, 2_000_000n, VERDICT_DISABLE, NO_DISABLES);
    expect(action.kind).toBe('noop');
  });
});

describe('decideRouteAction — disabled route + grok ok (re-enable gate)', () => {
  it('re-enables the route only if THIS cron disabled it', () => {
    const disablesByRepricer = new Set([DISABLED_ROUTE.pda]);
    const action = decideRouteAction(
      DISABLED_ROUTE,
      2_000_000n,
      VERDICT_OK,
      disablesByRepricer,
    );
    expect(action.kind).toBe('reenable_with_terms');
    if (action.kind !== 'reenable_with_terms') throw new Error('unreachable');
    expect(action.newPremiumBaseUnits).toBe(2_000_000n);
  });

  it('noop when grok says ok but route was disabled by someone else (manual /admin)', () => {
    const action = decideRouteAction(DISABLED_ROUTE, 2_000_000n, VERDICT_OK, NO_DISABLES);
    expect(action.kind).toBe('noop');
    if (action.kind !== 'noop') throw new Error('unreachable');
    expect(action.reason).toContain('not by this cron');
  });

  it('noop when grok says raise on a disabled route — defer to operator', () => {
    const disablesByRepricer = new Set([DISABLED_ROUTE.pda]);
    const action = decideRouteAction(
      DISABLED_ROUTE,
      2_000_000n,
      VERDICT_RAISE_1_5,
      disablesByRepricer,
    );
    expect(action.kind).toBe('noop');
    if (action.kind !== 'noop') throw new Error('unreachable');
    expect(action.reason).toContain('defer to operator');
  });
});

describe('clampPremiumBaseUnits', () => {
  it('clamps below $1 to MIN_PREMIUM_BASE_UNITS', () => {
    expect(clampPremiumBaseUnits(500_000n, 1.0)).toBe(MIN_PREMIUM_BASE_UNITS);
  });
  it('clamps above $5 to MAX_PREMIUM_BASE_UNITS', () => {
    expect(clampPremiumBaseUnits(3_000_000n, 2.5)).toBe(MAX_PREMIUM_BASE_UNITS);
  });
  it('passes through middle-of-range values', () => {
    expect(clampPremiumBaseUnits(2_000_000n, 1.0)).toBe(2_000_000n);
  });
  it('rounds rather than truncates', () => {
    // 1_000_001 × 1.5 = 1_500_001.5 → rounds to 1_500_002
    expect(clampPremiumBaseUnits(1_000_001n, 1.5)).toBe(1_500_002n);
  });
});

describe('clampPremiumBaseUnits — invariants for documentation', () => {
  it('USDC_BASE_UNITS_PER_USDC == 1_000_000', () => {
    expect(USDC_BASE_UNITS_PER_USDC).toBe(1_000_000n);
  });
  it('DRIFT_THRESHOLD_BASE_UNITS == 100_000 (10 cents)', () => {
    expect(DRIFT_THRESHOLD_BASE_UNITS).toBe(100_000n);
  });
});
