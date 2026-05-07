'use client';

import { usePathname } from 'next/navigation';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Fun-mode-only decorations. Renders null in serious mode.
 * Per Phase 12 M1: this component lives entirely under src/theme/fun/.
 *
 * Pages render <Mascots /> at the layout level; the component itself
 * decides what (if anything) to draw based on the active theme + route.
 */
export function Mascots() {
  const { mode } = useTheme();
  const pathname = usePathname();

  if (mode !== 'fun') return null;

  // Pilot mascot hidden on the globe page (it has its own immersive view).
  const showPilot = !pathname.startsWith('/markets');

  return (
    <>
      {showPilot && (
        <svg
          className="fun-mascot-pilot"
          viewBox="0 0 96 96"
          aria-hidden="true"
        >
          {/* Pilot helmet + face */}
          <ellipse cx="48" cy="60" rx="28" ry="30" fill="#6b3a1f" />
          <ellipse cx="48" cy="62" rx="22" ry="20" fill="#f4d4a8" />
          <rect x="22" y="44" width="52" height="10" rx="4" fill="#3a2410" />
          <circle
            cx="36"
            cy="48"
            r="5"
            fill="#67e8f9"
            stroke="#1e293b"
            strokeWidth="1.5"
          />
          <circle
            cx="60"
            cy="48"
            r="5"
            fill="#67e8f9"
            stroke="#1e293b"
            strokeWidth="1.5"
          />
          <ellipse cx="48" cy="40" rx="32" ry="14" fill="#92400e" />
          <ellipse cx="48" cy="36" rx="30" ry="10" fill="#b45309" />
          <path
            d="M 30 70 Q 48 76 66 70"
            fill="none"
            stroke="#3a2410"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="40" cy="68" r="2" fill="#dc2626" opacity="0.4" />
          <circle cx="56" cy="68" r="2" fill="#dc2626" opacity="0.4" />
        </svg>
      )}

      {/* Floating clouds */}
      <svg
        className="fun-cloud-1"
        style={{ top: 80, right: 240, width: 110, height: 50, opacity: 0.5 }}
        viewBox="0 0 110 50"
        aria-hidden="true"
      >
        <ellipse cx="30" cy="32" rx="22" ry="14" fill="white" />
        <ellipse cx="55" cy="26" rx="26" ry="18" fill="white" />
        <ellipse cx="82" cy="32" rx="20" ry="14" fill="white" />
      </svg>
      <svg
        className="fun-cloud-2"
        style={{ top: 320, right: 60, width: 90, height: 42, opacity: 0.45 }}
        viewBox="0 0 90 42"
        aria-hidden="true"
      >
        <ellipse cx="22" cy="26" rx="18" ry="12" fill="white" />
        <ellipse cx="48" cy="22" rx="22" ry="14" fill="white" />
        <ellipse cx="68" cy="28" rx="16" ry="10" fill="white" />
      </svg>
    </>
  );
}
