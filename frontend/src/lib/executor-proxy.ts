/**
 * frontend/src/lib/executor-proxy.ts
 *
 * Phase 25 — Shared helper for the Vercel-side proxies into the Render
 * executor. Every cron-related API route here is now a thin proxy:
 *   - /api/cron/runs        → GET  ${EXECUTOR_BASE_URL}/api/logs
 *   - /api/cron/[id]/trigger    → POST ${EXECUTOR_BASE_URL}/api/trigger/:job
 *   - /api/cron/repricer/trigger → POST ${EXECUTOR_BASE_URL}/api/trigger/repricer
 *   - /api/cron/fetcher/config  → GET  ${EXECUTOR_BASE_URL}/api/config/fetcher
 *   - /api/cron/repricer/config → GET  ${EXECUTOR_BASE_URL}/api/config/repricer
 *
 * SERVER-SIDE ONLY. The executor URL is intentionally kept off the
 * client bundle; if the lambda is omitted, the browser would otherwise
 * see the Render hostname directly which weakens the EXECUTOR_TRIGGER_SECRET
 * gate.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Resolve the executor base URL. Falls back to `http://localhost:8080`
 * for local dev so the frontend works against a daemon running in
 * another terminal without needing to set the env var.
 */
export function executorBaseUrl(): string {
  return (
    process.env.EXECUTOR_BASE_URL?.replace(/\/+$/, '') ??
    'http://localhost:8080'
  );
}

/**
 * Trigger-auth header pass-through. If the executor was started with
 * `EXECUTOR_TRIGGER_SECRET`, the frontend must hold the same secret in
 * its env and forward it on every POST /api/trigger/* proxy call.
 */
export function triggerHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const secret = process.env.EXECUTOR_TRIGGER_SECRET;
  if (secret) h['X-Trigger-Secret'] = secret;
  return h;
}

/**
 * Proxy an upstream JSON response back to the caller with the same
 * status code. Body is forwarded verbatim. Failures (network, timeout)
 * map to 502.
 */
export async function proxyJson(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `executor unreachable at ${url}: ${(e as Error).message}`,
      },
      { status: 502 },
    );
  }
  const text = await upstream.text();
  // Pass through Content-Type if present, else default to JSON.
  const ct = upstream.headers.get('content-type') ?? 'application/json';
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': ct },
  });
}
