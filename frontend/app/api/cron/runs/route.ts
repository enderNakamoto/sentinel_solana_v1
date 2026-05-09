/**
 * GET /api/cron/runs
 *
 * Returns recent cron-run records for the /crons page activity feeds.
 * Query params:
 *   - cron: 'classifier' | 'settler' | 'fetcher' (optional — omit for all)
 *   - limit: integer 1..100 (default 20)
 */

import { NextResponse } from 'next/server';
import { readRecentRuns, type CronId } from '@/lib/cron-runs';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cronParam = url.searchParams.get('cron');
  const limitParam = url.searchParams.get('limit');

  let cron: CronId | undefined;
  if (cronParam) {
    if (
      cronParam !== 'classifier' &&
      cronParam !== 'settler' &&
      cronParam !== 'fetcher'
    ) {
      return NextResponse.json(
        { ok: false, error: `Unknown cron id: ${cronParam}` },
        { status: 400 },
      );
    }
    cron = cronParam;
  }

  let limit = 20;
  if (limitParam) {
    const n = Number(limitParam);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return NextResponse.json(
        { ok: false, error: 'limit must be 1..100' },
        { status: 400 },
      );
    }
    limit = Math.floor(n);
  }

  const runs = readRecentRuns(cron, limit);
  return NextResponse.json({ ok: true, runs });
}
