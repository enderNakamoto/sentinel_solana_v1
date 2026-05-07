/**
 * Risk bar — 0..1 → green/amber/red gradient meter.
 * Ported from design_system/page-landing.jsx::RiskBar.
 */
export interface RiskBarProps {
  /** 0..1 — 0 = no risk, 1 = certain delay */
  risk: number;
}

export function RiskBar({ risk }: RiskBarProps) {
  const pct = Math.round(risk * 100);
  const color =
    risk < 0.25 ? 'var(--green)' : risk < 0.4 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="risk-bar">
        <div style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="num muted" style={{ fontSize: 11 }}>
        {pct}%
      </span>
    </div>
  );
}
