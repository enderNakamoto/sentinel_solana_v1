/**
 * Data layer — async API surface for all UI data needs.
 *
 * Per Phase 12 M3 (modularity rule): React components ALWAYS import from
 * here. They never import `@solana/kit` or `src/clients/` directly for
 * data — only for type imports if needed.
 *
 * Phase 12 implements every function via `mock.ts`. Phases 13–15 swap
 * function bodies one at a time to read from chain:
 *
 *   - Phase 13 (traveler):  getMyPolicies → getProgramAccounts(flight_pool)
 *                           with memcmp on BuyerRecord.buyer
 *   - Phase 14 (underwriter): getProtocolStats / getVaultStats →
 *                             vault.totalManagedAssets, vault.lockedCapital,
 *                             controller.totalPoliciesSold, etc.
 *                             getOpenMarkets → getProgramAccounts(flight_pool)
 *                             on FlightPool PDAs
 *   - Phase 15 (admin):     no new data fns; admin reads governance config
 *                           via the same pattern.
 *
 * Functions are async (Promise<...>) for forward-compat with real RPC
 * even though the mock implementations resolve synchronously.
 */

import {
  MOCK_AIRPORTS,
  MOCK_FLIGHTS,
  MOCK_MY_POLICIES,
  MOCK_PROTOCOL_STATS,
  MOCK_VAULT_STATS,
} from './mock';
import type {
  Airport,
  MarketView,
  MyPolicies,
  ProtocolStats,
  VaultStats,
} from './types';

export type {
  Airport,
  MarketView,
  MyPolicies,
  PolicyActive,
  PolicyHistory,
  ProtocolStats,
  VaultStats,
  VaultTier,
  VaultCompositionSlice,
  MyVaultPosition,
} from './types';

/**
 * Aggregated protocol metrics for the landing-page hero strip.
 * Phase 14: derive `tvl` from `vault.totalManagedAssets`,
 * `openMarkets` from `controller.activeFlightList.flights.length`.
 * `apy` + `avgPayoutSpeedSec` need calculator logic deferred.
 */
export async function getProtocolStats(): Promise<ProtocolStats> {
  return MOCK_PROTOCOL_STATS;
}

/**
 * All open insurance markets. Phase 14: getProgramAccounts(flight_pool)
 * filtered to active FlightPools, joined with their RouteAccount terms.
 */
export async function getOpenMarkets(): Promise<MarketView[]> {
  return MOCK_FLIGHTS;
}

/**
 * Single market by flight ident — convenience for the buy / detail flows.
 */
export async function getMarket(id: string): Promise<MarketView | null> {
  return MOCK_FLIGHTS.find((f) => f.id === id) ?? null;
}

/**
 * The connected wallet's policies — active + history.
 *
 * Phase 13: getProgramAccounts(flight_pool) with memcmp on
 * BuyerRecord.buyer (8-byte offset post-discriminator). Today returns
 * the design's mock for any wallet (or empty if no wallet param).
 */
export async function getMyPolicies(_walletAddr?: string): Promise<MyPolicies> {
  void _walletAddr; // unused in mock; Phase 13 wires the lookup
  return MOCK_MY_POLICIES;
}

/**
 * Vault overview for the Earn page. Phase 14 derives from `VaultState`
 * + share-price snapshots.
 */
export async function getVaultStats(): Promise<VaultStats> {
  return MOCK_VAULT_STATS;
}

/**
 * Airport metadata — used by the globe page for projection + labels.
 */
export async function getAirports(): Promise<Record<string, Airport>> {
  return MOCK_AIRPORTS;
}
