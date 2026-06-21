/**
 * Inline IATA → IATA route display with arrow. Used across markets,
 * portfolio, and buy pages. Ported from design_system/page-landing.jsx.
 */
export interface FlightRouteProps {
  from: string;
  to: string;
  minWidth?: number;
}

export function FlightRoute({ from, to, minWidth = 130 }: FlightRouteProps) {
  return (
    <div className="route" style={{ minWidth }}>
      <span className="iata">{from}</span>
      <span className="arr" />
      <span className="iata">{to}</span>
    </div>
  );
}
