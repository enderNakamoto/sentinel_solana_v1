/**
 * The Sentinel hexagon mark — pure SVG, no state.
 * Ported from design_system/shell.jsx::BrandMark.
 */
export interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 26 }: BrandMarkProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="brand-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5ee0d2" />
          <stop offset="1" stopColor="#ffb547" />
        </linearGradient>
      </defs>
      <path
        d="M16 2 L28 9 V20 L16 30 L4 20 V9 Z"
        fill="none"
        stroke="url(#brand-grad)"
        strokeWidth="1.5"
      />
      <path d="M10 16 L16 12 L22 16 L16 20 Z" fill="#ffb547" opacity="0.9" />
      <circle cx="16" cy="16" r="1.5" fill="#0a0e1a" />
    </svg>
  );
}
