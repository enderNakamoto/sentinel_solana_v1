'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useWalletSession } from '@solana/react-hooks';
import { FlightRoute } from '@/components/FlightRoute';
import { useToast } from '@/components/Toast';
import { useTheme } from '@/theme/ThemeProvider';
import {
  getMyPolicies,
  type MyPolicies,
  type PolicyActive,
  type PolicyHistory,
} from '@/data';

/**
 * Portfolio page — Active + History tabs.
 * Phase 12: data via mock; "Claim" button stubs `flight_pool.claim`.
 * Phase 13 wires the real ix.
 */
export default function PortfolioPage() {
  const { mode } = useTheme();
  const isFun = mode === 'fun';
  const { show } = useToast();
  const session = useWalletSession();
  const [policies, setPolicies] = useState<MyPolicies | null>(null);
  const [tab, setTab] = useState<'active' | 'history'>('active');

  useEffect(() => {
    void getMyPolicies(session?.account.address).then((p) => setPolicies(p));
  }, [session?.account.address]);

  const summary = useMemo(() => {
    if (!policies) return null;
    const totalPaid = policies.history.reduce((s, p) => s + p.settled, 0);
    const totalPremium =
      policies.history.reduce((s, p) => s + p.premium, 0) +
      policies.active.reduce((s, p) => s + p.premium, 0);
    const winRate = policies.history.length
      ? Math.round(
          (policies.history.filter((p) => p.result === 'paid').length /
            policies.history.length) *
            100,
        )
      : 0;
    const activeCoverage = policies.active.reduce((s, p) => s + p.payout, 0);
    return { totalPaid, totalPremium, winRate, activeCoverage };
  }, [policies]);

  function handleClaim(p: PolicyActive | PolicyHistory) {
    console.log('TODO: flight_pool.claim', { flightId: p.id });
    show({
      kind: 'success',
      title: isFun ? `Reward collected · ${p.id}` : `Claim submitted · ${p.id}`,
      body: `${p.payout} USDC payout · TODO: real ix wiring`,
    });
  }

  if (!policies || !summary) {
    return (
      <div className="page" style={{ maxWidth: 1280 }}>
        <div className="muted mono">Loading portfolio…</div>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="row between" style={{ marginBottom: 26 }}>
        <div>
          <div className="h-eyebrow">{isFun ? 'Adventurer log' : 'Portfolio'}</div>
          <h1
            style={{
              fontSize: 44,
              fontWeight: 400,
              letterSpacing: '-0.03em',
              margin: 0,
            }}
          >
            {isFun ? (
              <>
                Your{' '}
                <span
                  style={{
                    fontFamily: 'var(--serif)',
                    fontStyle: 'italic',
                    color: 'var(--amber)',
                  }}
                >
                  scrolls.
                </span>
              </>
            ) : (
              <>
                Your{' '}
                <span
                  style={{
                    fontFamily: 'var(--serif)',
                    fontStyle: 'italic',
                    color: 'var(--amber)',
                  }}
                >
                  coverage.
                </span>
              </>
            )}
          </h1>
        </div>
        <Link href="/buy" className="btn primary">
          {isFun ? '+ Bind another' : '+ New coverage'}
        </Link>
      </div>

      {/* Summary stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 16,
          marginBottom: 28,
        }}
      >
        {[
          ['Active coverage', `$${summary.activeCoverage}`, `${policies.active.length} flights`, 'var(--amber)'],
          ['Lifetime payouts', `$${summary.totalPaid}`, `${policies.history.filter((p) => p.result === 'paid').length} paid claims`, 'var(--cyan)'],
          ['Total premium spent', `$${summary.totalPremium.toFixed(0)}`, `across ${policies.active.length + policies.history.length} flights`, 'var(--ink)'],
          ['Hit rate', `${summary.winRate}%`, 'historical', 'var(--green)'],
        ].map(([k, v, sub, c], i) => (
          <div key={i} className="card">
            <div className="stat-label">{k}</div>
            <div
              className="stat-value"
              style={{ color: c, marginTop: 8 }}
            >
              {v}
            </div>
            <div className="muted mono" style={{ fontSize: 10.5, marginTop: 4 }}>
              {sub}
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === 'active' ? 'active' : ''}`}
          onClick={() => setTab('active')}
        >
          Active{' '}
          <span className="muted mono" style={{ fontSize: 10, marginLeft: 6 }}>
            {policies.active.length}
          </span>
        </button>
        <button
          type="button"
          className={`tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => setTab('history')}
        >
          History{' '}
          <span className="muted mono" style={{ fontSize: 10, marginLeft: 6 }}>
            {policies.history.length}
          </span>
        </button>
      </div>

      {tab === 'active' ? (
        <div className="col" style={{ gap: 14 }}>
          {policies.active.map((p) => {
            const tracking = p.status === 'tracking';
            const willHit =
              p.etaDelta != null && p.etaDelta >= p.threshold * 0.6;
            const eligibleClaim =
              p.etaDelta != null && p.etaDelta >= p.threshold;
            return (
              <div
                key={p.id}
                className="card"
                style={{ padding: 0, overflow: 'hidden' }}
              >
                <div
                  style={{
                    padding: 18,
                    display: 'grid',
                    gridTemplateColumns: '1.6fr 1fr 1fr 1fr 0.8fr',
                    gap: 16,
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      <span className="num" style={{ fontSize: 18 }}>
                        {p.id}
                      </span>
                      {tracking ? (
                        <span className="badge cyan">● Tracking</span>
                      ) : (
                        <span className="badge">Pre-departure</span>
                      )}
                    </div>
                    <div
                      className="row"
                      style={{ gap: 10, marginTop: 10, alignItems: 'center' }}
                    >
                      <FlightRoute from={p.from} to={p.to} />
                      <span className="muted mono" style={{ fontSize: 11 }}>
                        {p.date} · {p.dep}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="mono-tiny">Premium paid</div>
                    <div
                      className="num"
                      style={{ fontSize: 16, marginTop: 4 }}
                    >
                      {p.premium.toFixed(2)} <span className="muted">USDC</span>
                    </div>
                  </div>
                  <div>
                    <div className="mono-tiny">Potential payout</div>
                    <div
                      className="num"
                      style={{
                        fontSize: 16,
                        color: 'var(--cyan)',
                        marginTop: 4,
                      }}
                    >
                      {p.payout} <span className="muted">USDC</span>
                    </div>
                  </div>
                  <div>
                    <div className="mono-tiny">Current ETA delta</div>
                    {p.etaDelta != null ? (
                      <div
                        className="num"
                        style={{
                          fontSize: 16,
                          marginTop: 4,
                          color: willHit ? 'var(--amber)' : 'var(--ink)',
                        }}
                      >
                        {p.etaDelta} min
                      </div>
                    ) : (
                      <div
                        className="muted mono"
                        style={{ marginTop: 4, fontSize: 13 }}
                      >
                        —
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {eligibleClaim ? (
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => handleClaim(p)}
                      >
                        Claim
                      </button>
                    ) : (
                      <button type="button" className="btn">
                        Details
                      </button>
                    )}
                  </div>
                </div>
                {tracking && p.etaDelta != null && (
                  <div
                    style={{
                      padding: '10px 18px 16px',
                      borderTop: '1px solid var(--line)',
                      background: 'var(--bg)',
                    }}
                  >
                    <div className="row between" style={{ marginBottom: 6 }}>
                      <span className="mono-tiny">
                        Delay vs trigger ({p.threshold}m)
                      </span>
                      <span
                        className="mono muted"
                        style={{ fontSize: 10.5 }}
                      >
                        +{p.etaDelta}m / +{p.threshold}m
                      </span>
                    </div>
                    <div className="progress" style={{ height: 4 }}>
                      <div
                        style={{
                          width: `${Math.min(100, (p.etaDelta / p.threshold) * 100)}%`,
                          background: willHit ? 'var(--amber)' : 'var(--cyan)',
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
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
                <th>Date</th>
                <th>Premium</th>
                <th>Payout</th>
                <th>Delay</th>
                <th>Result</th>
                <th>P/L</th>
              </tr>
            </thead>
            <tbody>
              {policies.history.map((p) => {
                const pnl = p.settled - p.premium;
                return (
                  <tr key={`${p.id}-${p.date}`}>
                    <td>
                      <span className="num" style={{ fontSize: 14 }}>
                        {p.id}
                      </span>
                    </td>
                    <td>
                      <FlightRoute from={p.from} to={p.to} />
                    </td>
                    <td>
                      <span
                        className="muted mono"
                        style={{ fontSize: 12 }}
                      >
                        {p.date}
                      </span>
                    </td>
                    <td>
                      <span className="num">{p.premium.toFixed(2)}</span>
                    </td>
                    <td>
                      <span className="num">{p.payout}</span>
                    </td>
                    <td>
                      <span
                        className="num"
                        style={{
                          color:
                            p.delay > 60 ? 'var(--amber)' : 'var(--ink-3)',
                        }}
                      >
                        {p.delay}m
                      </span>
                    </td>
                    <td>
                      {p.result === 'paid' ? (
                        <span className="badge green">Paid out</span>
                      ) : (
                        <span className="badge">Expired</span>
                      )}
                    </td>
                    <td>
                      <span
                        className="num"
                        style={{
                          color: pnl > 0 ? 'var(--green)' : 'var(--red)',
                        }}
                      >
                        {pnl > 0 ? '+' : ''}
                        {pnl.toFixed(2)} USDC
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
