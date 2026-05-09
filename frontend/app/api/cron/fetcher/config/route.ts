/**
 * GET /api/cron/fetcher/config
 *
 * Reports the fetcher's effective server-side configuration so the
 * /crons UI can render the live/mock toggle correctly. Server-only —
 * AEROAPI_KEY is never returned, only the boolean "is set".
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const SCENARIOS = ['on_time', 'delayed', 'cancelled', 'scheduled', 'not_found'] as const;

export function GET() {
  const liveAvailable = Boolean(process.env.AEROAPI_KEY);
  const envMockOn = process.env.AEROAPI_MOCK === '1';
  // Default mode: explicit env mock-flag wins over a present key.
  const defaultMode: 'mock' | 'live' = envMockOn
    ? 'mock'
    : liveAvailable
      ? 'live'
      : 'mock';
  const defaultScenario =
    (process.env.AEROAPI_MOCK_SCENARIO ?? 'on_time').toLowerCase();
  return NextResponse.json({
    ok: true,
    liveAvailable,
    defaultMode,
    defaultScenario: SCENARIOS.includes(defaultScenario as never)
      ? defaultScenario
      : 'on_time',
    scenarios: SCENARIOS,
  });
}
