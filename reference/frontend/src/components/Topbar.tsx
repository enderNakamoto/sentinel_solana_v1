'use client';

import { usePathname } from 'next/navigation';
import { WalletButton } from './WalletButton';

interface CrumbMap {
  [path: string]: [string, string];
}

const CRUMBS: CrumbMap = {
  '/': ['Sentinel', 'Home'],
  '/markets': ['Markets', 'Live'],
  '/buy': ['Markets', 'Buy Coverage'],
  '/earn': ['Markets', 'Earn'],
  '/portfolio': ['Account', 'Portfolio'],
};

const MOCK_TICKER = [
  { label: 'TVL', value: '$7.42M', delta: '+1.2%', dir: 'up' as const },
  { label: 'APY', value: '12.4%', delta: '+0.3%', dir: 'up' as const },
  { label: 'Open', value: '142', delta: undefined, dir: undefined },
  { label: 'Settled 24h', value: '$184k', delta: '+8.2%', dir: 'up' as const },
];

export function Topbar() {
  const pathname = usePathname();

  const matchedKey = Object.keys(CRUMBS)
    .sort((a, b) => b.length - a.length)
    .find((k) => (k === '/' ? pathname === '/' : pathname.startsWith(k))) ?? '/';
  const [crumbA, crumbB] = CRUMBS[matchedKey] ?? ['Sentinel', ''];

  return (
    <div className="topbar">
      <div className="crumbs">
        {crumbA}{' '}
        <span style={{ color: 'var(--ink-4)', margin: '0 8px' }}>/</span>{' '}
        <strong>{crumbB}</strong>
      </div>
      <div className="spacer" />
      <div className="ticker">
        {MOCK_TICKER.map((t) => (
          <span key={t.label} className="t-item">
            <span className="muted">{t.label}</span>
            <span className="v">{t.value}</span>
            {t.delta && <span className={t.dir}>{t.delta}</span>}
          </span>
        ))}
      </div>
      <WalletButton />
    </div>
  );
}
