'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandMark } from './BrandMark';
import { useTheme } from '@/theme/ThemeProvider';

interface NavItem {
  href: string;
  label: string;
  funLabel: string;
  section: string;
  funSection: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', funLabel: 'Tavern', section: 'Protocol', funSection: 'Realm' },
  { href: '/markets', label: 'Live Markets', funLabel: 'Sky Map', section: 'Markets', funSection: 'Adventures' },
  { href: '/buy', label: 'Buy Coverage', funLabel: 'Cover a Flight', section: 'Markets', funSection: 'Adventures' },
  { href: '/earn', label: 'Earn', funLabel: 'Vault', section: 'Markets', funSection: 'Adventures' },
  { href: '/portfolio', label: 'Portfolio', funLabel: 'Adventurer', section: 'Account', funSection: 'Hero' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { mode } = useTheme();
  const isFun = mode === 'fun';

  let lastSection = '';

  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-mark">
          <BrandMark size={24} />
        </span>
        <span className="brand-name">
          Sentinel<em>·</em>
        </span>
      </Link>

      {NAV_ITEMS.map((item) => {
        const sectionLabel = isFun ? item.funSection : item.section;
        const itemLabel = isFun ? item.funLabel : item.label;
        const isActive =
          item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href);

        const head =
          sectionLabel !== lastSection ? (
            <div key={`s-${sectionLabel}`} className="nav-section">
              {sectionLabel}
            </div>
          ) : null;
        lastSection = sectionLabel;

        return (
          <div key={item.href}>
            {head}
            <Link
              href={item.href}
              className={`nav-item${isActive ? ' active' : ''}`}
            >
              <span className="dot" />
              <span>{itemLabel}</span>
            </Link>
          </div>
        );
      })}

      <div className="sidebar-footer">
        <div className="live-pill">
          {isFun ? 'Sentinels on watch' : 'Live oracle · ACARS'}
        </div>
        <div>v0.1.0 · Solana Devnet</div>
      </div>
    </aside>
  );
}
