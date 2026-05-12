/**
 * Phase 22 premium-pricing agent client (XGBoost FastAPI service).
 * Same contract the executor's repricer uses — POST /price returns a
 * premium clamped to [$1, $5].
 */

import { envVar } from "./std";

export interface RouteFeatures {
  flight_id: string;
  carrier: string;
  origin: string;
  dest: string;
  dep_time_hhmm: string;
  distance_mi: number;
  month: number;
  day_of_month: number;
  day_of_week: number;
}

export interface AgentPriceResponse {
  premium_usdc: number;
  premium_base_units: number;
  model_version?: string;
}

export async function getBaselinePremium(
  features: RouteFeatures,
): Promise<AgentPriceResponse> {
  const baseUrl = envVar("AGENT_BASE_URL");
  if (!baseUrl) throw new Error("AGENT_BASE_URL not set");

  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(features),
  });
  if (!res.ok) {
    throw new Error(`agent ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as AgentPriceResponse;
}
