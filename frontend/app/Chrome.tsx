'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { BottomNav } from '@/components/BottomNav';

/**
 * Conditionally renders the dapp chrome (Sidebar / Topbar / BottomNav)
 * around its children. On fullscreen routes — `/quant` and `/presentation`
 * — chrome is suppressed so the page takes the entire viewport.
 *
 * `/quant` is a slide page consumed by the deck's last-slide iframe and
 * should not display dapp navigation. `/presentation` is the deck itself.
 */

const FULLSCREEN_ROUTES = new Set(['/quant', '/presentation']);

export function Chrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const fullscreen = FULLSCREEN_ROUTES.has(pathname);

  if (fullscreen) {
    // Fullscreen: no chrome. Render children directly so the page can
    // do whatever it likes with the viewport.
    return <>{children}</>;
  }

  return (
    <div className="app">
      <Sidebar />
      <main
        style={{
          minHeight: '100vh',
          background: 'var(--bg)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Topbar />
        <div style={{ flex: 1 }}>{children}</div>
        <BottomNav />
      </main>
    </div>
  );
}
