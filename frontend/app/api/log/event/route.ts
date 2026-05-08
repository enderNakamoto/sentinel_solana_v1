/**
 * POST /api/log/event
 *
 * Browser → server bridge for toast / debug events. The frontend
 * fire-and-forgets a JSON payload here; we mirror it to the dev-server
 * stdout so anyone tailing the Next.js process (Claude Code, an operator
 * watching the terminal, etc.) sees the same error text the user sees.
 *
 * Schema: { kind: 'info'|'success'|'error', title, body?, source?, url?, ts? }
 *
 * Always returns 204 — never throws back at the client, since this is
 * purely diagnostic. Invalid JSON / missing fields are logged as such
 * and ignored.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

interface EventPayload {
  kind?: string;
  title?: string;
  body?: string;
  source?: string;
  url?: string;
  ts?: number;
}

export async function POST(req: Request) {
  let payload: EventPayload | null = null;
  try {
    payload = (await req.json()) as EventPayload;
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[browser-log] invalid JSON body');
    return new NextResponse(null, { status: 204 });
  }
  if (!payload || typeof payload !== 'object') {
    return new NextResponse(null, { status: 204 });
  }

  const kind = (payload.kind ?? 'info').toString().toLowerCase();
  const title = (payload.title ?? '').toString();
  const body = (payload.body ?? '').toString();
  const source = (payload.source ?? '').toString();
  const url = (payload.url ?? '').toString();
  const ts =
    typeof payload.ts === 'number' && Number.isFinite(payload.ts)
      ? new Date(payload.ts).toISOString()
      : new Date().toISOString();

  const tag = `[browser-${kind}]`;
  const meta = [ts, source && `src=${source}`, url && `url=${url}`]
    .filter(Boolean)
    .join(' · ');
  const headline = `${tag} ${title}${meta ? `  (${meta})` : ''}`;

  // Send errors to stderr so they're visually distinct in the dev log;
  // info / success go to stdout.
  if (kind === 'error') {
    // eslint-disable-next-line no-console
    console.error(headline);
    if (body) {
      // eslint-disable-next-line no-console
      console.error(
        body
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n'),
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(headline);
    if (body) {
      // eslint-disable-next-line no-console
      console.log(
        body
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n'),
      );
    }
  }

  return new NextResponse(null, { status: 204 });
}
