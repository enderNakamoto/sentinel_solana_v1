'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/admin', label: 'Admin' },
  { href: '/crons', label: 'Crons' },
  { href: '/faucet', label: 'Faucet' },
  { href: '/contracts', label: 'Contracts' },
] as const;

/**
 * Operator entry-point strip. Renders inside <main> on every page except `/`.
 * Auth gating happens inside each destination page — links are always visible.
 */
export function BottomNav() {
  const pathname = usePathname();
  if (pathname === '/') return null;

  return (
    <nav className="bottom-nav" aria-label="Operator pages">
      <div className="bottom-nav-inner">
        <span className="bottom-nav-label">OPERATOR</span>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`bottom-nav-item${isActive ? ' active' : ''}`}
            >
              {item.label}
            </Link>
          );
        })}
        <span className="bottom-nav-spacer" />
        <span className="bottom-nav-cluster">devnet</span>
      </div>
    </nav>
  );
}
