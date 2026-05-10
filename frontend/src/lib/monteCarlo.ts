/**
 * Monte Carlo simulation engine for Sentinel underwriter yield + protocol
 * earnings analysis. Pure TypeScript, deterministic RNG (Mulberry32 seeded
 * at 42), no React or DOM dependencies — safe to import from any
 * server/client component or test.
 *
 * Originally lived in `quant/src/lib/monteCarlo.ts` as a standalone Vite
 * app; ported into the frontend in Phase 24 so it can power the
 * `/quant` standalone page AND the embedded last slide of `/presentation`.
 */

export interface SimulationParams {
  premium: number;
  payout: number;
  numPolicies: number;
  capital: number;
  numSimulations: number;
  pMin: number;
  pMax: number;
}

export interface HistogramBin {
  binCenter: number;
  count: number;
}

export interface SimulationResult {
  meanYield: number;
  medianYield: number;
  percentile5: number;
  percentile95: number;
  stdDev: number;
  breakEvenP: number;
  profitProbability: number;
  histogram: HistogramBin[];
}

// Deterministic RNG (Mulberry32) so the simulation is reproducible
// across reloads for any given parameter set.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getPercentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function runSimulation(params: SimulationParams): SimulationResult {
  const { premium, payout, numPolicies, capital, numSimulations, pMin, pMax } = params;
  const rng = mulberry32(42);

  const yields: number[] = new Array(numSimulations);
  for (let i = 0; i < numSimulations; i++) {
    const p = pMin + rng() * (pMax - pMin);
    yields[i] = ((numPolicies * (premium - payout * p)) / capital) * 100;
  }

  const sorted = [...yields].sort((a, b) => a - b);
  const mean = yields.reduce((a, b) => a + b, 0) / yields.length;
  const variance = yields.reduce((a, b) => a + (b - mean) ** 2, 0) / yields.length;

  // Build histogram (40 bins across the observed range).
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const numBins = 40;
  const binWidth = (max - min) / numBins || 1;
  const bins: HistogramBin[] = [];

  for (let i = 0; i < numBins; i++) {
    bins.push({
      binCenter: Math.round((min + (i + 0.5) * binWidth) * 10) / 10,
      count: 0,
    });
  }

  for (const y of yields) {
    const idx = Math.min(Math.floor((y - min) / binWidth), numBins - 1);
    bins[idx].count++;
  }

  const profitCount = yields.filter((y) => y > 0).length;

  return {
    meanYield: mean,
    medianYield: getPercentile(sorted, 50),
    percentile5: getPercentile(sorted, 5),
    percentile95: getPercentile(sorted, 95),
    stdDev: Math.sqrt(variance),
    breakEvenP: premium / payout,
    profitProbability: (profitCount / numSimulations) * 100,
    histogram: bins,
  };
}

export function computeYieldAtP(
  premium: number,
  payout: number,
  numPolicies: number,
  capital: number,
  p: number,
): number {
  return ((numPolicies * (premium - payout * p)) / capital) * 100;
}

export const DEFAULT_PARAMS: SimulationParams = {
  premium: 20,
  payout: 100,
  numPolicies: 10000,
  capital: 100000,
  numSimulations: 10000,
  pMin: 0.01,
  pMax: 0.2,
};
