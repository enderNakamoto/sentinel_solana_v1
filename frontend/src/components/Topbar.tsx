'use client';

import { usePathname } from 'next/navigation';
import { ModeToggle } from './ModeToggle';
import { WalletButton } from './WalletButton';
import { useTheme } from '@/theme/ThemeProvider';

interface CrumbMap {
  [path: string]: [string, string];
}

const SERIOUS_CRUMBS: CrumbMap = {
  '/': ['Sentinel', 'Home'],
  '/markets': ['Markets', 'Live'],
  '/buy': ['Markets', 'Buy Coverage'],
  '/earn': ['Markets', 'Earn'],
  '/portfolio': ['Account', 'Portfolio'],
};

const FUN_CRUMBS: CrumbMap = {
  '/': ['AeroQuest', 'Tavern'],
  '/markets': ['Sky Map', 'Live'],
  '/buy': ['Quests', 'Cover a Flight'],
  '/earn': ['Vault', 'Earn'],
  '/portfolio': ['Adventurer', 'Portfolio'],
};

const MOCK_TICKER = [
  { label: 'TVL', value: '$7.42M', delta: '+1.2%', dir: 'up' as const },
  { label: 'APY', value: '12.4%', delta: '+0.3%', dir: 'up' as const },
  { label: 'Open', value: '142', delta: undefined, dir: undefined },
  { label: 'Settled 24h', value: '$184k', delta: '+8.2%', dir: 'up' as const },
];

export function Topbar() {
  const pathname = usePathname();
  const { mode } = useTheme();
  const isFun = mode === 'fun';

  // Match the most specific route prefix (so /buy/whatever still maps to /buy).
  const crumbMap = isFun ? FUN_CRUMBS : SERIOUS_CRUMBS;
  const matchedKey = Object.keys(crumbMap)
    .sort((a, b) => b.length - a.length)
    .find((k) => (k === '/' ? pathname === '/' : pathname.startsWith(k))) ?? '/';
  const [crumbA, crumbB] = crumbMap[matchedKey] ?? ['Sentinel', ''];

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
      {isFun && (
        <span className="gem-pill">
          <svg viewBox="0 0 16 16">
            <polygon
              points="8,1 14,6 11,15 5,15 2,6"
              fill="#a78bfa"
              stroke="#2a1408"
              strokeWidth="1"
            />
            <polygon
              points="8,1 14,6 8,9 2,6"
              fill="#c4b5fd"
              stroke="#2a1408"
              strokeWidth="1"
            />
          </svg>
          1,250
        </span>
      )}
      <ModeToggle />
      <WalletButton />
    </div>
  );
}
