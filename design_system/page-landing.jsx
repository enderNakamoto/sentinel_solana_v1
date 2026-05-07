const { Sparkline, BrandMark } = window;

function PageLanding({ go }) {
  const { FLIGHTS, TVL_HISTORY, VAULT_HISTORY } = window.SENTINEL;
  const live = FLIGHTS.slice(0, 5);

  return (
    <div className="page" style={{ paddingTop: 0, maxWidth: 1280 }}>
      {/* HERO */}
      <section style={{ position: 'relative', padding: '80px 0 100px', overflow: 'hidden' }} className="grain">
        <div className="horizon" />
        <div className="grid-bg" style={{ position: 'absolute', inset: 0, opacity: .4, maskImage: 'radial-gradient(ellipse at 50% 60%, #000, transparent 70%)' }} />
        <div style={{ position: 'relative', maxWidth: 880 }}>
          <div className="h-eyebrow">Parametric flight delay protocol · Solana</div>
          <h1 className="display">
            Insurance <em>and</em> alpha,<br/>
            for every <em>delayed</em> flight.
          </h1>
          <p className="lede" style={{ marginTop: 28, fontSize: 19 }}>
            Pay a small premium to get an instant payout when your flight is late.
            Or deposit into the vault and underwrite the risk for yield.
            Settled on-chain by oracles, no claims.
          </p>
          <div className="row" style={{ marginTop: 36, gap: 12 }}>
            <button className="btn primary lg" onClick={() => go('buy')}>
              Cover a flight →
            </button>
            <button className="btn lg" onClick={() => go('vault')}>
              Earn 12.4% APY
            </button>
            <button className="btn ghost lg" onClick={() => go('globe')}>
              Watch live markets
            </button>
          </div>
        </div>

        {/* Floating stat strip */}
        <div style={{ position: 'relative', marginTop: 80, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--bg-1)', overflow: 'hidden' }}>
          {[
            { k: 'Total Value Locked', v: '$7.42M', d: '+1.2% 24h', spark: TVL_HISTORY, color: 'var(--cyan)', fill: 'rgba(94,224,210,.12)' },
            { k: 'Vault APY', v: '12.4%', d: '+0.3% week', spark: VAULT_HISTORY, color: 'var(--amber)', fill: 'rgba(255,181,71,.12)' },
            { k: 'Open Markets', v: '142', d: '24 carriers' },
            { k: 'Avg. Payout Speed', v: '6.2s', d: 'after touchdown' },
          ].map((s, i) => (
            <div key={i} style={{ padding: 22, borderRight: i < 3 ? '1px solid var(--line)' : 'none' }}>
              <div className="stat-label">{s.k}</div>
              <div className="stat-value" style={{ marginTop: 8 }}>{s.v}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                <div className="stat-delta">{s.d}</div>
                {s.spark && <div style={{ width: 80 }}><Sparkline data={s.spark} color={s.color} fill={s.fill} height={28} /></div>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section style={{ padding: '60px 0' }}>
        <div className="h-eyebrow">How it works</div>
        <h2 className="section" style={{ maxWidth: 720 }}>Two sides of one <em>market.</em></h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 40 }}>
          <SideCard
            tag="For travelers"
            color="var(--amber)"
            title="Buy parametric coverage"
            steps={[
              ['01', 'Pick your flight from the whitelisted set.'],
              ['02', 'Pay a premium based on real-time delay odds.'],
              ['03', 'If delay > threshold, payout hits your wallet automatically.'],
            ]}
            example="UA1437 SFO→JFK · 12.40 USDC premium · 180 USDC payout if >60min late"
          />
          <SideCard
            tag="For underwriters"
            color="var(--cyan)"
            title="Deposit and earn"
            steps={[
              ['01', 'Deposit USDC into a risk tier (Conservative / Balanced / Aggressive).'],
              ['02', 'The vault pools premiums and writes coverage across all open markets.'],
              ['03', 'Earn the spread when delays don\u2019t hit. Withdraw any time.'],
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
            <h2 className="section">Markets open for <em>coverage.</em></h2>
          </div>
          <button className="btn" onClick={() => go('globe')}>View all 142 →</button>
        </div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          <table className="t">
            <thead>
              <tr>
                <th>Flight</th><th>Route</th><th>Departs</th><th>Premium</th><th>Payout</th><th>Delay odds</th><th>Coverage left</th><th></th>
              </tr>
            </thead>
            <tbody>
              {live.map(f => (
                <tr key={f.id}>
                  <td><span className="num" style={{ fontSize: 14 }}>{f.id}</span><div className="carrier">{f.carrier}</div></td>
                  <td><FlightRoute from={f.from} to={f.to} /></td>
                  <td><span className="num muted">{f.depTs}</span></td>
                  <td><span className="num">{f.premium.toFixed(2)} <span className="muted">USDC</span></span></td>
                  <td><span className="num" style={{ color: 'var(--cyan)' }}>{f.payout} <span className="muted">USDC</span></span></td>
                  <td><RiskBar r={f.risk} /></td>
                  <td><span className="num">{f.slots} slots</span></td>
                  <td><button className="btn primary" style={{ padding: '6px 12px' }} onClick={() => go('buy')}>Cover</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* TRUST STRIP */}
      <section style={{ padding: '70px 0 30px', textAlign: 'center' }}>
        <div className="mono-tiny" style={{ marginBottom: 26 }}>Settlement & data</div>
        <div className="row" style={{ justifyContent: 'center', gap: 56, fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink-2)' }}>
          <span>◇ ACARS Oracle</span>
          <span>◈ FlightAware</span>
          <span>◇ Switchboard</span>
          <span>◆ Squads Multisig</span>
        </div>
      </section>
    </div>
  );
}

function SideCard({ tag, color, title, steps, example }) {
  return (
    <div className="card" style={{ padding: 28, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: color, opacity: 0.6 }} />
      <div className="mono-tiny" style={{ color }}>{tag}</div>
      <h3 style={{ fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', margin: '10px 0 24px' }}>{title}</h3>
      <div className="col" style={{ gap: 18 }}>
        {steps.map(([n, t]) => (
          <div key={n} className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', paddingTop: 3 }}>{n}</span>
            <span style={{ fontSize: 15, color: 'var(--ink)', lineHeight: 1.5 }}>{t}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, padding: 14, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-2)' }}>
        {example}
      </div>
    </div>
  );
}

function FlightRoute({ from, to }) {
  return (
    <div className="route" style={{ minWidth: 130 }}>
      <span className="iata">{from}</span>
      <span className="arr" />
      <span className="iata">{to}</span>
    </div>
  );
}
window.FlightRoute = FlightRoute;

function RiskBar({ r }) {
  const pct = Math.round(r * 100);
  const color = r < 0.25 ? 'var(--green)' : r < 0.4 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="risk-bar"><div style={{ width: pct + '%', background: color }} /></div>
      <span className="num muted" style={{ fontSize: 11 }}>{pct}%</span>
    </div>
  );
}
window.RiskBar = RiskBar;

window.PageLanding = PageLanding;
