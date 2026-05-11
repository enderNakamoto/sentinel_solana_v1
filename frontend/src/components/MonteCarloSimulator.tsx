'use client';

import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  DEFAULT_PARAMS,
  runSimulation,
  type SimulationParams,
} from '@/lib/monteCarlo';

// Frontend palette literals — Recharts SVG attributes don't resolve CSS
// vars, so the chart needs concrete hex. Everything outside the chart
// uses var(--*) tokens via inline style.
const COLOR = {
  cyan: '#5ee0d2',
  green: '#7ee787',
  amber: '#ffb547',
  red: '#ff5d6c',
  line: '#1e2533',
  ink: '#eef1f7',
  ink2: '#b6becd',
  ink3: '#6b7385',
  bg1: '#0b0f17',
} as const;

// ─── Sub-components ──────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
  subtext,
}: {
  label: string;
  value: string;
  color: string;
  subtext?: string;
}) {
  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
      }}
    >
      <p
        className="text-[11px] uppercase mb-1.5"
        style={{
          letterSpacing: '0.15em',
          color: 'var(--ink-3)',
        }}
      >
        {label}
      </p>
      <p
        className="text-2xl font-bold"
        style={{ color, fontFamily: 'var(--mono)' }}
      >
        {value}
      </p>
      {subtext && (
        <p className="text-xs mt-1" style={{ color: 'var(--ink-3)' }}>
          {subtext}
        </p>
      )}
    </div>
  );
}

function ParamSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline">
        <label className="text-xs" style={{ color: 'var(--ink-3)' }}>
          {label}
        </label>
        <span
          className="text-sm"
          style={{ color: 'var(--ink)', fontFamily: 'var(--mono)' }}
        >
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mc-slider w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{
          accentColor: 'var(--cyan)',
          background: 'var(--line)',
        }}
      />
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { binCenter: number; count: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
      }}
    >
      <p style={{ color: 'var(--ink)', fontFamily: 'var(--mono)' }}>
        Yield: {data.binCenter.toFixed(1)}%
      </p>
      <p style={{ color: 'var(--ink-3)' }}>{data.count} simulations</p>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────

interface MonteCarloSimulatorProps {
  /** Show the top hero (eyebrow + h1 + lead). Default true. */
  showHero?: boolean;
}

