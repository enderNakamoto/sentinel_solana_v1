/**
 * Globe — public component. The single entry point for any page rendering
 * a globe view.
 *
 * Per Phase 12 M2: pages import this file ONLY (never SvgGlobe directly).
 * Future swap: replace the import below with `./ThreeGlobe` (or similar)
 * and the consuming page is unchanged.
 */
export { SvgGlobe as Globe } from './SvgGlobe';
export type { GlobeProps, GlobeStyle } from './types';
