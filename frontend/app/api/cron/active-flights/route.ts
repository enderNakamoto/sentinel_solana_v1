/**
 * GET /api/cron/active-flights — proxy to executor.
 *
 * Phase 25. The executor already holds a SolanaClient and reads the
 * ActiveFlightList + per-flight status. This Vercel route just forwards
 * the call so the frontend has a single source of truth for cron data.
 */

import { executorBaseUrl, proxyJson } from '@/lib/executor-proxy';

export const runtime = 'nodejs';

export async function GET() {
  return proxyJson(`${executorBaseUrl()}/api/active-flights`);
}
