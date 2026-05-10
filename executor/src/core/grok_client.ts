/**
 * executor/src/core/grok_client.ts
 *
 * xAI Grok client for the Phase 23 Route Repricer cron.
 *
 * Live mode: POSTs to https://api.x.ai/v1/chat/completions with
 *   - model: "grok-4"
 *   - search_parameters: { mode: "on", sources: [{ type: "news" }] }
 *   - response_format: { type: "json_schema", json_schema: GeopoliticalRiskSchema }
 * Asks Grok whether geopolitical / airspace events justify a premium
 * multiplier or full route disable for the next 30 days.
 *
 * Mock mode: returns the env-driven fixture (GROK_MOCK_VERDICT) without
 * touching the network.
 *
 * Failure semantic: any error → safe-default `{ action: "ok",
 * multiplier: 1.0, reason: "grok unavailable; baseline only" }`. NEVER
 * throws — the cron's per-route loop must keep going. Same posture as
 * the Phase 18 AeroAPI client.
 */

export type GrokAction = 'ok' | 'raise' | 'disable';

export interface GrokVerdict {
  action: GrokAction;
  /** 1.0–3.0 when action === 'raise'; 1.0 otherwise. */
  multiplier: number;
  /** ≤200 chars; surfaced in the activity feed. */
  reason: string;
}

export interface RouteSummary {
  flightId: string;
  carrier: string;
  origin: string;
  destination: string;
}

export interface GrokClient {
  assess(route: RouteSummary): Promise<GrokVerdict>;
}

export const GROK_SAFE_DEFAULT: GrokVerdict = {
  action: 'ok',
  multiplier: 1.0,
  reason: 'grok unavailable; baseline only',
};

// ─── Live xAI client ─────────────────────────────────────────────────────

export interface CreateGrokClientOpts {
  apiKey: string;
  /** xAI base URL. Override for testing. Default https://api.x.ai/v1 */
  baseUrl?: string;
  /** Model id. Default grok-4. */
  model?: string;
  /** Per-call timeout in ms. Default 30_000 (Live Search is slow). */
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4';

export function createGrokClient(opts: CreateGrokClientOpts): GrokClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function buildRequest(route: RouteSummary): unknown {
    const userPrompt =
      `You are a flight insurance risk analyst. Within the next 30 days, ` +
      `is there credible news of airspace closure, military action, embargo, ` +
      `or a major operational disruption affecting flights from ` +
      `${route.origin} to ${route.destination} operated by carrier ` +
      `${route.carrier} (e.g. flight ${route.flightId})? ` +
      `Reply with strict JSON conforming to the provided schema. ` +
      `Use action "disable" only for confirmed flight-stopping events ` +
      `(announced airspace closure, fleet grounding, war zone). ` +
      `Use "raise" with a multiplier between 1.1 and 3.0 for elevated ` +
      `but still-operational risk (severe weather forecast, partial strikes, ` +
      `regional unrest near the airport). ` +
      `Use "ok" with multiplier 1.0 when no credible disruption is reported.`;

    return {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a precise risk analyst. Always return strict JSON ' +
            'matching the schema. Keep the reason field under 200 characters.',
        },
        { role: 'user', content: userPrompt },
      ],
      search_parameters: {
        mode: 'on',
        sources: [{ type: 'news' }],
      },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'geopolitical_risk_verdict',
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['ok', 'raise', 'disable'] },
              multiplier: { type: 'number', minimum: 1.0, maximum: 3.0 },
              reason: { type: 'string', maxLength: 200 },
            },
            required: ['action', 'multiplier', 'reason'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    };
  }

  return {
    async assess(route) {
      try {
        const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(buildRequest(route)),
        });
        if (!res.ok) {
          return { ...GROK_SAFE_DEFAULT, reason: `grok ${res.status}: ${GROK_SAFE_DEFAULT.reason}` };
        }
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = body?.choices?.[0]?.message?.content;
        if (!content) return GROK_SAFE_DEFAULT;
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return GROK_SAFE_DEFAULT;
        }
        return coerceVerdict(parsed);
      } catch {
        return GROK_SAFE_DEFAULT;
      }
    },
  };
}

/**
 * Validate + clamp a parsed JSON object into a GrokVerdict. Any field
 * that fails schema validation falls back to the safe default. Exposed
 * for unit tests.
 */
export function coerceVerdict(raw: unknown): GrokVerdict {
  if (!raw || typeof raw !== 'object') return GROK_SAFE_DEFAULT;
  const r = raw as Record<string, unknown>;
  const actionRaw = String(r.action ?? '').toLowerCase();
  if (actionRaw !== 'ok' && actionRaw !== 'raise' && actionRaw !== 'disable') {
    return GROK_SAFE_DEFAULT;
  }
  const action = actionRaw as GrokAction;
  const multRaw = Number(r.multiplier ?? 1.0);
  const multiplier =
    action === 'raise'
      ? Math.max(1.0, Math.min(3.0, Number.isFinite(multRaw) ? multRaw : 1.0))
      : 1.0;
  const reason = String(r.reason ?? '').slice(0, 200);
  return { action, multiplier, reason: reason || GROK_SAFE_DEFAULT.reason };
}

// ─── Mock client for tests + GROK_MOCK env ───────────────────────────────

export interface MockGrokClientOpts {
  /** Pinned verdict spec; default 'ok'. Format: 'ok' | 'raise:<mult>' | 'disable'. */
  verdict?: string;
}

/**
 * Parse a GROK_MOCK_VERDICT env value into a GrokVerdict. Exposed for
 * unit tests + the route-handler env-resolution path.
 */
export function parseMockVerdict(spec: string | undefined): GrokVerdict {
  const raw = (spec ?? 'ok').trim().toLowerCase();
  if (raw === 'disable') {
    return { action: 'disable', multiplier: 1.0, reason: 'mock: disable scenario' };
  }
  if (raw === 'ok' || raw === '') {
    return { action: 'ok', multiplier: 1.0, reason: 'mock baseline' };
  }
  if (raw.startsWith('raise')) {
    const parts = raw.split(':');
    const m = parts[1] !== undefined ? Number(parts[1]) : 1.5;
    const multiplier = Math.max(1.0, Math.min(3.0, Number.isFinite(m) ? m : 1.5));
    return {
      action: 'raise',
      multiplier,
      reason: `mock: raise×${multiplier.toFixed(2)}`,
    };
  }
  return { action: 'ok', multiplier: 1.0, reason: 'mock baseline (unknown verdict spec)' };
}

export function createMockGrokClient(opts: MockGrokClientOpts = {}): GrokClient {
  const verdict = parseMockVerdict(opts.verdict);
  return {
    async assess(_route) {
      return verdict;
    },
  };
}
