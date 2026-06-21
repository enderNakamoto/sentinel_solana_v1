'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandMark } from './BrandMark';

interface NavItem {
  href: string;
  label: string;
  section: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', section: 'Protocol' },
  { href: '/markets', label: 'Live Markets', section: 'Markets' },
  { href: '/buy', label: 'Buy Coverage', section: 'Markets' },
  { href: '/earn', label: 'Earn', section: 'Markets' },
  { href: '/portfolio', label: 'Portfolio', section: 'Account' },
];

export function Sidebar() {
  const pathname = usePathname();

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
        const isActive =
          item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href);

        const head =
          item.section !== lastSection ? (
            <div key={`s-${item.section}`} className="nav-section">
              {item.section}
            </div>
          ) : null;
        lastSection = item.section;

        return (
          <div key={item.href}>
            {head}
            <Link
              href={item.href}
              className={`nav-item${isActive ? ' active' : ''}`}
            >
              <span className="dot" />
              <span>{item.label}</span>
            </Link>
          </div>
        );
      })}

      <div className="sidebar-footer">
        <div className="live-pill">Live oracle · ACARS</div>
        <div>v0.1.0</div>
      </div>
    </aside>
  );
}
