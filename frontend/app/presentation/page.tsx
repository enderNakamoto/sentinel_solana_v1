/**
 * /presentation — fullscreen wrapper around the static slide deck at
 * /public/presentation/slides.html.
 *
 * The deck is intentionally a static HTML file (not converted to JSX) so
 * any future iteration can be hand-edited without rebuilding Next. The
 * iframe overlays the dapp chrome (sidebar / topbar / bottom-nav) at
 * z-index 9999 so the deck takes the entire viewport. Browser back-arrow
 * exits.
 *
 * The deck's last slide (id=s-quant) is itself an iframe pointing at
 * /quant — so the Monte Carlo simulator renders inline as the final
 * slide without leaving the deck context.
 */

'use client';

import Link from 'next/link';

export default function PresentationPage() {
  return (
    <>
      <iframe
        src="/presentation/slides.html"
        title="Sentinel Protocol Presentation"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          border: 0,
          background: 'var(--bg)',
          zIndex: 9999,
        }}
      />
      <Link
        href="/"
        style={{
          position: 'fixed',
          top: 16,
          right: 18,
          zIndex: 10000,
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          padding: '6px 12px',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(4px)',
          border: '1px solid var(--line)',
        }}
        title="Exit presentation"
      >
        ← Exit
      </Link>
    </>
  );
}
