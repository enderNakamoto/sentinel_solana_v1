/**
 * GET /api/cron/runs — proxy to executor's /api/logs.
 *
 * Phase 25. Forwards `?cron=&limit=` query params verbatim. The
 * executor's in-memory ring buffer is the single source of truth for
 * cron-run history; Vercel no longer persists anything.
 */

import { executorBaseUrl, proxyJson } from '@/lib/executor-proxy';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = new URL(`${executorBaseUrl()}/api/logs`);
  // Forward whitelisted params verbatim — keeps the executor's input
  // validation as the single gate.
  for (const k of ['cron', 'limit']) {
    const v = url.searchParams.get(k);
    if (v) target.searchParams.set(k, v);
  }
  // The executor returns `{ ok, runs }` — we forward verbatim. Clients
  // that consumed the old `/api/cron/runs` already handled that shape.
  return proxyJson(target.toString());
}
