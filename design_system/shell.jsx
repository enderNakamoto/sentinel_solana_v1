const { useState, useEffect, useRef, useMemo, createContext, useContext } = React;

const NavCtx = createContext(null);
window.useNav = () => useContext(NavCtx);

function Sparkline({ data, color = 'var(--cyan)', fill = 'rgba(94,224,210,.12)', height = 40 }) {
  const w = 200, h = height;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - ((v - min) / range) * (h - 4) - 2]);
  const d = 'M' + pts.map(p => p.join(',')).join(' L ');
  const area = d + ` L ${w},${h} L 0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, display: 'block' }}>
      <path d={area} fill={fill} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function BrandMark({ size = 26 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size}>
      <defs>
        <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5ee0d2" />
          <stop offset="1" stopColor="#ffb547" />
        </linearGradient>
      </defs>
      <path d="M16 2 L28 9 V20 L16 30 L4 20 V9 Z" fill="none" stroke="url(#bg-grad)" strokeWidth="1.5" />
      <path d="M10 16 L16 12 L22 16 L16 20 Z" fill="#ffb547" opacity="0.9" />
      <circle cx="16" cy="16" r="1.5" fill="#0a0e1a" />
    </svg>
  );
}

function Sidebar({ page, setPage }) {
  const items = [
    { id: 'home',       label: 'Home',         section: 'Protocol' },
    { id: 'globe',      label: 'Live Markets', section: 'Markets' },
    { id: 'buy',        label: 'Buy Coverage', section: 'Markets' },
    { id: 'vault',      label: 'Earn',         section: 'Markets' },
    { id: 'positions',  label: 'Portfolio',    section: 'Account' },
  ];
  let lastSection = '';
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><BrandMark size={24} /></div>
        <div className="brand-name">Sentinel<em>·</em></div>
      </div>
      {items.map(it => {
        const head = it.section !== lastSection ? <div key={'s' + it.section} className="nav-section">{it.section}</div> : null;
        lastSection = it.section;
        return (
          <React.Fragment key={it.id}>
            {head}
            <div className={'nav-item' + (page === it.id ? ' active' : '')} onClick={() => setPage(it.id)}>
              <span className="dot" />
              <span>{it.label}</span>
            </div>
          </React.Fragment>
        );
      })}
      <div className="sidebar-footer">
        <div className="live-pill">Live oracle · ACARS</div>
        <div>v1.2.0 · Solana Mainnet</div>
      </div>
    </aside>
  );
}

function ModeToggle({ isFun, onChange }) {
  return (
    <button
      onClick={() => onChange(isFun ? 'serious' : 'fun')}
      title={'Switch to ' + (isFun ? 'Serious' : 'Fun') + ' mode'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 0,
        padding: 3,
        background: isFun ? 'linear-gradient(180deg, #f4e4b8 0%, #d9be73 100%)' : 'var(--bg-2)',
        border: '1px solid ' + (isFun ? '#2a1408' : 'var(--line-2)'),
        borderRadius: 22,
        cursor: 'pointer',
        boxShadow: isFun ? 'inset 0 1px 0 rgba(255,255,255,.6), 0 2px 0 #2a1408' : 'none',
        fontFamily: isFun ? 'Cinzel, serif' : 'var(--mono)',
      }}
    >
      <span style={{
        padding: '5px 12px', borderRadius: 16,
        background: !isFun ? 'var(--bg-3)' : 'transparent',
        color: !isFun ? 'var(--ink)' : '#7a5236',
        fontSize: 11, fontWeight: 600, letterSpacing: '.08em',
        textTransform: 'uppercase',
        transition: 'all .15s ease',
      }}>Serious</span>
      <span style={{
        padding: '5px 12px', borderRadius: 16,
        background: isFun ? 'linear-gradient(180deg, #fbbf24 0%, #d97706 100%)' : 'transparent',
        color: isFun ? '#2a1408' : 'var(--ink-3)',
        fontSize: 11, fontWeight: 700, letterSpacing: '.08em',
        textTransform: 'uppercase',
        boxShadow: isFun ? 'inset 0 1px 0 rgba(255,255,255,.4)' : 'none',
        transition: 'all .15s ease',
      }}>Fun</span>
    </button>
  );
}

function Topbar({ page, tweaks, isFun, onModeChange }) {
  const crumbMap = {
    home: ['Sentinel', 'Home'],
    globe: ['Markets', 'Live'],
    buy: ['Markets', 'Buy Coverage'],
    vault: ['Markets', 'Earn'],
    positions: ['Account', 'Portfolio'],
  };
  const funCrumbMap = {
    home: ['AeroQuest', 'Tavern'],
    globe: ['Sky Map', 'Live'],
    buy: ['Quests', 'Cover a Flight'],
    vault: ['Vault', 'Earn'],
    positions: ['Adventurer', 'Portfolio'],
  };
  const c = (isFun ? funCrumbMap : crumbMap)[page] || ['Sentinel'];
  return (
    <div className="topbar">
      <div className="crumbs">{c[0]} <span style={{ color: 'var(--ink-4)', margin: '0 8px' }}>/</span> <strong>{c[1]}</strong></div>
      <div className="spacer" />
      {tweaks.showTicker && (
        <div className="ticker">
          <span className="t-item"><span className="muted">TVL</span><span className="v">$7.42M</span><span className="up">+1.2%</span></span>
          <span className="t-item"><span className="muted">APY</span><span className="v">12.4%</span><span className="up">+0.3%</span></span>
          <span className="t-item"><span className="muted">Open</span><span className="v">142</span></span>
          <span className="t-item"><span className="muted">Settled 24h</span><span className="v">$184k</span><span className="up">+8.2%</span></span>
        </div>
      )}
      {isFun && (
        <span className="gem-pill">
          <svg viewBox="0 0 16 16"><polygon points="8,1 14,6 11,15 5,15 2,6" fill="#a78bfa" stroke="#2a1408" strokeWidth="1" /><polygon points="8,1 14,6 8,9 2,6" fill="#c4b5fd" stroke="#2a1408" strokeWidth="1" /></svg>
          1,250
        </span>
      )}
      <ModeToggle isFun={isFun} onChange={onModeChange} />
      <div className="wallet">
        <span className="chain" />
        <span className="addr">7xK9…aP2v</span>
        <span style={{ color: 'var(--ink-4)' }}>·</span>
        <span className="bal">412.8 USDC</span>
      </div>
    </div>
  );
}

window.Sparkline = Sparkline;
window.Sidebar = Sidebar;
window.Topbar = Topbar;
window.BrandMark = BrandMark;
window.ModeToggle = ModeToggle;
