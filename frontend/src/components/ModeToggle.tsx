'use client';

import { useTheme } from '@/theme/ThemeProvider';

/**
 * Topbar mode toggle — flips serious↔fun.
 * Ported from design_system/shell.jsx::ModeToggle.
 */
export function ModeToggle() {
  const { mode, setMode } = useTheme();
  const isFun = mode === 'fun';

  return (
    <button
      type="button"
      onClick={() => setMode(isFun ? 'serious' : 'fun')}
      title={`Switch to ${isFun ? 'Serious' : 'Fun'} mode`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0,
        padding: 3,
        background: isFun
          ? 'linear-gradient(180deg, #f4e4b8 0%, #d9be73 100%)'
          : 'var(--bg-2)',
        border: `1px solid ${isFun ? '#2a1408' : 'var(--line-2)'}`,
        borderRadius: 22,
        cursor: 'pointer',
        boxShadow: isFun
          ? 'inset 0 1px 0 rgba(255,255,255,.6), 0 2px 0 #2a1408'
          : 'none',
        fontFamily: isFun ? 'Cinzel, serif' : 'var(--mono)',
      }}
    >
      <span
        style={{
          padding: '5px 12px',
          borderRadius: 16,
          background: !isFun ? 'var(--bg-3)' : 'transparent',
          color: !isFun ? 'var(--ink)' : '#7a5236',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          transition: 'all .15s ease',
        }}
      >
        Serious
      </span>
      <span
        style={{
          padding: '5px 12px',
          borderRadius: 16,
          background: isFun
            ? 'linear-gradient(180deg, #fbbf24 0%, #d97706 100%)'
            : 'transparent',
          color: isFun ? '#2a1408' : 'var(--ink-3)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          boxShadow: isFun ? 'inset 0 1px 0 rgba(255,255,255,.4)' : 'none',
          transition: 'all .15s ease',
        }}
      >
        Fun
      </span>
    </button>
  );
}
