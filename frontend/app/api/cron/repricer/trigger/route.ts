/**
 * POST /api/cron/repricer/trigger — proxy to executor.
 *
 * Phase 25 (D-Phase25-1): query params (mode, dryRun) pass through
 * verbatim. The executor reads its env defaults (GROK_MOCK_VERDICT,
 * AGENT_MOCK, etc.) and resolves the effective mode there.
 */

import {
  executorBaseUrl,
  proxyJson,
  triggerHeaders,
} from '@/lib/executor-proxy';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const target = new URL(`${executorBaseUrl()}/api/trigger/repricer`);
  for (const k of ['mode', 'dryRun']) {
    const v = url.searchParams.get(k);
    if (v) target.searchParams.set(k, v);
  }
  return proxyJson(target.toString(), {
    method: 'POST',
    headers: triggerHeaders(),
  });
}
