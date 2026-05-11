/**
 * executor/src/core/decide_route_actions.ts
 *
 * Pure decision module for the Phase 23 Route Repricer cron.
 *
 * Given a route's current on-chain state, the agent's baseline premium,
 * Grok's geopolitical verdict, and the set of routes this cron previously
 * disabled, decides which of the 4 governance instructions to send.
 *
 * Action shape (closed set):
 *   noop                     — within drift threshold OR Grok says ok and route is already correct
 *   update_premium(new_bps)  — Grok multiplier × baseline, re-clamped to [$1, $5]
 *   disable                  — Grok action == "disable" AND route is currently approved
 *   reenable_with_terms(...) — Grok action == "ok" AND route is currently disabled
 *                              AND route was previously disabled by THIS cron
 *
 * No I/O. Easy to unit-test.
 */

import type { GrokVerdict } from './grok_client.ts';

export const PUSD_BASE_UNITS_PER_PUSD = 1_000_000n;
export const MIN_PREMIUM_BASE_UNITS = 1n * PUSD_BASE_UNITS_PER_PUSD; // $1
export const MAX_PREMIUM_BASE_UNITS = 5n * PUSD_BASE_UNITS_PER_PUSD; // $5
export const DRIFT_THRESHOLD_BASE_UNITS = 100_000n; // 10¢

export interface RouteState {
  /** PDA address (base58). */
  pda: string;
  flightId: string;
  origin: string;
  destination: string;
  /** Current premium override, or null if route falls back to global default. */
  currentPremiumBaseUnits: bigint | null;
  /** RouteAccount.approved. */
  approved: boolean;
}

export type RouteAction =
  | { kind: 'noop'; routePda: string; reason: string }
  | {
      kind: 'update_premium';
      routePda: string;
      flightId: string;
      origin: string;
      destination: string;
      newPremiumBaseUnits: bigint;
      reason: string;
    }
  | {
      kind: 'disable';
      routePda: string;
      flightId: string;
      origin: string;
      destination: string;
      reason: string;
    }
  | {
      kind: 'reenable_with_terms';
      routePda: string;
      flightId: string;
      origin: string;
      destination: string;
      newPremiumBaseUnits: bigint;
      reason: string;
    };

/**
 * Apply Grok's multiplier to the agent's baseline and clamp to the
 * locked $1–$5 range. All math in PUSD base units (6 decimals).
 */
export function clampPremiumBaseUnits(
  baselineBaseUnits: bigint,
  multiplier: number,
): bigint {
  const baselineNum = Number(baselineBaseUnits);
  const adjusted = Math.round(baselineNum * multiplier);
  let result = BigInt(adjusted);
  if (result < MIN_PREMIUM_BASE_UNITS) result = MIN_PREMIUM_BASE_UNITS;
  if (result > MAX_PREMIUM_BASE_UNITS) result = MAX_PREMIUM_BASE_UNITS;
  return result;
}

export function decideRouteAction(
  route: RouteState,
  baselinePremiumBaseUnits: bigint,
  verdict: GrokVerdict,
  recentDisablesByRepricer: ReadonlySet<string>,
): RouteAction {
  const targetPremiumBaseUnits = clampPremiumBaseUnits(
    baselinePremiumBaseUnits,
    verdict.multiplier,
  );

  // ── Branch 1: Grok says disable ──────────────────────────────────────
  if (verdict.action === 'disable') {
    if (!route.approved) {
      return {
        kind: 'noop',
        routePda: route.pda,
        reason: `grok: disable but route already disabled (${verdict.reason})`,
      };
    }
    return {
      kind: 'disable',
      routePda: route.pda,
      flightId: route.flightId,
      origin: route.origin,
      destination: route.destination,
      reason: verdict.reason,
    };
  }

  // ── Branch 2: route is currently disabled ────────────────────────────
  if (!route.approved) {
    if (verdict.action === 'ok' && recentDisablesByRepricer.has(route.pda)) {
      return {
        kind: 'reenable_with_terms',
        routePda: route.pda,
        flightId: route.flightId,
        origin: route.origin,
        destination: route.destination,
        newPremiumBaseUnits: targetPremiumBaseUnits,
        reason: `grok: ok — re-enabling after prior cron disable (${verdict.reason})`,
      };
    }
    return {
      kind: 'noop',
      routePda: route.pda,
      reason:
        verdict.action === 'ok'
          ? 'route disabled (not by this cron); grok says ok — leaving alone'
          : `route disabled; grok wants raise×${verdict.multiplier.toFixed(2)} — defer to operator`,
    };
  }

  // ── Branch 3: route is approved, Grok says ok or raise ───────────────
  // Drift check vs the existing on-chain premium. Routes with no override
  // (currentPremiumBaseUnits === null) always get the explicit override
  // applied so the on-chain value matches what the agent + Grok produced.
  const current = route.currentPremiumBaseUnits;
  if (current !== null) {
    const delta =
      targetPremiumBaseUnits > current
        ? targetPremiumBaseUnits - current
        : current - targetPremiumBaseUnits;
    if (delta < DRIFT_THRESHOLD_BASE_UNITS) {
      return {
        kind: 'noop',
        routePda: route.pda,
        reason:
          `within drift threshold (Δ=${delta} base units < ` +
          `${DRIFT_THRESHOLD_BASE_UNITS}); grok: ${verdict.action}`,
      };
    }
  }

  return {
    kind: 'update_premium',
    routePda: route.pda,
    flightId: route.flightId,
    origin: route.origin,
    destination: route.destination,
    newPremiumBaseUnits: targetPremiumBaseUnits,
    reason:
      verdict.action === 'raise'
        ? `grok raise×${verdict.multiplier.toFixed(2)}: ${verdict.reason}`
        : `agent baseline (${verdict.reason})`,
  };
}
