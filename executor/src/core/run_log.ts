/**
 * executor/src/core/run_log.ts
 *
 * Phase 25 — In-memory ring buffer for cron-run records. The executor's
 * only memory of past runs. No DB, no file, no external service —
 * module-scope state with `push + shift` rotation, MAX_ENTRIES per job.
 *
 * Lifetime: `startedAt` and `buffers` are initialized when the module is
 * first imported and live until the Node process exits. Process restart
 * wipes everything — that's why the `/crons` UI shows empty logs right
 * after a Render redeploy until each cron fires again. Accepted in
 * D-Phase25-3; audit/forensic history lives on chain.
 *
 * Trade-offs:
 *   - Cheap, zero-dep. No I/O, no schema migrations, no rotation logic.
 *   - Lossy on restart — operational dashboard only.
 *   - Single-process. If we ever scaled to multiple replicas, each would
 *     hold its own buffer and `/api/logs` would show whichever replica
 *     the load balancer routed to (don't scale — D-Phase25-2 keeps one
 *     instance).
 */

import type { HealthStatus, JobName, RunLogEntry } from './types.ts';

const MAX_ENTRIES = 10;

const buffers: Record<JobName, RunLogEntry[]> = {
  fetcher: [],
  classifier: [],
  settler: [],
  repricer: [],
};

const startedAt = new Date();

/**
 * Append a record to the matching job's buffer. If the buffer would
 * exceed `MAX_ENTRIES`, drop the oldest (head). Not a true ring buffer —
 * `shift()` is O(n) — but n ≤ 10 so the cost is negligible.
 */
export function logRun(entry: RunLogEntry): void {
  const buf = buffers[entry.cron];
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.shift();
}

/**
 * Return the live buffers object by reference. Callers must JSON-encode
 * (or copy) immediately — mutating the returned object corrupts state.
 * The HTTP /api/logs handler serializes straight to JSON, so the shared
 * reference is safe in practice.
 */
export function getLogs(): Record<JobName, RunLogEntry[]> {
  return buffers;
}

/**
 * Return the most-recent records for a given cron (newest-first), or
 * across all crons when `cron` is undefined. Interleaved by `ts` when
 * cross-cron — matches the previous frontend `/api/cron/runs` shape.
 */
export function readRecentRuns(
  cron: JobName | undefined,
  limit: number = 20,
): RunLogEntry[] {
  if (cron) {
    const buf = buffers[cron];
    return buf.slice(-limit).reverse();
  }
  // All crons. Concat → sort by ts ascending → tail → reverse to newest-first.
  const all: RunLogEntry[] = [];
  for (const key of Object.keys(buffers) as JobName[]) {
    all.push(...buffers[key]);
  }
  all.sort((a, b) => a.ts.localeCompare(b.ts));
  return all.slice(-limit).reverse();
}

/**
 * Walk recent repricer records and return the union of their
 * `newlyDisabledPdas` — drives the next run's re-enable gate
 * (D23-1: only re-enable routes that this cron previously disabled).
 *
 * Bounded to the recent buffer length so a long-running daemon doesn't
 * accumulate forever. The buffer cap is `MAX_ENTRIES`, which gives
 * effectively unlimited recent context here.
 */
export function readDisabledByRepricer(): Set<string> {
  const acc = new Set<string>();
  for (const r of buffers.repricer) {
    if (Array.isArray(r.newlyDisabledPdas)) {
      for (const pda of r.newlyDisabledPdas) acc.add(pda);
    }
  }
  return acc;
}

/**
 * Build the current `/api/health` payload — uptime (since module load)
 * + the most recent entry per job (null if the job hasn't run yet).
 */
export function getHealth(): HealthStatus {
  const uptimeMs = Date.now() - startedAt.getTime();
  return {
    uptime_seconds: Math.floor(uptimeMs / 1000),
    started_at: startedAt.toISOString(),
    last_run: {
      fetcher: buffers.fetcher.at(-1) ?? null,
      classifier: buffers.classifier.at(-1) ?? null,
      settler: buffers.settler.at(-1) ?? null,
      repricer: buffers.repricer.at(-1) ?? null,
    },
  };
}

/** Short random id for an entry — keeps UI list keys stable. */
export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
