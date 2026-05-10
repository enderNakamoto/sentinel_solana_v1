/**
 * executor/src/core/route_repricer.ts
 *
 * Phase 23 Route Repricer cron orchestrator.
 *
 * For each whitelisted RouteAccount on the configured cluster:
 *   1. Parse `flight_id` to extract carrier (e.g. "AA100" -> "AA").
 *   2. POST the flight tuple to the Phase 22 agent → baseline premium.
 *   3. Ask Grok for a geopolitical risk verdict → multiplier or disable.
 *   4. Decide one of `noop` / `update_premium` / `disable` /
 *      `reenable_with_terms` via the pure `decideRouteAction` module.
 *   5. The caller's `applyAction` callback turns the action into a tx.
 *
 * Returns the per-route decision array — the route handler serialises
 * this into the JSONL log + activity feed.
 */

import {
  type Address,
  type Base58EncodedBytes,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import type { AgentClient, AgentPriceRequest } from './agent_client.ts';
import type { GrokClient } from './grok_client.ts';
import {
  type RouteAction,
  type RouteState,
  decideRouteAction,
} from './decide_route_actions.ts';

// Re-export so route handlers can import RouteAction from a single place.
export type { RouteAction } from './decide_route_actions.ts';

// ─── RouteAccount discriminator + decoder (Anchor layout) ────────────────
//
// Lifted from
// `executor/src/clients/governance/src/generated/accounts/routeAccount.ts`.
// We avoid importing the Codama client here to keep this module
// test-friendly (the generated chain has directory-import quirks).

const ROUTE_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  135, 89, 73, 184, 33, 21, 243, 86,
]);

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58FromBytes(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    out = BASE58_ALPHABET[r] + out;
  }
  return '1'.repeat(leading) + out;
}

const ROUTE_ACCOUNT_DISCRIMINATOR_B58 = base58FromBytes(
  ROUTE_ACCOUNT_DISCRIMINATOR,
);

interface DecodedRouteAccount {
  flightId: string;
  origin: string;
  destination: string;
  premium: bigint | null;
  payoff: bigint | null;
  delayHours: number | null;
  approved: boolean;
}

function readOptionU64(
  buf: Buffer,
  off: number,
): { value: bigint | null; bytesRead: number } {
  const tag = buf.readUInt8(off);
  if (tag === 0) return { value: null, bytesRead: 1 };
  return { value: buf.readBigUInt64LE(off + 1), bytesRead: 9 };
}

function readOptionU32(
  buf: Buffer,
  off: number,
): { value: number | null; bytesRead: number } {
  const tag = buf.readUInt8(off);
  if (tag === 0) return { value: null, bytesRead: 1 };
  return { value: buf.readUInt32LE(off + 1), bytesRead: 5 };
}

export function decodeRouteAccount(buf: Buffer): DecodedRouteAccount {
  // Skip 8-byte discriminator.
  let off = 8;
  // Borsh String: u32 length + utf-8 bytes.
  const flightLen = buf.readUInt32LE(off);
  off += 4;
  const flightId = buf.slice(off, off + flightLen).toString('utf-8');
  off += flightLen;
  const originLen = buf.readUInt32LE(off);
  off += 4;
  const origin = buf.slice(off, off + originLen).toString('utf-8');
  off += originLen;
  const destLen = buf.readUInt32LE(off);
  off += 4;
  const destination = buf.slice(off, off + destLen).toString('utf-8');
  off += destLen;
  // Option<u64> premium, payoff
  const premium = readOptionU64(buf, off);
  off += premium.bytesRead;
  const payoff = readOptionU64(buf, off);
  off += payoff.bytesRead;
  // Option<u32> delay_hours
  const delayHours = readOptionU32(buf, off);
  off += delayHours.bytesRead;
  // bool approved (1 byte)
  const approved = buf.readUInt8(off) !== 0;
  return {
    flightId,
    origin,
    destination,
    premium: premium.value,
    payoff: payoff.value,
    delayHours: delayHours.value,
    approved,
  };
}

// ─── Carrier inference ───────────────────────────────────────────────────
//
// `RouteAccount.flight_id` is e.g. "AA100", "UA1532". Two-char carrier
// code + numeric flight number. Phase 23 Pre-work Notes: skip routes that
// don't match this shape rather than synthesise.

const FLIGHT_ID_REGEX = /^([A-Z0-9]{2})(\d+)$/;

export function parseCarrierFromFlightId(flightId: string): string | null {
  const m = flightId.toUpperCase().match(FLIGHT_ID_REGEX);
  return m ? m[1] : null;
}

