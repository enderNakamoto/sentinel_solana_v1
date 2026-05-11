/**
 * GET /api/cron/fetcher/config — proxy to executor.
 *
 * Phase 25 (D-Phase25-6): single source of truth for "is live mode
 * available" lives on the executor (where AEROAPI_KEY is set). Vercel
 * doesn't need the AeroAPI key anymore.
 */

import { executorBaseUrl, proxyJson } from '@/lib/executor-proxy';

export const runtime = 'nodejs';

export async function GET() {
  return proxyJson(`${executorBaseUrl()}/api/config/fetcher`);
}
