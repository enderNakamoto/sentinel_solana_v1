/**
 * executor/src/core/agent_client.ts
 *
 * Typed HTTP client for the Phase 22 Premium Pricing Agent.
 *
 * Used by the Phase 23 Route Repricer cron to obtain a baseline premium
 * per route before applying the Grok geopolitical multiplier.
 *
 * Live mode: POST ${baseUrl}/price with the flight tuple → premium response.
 * Mock mode: in-process stub returning a fixed fixture (no network).
 *
 * Design: no retries. 5s timeout per call. The cron handles failures by
 * skipping the route and emitting a warning in the captured log — same
 * posture as the AeroAPI client in Phase 18.
 */

export interface AgentPriceRequest {
  flight_id: string;
  carrier: string;
  origin: string;
  dest: string;
  dep_time_hhmm: number;
  distance_mi: number;
  month: number;
  day_of_month: number;
  day_of_week: number;
}

export interface AgentPriceResponse {
  p_delay: number;
  premium_usdc: number;
  premium_base_units: number;
  model_version: string;
}

export interface AgentHealth {
  ok: boolean;
  modelVersion?: string;
  error?: string;
}

export interface AgentClient {
  postPrice(req: AgentPriceRequest): Promise<AgentPriceResponse>;
  /** Reachability probe — used for the route handler's pre-flight check. */
  healthz(): Promise<AgentHealth>;
}

const PUSD_BASE_UNITS_PER_PUSD = 1_000_000;

// ─── Live HTTP client ────────────────────────────────────────────────────

export interface CreateAgentClientOpts {
  baseUrl: string;
  /** Per-call timeout in ms. Default 5_000. */
  timeoutMs?: number;
  /** Override for tests / dependency injection. */
  fetchImpl?: typeof fetch;
}

export function createAgentClient(opts: CreateAgentClientOpts): AgentClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  async function fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async postPrice(req) {
      const res = await fetchWithTimeout('/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`agent /price returned ${res.status}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as AgentPriceResponse;
    },

    async healthz() {
      try {
        const res = await fetchWithTimeout('/healthz', { method: 'GET' });
        if (!res.ok) {
          return { ok: false, error: `agent /healthz returned ${res.status}` };
        }
        const body = (await res.json()) as { status: string; model_version: string };
        return { ok: body.status === 'ok', modelVersion: body.model_version };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  };
}

// ─── Mock client for tests + AGENT_MOCK env ──────────────────────────────

export interface MockAgentClientOpts {
  /** USDC premium returned for every request. Default 2.5 ($2.50). Clamped to [1, 5]. */
  fixedPremiumUsdc?: number;
}

export function createMockAgentClient(opts: MockAgentClientOpts = {}): AgentClient {
  const raw = opts.fixedPremiumUsdc ?? 2.5;
  const fixed = Math.max(1.0, Math.min(5.0, raw));
  const modelVersion = 'mock';
  return {
    async postPrice(_req) {
      return {
        p_delay: (fixed - 1.0) / 4.0,
        premium_usdc: fixed,
        premium_base_units: Math.round(fixed * PUSD_BASE_UNITS_PER_PUSD),
        model_version: modelVersion,
      };
    },
    async healthz() {
      return { ok: true, modelVersion };
    },
  };
}
