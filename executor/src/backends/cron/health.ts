/**
 * executor/backends/cron/health.ts
 *
 * Minimal /health HTTP server for the cron daemon. Reports last-run
 * timestamp + result for each schedule. Used by Docker's HEALTHCHECK
 * directive and by Kubernetes liveness/readiness probes.
 *
 * Returns:
 *   GET /health → 200 with JSON
 *     {
 *       "ok": true,
 *       "schedules": {
 *         "fetcher":    {"lastRunUnix": 1778029553, "lastResult": "ok"},
 *         "classifier": {"lastRunUnix": 1778029553, "lastResult": "ok"},
 *         "settler":    {"lastRunUnix": 1778029553, "lastResult": "ok"}
 *       }
 *     }
 *
 *   GET anything else → 404.
 *
 * The `ok` field is true if no schedule has reported `failed` on its
 * last run. `null` lastRunUnix means the schedule hasn't run yet (cold
 * start; orchestrator should not flag as unhealthy until at least one
 * tick of the slowest schedule — 2h — has elapsed).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type ScheduleName = 'fetcher' | 'classifier' | 'settler';
export type ScheduleResult = 'ok' | 'failed';

export interface ScheduleStatus {
  lastRunUnix: number | null;
  lastResult: ScheduleResult | null;
}

export type HealthState = Record<ScheduleName, ScheduleStatus>;

export function emptyHealthState(): HealthState {
  return {
    fetcher: { lastRunUnix: null, lastResult: null },
    classifier: { lastRunUnix: null, lastResult: null },
    settler: { lastRunUnix: null, lastResult: null },
  };
}

export function recordTick(
  state: HealthState,
  schedule: ScheduleName,
  result: ScheduleResult,
): void {
  state[schedule] = {
    lastRunUnix: Math.floor(Date.now() / 1000),
    lastResult: result,
  };
}

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

export function startHealthServer(state: HealthState, port: number): HealthServer {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      const ok = Object.values(state).every(
        (s) => s.lastResult !== 'failed',
      );
      const body = JSON.stringify({ ok, schedules: state });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port);
  return {
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
