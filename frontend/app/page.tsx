'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Sparkline } from '@/components/Sparkline';
import { FlightRoute } from '@/components/FlightRoute';
import { RiskBar } from '@/components/RiskBar';
import {
  getOpenMarkets,
  getProtocolStats,
  type MarketView,
  type ProtocolStats,
} from '@/data';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Home / Landing page.
 *
 * Phase 12: all data via the mock src/data layer. Phase 14 swaps the
 * data fns to read from chain — this component stays unchanged (M3).
 */
export default function HomePage() {
  const { mode } = useTheme();
  const isFun = mode === 'fun';
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [markets, setMarkets] = useState<MarketView[]>([]);

  useEffect(() => {
    void Promise.all([getProtocolStats(), getOpenMarkets()]).then(
      ([s, m]) => {
        setStats(s);
        setMarkets(m.slice(0, 5));
      },
    );
  }, []);

  return (
    <div className="page" style={{ paddingTop: 0, maxWidth: 1280 }}>
      {/* HERO */}
      <section
        style={{ position: 'relative', padding: '80px 0 100px', overflow: 'hidden' }}
        className="grain"
      >
        <div className="horizon" />
        <div
          className="grid-bg"
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.4,
            maskImage:
              'radial-gradient(ellipse at 50% 60%, #000, transparent 70%)',
          }}
        />
        <div style={{ position: 'relative', maxWidth: 880 }}>
          <div className="h-eyebrow">
            {isFun
              ? 'AeroQuest · The Skies of Solana'
              : 'Parametric flight delay protocol · Solana'}
          </div>
          <h1 className="display">
            {isFun ? (
              <>
                A wager <em>on</em> the<br />
                fickle <em>winds.</em>
              </>
            ) : (
              <>
                Insurance <em>and</em> alpha,<br />
                for every <em>delayed</em> flight.
              </>
            )}
          </h1>
          <p className="lede" style={{ marginTop: 28, fontSize: 19 }}>
            {isFun
              ? 'Charter a coverage scroll for any flight — claim your gold the moment the gale carries it astray. Or fund the underwriter chest and earn the spread when skies stay clear.'
              : 'Pay a small premium to get an instant payout when your flight is late. Or deposit into the vault and underwrite the risk for yield. Settled on-chain by oracles, no claims.'}
          </p>
          <div className="row" style={{ marginTop: 36, gap: 12, flexWrap: 'wrap' }}>
            <Link href="/buy" className="btn primary lg">
              {isFun ? 'Bind a flight →' : 'Cover a flight →'}
            </Link>
            <Link href="/earn" className="btn lg">
              {isFun ? 'Open the vault' : 'Earn 12.4% APY'}
            </Link>
            <Link href="/markets" className="btn ghost lg">
              {isFun ? 'Watch the sky map' : 'Watch live markets'}
            </Link>
            <Link
              href="/presentation"
              className="btn ghost lg"
              style={{
                borderColor: 'var(--violet)',
                color: 'var(--violet)',
              }}
            >
              {isFun ? 'Read the chronicle ↗' : 'View pitch ↗'}
            </Link>
          </div>
        </div>

        {/* Floating stat strip */}
        <div
          style={{
            position: 'relative',
            marginTop: 80,
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 0,
            border: '1px solid var(--line)',
            borderRadius: 12,
            background: 'var(--bg-1)',
            overflow: 'hidden',
          }}
        >
          {[
            {
              k: 'Total Value Locked',
              v: stats ? `$${(stats.tvl / 1_000_000).toFixed(2)}M` : '—',
              d: stats
                ? `+$${(stats.tvl24hChange / 1000).toFixed(0)}k 24h`
                : '—',
              spark: stats?.tvlHistory,
              color: 'var(--cyan)',
              fill: 'rgba(94,224,210,.12)',
            },
            {
              k: 'Vault APY',
              v: stats ? `${stats.apy.toFixed(1)}%` : '—',
              d: stats ? `+${stats.apy7dChange.toFixed(1)}% week` : '—',
              spark: stats?.apyHistory,
              color: 'var(--amber)',
              fill: 'rgba(255,181,71,.12)',
            },
            {
              k: 'Open Markets',
              v: stats ? `${stats.openMarkets}` : '—',
              d: stats ? `${stats.carriers} carriers` : '—',
              spark: undefined,
              color: 'var(--cyan)',
              fill: 'rgba(94,224,210,.12)',
            },
            {
              k: 'Avg. Payout Speed',
              v: stats ? `${stats.avgPayoutSpeedSec.toFixed(1)}s` : '—',
              d: 'after touchdown',
              spark: undefined,
              color: 'var(--cyan)',
              fill: 'rgba(94,224,210,.12)',
            },
          ].map((s, i) => (
            <div
              key={s.k}
              style={{
                padding: 22,
                borderRight: i < 3 ? '1px solid var(--line)' : 'none',
              }}
            >
              <div className="stat-label">{s.k}</div>
              <div className="stat-value" style={{ marginTop: 8 }}>
                {s.v}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                }}
              >
                <div className="stat-delta">{s.d}</div>
                {s.spark && (
                  <div style={{ width: 80 }}>
                    <Sparkline
                      data={s.spark}
                      color={s.color}
                      fill={s.fill}
                      height={28}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section style={{ padding: '60px 0' }}>
        <div className="h-eyebrow">How it works</div>
        <h2 className="section" style={{ maxWidth: 720 }}>
          Two sides of one <em>market.</em>
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 24,
            marginTop: 40,
          }}
        >
          <SideCard
            tag="For travelers"
            color="var(--amber)"
            title="Buy parametric coverage"
            steps={[
              ['01', 'Pick your flight from the whitelisted set.'],
              ['02', 'Pay a premium based on real-time delay odds.'],
              [
                '03',
                'If delay > threshold, payout hits your wallet automatically.',
              ],
            ]}
            example="UA1437 SFO→JFK · 12.40 USDC premium · 180 USDC payout if >60min late"
          />
          <SideCard
            tag="For underwriters"
            color="var(--cyan)"
            title="Deposit and earn"
            steps={[
              [
                '01',
                'Deposit USDC into a risk tier (Conservative / Balanced / Aggressive).',
              ],
              [
                '02',
                'The vault pools premiums and writes coverage across all open markets.',
              ],
              [
                '03',
                'Earn the spread when delays don’t hit. Withdraw any time.',
              ],
            ]}
            example="Balanced tier · 12.4% APY · 14d historical drawdown 0.8%"
          />
        </div>
      </section>

      {/* LIVE MARKETS PEEK */}
      <section style={{ padding: '40px 0' }}>
        <div className="row between" style={{ marginBottom: 18 }}>
          <div>
            <div className="h-eyebrow">Live now</div>
            <h2 className="section">
              Markets open for <em>coverage.</em>
            </h2>
          </div>
          <Link href="/markets" className="btn">
            View all {stats?.openMarkets ?? '—'} →
          </Link>
        </div>
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <table className="t">
            <thead>
              <tr>
                <th>Flight</th>
                <th>Route</th>
                <th>Departs</th>
                <th>Premium</th>
                <th>Payout</th>
                <th>Delay odds</th>
                <th>Coverage left</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {markets.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className="num" style={{ fontSize: 14 }}>
                      {f.id}
                    </span>
                    <div className="carrier">{f.carrier}</div>
                  </td>
                  <td>
                    <FlightRoute from={f.from} to={f.to} />
                  </td>
                  <td>
                    <span className="num muted">{f.depTs}</span>
                  </td>
                  <td>
                    <span className="num">
                      {f.premium.toFixed(2)} <span className="muted">USDC</span>
                    </span>
                  </td>
                  <td>
                    <span className="num" style={{ color: 'var(--cyan)' }}>
                      {f.payout} <span className="muted">USDC</span>
                    </span>
                  </td>
                  <td>
                    <RiskBar risk={f.risk} />
                  </td>
                  <td>
                    <span className="num">{f.slots} slots</span>
                  </td>
                  <td>
                    <Link
                      href="/buy"
                      className="btn primary"
                      style={{ padding: '6px 12px' }}
                    >
                      Cover
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* TRUST STRIP */}
      <section style={{ padding: '70px 0 30px', textAlign: 'center' }}>
        <div className="mono-tiny" style={{ marginBottom: 26 }}>
          Settlement & data
        </div>
        <div
          className="row"
          style={{
            justifyContent: 'center',
            gap: 56,
            fontFamily: 'var(--mono)',
            fontSize: 14,
            color: 'var(--ink-2)',
          }}
        >
          <span>◇ ACARS Oracle</span>
          <span>◈ FlightAware</span>
          <span>◇ Switchboard</span>
          <span>◆ Squads Multisig</span>
        </div>
      </section>
    </div>
  );
}

interface SideCardProps {
  tag: string;
  color: string;
  title: string;
  steps: Array<[string, string]>;
  example: string;
}

function SideCard({ tag, color, title, steps, example }: SideCardProps) {
  return (
    <div className="card" style={{ padding: 28, position: 'relative', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: color,
          opacity: 0.6,
        }}
      />
      <div className="mono-tiny" style={{ color }}>
        {tag}
      </div>
      <h3
        style={{
          fontSize: 26,
          fontWeight: 400,
          letterSpacing: '-0.02em',
          margin: '10px 0 24px',
        }}
      >
        {title}
      </h3>
      <div className="col" style={{ gap: 18 }}>
        {steps.map(([n, t]) => (
          <div
            key={n}
            className="row"
            style={{ gap: 14, alignItems: 'flex-start' }}
          >
            <span
              className="mono"
              style={{ fontSize: 11, color: 'var(--ink-3)', paddingTop: 3 }}
            >
              {n}
            </span>
            <span style={{ fontSize: 15, color: 'var(--ink)', lineHeight: 1.5 }}>
              {t}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 24,
          padding: 14,
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          color: 'var(--ink-2)',
        }}
      >
        {example}
      </div>
    </div>
  );
}
