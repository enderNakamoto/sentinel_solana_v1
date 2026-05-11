/**
 * POST /api/cron/[id]/trigger — proxy to executor.
 *
 * Phase 25 (D-Phase25-1): query params (mode, scenario) pass through
 * verbatim. The executor reads its env defaults (AEROAPI_MOCK_SCENARIO
 * etc.) and resolves the effective mode there. No in-lambda execution.
 */

import {
  executorBaseUrl,
  proxyJson,
  triggerHeaders,
} from '@/lib/executor-proxy';

export const runtime = 'nodejs';

const VALID_JOBS = new Set(['fetcher', 'classifier', 'settler']);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!VALID_JOBS.has(id)) {
    return Response.json(
      { ok: false, error: `Unknown cron id: ${id}` },
      { status: 400 },
    );
  }
  const url = new URL(req.url);
  const target = new URL(`${executorBaseUrl()}/api/trigger/${id}`);
  for (const k of ['mode', 'scenario']) {
    const v = url.searchParams.get(k);
    if (v) target.searchParams.set(k, v);
  }
  return proxyJson(target.toString(), {
    method: 'POST',
    headers: triggerHeaders(),
  });
}
