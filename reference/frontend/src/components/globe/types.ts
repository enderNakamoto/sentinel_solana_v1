/**
 * Public Globe API. Per Phase 12 M2 (modularity rule): pages import only
 * from `./Globe`. The default export of Globe.tsx is the current
 * implementation — Phase 14 (or later) will swap to a ThreeJS / Mapbox
 * implementation behind this same prop interface.
 */

import type { MarketView, Airport } from '@/data';

export type GlobeStyle = 'arcs' | 'wire' | 'flat';

export interface GlobeProps {
  markets: MarketView[];
  airports: Record<string, Airport>;
  selectedId?: string | null;
  style?: GlobeStyle;
  spin?: boolean;
  onSelectMarket?: (id: string) => void;
}
