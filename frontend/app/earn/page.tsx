'use client';

import { useEffect, useState } from 'react';
import { Sparkline } from '@/components/Sparkline';
import { useToast } from '@/components/Toast';
import { useTheme } from '@/theme/ThemeProvider';
import { getVaultStats, type VaultStats, type VaultTier } from '@/data';

/**
 * Earn / Vault page. Phase 12: stub forms — submit logs intended ix +
 * dispatches a fake-success toast. Phase 14 wires real `vault.deposit`,
 * `vault.redeem`, `vault.request_withdrawal`.
 */
export default function EarnPage() {
  const { mode } = useTheme();
  const isFun = mode === 'fun';
  const { show } = useToast();
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [tierId, setTierId] = useState<VaultTier['id']>('balanced');
  const [amount, setAmount] = useState(1000);

  useEffect(() => {
    void getVaultStats().then((s) => setStats(s));
  }, []);

  if (!stats) {
    return (
      <div className="page" style={{ maxWidth: 1280 }}>
        <div className="muted mono">Loading vault…</div>
      </div>
    );
  }

  const tier = stats.tiers.find((t) => t.id === tierId) ?? stats.tiers[1];
  const projected = (amount * tier.apy) / 100;

  function handleDeposit() {
    console.log('TODO: vault.deposit', { amount, tierId });
    show({
      kind: 'success',
      title: isFun
        ? `Added ${amount.toLocaleString()} USDC to the chest`
        : `Deposit submitted · ${amount.toLocaleString()} USDC`,
      body: `Tier: ${tier.label} · Effective APY ${tier.apy}%`,
    });
  }

  function handleWithdraw() {
    console.log('TODO: vault.redeem (or request_withdrawal if locked)');
    show({
      kind: 'success',
      title: isFun ? 'Withdrawal request entered the queue' : 'Withdrawal requested',
      body: 'TODO: route via redeem vs queue based on free capital',
    });
  }

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      {/* Header */}
      <div className="row between" style={{ marginBottom: 32 }}>
        <div>
          <div className="h-eyebrow">{isFun ? 'Underwriter chest' : 'Earn'}</div>
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
                Underwrite the{' '}
                <span
                  style={{
                    fontFamily: 'var(--serif)',
                    fontStyle: 'italic',
                    color: 'var(--ink-2)',
                  }}
                >
                  skies.
                </span>
              </>
            ) : (
              <>
                Underwrite delays.{' '}
                <span
                  style={{
                    fontFamily: 'var(--serif)',
                    fontStyle: 'italic',
                    color: 'var(--ink-2)',
                  }}
                >
                  Earn premiums.
                </span>
              </>
            )}
          </h1>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="badge cyan">● Vault open</div>
          <div className="badge">Audited by OtterSec</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
        {/* LEFT: vault overview + chart */}
        <div className="col" style={{ gap: 24 }}>
          <div className="card" style={{ padding: 24 }}>
            <div className="row between" style={{ marginBottom: 20 }}>
              <div>
                <div className="mono-tiny">Vault TVL</div>
                <div
                  style={{
                    fontSize: 44,
                    fontFamily: 'var(--sans)',
                    fontWeight: 400,
                    letterSpacing: '-0.02em',
                    marginTop: 4,
                  }}
                >
                  ${stats.tvl.toLocaleString()}
                </div>
                <div className="row" style={{ gap: 12, marginTop: 6 }}>
                  <span className="stat-delta">
                    +${stats.tvlChange24h.toLocaleString()} (24h)
                  </span>
                  <span
                    className="muted mono"
                    style={{ fontSize: 11 }}
                  >
                    Utilization {Math.round(stats.utilization * 100)}%
                  </span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="mono-tiny">Current APY</div>
                <div
                  style={{
                    fontSize: 44,
                    fontFamily: 'var(--sans)',
                    fontWeight: 400,
                    letterSpacing: '-0.02em',
                    color: 'var(--amber)',
                    marginTop: 4,
                  }}
                >
                  {stats.apy.toFixed(1)}%
                </div>
                <div
                  className="muted mono"
                  style={{ fontSize: 11, marginTop: 6 }}
                >
                  30-day rolling
                </div>
              </div>
            </div>
            <div style={{ height: 160, position: 'relative' }}>
              <Sparkline
                data={[3.1, 3.2, 3.3, 3.5, 3.4, 3.6, 3.8, 3.9, 4.0, 4.2, 4.3, 4.5, 4.6, 4.8, 5.0, 5.1, 5.3, 5.4, 5.6, 5.8, 5.9, 6.1, 6.3, 6.4, 6.6, 6.8, 6.9, 7.1, 7.3, 7.42]}
                color="var(--cyan)"
                fill="rgba(94,224,210,.08)"
                height={160}
              />
              <div
                className="mono-tiny"
                style={{ position: 'absolute', bottom: -22, left: 0 }}
              >
                30d ago
              </div>
              <div
                className="mono-tiny"
                style={{ position: 'absolute', bottom: -22, right: 0 }}
              >
                today
              </div>
            </div>
          </div>

          {/* Risk tiers */}
          <div>
            <div className="mono-tiny" style={{ marginBottom: 12 }}>
              Choose your risk tier
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 12,
              }}
            >
              {stats.tiers.map((v) => {
                const active = tierId === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setTierId(v.id)}
                    style={{
                      padding: 18,
                      borderRadius: 10,
                      cursor: 'pointer',
                      background: active ? 'var(--bg-2)' : 'var(--bg-1)',
                      border: `1px solid ${active ? `var(${v.accentVar})` : 'var(--line)'}`,
                      transition: 'all .15s ease',
                      position: 'relative',
                      textAlign: 'left',
                    }}
                  >
                    {active && (
                      <div
                        style={{
                          position: 'absolute',
                          top: 12,
                          right: 12,
                          width: 8,
                          height: 8,
                          borderRadius: 50,
                          background: `var(${v.accentVar})`,
                          boxShadow: `0 0 8px var(${v.accentVar})`,
                        }}
                      />
                    )}
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      {v.label}
                    </div>
                    <div
                      style={{
                        fontSize: 28,
                        fontFamily: 'var(--sans)',
                        letterSpacing: '-0.02em',
                        marginTop: 8,
                        color: `var(${v.accentVar})`,
                      }}
                    >
                      {v.apy}%{' '}
                      <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                        APY
                      </span>
                    </div>
                    <div
                      className="muted mono"
                      style={{ fontSize: 10.5, marginTop: 4 }}
                    >
                      Max DD: {v.maxDrawdown}%
                    </div>
                  </button>
                );
              })}
            </div>
            <div
              style={{
                marginTop: 14,
                padding: 14,
                background: 'var(--bg-1)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                fontSize: 13,
                color: 'var(--ink-2)',
              }}
            >
              {tier.description}
            </div>
          </div>

          {/* Composition */}
          <div className="card">
            <div className="card-head">
              <div className="card-title">Vault composition</div>
              <span className="mono muted" style={{ fontSize: 11 }}>
                by route region
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                height: 8,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              {stats.composition.map((s) => (
                <div
                  key={s.label}
                  style={{ width: `${s.pct}%`, background: s.colorVar }}
                />
              ))}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${stats.composition.length}, 1fr)`,
                gap: 10,
                marginTop: 16,
              }}
            >
              {stats.composition.map((s) => (
                <div key={s.label}>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        background: s.colorVar,
                        borderRadius: 1,
                      }}
                    />
                    <span className="muted mono" style={{ fontSize: 10 }}>
                      {s.label}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 13,
                      marginTop: 4,
                    }}
                  >
                    {s.pct}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT: deposit panel + my position */}
        <div className="col" style={{ gap: 16 }}>
          <div className="card" style={{ padding: 24 }}>
            <div className="card-title" style={{ marginBottom: 18 }}>
              Deposit
            </div>
            <div className="mono-tiny" style={{ marginBottom: 8 }}>
              Amount
            </div>
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                type="number"
                value={amount}
                onChange={(e) => setAmount(Math.max(0, +e.target.value))}
                style={{ fontSize: 24, padding: '16px 70px 16px 16px' }}
              />
              <span
                style={{
                  position: 'absolute',
                  right: 16,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontFamily: 'var(--mono)',
                  color: 'var(--ink-3)',
                  fontSize: 13,
                }}
              >
                USDC
              </span>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              {[100, 500, 1000, 5000].map((v) => (
                <button
                  key={v}
                  type="button"
                  className="btn"
                  style={{ padding: '6px 10px', fontSize: 11.5 }}
                  onClick={() => setAmount(v)}
                >
                  ${v}
                </button>
              ))}
              <button
                type="button"
                className="btn"
                style={{ padding: '6px 10px', fontSize: 11.5 }}
                onClick={() => setAmount(412.8)}
              >
                MAX
              </button>
            </div>

            <div className="divider" style={{ margin: '20px 0' }} />

            <div className="col" style={{ gap: 10 }}>
              {[
                ['Selected tier', tier.label],
                ['Effective APY', `${tier.apy}%`, tier.accentVar],
                ['Projected 1Y yield', `${projected.toFixed(2)} USDC`],
                ['Lock-up', 'None · Withdraw any time'],
                ['Network fee', '~0.00012 SOL'],
              ].map((row, i) => (
                <div key={i} className="row between">
                  <span className="muted" style={{ fontSize: 12 }}>
                    {row[0]}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontFamily: 'var(--mono)',
                      color: row[2] ? `var(${row[2]})` : 'var(--ink)',
                    }}
                  >
                    {row[1]}
                  </span>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn primary lg"
              style={{ width: '100%', marginTop: 22 }}
              onClick={handleDeposit}
            >
              {isFun
                ? `Add ${amount.toLocaleString()} USDC to the chest`
                : `Deposit ${amount.toLocaleString()} USDC`}
            </button>
            <div
              className="mono-tiny"
              style={{
                textAlign: 'center',
                marginTop: 10,
                color: 'var(--ink-4)',
              }}
            >
              By depositing you agree to underwrite payouts on covered flights.
            </div>
          </div>

          {stats.myPosition && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">Your position</div>
                <span className="badge cyan">Active</span>
              </div>
              <div className="row between">
                <span className="muted" style={{ fontSize: 12 }}>
                  Deposited
                </span>
                <span className="num">
                  {stats.myPosition.deposited.toFixed(2)} USDC
                </span>
              </div>
              <div className="row between" style={{ marginTop: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  Earned
                </span>
                <span className="num" style={{ color: 'var(--green)' }}>
                  +{stats.myPosition.earned.toFixed(2)} USDC
                </span>
              </div>
              <div className="row between" style={{ marginTop: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  Active coverage
                </span>
                <span className="num">
                  ${stats.myPosition.activeCoverage} written
                </span>
              </div>
              <button
                type="button"
                className="btn ghost"
                style={{ width: '100%', marginTop: 14 }}
                onClick={handleWithdraw}
              >
                Withdraw
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
