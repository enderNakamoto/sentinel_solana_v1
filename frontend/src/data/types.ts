/**
 * Data layer types — the boundary between the UI and (eventually) the
 * Solana on-chain reads. Phase 12 implements these against in-memory
 * mock data; Phases 13–15 swap implementations one at a time.
 *
 * Per Phase 12 M3 (modularity rule): React components ALWAYS go through
 * `src/data/`. They never import from `@solana/kit` or `src/clients/`
 * directly for data — only for type imports if needed.
 */

export interface Airport {
  code: string;       // IATA
  name: string;
  city: string;
  lat: number;
  lon: number;
  country: string;
}

/**
 * A single open flight market. Mirrors design_system/data.jsx::FLIGHTS[]
 * shape. Phase 14 will derive this from on-chain `FlightPool` PDAs +
 * `RouteAccount.resolvedTerms` + airport metadata.
 */
export interface MarketView {
  id: string;          // flight ident, e.g. 'UA1437'
  carrier: string;
  from: string;        // IATA
  to: string;          // IATA
  dep: string;         // HH:MM local
  arr: string;         // HH:MM local
  date: string;        // 'May 9' display label
  risk: number;        // 0..1 — currently mocked from the design
  premium: number;     // PUSD display
  payout: number;      // PUSD display
  tvl: number;         // PUSD pool TVL
  slots: number;       // remaining coverage slots
  threshold: number;   // delay threshold in minutes
  depTs: string;       // 'T+18h' relative timestamp
}

/**
 * Aggregated protocol stats — the landing-page hero strip. Phase 14 will
 * derive `tvl` and `openMarkets` from chain reads (vault + controller);
 * `apy` and `avgPayoutSpeedSec` need calculator logic that's deferred.
 */
export interface ProtocolStats {
  tvl: number;             // PUSD
  tvl24hChange: number;    // PUSD delta
  apy: number;             // percent
  apy7dChange: number;     // percent delta
  openMarkets: number;
  carriers: number;
  avgPayoutSpeedSec: number;
  tvlHistory: number[];    // 30-day daily series
  apyHistory: number[];    // 30-day daily series
}

/**
 * Vault state for the Earn page. `tvl`, `lockedCapital` map directly to
 * `vault.totalManagedAssets` + `vault.lockedCapital` once wired in
 * Phase 14.
 */
export interface VaultStats {
  tvl: number;
  tvlChange24h: number;
  utilization: number;     // 0..1
  apy: number;
  tiers: VaultTier[];
  composition: VaultCompositionSlice[];
  myPosition?: MyVaultPosition;
}

export interface VaultTier {
  id: 'conservative' | 'balanced' | 'aggressive';
  label: string;
  apy: number;
  maxDrawdown: number;
  description: string;
  accentVar: '--cyan' | '--amber' | '--violet';
}

export interface VaultCompositionSlice {
  label: string;
  pct: number;
  colorVar: string;
}

export interface MyVaultPosition {
  deposited: number;
  earned: number;
  activeCoverage: number;
}

/**
 * Active or historical buyer-side policy. Mirrors
 * design_system/data.jsx::MY_POSITIONS shape. Phase 13 will derive these
 * from `getProgramAccounts(flight_pool, ...)` + memcmp on `BuyerRecord`.
 */
export interface PolicyActive {
  id: string;
  date: string;
  dep: string;
  from: string;
  to: string;
  premium: number;
  payout: number;
  status: 'tracking' | 'pre-departure';
  etaDelta: number | null;   // minutes; null if pre-departure
  threshold: number;          // minutes
}

export interface PolicyHistory {
  id: string;
  date: string;
  from: string;
  to: string;
  premium: number;
  payout: number;
  settled: number;            // PUSD actually received
  result: 'paid' | 'expired';
  delay: number;              // minutes
}

export interface MyPolicies {
  active: PolicyActive[];
  history: PolicyHistory[];
}