// ─── Calendar feature derivation ─────────────────────────────────────────
//
// The Phase 22 agent expects (month, day_of_month, day_of_week,
// dep_time_hhmm, distance_mi). The on-chain RouteAccount has none of
// these — it's flight_id + origin + dest + premium/payoff/delay overrides.
// For the POC we feed today's date as the reference time and use simple
// fallback values for the numerical features. Phase 23 §Out-of-scope
// flags this: realistic per-route distance + scheduled departure are a
// follow-up that requires either an FlightPool join or a static route
// catalog.

export interface DepTimeAndDistanceFallback {
  /** Default scheduled departure time HHMM. Default 1200 (noon). */
  depTimeHhmm: number;
  /** Default route distance (miles). Default 1000. */
  distanceMi: number;
}

const DEFAULT_FALLBACK: DepTimeAndDistanceFallback = {
  depTimeHhmm: 1200,
  distanceMi: 1000,
};

export function buildAgentRequest(
  flightId: string,
  carrier: string,
  origin: string,
  destination: string,
  now: Date,
  fallback: DepTimeAndDistanceFallback,
): AgentPriceRequest {
  const month = now.getUTCMonth() + 1; // 1-12
  const dayOfMonth = now.getUTCDate(); // 1-31
  // JS getUTCDay: 0=Sun..6=Sat. Agent expects Mon=1..Sun=7.
  const jsDow = now.getUTCDay();
  const dayOfWeek = jsDow === 0 ? 7 : jsDow;

  return {
    flight_id: flightId,
    carrier,
    origin,
    dest: destination,
    dep_time_hhmm: fallback.depTimeHhmm,
    distance_mi: fallback.distanceMi,
    month,
    day_of_month: dayOfMonth,
    day_of_week: dayOfWeek,
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────

export interface RepricerLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

function consoleLogger(): RepricerLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
}

export interface RouteDecisionRecord {
  routePda: string;
  flightId: string;
  origin: string;
  destination: string;
  carrier: string;
  baselinePremiumBaseUnits: string; // bigint stringified for JSONL
  baselinePremiumUsdc: number;
  grokAction: string;
  grokMultiplier: number;
  grokReason: string;
  /** Stringified-bigints version of RouteAction so JSON.stringify works. */
  action: SerializedRouteAction;
  txSignature?: string;
  error?: string;
}

export type SerializedRouteAction =
  | { kind: 'noop'; routePda: string; reason: string }
  | {
      kind: 'update_premium';
      routePda: string;
      flightId: string;
      origin: string;
      destination: string;
      newPremiumBaseUnits: string;
      reason: string;
    }
  | {
      kind: 'disable';
      routePda: string;
      flightId: string;
      origin: string;
      destination: string;
      reason: string;
    }
  | {
      kind: 'reenable_with_terms';
      routePda: string;
      flightId: string;
      origin: string;
      destination: string;
      newPremiumBaseUnits: string;
      reason: string;
    };

export function serializeAction(a: RouteAction): SerializedRouteAction {
  if (a.kind === 'noop' || a.kind === 'disable') return a;
  return { ...a, newPremiumBaseUnits: a.newPremiumBaseUnits.toString() };
}

export interface RunRepricerOpts {
  rpc: Rpc<SolanaRpcApi>;
  agent: AgentClient;
  grok: GrokClient;
  governanceProgramId: Address;
  /** Returns a tx signature on success. Skipped entirely when dryRun=true. */
  applyAction: (action: RouteAction) => Promise<string>;
  /** Routes this cron previously disabled — eligible for re-enable. */
  recentDisablesByRepricer: ReadonlySet<string>;
  /** When true, decide actions but never call applyAction. */
  dryRun?: boolean;
  /** UTC reference for calendar-feature derivation. Default: today. */
  now?: Date;
  /** Fallback values for the numerical features. Default: noon, 1000 mi. */
  fallback?: DepTimeAndDistanceFallback;
  logger?: RepricerLogger;
}

export interface RunRepricerResult {
  decisions: RouteDecisionRecord[];
  signatures: string[];
  histogram: { noop: number; update: number; disable: number; reenable: number };
  /** Routes newly disabled in THIS run — caller appends to JSONL `disabledByRepricer`. */
  newlyDisabledPdas: string[];
}

export async function runRepricerOnce(
  opts: RunRepricerOpts,
): Promise<RunRepricerResult> {
  const log = opts.logger ?? consoleLogger();
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const fallback = opts.fallback ?? DEFAULT_FALLBACK;

  log.info(
    `[repricer] scanning routes (program=${opts.governanceProgramId} dryRun=${dryRun})`,
  );

  // 1. Fetch all RouteAccounts via getProgramAccounts + memcmp on the
  // 8-byte Anchor discriminator. Kit's RPC types union the
  // `withContext`/no-`withContext` shapes; cast to the unwrapped array
  // form (matches the runtime shape when withContext is omitted/false).
  const accountsResp = (await opts.rpc
    .getProgramAccounts(opts.governanceProgramId, {
      encoding: 'base64',
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: ROUTE_ACCOUNT_DISCRIMINATOR_B58 as unknown as Base58EncodedBytes,
            encoding: 'base58',
          },
        },
      ],
    })
    .send()) as unknown as ReadonlyArray<{
    pubkey: Address;
    account: {
      data: readonly [string, 'base64'];
      owner: Address;
      lamports: bigint;
      executable: boolean;
    };
  }>;

  log.info(`[repricer] found ${accountsResp.length} RouteAccount(s)`);

  // 2. Decode + iterate.
  const decisions: RouteDecisionRecord[] = [];
  const signatures: string[] = [];
  const histogram = { noop: 0, update: 0, disable: 0, reenable: 0 };
  const newlyDisabledPdas: string[] = [];

  for (const entry of accountsResp) {
    const pda = String(entry.pubkey);
    const dataB64 = Array.isArray(entry.account.data)
      ? entry.account.data[0]
      : (entry.account.data as unknown as string);
    const buf = Buffer.from(dataB64, 'base64');

    let decoded: DecodedRouteAccount;
    try {
      decoded = decodeRouteAccount(buf);
    } catch (e) {
      log.warn(`[repricer] failed to decode RouteAccount ${pda}: ${String(e)}`);
      continue;
    }

    const carrier = parseCarrierFromFlightId(decoded.flightId);
    if (!carrier) {
      log.warn(
        `[repricer] flight_id "${decoded.flightId}" doesn't match /^[A-Z0-9]{2}\\d+$/ — skipping route ${pda}`,
      );
      continue;
    }

    // 3. Agent baseline.
    let agentResp;
    try {
      agentResp = await opts.agent.postPrice(
        buildAgentRequest(
          decoded.flightId,
          carrier,
          decoded.origin,
          decoded.destination,
          now,
          fallback,
        ),
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.warn(`[repricer] agent failed for ${decoded.flightId}: ${err} — skipping`);
      continue;
    }

    // 4. Grok verdict (never throws — has its own safe-default).
    const verdict = await opts.grok.assess({
      flightId: decoded.flightId,
      carrier,
      origin: decoded.origin,
      destination: decoded.destination,
    });

    // 5. Decide.
    const route: RouteState = {
      pda,
      flightId: decoded.flightId,
      origin: decoded.origin,
      destination: decoded.destination,
      currentPremiumBaseUnits: decoded.premium,
      approved: decoded.approved,
    };
    const baselineBaseUnits = BigInt(agentResp.premium_base_units);
    const action = decideRouteAction(
      route,
      baselineBaseUnits,
      verdict,
      opts.recentDisablesByRepricer,
    );

    // 6. Apply (or skip if dryRun / noop).
    let txSignature: string | undefined;
    let error: string | undefined;
    if (action.kind !== 'noop') {
      if (dryRun) {
        log.info(`[repricer] DRY_RUN ${action.kind} for ${decoded.flightId}`);
      } else {
        try {
          txSignature = await opts.applyAction(action);
          signatures.push(txSignature);
          log.info(
            `[repricer] ${action.kind} for ${decoded.flightId} → ${txSignature}`,
          );
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          log.warn(`[repricer] applyAction failed for ${decoded.flightId}: ${error}`);
        }
      }
    }

    // Track what we did.
    if (action.kind === 'noop') histogram.noop++;
    else if (action.kind === 'update_premium') histogram.update++;
    else if (action.kind === 'disable') {
      histogram.disable++;
      if (!error) newlyDisabledPdas.push(pda);
    } else if (action.kind === 'reenable_with_terms') histogram.reenable++;

    decisions.push({
      routePda: pda,
      flightId: decoded.flightId,
      origin: decoded.origin,
      destination: decoded.destination,
      carrier,
      baselinePremiumBaseUnits: baselineBaseUnits.toString(),
      baselinePremiumUsdc: agentResp.premium_usdc,
      grokAction: verdict.action,
      grokMultiplier: verdict.multiplier,
      grokReason: verdict.reason,
      action: serializeAction(action),
      txSignature,
      error,
    });
  }

  log.info(
    `[repricer] done: ${histogram.noop} noop · ${histogram.update} update · ` +
      `${histogram.disable} disable · ${histogram.reenable} reenable`,
  );

  return { decisions, signatures, histogram, newlyDisabledPdas };
}

