'use client';

import { useEffect, useMemo, useState } from 'react';
import { FlightRoute } from '@/components/FlightRoute';
import { RiskBar } from '@/components/RiskBar';
import { useToast } from '@/components/Toast';
import { useTheme } from '@/theme/ThemeProvider';
import { getOpenMarkets, type MarketView } from '@/data';

/**
 * Buy Coverage page. Phase 12: stub button — clicking "Cover" logs the
 * intended ix + dispatches a fake-success toast. Phase 13 wires
 * `controller.buy_insurance` here.
 */
export default function BuyPage() {
  const { mode } = useTheme();
  const isFun = mode === 'fun';
  const { show } = useToast();
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [coverage, setCoverage] = useState(180);
  const [threshold, setThreshold] = useState(60);
  const [search, setSearch] = useState('');

  useEffect(() => {
    void getOpenMarkets().then((m) => {
      setMarkets(m);
      setSelectedId(m[0]?.id ?? null);
    });
  }, []);

  const flight = markets.find((m) => m.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    if (!search) return markets;
    const q = search.toLowerCase();
    return markets.filter(
      (f) =>
        f.id.toLowerCase().includes(q) ||
        f.from.toLowerCase().includes(q) ||
        f.to.toLowerCase().includes(q) ||
        f.carrier.toLowerCase().includes(q),
    );
  }, [markets, search]);

  // Premium scales with coverage, risk, and threshold (mocked formula
  // matching the design system).
  const premium = flight
    ? (coverage * (flight.risk * (60 / threshold)) * 0.13).toFixed(2)
    : '0.00';
  const multiplier = flight && parseFloat(premium) > 0
    ? (coverage / parseFloat(premium)).toFixed(1)
    : '—';

  function handleCover() {
    if (!flight) return;
    console.log('TODO: controller.buy_insurance', {
      flightId: flight.id,
      origin: flight.from,
      destination: flight.to,
      coverage,
      threshold,
      premium,
    });
    show({
      kind: 'success',
      title: isFun
        ? `Scroll bound · ${flight.id}`
        : `Coverage purchased · ${flight.id}`,
      body: `${premium} USDC premium · ${coverage} USDC payout if >${threshold}m late`,
    });
  }

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="row between" style={{ marginBottom: 26 }}>
        <div>
          <div className="h-eyebrow">
            {isFun ? 'Bind a coverage scroll' : 'Buy coverage'}
          </div>
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
                Wager on{' '}
                <span
                  style={{
                    fontFamily: 'var(--serif)',
                    fontStyle: 'italic',
                    color: 'var(--amber)',
                  }}
                >
                  the winds.
                </span>
              </>
            ) : (
              <>
                Cover a{' '}
                <span
                  style={{
                    fontFamily: 'var(--serif)',
                    fontStyle: 'italic',
                    color: 'var(--amber)',
                  }}
                >
                  flight.
                </span>
              </>
            )}
          </h1>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <div className="badge">{markets.length} markets · whitelisted</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
        {/* LEFT: flight picker */}
        <div>
          <div style={{ position: 'relative', marginBottom: 14 }}>
            <input
              className="input"
              placeholder="Search by flight, route or carrier…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: 38 }}
            />
            <span
              style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--ink-3)',
                fontSize: 14,
              }}
            >
              ⌕
            </span>
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
                  <th>Risk</th>
                  <th>Premium</th>
                  <th>Payout</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => {
                  const active = f.id === selectedId;
                  return (
                    <tr
                      key={f.id}
                      onClick={() => setSelectedId(f.id)}
                      style={{
                        cursor: 'pointer',
                        background: active ? 'var(--bg-2)' : 'transparent',
                        position: 'relative',
                      }}
                    >
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          {active && (
                            <span
                              style={{
                                width: 4,
                                height: 24,
                                background: 'var(--amber)',
                                borderRadius: 2,
                                marginLeft: -10,
                              }}
                            />
                          )}
                          <div>
                            <div className="num" style={{ fontSize: 14 }}>
                              {f.id}
                            </div>
                            <div className="carrier">{f.carrier}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <FlightRoute from={f.from} to={f.to} />
                      </td>
                      <td>
                        <span className="num muted">{f.depTs}</span>
                      </td>
                      <td>
                        <RiskBar risk={f.risk} />
                      </td>
                      <td>
                        <span className="num">{f.premium.toFixed(2)}</span>
                      </td>
                      <td>
                        <span className="num" style={{ color: 'var(--cyan)' }}>
                          {f.payout}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            className="mono-tiny"
            style={{ marginTop: 14, color: 'var(--ink-4)' }}
          >
            Need a flight added to the whitelist?{' '}
            <span style={{ color: 'var(--cyan)', cursor: 'pointer' }}>
              Submit a request →
            </span>
          </div>
        </div>

        {/* RIGHT: configurator */}
        <div
          className="card"
          style={{
            padding: 0,
            overflow: 'hidden',
            position: 'sticky',
            top: 72,
            alignSelf: 'flex-start',
          }}
        >
          {flight && (
            <>
              <div
                style={{
                  padding: 20,
                  borderBottom: '1px solid var(--line)',
                  background: 'var(--bg-2)',
                }}
              >
                <div className="row between">
                  <div>
                    <div className="num" style={{ fontSize: 18 }}>
                      {flight.id}
                    </div>
                    <div className="carrier">
                      {flight.carrier} · {flight.date}
                    </div>
                  </div>
                  <span className="badge amber">{flight.depTs}</span>
                </div>
                <div
                  className="row"
                  style={{ gap: 16, marginTop: 18, alignItems: 'center' }}
                >
                  <div>
                    <div className="num" style={{ fontSize: 24 }}>
                      {flight.from}
                    </div>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      {flight.dep}
                    </div>
                  </div>
                  <div
                    style={{ flex: 1, position: 'relative', height: 24 }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: 11,
                        left: 0,
                        right: 0,
                        height: 1,
                        background: 'var(--line-2)',
                        borderTop: '1px dashed var(--ink-4)',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        top: 6,
                        left: '50%',
                        transform: 'translateX(-50%) rotate(90deg)',
                        color: 'var(--amber)',
                        fontSize: 12,
                      }}
                    >
                      ✈
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num" style={{ fontSize: 24 }}>
                      {flight.to}
                    </div>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      {flight.arr}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ padding: 22 }}>
                {/* Coverage slider */}
                <div className="mono-tiny" style={{ marginBottom: 8 }}>
                  Payout amount
                </div>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <div
                    style={{
                      fontSize: 32,
                      fontFamily: 'var(--sans)',
                      letterSpacing: '-0.02em',
                      color: 'var(--cyan)',
                    }}
                  >
                    {coverage}{' '}
                    <span style={{ fontSize: 14, color: 'var(--ink-3)' }}>
                      USDC
                    </span>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    {[100, 180, 250, 500].map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="btn"
                        style={{ padding: '4px 8px', fontSize: 11 }}
                        onClick={() => setCoverage(v)}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="range"
                  className="seek"
                  min="50"
                  max="1000"
                  step="10"
                  value={coverage}
                  onChange={(e) => setCoverage(+e.target.value)}
                />

                {/* Threshold */}
                <div
                  className="mono-tiny"
                  style={{ marginTop: 22, marginBottom: 8 }}
                >
                  Trigger threshold
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {[30, 60, 90, 120].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setThreshold(v)}
                      className="btn"
                      style={{
                        flex: 1,
                        padding: '10px',
                        background:
                          threshold === v ? 'var(--bg-3)' : 'var(--bg)',
                        borderColor:
                          threshold === v ? 'var(--amber)' : 'var(--line-2)',
                        color: threshold === v ? 'var(--amber)' : 'var(--ink-2)',
                      }}
                    >
                      &gt;{v}min
                    </button>
                  ))}
                </div>
                <div
                  className="mono-tiny"
                  style={{ marginTop: 8, color: 'var(--ink-4)' }}
                >
                  Payout triggers if arrival is delayed more than {threshold}{' '}
                  minutes.
                </div>

                <div className="divider" style={{ margin: '22px 0' }} />

                {/* Quote */}
                <div className="col" style={{ gap: 10 }}>
                  <div className="row between">
                    <span className="muted" style={{ fontSize: 12 }}>
                      Live delay odds
                    </span>
                    <span className="num">
                      {Math.round(flight.risk * 100)}%
                    </span>
                  </div>
                  <div className="row between">
                    <span className="muted" style={{ fontSize: 12 }}>
                      Premium
                    </span>
                    <span
                      className="num"
                      style={{ fontSize: 16, color: 'var(--amber)' }}
                    >
                      {premium} USDC
                    </span>
                  </div>
                  <div className="row between">
                    <span className="muted" style={{ fontSize: 12 }}>
                      Implied multiplier
                    </span>
                    <span className="num">{multiplier}×</span>
                  </div>
                  <div className="row between">
                    <span className="muted" style={{ fontSize: 12 }}>
                      Settlement
                    </span>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {isFun ? 'Auto · upon landing' : 'Auto · on landing'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn primary lg"
                  style={{ width: '100%', marginTop: 22 }}
                  onClick={handleCover}
                >
                  {isFun
                    ? `Stamp the scroll · ${premium} USDC`
                    : `Pay ${premium} USDC · Cover this flight`}
                </button>
                <div
                  className="mono-tiny"
                  style={{
                    textAlign: 'center',
                    marginTop: 10,
                    color: 'var(--ink-4)',
                  }}
                >
                  No KYC · Non-custodial · Refund if flight cancelled
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
