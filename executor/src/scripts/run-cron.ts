/**
 * executor/scripts/run-cron.ts
 *
 * Phase 10 — Thin entry shim for the node-cron daemon. Lets us re-use
 * `scripts/run.sh` (which resolves names against `executor/src/scripts/`)
 * to bundle + run the daemon. The actual implementation lives in
 * `../backends/cron/index.ts`.
 *
 * Run via:
 *   pnpm cron-daemon
 * or directly:
 *   bash scripts/run.sh run-cron
 */

import './../backends/cron/index.ts';