export default function MonteCarloSimulator({
  showHero = true,
}: MonteCarloSimulatorProps = {}) {
  const [params, setParams] = useState<SimulationParams>(DEFAULT_PARAMS);
  const [protocolFeeRate, setProtocolFeeRate] = useState(0.05);
  const [protocolCapital, setProtocolCapital] = useState(50000);

  const update = (key: keyof SimulationParams, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  const result = useMemo(() => runSimulation(params), [params]);

  const protocolEarnings = useMemo(() => {
    const totalPremiums = params.numPolicies * params.premium;
    const feeIncome = totalPremiums * protocolFeeRate;
    const vaultYieldPct = result.meanYield / 100;
    const vaultIncome = protocolCapital * vaultYieldPct;
    const totalEarnings = feeIncome + vaultIncome;
    return { totalPremiums, feeIncome, vaultIncome, totalEarnings, vaultYieldPct };
  }, [params, protocolFeeRate, protocolCapital, result.meanYield]);

  return (
    <div className="w-full" style={{ color: 'var(--ink)' }}>
      <style>{`
        .mc-slider::-webkit-slider-thumb {
          appearance: none; -webkit-appearance: none;
          width: 16px; height: 16px; border-radius: 50%;
          background: var(--cyan); border: 2px solid var(--bg-1);
          box-shadow: 0 0 0 1px var(--cyan); cursor: pointer;
        }
        .mc-slider::-moz-range-thumb {
          width: 16px; height: 16px; border-radius: 50%;
          background: var(--cyan); border: 2px solid var(--bg-1);
          box-shadow: 0 0 0 1px var(--cyan); cursor: pointer;
        }
      `}</style>
      {/* ─── Hero ─── */}
      {showHero && (
        <section className="max-w-6xl mx-auto px-6 pt-10 pb-8">
          <p
            className="text-[11px] uppercase mb-3"
            style={{ letterSpacing: '0.15em', color: 'var(--cyan)' }}
          >
            Quantitative Analysis
          </p>
          <h1
            className="text-4xl md:text-5xl font-extrabold tracking-tight leading-tight mb-3"
            style={{ color: 'var(--ink)' }}
          >
            A poor man&apos;s{' '}
            <span style={{ color: 'var(--cyan)' }}>Monte Carlo.</span>
          </h1>
          <p
            className="text-base md:text-lg leading-relaxed max-w-3xl mb-6"
            style={{ color: 'var(--ink-2)' }}
          >
            For every set of parameters below &mdash; premium, payout, policy volume,
            vault capital &mdash; we draw{' '}
            <strong style={{ color: 'var(--ink)' }}>10,000 random delay rates</strong>{' '}
            and compute the underwriter&apos;s yield each time. The histogram is the
            distribution of outcomes; the four cards above are its summary stats.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl">
            <div
              className="rounded-xl p-5 border"
              style={{
                background: 'rgba(94,224,210,0.06)',
                borderColor: 'rgba(94,224,210,0.3)',
              }}
            >
              <p
                className="text-[11px] uppercase mb-2"
                style={{ letterSpacing: '0.15em', color: 'var(--cyan)' }}
              >
                What this does
              </p>
              <p
                className="text-sm leading-relaxed"
                style={{ color: 'var(--ink-2)' }}
              >
                Each trial picks a delay probability{' '}
                <code style={{ color: 'var(--ink)', fontFamily: 'var(--mono)' }}>p</code>{' '}
                uniformly between the min/max sliders, then applies the parametric
                formula{' '}
                <code style={{ color: 'var(--ink)', fontFamily: 'var(--mono)' }}>
                  yield = M&middot;(&pi; &minus; &lambda;&middot;p) / C
                </code>
                . 10,000 trials give us a mean, a 5th/95th percentile, and a profit
                probability for the vault.
              </p>
            </div>

            <div
              className="rounded-xl p-5 border"
              style={{
                background: 'rgba(255,181,71,0.06)',
                borderColor: 'rgba(255,181,71,0.3)',
              }}
            >
              <p
                className="text-[11px] uppercase mb-2"
                style={{ letterSpacing: '0.15em', color: 'var(--amber)' }}
              >
                Why &ldquo;poor man&apos;s&rdquo;
              </p>
              <p
                className="text-sm leading-relaxed"
                style={{ color: 'var(--ink-2)' }}
              >
                A real Monte Carlo would calibrate{' '}
                <code style={{ color: 'var(--ink)', fontFamily: 'var(--mono)' }}>p</code>{' '}
                to historical BTS data per route, draw individual flight outcomes
                (Bernoulli, not an average), and model correlated outages when storms
                hit a hub. Ours uses a flat uniform distribution &mdash; good enough
                to sanity-check that the economics work, not good enough to set
                premiums. That&apos;s why on-chain pricing comes from the{' '}
                <strong style={{ color: 'var(--ink)' }}>XGBoost + Grok agent</strong>,
                not from this page.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ─── Key Stats ─── */}
      <section className="max-w-6xl mx-auto px-6 pb-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Average Yield"
            value={`${result.meanYield >= 0 ? '+' : ''}${result.meanYield.toFixed(1)}%`}
            color="var(--cyan)"
            subtext="Mean across all trials"
          />
          <StatCard
            label="Worst Case (5th %ile)"
            value={`${result.percentile5 >= 0 ? '+' : ''}${result.percentile5.toFixed(1)}%`}
            color={result.percentile5 >= 0 ? 'var(--amber)' : 'var(--red)'}
            subtext="5% of outcomes are worse"
          />
          <StatCard
            label="Best Case (95th %ile)"
            value={`+${result.percentile95.toFixed(1)}%`}
            color="var(--green)"
            subtext="5% of outcomes are better"
          />
          <StatCard
            label="Profit Probability"
            value={`${result.profitProbability.toFixed(1)}%`}
            color={
              result.profitProbability >= 90
                ? 'var(--green)'
                : result.profitProbability >= 50
                  ? 'var(--amber)'
                  : 'var(--red)'
            }
            subtext="Chance of positive return"
          />
        </div>
      </section>

      {/* ─── Interactive Panel ─── */}
      <section className="max-w-6xl mx-auto px-6 pb-12">
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          {/* Controls */}
          <div
            className="rounded-xl p-5 space-y-6"
            style={{
              background: 'var(--bg-1)',
              border: '1px solid var(--line)',
            }}
          >
            <div>
              <p
                className="text-[11px] uppercase mb-4"
                style={{ letterSpacing: '0.15em', color: 'var(--cyan)' }}
              >
                Policy Terms
              </p>
              <div className="space-y-4">
                <ParamSlider
                  label="Premium (π)"
                  value={params.premium}
                  onChange={(v) => update('premium', v)}
                  min={1}
                  max={50}
                  step={1}
                  format={(v) => `$${v}`}
                />
                <ParamSlider
                  label="Payout (λ)"
                  value={params.payout}
                  onChange={(v) => update('payout', v)}
                  min={50}
                  max={500}
                  step={10}
                  format={(v) => `$${v}`}
                />
              </div>
            </div>

            <div>
              <p
                className="text-[11px] uppercase mb-4"
                style={{ letterSpacing: '0.15em', color: 'var(--cyan)' }}
              >
                Scale
              </p>
              <div className="space-y-4">
                <ParamSlider
                  label="Policies Sold (M)"
                  value={params.numPolicies}
                  onChange={(v) => update('numPolicies', v)}
                  min={100}
                  max={50000}
                  step={100}
                  format={(v) => v.toLocaleString()}
                />
                <ParamSlider
                  label="Capital (C)"
                  value={params.capital}
                  onChange={(v) => update('capital', v)}
                  min={10000}
                  max={1000000}
                  step={10000}
                  format={(v) => `$${v.toLocaleString()}`}
                />
              </div>
            </div>

            <div>
              <p
                className="text-[11px] uppercase mb-4"
                style={{ letterSpacing: '0.15em', color: 'var(--cyan)' }}
              >
                Delay Probability Range
              </p>
              <div className="space-y-4">
                <ParamSlider
                  label="Min Delay Rate"
                  value={params.pMin}
                  onChange={(v) => update('pMin', v)}
                  min={0.01}
                  max={0.15}
                  step={0.01}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <ParamSlider
                  label="Max Delay Rate"
                  value={params.pMax}
                  onChange={(v) => update('pMax', v)}
                  min={0.1}
                  max={0.4}
                  step={0.01}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                />
              </div>
            </div>

            <div
              className="pt-2"
              style={{ borderTop: '1px solid var(--line)' }}
            >
              <div className="flex justify-between items-baseline">
                <span className="text-xs" style={{ color: 'var(--ink-3)' }}>
                  Break-even delay rate
                </span>
                <span
                  className="text-sm"
                  style={{ color: 'var(--amber)', fontFamily: 'var(--mono)' }}
                >
                  p* = {(result.breakEvenP * 100).toFixed(0)}%
                </span>
              </div>
              <p
                className="text-[10px] mt-1"
                style={{ color: 'var(--ink-3)' }}
              >
                Above this rate, underwriters lose money
              </p>
            </div>
          </div>

          {/* Chart */}
          <div
            className="rounded-xl p-5"
            style={{
              background: 'var(--bg-1)',
              border: '1px solid var(--line)',
            }}
          >
            <p
              className="text-[11px] uppercase mb-4"
              style={{ letterSpacing: '0.15em', color: 'var(--cyan)' }}
            >
              Distribution of Simulated Yields ({params.numSimulations.toLocaleString()} trials)
            </p>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart
                data={result.histogram}
                margin={{ top: 36, right: 40, bottom: 24, left: 16 }}
              >
                <CartesianGrid stroke={COLOR.line} strokeDasharray="3 3" />
                <XAxis
                  dataKey="binCenter"
                  tick={{ fill: COLOR.ink3, fontSize: 10 }}
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  interval={Math.max(0, Math.floor(result.histogram.length / 8) - 1)}
                  padding={{ left: 32, right: 32 }}
                  axisLine={{ stroke: COLOR.line }}
                  tickLine={{ stroke: COLOR.line }}
                  label={{
                    value: 'Yield (%)',
                    position: 'insideBottom',
                    offset: -10,
                    fill: COLOR.ink3,
                    fontSize: 11,
                  }}
                />
                <YAxis
                  tick={{ fill: COLOR.ink3, fontSize: 10 }}
                  axisLine={{ stroke: COLOR.line }}
                  tickLine={{ stroke: COLOR.line }}
                  label={{
                    value: 'Frequency',
                    angle: -90,
                    position: 'insideLeft',
                    offset: 10,
                    fill: COLOR.ink3,
                    fontSize: 11,
                  }}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ fill: 'rgba(94,224,210,0.08)' }}
                />
                <ReferenceLine
                  x={result.histogram.reduce((closest, bin) =>
                    Math.abs(bin.binCenter - result.meanYield) <
                    Math.abs(closest.binCenter - result.meanYield)
                      ? bin
                      : closest,
                  ).binCenter}
                  stroke={COLOR.red}
                  strokeDasharray="6 3"
                  strokeWidth={2}
                  label={{
                    value: `Mean: ${result.meanYield.toFixed(0)}%`,
                    position: 'top',
                    fill: COLOR.red,
                    fontSize: 11,
                  }}
                />
                <ReferenceLine
                  x={result.histogram.reduce((closest, bin) =>
                    Math.abs(bin.binCenter - result.percentile5) <
                    Math.abs(closest.binCenter - result.percentile5)
                      ? bin
                      : closest,
                  ).binCenter}
                  stroke={COLOR.amber}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{
                    value: `5th: ${result.percentile5.toFixed(0)}%`,
                    position: 'insideTopLeft',
                    offset: 6,
                    fill: COLOR.amber,
                    fontSize: 10,
                  }}
                />
                <ReferenceLine
                  x={result.histogram.reduce((closest, bin) =>
                    Math.abs(bin.binCenter - result.percentile95) <
                    Math.abs(closest.binCenter - result.percentile95)
                      ? bin
                      : closest,
                  ).binCenter}
                  stroke={COLOR.green}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{
                    value: `95th: ${result.percentile95.toFixed(0)}%`,
                    position: 'insideTopRight',
                    offset: 6,
                    fill: COLOR.green,
                    fontSize: 10,
                  }}
                />
                <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                  {result.histogram.map((entry, idx) => (
                    <Cell
                      key={idx}
                      fill={
                        entry.binCenter >= 0
                          ? 'rgba(94,224,210,0.7)'
                          : 'rgba(255,93,108,0.7)'
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* ─── Protocol Earnings Explorer ─── */}
      <section className="max-w-6xl mx-auto px-6 pb-12">
        <p
          className="text-[11px] uppercase mb-4"
          style={{ letterSpacing: '0.15em', color: 'var(--cyan)' }}
        >
          Protocol Earnings Explorer
        </p>
        <div
          className="rounded-xl p-6"
          style={{
            background: 'var(--bg-1)',
            border: '1px solid var(--line)',
          }}
        >
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-8">
            <div className="space-y-5">
              <ParamSlider
                label="Protocol Fee Rate"
                value={protocolFeeRate}
                onChange={setProtocolFeeRate}
                min={0.01}
                max={0.2}
                step={0.01}
                format={(v) => `${(v * 100).toFixed(0)}%`}
              />
              <ParamSlider
                label="Protocol Capital in Vault"
                value={protocolCapital}
                onChange={setProtocolCapital}
                min={10000}
                max={500000}
                step={5000}
                format={(v) => `$${v.toLocaleString()}`}
              />
              <div
                className="pt-3"
                style={{ borderTop: '1px solid var(--line)' }}
              >
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-xs" style={{ color: 'var(--ink-3)' }}>
                    Vault Yield (mean)
                  </span>
                  <span
                    className="text-sm"
                    style={{
                      color: result.meanYield >= 0 ? 'var(--green)' : 'var(--red)',
                      fontFamily: 'var(--mono)',
                    }}
                  >
                    {result.meanYield >= 0 ? '+' : ''}
                    {result.meanYield.toFixed(1)}%
                  </span>
                </div>
                <p
                  className="text-[10px]"
                  style={{ color: 'var(--ink-3)' }}
                >
                  From Monte Carlo simulation above
                </p>
              </div>
            </div>

            <div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <StatCard
                  label="Premium Fee Income"
                  value={`$${Math.round(protocolEarnings.feeIncome).toLocaleString()}`}
                  color="var(--cyan)"
                  subtext={`${(protocolFeeRate * 100).toFixed(0)}% of $${protocolEarnings.totalPremiums.toLocaleString()}`}
                />
                <StatCard
                  label="Vault Yield Income"
                  value={`${protocolEarnings.vaultIncome >= 0 ? '' : '-'}$${Math.abs(Math.round(protocolEarnings.vaultIncome)).toLocaleString()}`}
                  color={
                    protocolEarnings.vaultIncome >= 0
                      ? 'var(--green)'
                      : 'var(--red)'
                  }
                  subtext={`${result.meanYield.toFixed(1)}% on $${protocolCapital.toLocaleString()}`}
                />
                <StatCard
                  label="Total Protocol Earnings"
                  value={`${protocolEarnings.totalEarnings >= 0 ? '' : '-'}$${Math.abs(Math.round(protocolEarnings.totalEarnings)).toLocaleString()}`}
                  color={
                    protocolEarnings.totalEarnings >= 0
                      ? 'var(--green)'
                      : 'var(--red)'
                  }
                  subtext="Fee + Vault yield"
                />
                <StatCard
                  label="Earnings Split"
                  value={
                    protocolEarnings.totalEarnings > 0
                      ? `${((protocolEarnings.feeIncome / protocolEarnings.totalEarnings) * 100).toFixed(0)}% / ${((protocolEarnings.vaultIncome / protocolEarnings.totalEarnings) * 100).toFixed(0)}%`
                      : '—'
                  }
                  color="var(--amber)"
                  subtext="Fee vs Vault"
                />
              </div>

              <div className="space-y-2">
                <div
                  className="flex justify-between text-[10px] uppercase"
                  style={{
                    color: 'var(--ink-3)',
                    letterSpacing: '0.1em',
                  }}
                >
                  <span>Earnings Composition</span>
                  <span>
                    Total: $
                    {Math.abs(Math.round(protocolEarnings.totalEarnings)).toLocaleString()}
                  </span>
                </div>
                {protocolEarnings.totalEarnings > 0 ? (
                  <div
                    className="h-6 rounded-full overflow-hidden flex"
                    style={{ background: 'var(--line)' }}
                  >
                    <div
                      className="h-full rounded-l-full transition-all duration-300"
                      style={{
                        width: `${(protocolEarnings.feeIncome / protocolEarnings.totalEarnings) * 100}%`,
                        background: 'rgba(94,224,210,0.6)',
                      }}
                    />
                    <div
                      className="h-full rounded-r-full transition-all duration-300"
                      style={{
                        width: `${(Math.max(0, protocolEarnings.vaultIncome) / protocolEarnings.totalEarnings) * 100}%`,
                        background: 'rgba(126,231,135,0.6)',
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className="h-6 rounded-full"
                    style={{ background: 'rgba(255,93,108,0.3)' }}
                  />
                )}
                <div className="flex gap-4 text-[10px]">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: 'rgba(94,224,210,0.6)' }}
                    />
                    <span style={{ color: 'var(--ink-3)' }}>Premium Fees</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: 'rgba(126,231,135,0.6)' }}
                    />
                    <span style={{ color: 'var(--ink-3)' }}>Vault Yield</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
