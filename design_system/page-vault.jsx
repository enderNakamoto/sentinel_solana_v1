const { Sparkline } = window;

function PageVault({ go }) {
  const { VAULT_HISTORY, TVL_HISTORY } = window.SENTINEL;
  const [tier, setTier] = useState('balanced');
  const [amount, setAmount] = useState(1000);

  const tiers = {
    conservative: { label: 'Conservative', apy: 7.8, dd: 0.2, color: 'var(--cyan)', desc: 'Only writes coverage on flights with <20% delay odds. Lowest variance.' },
    balanced: { label: 'Balanced', apy: 12.4, dd: 0.8, color: 'var(--amber)', desc: 'Default mix across all whitelisted markets. Best risk-adjusted return.' },
    aggressive: { label: 'Aggressive', apy: 21.7, dd: 3.6, color: 'var(--violet)', desc: 'Concentrated on high-premium / high-risk routes. Larger drawdowns.' },
  };
  const t = tiers[tier];
  const projected = (amount * t.apy / 100).toFixed(2);

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      {/* Header */}
      <div className="row between" style={{ marginBottom: 32 }}>
        <div>
          <div className="h-eyebrow">Earn</div>
          <h1 style={{ fontSize: 44, fontWeight: 400, letterSpacing: '-0.03em', margin: 0 }}>
            Underwrite delays. <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-2)' }}>Earn premiums.</span>
          </h1>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="badge cyan">● Vault open</div>
          <div className="badge">Audited by OtterSec</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
        {/* LEFT: Vault overview + chart */}
        <div className="col" style={{ gap: 24 }}>
          <div className="card" style={{ padding: 24 }}>
            <div className="row between" style={{ marginBottom: 20 }}>
              <div>
                <div className="mono-tiny">Vault TVL</div>
                <div style={{ fontSize: 44, fontFamily: 'var(--sans)', fontWeight: 400, letterSpacing: '-0.02em', marginTop: 4 }}>
                  $7,423,108
                </div>
                <div className="row" style={{ gap: 12, marginTop: 6 }}>
                  <span className="stat-delta">+$87,420 (24h)</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>Utilization 64%</span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="mono-tiny">Current APY</div>
                <div style={{ fontSize: 44, fontFamily: 'var(--sans)', fontWeight: 400, letterSpacing: '-0.02em', color: 'var(--amber)', marginTop: 4 }}>
                  12.4%
                </div>
                <div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>30-day rolling</div>
              </div>
            </div>
            <div style={{ height: 160, position: 'relative' }}>
              <Sparkline data={TVL_HISTORY} color="var(--cyan)" fill="rgba(94,224,210,.08)" height={160} />
              <div className="mono-tiny" style={{ position: 'absolute', bottom: -22, left: 0 }}>30d ago</div>
              <div className="mono-tiny" style={{ position: 'absolute', bottom: -22, right: 0 }}>today</div>
            </div>
          </div>

          {/* Risk tiers */}
          <div>
            <div className="mono-tiny" style={{ marginBottom: 12 }}>Choose your risk tier</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {Object.entries(tiers).map(([k, v]) => {
                const active = tier === k;
                return (
                  <div key={k}
                       onClick={() => setTier(k)}
                       style={{
                         padding: 18, borderRadius: 10, cursor: 'pointer',
                         background: active ? 'var(--bg-2)' : 'var(--bg-1)',
                         border: '1px solid ' + (active ? v.color : 'var(--line)'),
                         transition: 'all .15s ease',
                         position: 'relative',
                       }}>
                    {active && <div style={{ position: 'absolute', top: 12, right: 12, width: 8, height: 8, borderRadius: 50, background: v.color, boxShadow: '0 0 8px ' + v.color }} />}
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{v.label}</div>
                    <div style={{ fontSize: 28, fontFamily: 'var(--sans)', letterSpacing: '-0.02em', marginTop: 8, color: v.color }}>
                      {v.apy}% <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>APY</span>
                    </div>
                    <div className="muted mono" style={{ fontSize: 10.5, marginTop: 4 }}>Max DD: {v.dd}%</div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 14, padding: 14, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13, color: 'var(--ink-2)' }}>
              {t.desc}
            </div>
          </div>

          {/* Composition */}
          <div className="card">
            <div className="card-head">
              <div className="card-title">Vault composition</div>
              <span className="mono muted" style={{ fontSize: 11 }}>by route region</span>
            </div>
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: '38%', background: 'var(--cyan)' }} />
              <div style={{ width: '24%', background: 'var(--amber)' }} />
              <div style={{ width: '18%', background: 'var(--violet)' }} />
              <div style={{ width: '12%', background: 'var(--green)' }} />
              <div style={{ width: '8%', background: 'var(--red)' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginTop: 16 }}>
              {[
                ['North America', 38, 'var(--cyan)'],
                ['Transatlantic', 24, 'var(--amber)'],
                ['Asia-Pacific', 18, 'var(--violet)'],
                ['Intra-Europe', 12, 'var(--green)'],
                ['Other', 8, 'var(--red)'],
              ].map(([n, p, c]) => (
                <div key={n}>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span style={{ width: 6, height: 6, background: c, borderRadius: 1 }} />
                    <span className="muted mono" style={{ fontSize: 10 }}>{n}</span>
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, marginTop: 4 }}>{p}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT: Deposit panel */}
        <div className="col" style={{ gap: 16 }}>
          <div className="card" style={{ padding: 24 }}>
            <div className="card-title" style={{ marginBottom: 18 }}>Deposit</div>
            <div className="mono-tiny" style={{ marginBottom: 8 }}>Amount</div>
            <div style={{ position: 'relative' }}>
              <input className="input" type="number" value={amount} onChange={e => setAmount(Math.max(0, +e.target.value))}
                     style={{ fontSize: 24, padding: '16px 70px 16px 16px' }} />
              <span style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--mono)', color: 'var(--ink-3)', fontSize: 13 }}>USDC</span>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              {[100, 500, 1000, 5000].map(v => (
                <button key={v} className="btn" style={{ padding: '6px 10px', fontSize: 11.5 }} onClick={() => setAmount(v)}>${v}</button>
              ))}
              <button className="btn" style={{ padding: '6px 10px', fontSize: 11.5 }} onClick={() => setAmount(412.8)}>MAX</button>
            </div>

            <div className="divider" style={{ margin: '20px 0' }} />

            <div className="col" style={{ gap: 10 }}>
              {[
                ['Selected tier', t.label],
                ['Effective APY', <span style={{ color: t.color }}>{t.apy}%</span>],
                ['Projected 1Y yield', <span className="num">{projected} USDC</span>],
                ['Lock-up', 'None · Withdraw any time'],
                ['Network fee', '~0.00012 SOL'],
              ].map(([k, v], i) => (
                <div key={i} className="row between">
                  <span className="muted" style={{ fontSize: 12 }}>{k}</span>
                  <span style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>{v}</span>
                </div>
              ))}
            </div>

            <button className="btn primary lg" style={{ width: '100%', marginTop: 22 }}>
              Deposit {amount.toLocaleString()} USDC
            </button>
            <div className="mono-tiny" style={{ textAlign: 'center', marginTop: 10, color: 'var(--ink-4)' }}>
              By depositing you agree to underwrite payouts on covered flights.
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">Your position</div>
              <span className="badge cyan">Active</span>
            </div>
            <div className="row between"><span className="muted" style={{ fontSize: 12 }}>Deposited</span><span className="num">2,400.00 USDC</span></div>
            <div className="row between" style={{ marginTop: 8 }}><span className="muted" style={{ fontSize: 12 }}>Earned</span><span className="num" style={{ color: 'var(--green)' }}>+148.32 USDC</span></div>
            <div className="row between" style={{ marginTop: 8 }}><span className="muted" style={{ fontSize: 12 }}>Active coverage</span><span className="num">$1,536 written</span></div>
            <button className="btn ghost" style={{ width: '100%', marginTop: 14 }}>Withdraw</button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.PageVault = PageVault;
