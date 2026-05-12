/**
 * FlightAware AeroAPI client — minimal subset for the FlightDataFetcher
 * cron. Production logic (4xx envelope decode, scheduled→active fallback,
 * multi-segment carrier handling) lives in executor/src/core/aero_api.ts;
 * the Acurast bundle keeps just enough to demo a TEE-attested write path.
 */

import { envVar } from "./std";

const BASE_URL = "https://aeroapi.flightaware.com/aeroapi";

export interface AeroFlightSummary {
  flightId: string;
  /** Unix seconds, or null if not yet known. */
  etaUnix: number | null;
  /** Unix seconds — actual gate-in / on-ground. */
  actualArrivalUnix: number | null;
  cancelled: boolean;
}

export async function fetchFlightSummary(
  flightIdent: string,
): Promise<AeroFlightSummary | null> {
  const key = envVar("AEROAPI_KEY");
  if (!key) throw new Error("AEROAPI_KEY not set");

  const res = await fetch(`${BASE_URL}/flights/${encodeURIComponent(flightIdent)}`, {
    headers: { "x-apikey": key },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`aeroapi ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as {
    flights?: Array<{
      ident?: string;
      cancelled?: boolean;
      estimated_in?: string | null;
      actual_in?: string | null;
      estimated_on?: string | null;
      actual_on?: string | null;
    }>;
  };
  const f = body.flights?.[0];
  if (!f) return null;

  const eta = f.estimated_in ?? f.estimated_on ?? null;
  const actual = f.actual_in ?? f.actual_on ?? null;

  return {
    flightId: f.ident ?? flightIdent,
    etaUnix: eta ? Math.floor(new Date(eta).getTime() / 1000) : null,
    actualArrivalUnix: actual ? Math.floor(new Date(actual).getTime() / 1000) : null,
    cancelled: !!f.cancelled,
  };
}
