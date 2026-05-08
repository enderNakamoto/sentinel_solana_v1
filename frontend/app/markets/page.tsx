'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Globe } from '@/components/globe/Globe';
import {
  getAirports,
  getOpenMarkets,
  type Airport,
  type MarketView,
} from '@/data';

/**
 * Live Markets — globe view + side panels.
 *
 * Phase 12: data via mock; globe is SvgGlobe under the hood (M2 boundary
 * keeps a future ThreeJS swap local to src/components/globe/).
 */
export default function MarketsPage() {
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [airports, setAirports] = useState<Record<string, Airport>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getOpenMarkets(), getAirports()]).then(([m, a]) => {
      setMarkets(m);
      setAirports(a);
      setSelectedId(m[0]?.id ?? null);
    });
  }, []);

  const selected = markets.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="globe-stage">
      {/* Stars backdrop */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'radial-gradient(1px 1px at 10% 20%, #fff5, transparent), radial-gradient(1px 1px at 80% 70%, #fff4, transparent), radial-gradient(1px 1px at 30% 80%, #fff3, transparent), radial-gradient(1px 1px at 60% 10%, #fff5, transparent), radial-gradient(1px 1px at 90% 30%, #fff3, transparent)',
          backgroundSize: '600px 600px',
        }}
      />

      <Globe
        markets={markets}
        airports={airports}
        selectedId={selectedId}
        onSelectMarket={(id) => setSelectedId(id)}
      />

      {/* LEFT panel: live markets list */}
      <div className="globe-overlay-l">
        <div className="panel">
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="card-title">Live Markets</div>
            <span
              className="live-pill"
              style={{ fontFamily: 'var(--mono)', fontSize: 10 }}
            >
              {markets.length} open
            </span>
          </div>
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {markets.map((f) => {
              const active = f.id === selectedId;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedId(f.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: active ? 'var(--bg-2)' : 'transparent',
                    borderTop: 'none',
                    borderRight: 'none',
                    borderBottom: 'none',
                    borderLeft: `2px solid ${active ? 'var(--amber)' : 'transparent'}`,
                  }}
                >
                  <div className="row between">
                    <div className="num" style={{ fontSize: 12 }}>
                      {f.id}
                    </div>
                    <span
                      className="num muted"
                      style={{ fontSize: 10 }}
                    >
                      {f.depTs}
                    </span>
                  </div>
                  <div className="row between" style={{ marginTop: 4 }}>
                    <span
                      className="num"
                      style={{ fontSize: 11, color: 'var(--ink-2)' }}
                    >
                      {f.from} → {f.to}
                    </span>
                    <span
                      className="num"
                      style={{
                        fontSize: 11,
                        color:
                          f.risk < 0.25
                            ? 'var(--green)'
                            : f.risk < 0.4
                              ? 'var(--amber)'
                              : 'var(--red)',
                      }}
                    >
                      {Math.round(f.risk * 100)}%
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* RIGHT panel: selected market detail */}
      <div className="globe-overlay-r">
        {selected && (
          <div className="panel">
            <div className="row between">
              <div>
                <div className="num" style={{ fontSize: 18 }}>
                  {selected.id}
                </div>
                <div className="carrier">
                  {selected.carrier} · {selected.date}
                </div>
              </div>
              <span className="badge amber">{selected.depTs}</span>
            </div>

            <div className="panel-section">
              <div
                className="row"
                style={{ gap: 14, alignItems: 'center', marginTop: 4 }}
              >
                <div>
                  <div className="num" style={{ fontSize: 22 }}>
                    {selected.from}
                  </div>
                  <div className="muted mono" style={{ fontSize: 10 }}>
                    {selected.dep}
                  </div>
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 1,
                    background: 'var(--ink-4)',
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: -6,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      color: 'var(--amber)',
                      fontSize: 11,
                    }}
                  >
                    ✈
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="num" style={{ fontSize: 22 }}>
                    {selected.to}
                  </div>
                  <div className="muted mono" style={{ fontSize: 10 }}>
                    {selected.arr}
                  </div>
                </div>
              </div>
            </div>

            <div className="panel-section col" style={{ gap: 8 }}>
              {[
                ['Delay odds', `${Math.round(selected.risk * 100)}%`],
                ['Premium', `${selected.premium.toFixed(2)} USDC`],
                ['Payout', `${selected.payout} USDC`],
                ['Threshold', `>${selected.threshold}min`],
                ['Pool TVL', `$${selected.tvl.toLocaleString()}`],
                ['Coverage left', `${selected.slots} slots`],
              ].map(([k, v], i) => (
                <div key={i} className="row between">
                  <span className="muted" style={{ fontSize: 11 }}>
                    {k}
                  </span>
                  <span
                    className="num"
                    style={{
                      fontSize: 12,
                      color: k === 'Payout' ? 'var(--cyan)' : 'var(--ink)',
                    }}
                  >
                    {v}
                  </span>
                </div>
              ))}
            </div>

            <Link
              href="/buy"
              className="btn primary"
              style={{ width: '100%', marginTop: 14, display: 'block', textAlign: 'center' }}
            >
              Cover {selected.id} →
            </Link>
          </div>
        )}

        <div className="panel" style={{ marginTop: 14, padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 10 }}>
            Legend
          </div>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            {(
              [
                ['var(--green)', 'Low risk'],
                ['var(--amber)', 'Medium'],
                ['var(--red)', 'High'],
                ['var(--cyan)', 'Airport'],
              ] as const
            ).map(([c, l]) => (
              <div key={l} className="row" style={{ gap: 6 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 50,
                    background: c,
                    boxShadow: `0 0 6px ${c}`,
                  }}
                />
                <span className="muted mono" style={{ fontSize: 10 }}>
                  {l}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom hint */}
      <div
        style={{
          position: 'absolute',
          bottom: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: 'var(--ink-3)',
          letterSpacing: '.15em',
        }}
      >
        DRAG TO ROTATE · {markets.length} ACTIVE FLIGHTS · LIVE
      </div>
    </div>
  );
}
