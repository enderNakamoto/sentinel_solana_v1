/**
 * frontend/src/lib/cron-runs.ts
 *
 * JSONL-on-disk persistence for cron-run records. Each line in the log
 * file is a complete `CronRunRecord` JSON object. Append-rotates at
 * `RECORDS_PER_CRON` to keep the file from growing unbounded.
 *
 * SERVER-SIDE ONLY. Never import this from a client component.
 *
 * Caveat: on Vercel/serverless deploys the filesystem is ephemeral, so
 * the log resets on each cold start / redeploy. For hackathon-local use
 * this is fine; for production we'd swap the impl for KV/Postgres
 * behind the same `appendRun` / `readRecentRuns` interface.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type CronId = 'classifier' | 'settler' | 'fetcher';

export interface CronRunRecord {
  /** Random per-record identifier (lets the UI key list items stably). */
  id: string;
  /** Which cron produced this record. */
  cron: CronId;
  /** ISO timestamp at trigger start. */
  ts: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True if every batch landed; false if any batch failed (or pre-flight error). */
  ok: boolean;
  /**
   * Single concise human-readable summary line. Per the Phase 17 spec
   * this is what the activity feed renders by default — keep it tight.
   *  - OK: "3 acted, 5 skipped"  /  "0 settleable"
   *  - FAILED: "tx failed: insufficient funds for rent"
   */
  summary: string;
  /** Tx signatures that landed during this tick (success or partial). */
  signatures: string[];
  /** Captured stdout, joined with newlines. Used by "View log". */
  logs: string;
  /** Concise error message when ok=false (mirror of summary's tail). */
  error?: string;
}

const RECORDS_PER_CRON = 100;
const LOG_FILENAME = '.cache-cron-runs.jsonl';

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(cur, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'sentinel-solana') return cur;
      } catch {
        /* keep walking */
      }
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

export function cronLogPath(): string {
  // The frontend workspace dir houses the log so it shares the
  // gitignore + `pnpm clean` lifecycle with `.next/` and friends.
  const repoRoot = findRepoRoot(process.cwd());
  return resolve(repoRoot, 'frontend', LOG_FILENAME);
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAllLines(path: string): CronRunRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return [];
  const out: CronRunRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CronRunRecord);
    } catch {
      // Skip malformed lines silently — they're diagnostic-only data.
    }
  }
  return out;
}

/**
 * Append a record to the JSONL. If the post-append count for this
 * cron exceeds `RECORDS_PER_CRON`, rewrite the file with the trimmed
 * tail. Cheap because the file is small (≤200 records total) and
 * `/api/cron/runs` is also bounded so the rewrites stay fast.
 */
export function appendRun(record: CronRunRecord): void {
  const path = cronLogPath();
  ensureDir(path);
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');

  // Rotate if we exceed the cap for this cron.
  const all = readAllLines(path);
  const keptByCron: Record<CronId, CronRunRecord[]> = {
    classifier: [],
    settler: [],
    fetcher: [],
  };
  for (const r of all) {
    if (r.cron === 'classifier' || r.cron === 'settler' || r.cron === 'fetcher') {
      keptByCron[r.cron].push(r);
    }
  }
  let didTrim = false;
  for (const cronId of ['classifier', 'settler', 'fetcher'] as const) {
    if (keptByCron[cronId].length > RECORDS_PER_CRON) {
      keptByCron[cronId] = keptByCron[cronId].slice(-RECORDS_PER_CRON);
      didTrim = true;
    }
  }
  if (didTrim) {
    const merged = [
      ...keptByCron.classifier,
      ...keptByCron.settler,
      ...keptByCron.fetcher,
    ].sort((a, b) => a.ts.localeCompare(b.ts));
    writeFileSync(path, merged.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}

/**
 * Return the most-recent records for a given cron, newest-first.
 * Pass `cron: undefined` to get all crons interleaved.
 */
export function readRecentRuns(
  cron: CronId | undefined,
  limit = 20,
): CronRunRecord[] {
  const path = cronLogPath();
  const all = readAllLines(path);
  const filtered = cron ? all.filter((r) => r.cron === cron) : all;
  return filtered.slice(-limit).reverse();
}

/** Generate a short random id for a record. */
export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
