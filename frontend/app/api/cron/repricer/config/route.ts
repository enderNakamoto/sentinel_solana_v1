/**
 * GET /api/cron/repricer/config
 *
 * Reports the repricer's effective server-side configuration so the
 * /crons UI can render the live/mock toggle correctly. Server-only —
 * XAI_API_KEY is never returned, only the boolean "is set".
 *
 * Phase 23. Mirrors Phase 18's /api/cron/fetcher/config shape.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  const liveAvailable = Boolean(process.env.XAI_API_KEY);
  const grokMockOn = process.env.GROK_MOCK === '1';
  const agentMockOn = process.env.AGENT_MOCK === '1';
  const agentBaseUrl = process.env.AGENT_BASE_URL ?? '';

  // Default mode: explicit env mock-flag wins over a present key.
  const defaultMode: 'mock' | 'live' =
    grokMockOn || agentMockOn ? 'mock' : liveAvailable && agentBaseUrl ? 'live' : 'mock';

  // Probe agent reachability — 1s timeout, never throws.
  let agentReachable = false;
  if (agentBaseUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_000);
      try {
        const res = await fetch(`${agentBaseUrl.replace(/\/+$/, '')}/healthz`, {
          method: 'GET',
          signal: controller.signal,
        });
        agentReachable = res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      agentReachable = false;
    }
  }

  return NextResponse.json({
    ok: true,
    liveAvailable,
    agentReachable,
    agentBaseUrl: agentBaseUrl || null,
    defaultMode,
    defaultGrokVerdict: process.env.GROK_MOCK_VERDICT ?? 'ok',
    grokMockVerdicts: ['ok', 'raise:1.5', 'raise:2.0', 'disable'],
  });
}
