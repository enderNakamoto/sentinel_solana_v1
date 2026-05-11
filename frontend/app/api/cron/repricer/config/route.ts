/**
 * GET /api/cron/repricer/config — proxy to executor.
 *
 * Phase 25 (D-Phase25-6): single source of truth for "is live mode
 * available" lives on the executor (where XAI_API_KEY + AGENT_BASE_URL
 * are set). Vercel doesn't need either anymore.
 */

import { executorBaseUrl, proxyJson } from '@/lib/executor-proxy';

export const runtime = 'nodejs';

export async function GET() {
  return proxyJson(`${executorBaseUrl()}/api/config/repricer`);
}
