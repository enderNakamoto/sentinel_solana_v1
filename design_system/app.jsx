const { Sidebar, Topbar, PageLanding, PageVault, PageBuy, PageGlobe, PagePositions } = window;
const { useState, useEffect } = React;
const { TweaksPanel, useTweaks, TweakSection, TweakRadio, TweakColor, TweakToggle } = window;

const PALETTES = {
  '#ffb547': { '--amber': '#ffb547', '--amber-d': '#d28a1f' },
  '#a98bff': { '--amber': '#a98bff', '--amber-d': '#7c5fe0' },
  '#c6ff5e': { '--amber': '#c6ff5e', '--amber-d': '#94c437' },
  '#ff5ea8': { '--amber': '#ff5ea8', '--amber-d': '#d23878' },
};

function FunFlourishes({ page }) {
  // Decorative pieces only shown in fun mode
  return (
    <>
      {/* Pilot mascot in bottom-left */}
      <svg className="fun-mascot-pilot" viewBox="0 0 96 96" style={{ display: page === 'globe' ? 'none' : 'block' }}>
        {/* Goggles + pilot helmet */}
        <ellipse cx="48" cy="60" rx="28" ry="30" fill="#6b3a1f" />
        <ellipse cx="48" cy="62" rx="22" ry="20" fill="#f4d4a8" />
        <rect x="22" y="44" width="52" height="10" rx="4" fill="#3a2410" />
        <circle cx="36" cy="48" r="5" fill="#67e8f9" stroke="#1e293b" strokeWidth="1.5" />
        <circle cx="60" cy="48" r="5" fill="#67e8f9" stroke="#1e293b" strokeWidth="1.5" />
        <ellipse cx="48" cy="40" rx="32" ry="14" fill="#92400e" />
        <ellipse cx="48" cy="36" rx="30" ry="10" fill="#b45309" />
        <path d="M 30 70 Q 48 76 66 70" fill="none" stroke="#3a2410" strokeWidth="2" strokeLinecap="round" />
        <circle cx="40" cy="68" r="2" fill="#dc2626" opacity="0.4" />
        <circle cx="56" cy="68" r="2" fill="#dc2626" opacity="0.4" />
      </svg>

      {/* Floating clouds */}
      <svg className="fun-cloud-1" style={{ top: 80, right: 240, width: 110, height: 50, opacity: 0.5 }} viewBox="0 0 110 50">
        <ellipse cx="30" cy="32" rx="22" ry="14" fill="white" />
        <ellipse cx="55" cy="26" rx="26" ry="18" fill="white" />
        <ellipse cx="82" cy="32" rx="20" ry="14" fill="white" />
      </svg>
      <svg className="fun-cloud-2" style={{ top: 320, right: 60, width: 90, height: 42, opacity: 0.45 }} viewBox="0 0 90 42">
        <ellipse cx="22" cy="26" rx="18" ry="12" fill="white" />
        <ellipse cx="48" cy="22" rx="22" ry="14" fill="white" />
        <ellipse cx="68" cy="28" rx="16" ry="10" fill="white" />
      </svg>
    </>
  );
}

function App() {
  const defaultsText = document.getElementById('tweak-defaults').textContent;
  const defaults = JSON.parse(defaultsText.replace(/\/\*EDITMODE-(BEGIN|END)\*\//g, '').trim());
  const [tweaks, setTweak] = useTweaks(defaults);
  const [page, setPage] = useState('home');

  // Apply palette
  useEffect(() => {
    const p = PALETTES[tweaks.accent] || PALETTES['#ffb547'];
    Object.entries(p).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  }, [tweaks.accent]);

  // Apply mode class on body
  useEffect(() => {
    document.body.classList.toggle('mode-fun', tweaks.mode === 'fun');
  }, [tweaks.mode]);

  const go = (p) => { setPage(p); window.scrollTo({ top: 0 }); };

  // Keyboard nav
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const order = ['home', 'globe', 'buy', 'vault', 'positions'];
      if (e.key === 'ArrowRight') {
        const i = order.indexOf(page);
        if (i < order.length - 1) go(order[i + 1]);
      }
      if (e.key === 'ArrowLeft') {
        const i = order.indexOf(page);
        if (i > 0) go(order[i - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page]);

  const PageComp = {
    home: PageLanding,
    globe: PageGlobe,
    buy: PageBuy,
    vault: PageVault,
    positions: PagePositions,
  }[page];

  const isFun = tweaks.mode === 'fun';

  return (
    <div className="app" data-screen-label={page}>
      <Sidebar page={page} setPage={go} isFun={isFun} />
      <main style={{ minHeight: '100vh', background: 'var(--bg)' }}>
        <Topbar page={page} tweaks={tweaks} isFun={isFun} onModeChange={(v) => setTweak('mode', v)} />
        <PageComp go={go} tweaks={tweaks} isFun={isFun} />
      </main>

      {isFun && <FunFlourishes page={page} />}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Mode" />
        <TweakRadio
          label="Vibe"
          value={tweaks.mode}
          options={['serious', 'fun']}
          onChange={(v) => setTweak('mode', v)}
        />
        <TweakSection label="Accent palette" />
        <TweakColor
          label="Accent"
          value={tweaks.accent}
          options={['#ffb547', '#a98bff', '#c6ff5e', '#ff5ea8']}
          onChange={(v) => setTweak('accent', v)}
        />
        <TweakSection label="Live markets map" />
        <TweakRadio
          label="Map style"
          value={tweaks.globeStyle}
          options={['arcs', 'wire', 'flat']}
          onChange={(v) => setTweak('globeStyle', v)}
        />
        <TweakSection label="Topbar" />
        <TweakToggle
          label="Show ticker"
          value={tweaks.showTicker}
          onChange={(v) => setTweak('showTicker', v)}
        />
      </TweaksPanel>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
