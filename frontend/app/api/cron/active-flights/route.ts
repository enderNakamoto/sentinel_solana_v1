/**
 * GET /api/cron/active-flights
 *
 * Reads `ActiveFlightList` PDA + each entry's `FlightData.status` from
 * the chain the frontend is currently configured for, and returns a
 * compact JSON array the /crons page renders as a "what would the next
 * tick do" panel.
 *
 * No keypair needed — read-only RPC calls.
 */

import { NextResponse } from 'next/server';
import { createSolanaClient } from '@executor/core/solana_client';
import { FlightStatus } from '@executor/core/types';
import { activeCluster, repoRoot, resolveKeeperKeypairPath } from '@/lib/cron-keypair';

export const runtime = 'nodejs';

const STATUS_NAME: Record<FlightStatus, string> = {
  [FlightStatus.NotInitiated]: 'NotInitiated',
  [FlightStatus.Active]: 'Active',
  [FlightStatus.Landed]: 'Landed',
  [FlightStatus.Cancelled]: 'Cancelled',
  [FlightStatus.ToBeSettledOnTime]: 'ToBeSettledOnTime',
  [FlightStatus.ToBeSettledDelayed]: 'ToBeSettledDelayed',
  [FlightStatus.ToBeSettledCancelled]: 'ToBeSettledCancelled',
  [FlightStatus.Settled]: 'Settled',
};

export async function GET() {
  try {
    const cluster = activeCluster();
    // The reader doesn't actually transact, but `createSolanaClient`
    // still wants a signer for parity with the trigger routes. Re-using
    // the keeper keypair is harmless — it isn't used here.
    const keypairPath = resolveKeeperKeypairPath();
    const solana = await createSolanaClient({
      cluster,
      repoRoot: repoRoot(),
      keypairPath,
    });

    const entries = await solana.readActiveFlightList();
    const flights = await Promise.all(
      entries.map(async (entry) => {
        const status =
          (await solana.readFlightDataStatus(entry.flightId, entry.date)) ??
          FlightStatus.NotInitiated;
        return {
          flightId: entry.flightId,
          date: entry.date.toString(),
          status: STATUS_NAME[status] ?? `Unknown(${status})`,
        };
      }),
    );

    return NextResponse.json({
      ok: true,
      cluster,
      rpcUrl: solana.rpcUrl,
      count: flights.length,
      flights,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: message.slice(0, 240) },
      { status: 500 },
    );
  }
}
