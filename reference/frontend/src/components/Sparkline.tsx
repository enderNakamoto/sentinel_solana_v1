/**
 * Tiny SVG sparkline. Pure SVG — no chart lib dependency.
 * Ported from design_system/shell.jsx::Sparkline.
 */
export interface SparklineProps {
  data: number[];
  color?: string;
  fill?: string;
  height?: number;
}

export function Sparkline({
  data,
  color = 'var(--cyan)',
  fill = 'rgba(94,224,210,.12)',
  height = 40,
}: SparklineProps) {
  if (data.length < 2) return null;
  const w = 200;
  const h = height;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * w,
    h - ((v - min) / range) * (h - 4) - 2,
  ]);
  const d = 'M' + pts.map((p) => p.join(',')).join(' L ');
  const area = `${d} L ${w},${h} L 0,${h} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: h, display: 'block' }}
      aria-hidden="true"
    >
      <path d={area} fill={fill} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
