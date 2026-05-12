/**
 * xAI Grok client — Agent Tools API (/v1/responses) with web_search.
 *
 * Mirrors executor/src/core/grok_client.ts at a minimal surface: query
 * Grok for a single route, parse the schema-conformant JSON, fall back
 * to a safe default on any error so the repricer keeps making progress.
 */

import { envVar } from "./std";

export type GrokAction = "ok" | "raise" | "disable";
export interface GrokVerdict {
  action: GrokAction;
  multiplier: number;
  reason: string;
}

export const GROK_SAFE_DEFAULT: GrokVerdict = {
  action: "ok",
  multiplier: 1.0,
  reason: "grok unavailable; baseline only",
};

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4-fast-non-reasoning";

export interface RouteSummary {
  flightId: string;
  carrier: string;
  origin: string;
  destination: string;
}

export async function assessRoute(route: RouteSummary): Promise<GrokVerdict> {
  const apiKey = envVar("XAI_API_KEY");
  if (!apiKey) return GROK_SAFE_DEFAULT;

  const systemPrompt =
    "You are a precise flight-insurance risk analyst. Use the " +
    "web_search tool to ground every answer on real news. Return " +
    "strict JSON matching the schema. Keep reason under 200 chars.";
  const userPrompt =
    `Within the next 30 days, is there credible news of airspace ` +
    `closure, military action, embargo, or a major operational ` +
    `disruption affecting flights from ${route.origin} to ` +
    `${route.destination} on carrier ${route.carrier} (flight ${route.flightId})?`;

  const body = {
    model: DEFAULT_MODEL,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    text: {
      format: {
        type: "json_schema",
        name: "geopolitical_risk_verdict",
        schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["ok", "raise", "disable"] },
            multiplier: { type: "number", minimum: 1.0, maximum: 3.0 },
            reason: { type: "string", maxLength: 200 },
          },
          required: ["action", "multiplier", "reason"],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  };

  try {
    const res = await fetch(`${DEFAULT_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ...GROK_SAFE_DEFAULT, reason: `grok ${res.status}` };
    }
    const envelope = (await res.json()) as {
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };
    const text = extractOutputText(envelope);
    if (!text) return GROK_SAFE_DEFAULT;
    return coerceVerdict(JSON.parse(text));
  } catch {
    return GROK_SAFE_DEFAULT;
  }
}

function extractOutputText(body: {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}): string | null {
  for (const item of body?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c?.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }
  return null;
}

function coerceVerdict(raw: unknown): GrokVerdict {
  if (!raw || typeof raw !== "object") return GROK_SAFE_DEFAULT;
  const r = raw as Record<string, unknown>;
  const actionRaw = String(r.action ?? "").toLowerCase();
  if (actionRaw !== "ok" && actionRaw !== "raise" && actionRaw !== "disable") {
    return GROK_SAFE_DEFAULT;
  }
  const action = actionRaw as GrokAction;
  const m = Number(r.multiplier ?? 1.0);
  const multiplier =
    action === "raise"
      ? Math.max(1.0, Math.min(3.0, Number.isFinite(m) ? m : 1.0))
      : 1.0;
  const reason = String(r.reason ?? "").slice(0, 200);
  return { action, multiplier, reason: reason || GROK_SAFE_DEFAULT.reason };
}
