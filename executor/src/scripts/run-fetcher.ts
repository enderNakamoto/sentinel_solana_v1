/**
 * executor/scripts/run-fetcher.ts
 *
 * Phase 8 — One-shot runner for the FlightDataFetcher cron. Loads env,
 * builds Solana + AeroAPI clients, calls `runFetcherOnce`, exits.
 *
 * In production (Phase 10) this same logic is wrapped by the node-cron
 * backend on a 2-hour schedule. For manual operation:
 *
 *   ORACLE_KEYPAIR=keys/surfpool-oracle.json \
 *   AEROAPI_KEY=... \
 *   CLUSTER=surfpool \
 *   pnpm run-fetcher
 *
 * Required env:
 *   CLUSTER             — surfpool | devnet | testnet | mainnet
 *   ORACLE_KEYPAIR      — path to the authorized_oracle keypair file
 *   AEROAPI_KEY         — FlightAware AeroAPI key (x-apikey header)
 *
 * Optional env:
 *   SOLANA_RPC_URL      — overrides the deployment artifact's rpcUrl
 *   AEROAPI_BASE_URL    — overrides https://aeroapi.flightaware.com/aeroapi
 *                         (useful for staging or replay testing)
 */

import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAeroApiClient } from '../core/aeroapi_client.ts';
import {
  decideFetcherActions,
  runFetcherOnce,
} from '../core/flight_data_fetcher.ts';
import { createSolanaClient } from '../core/solana_client.ts';
import {
  type ActiveFlightEntry,
  type SolanaClient,
} from '../core/solana_client.ts';
import { type DeploymentArtifact, type FetcherAction } from '../core/types.ts';

import {
  getSetCancelledInstructionAsync,
  getSetEstimatedArrivalInstructionAsync,
  getSetLandedInstructionAsync,
} from '../clients/oracle_aggregator/src/generated/index.ts';
import { address as kitAddress } from '@solana/kit';

// ─── Action → Codama instructions translator ─────────────────────────────
//
// Lives in the runner (not in core) so the core decision module stays
// Codama-import-free for clean unit testing.

async function actionToIxs(
  solana: SolanaClient,
  entry: ActiveFlightEntry,
  action: FetcherAction,
): Promise<Array<Awaited<ReturnType<typeof getSetEstimatedArrivalInstructionAsync>>>> {
  // The fetcher's three oracle ixs share the same accounts struct (per
  // Phase 4 D1 — `SetFlightStatus`), so a single return-array type works.
  switch (action.kind) {
    case 'skip':
      return [];

    case 'set_estimated_arrival':
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: await deriveFlightDataPdaAddr(solana.deployment, entry),
          authority: solana.signer,
          flightId: entry.flightId,
          date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
      ];

    case 'set_landed':
      return [
        (await getSetLandedInstructionAsync({
          flightData: await deriveFlightDataPdaAddr(solana.deployment, entry),
          authority: solana.signer,
          flightId: entry.flightId,
          date: entry.date,
          actualArrival: BigInt(action.actualArrivalUnixSec),
        })) as never,
      ];

    case 'set_cancelled':
      return [
        (await getSetCancelledInstructionAsync({
          flightData: await deriveFlightDataPdaAddr(solana.deployment, entry),
          authority: solana.signer,
          flightId: entry.flightId,
          date: entry.date,
        })) as never,
      ];

    case 'set_estimated_arrival_then_cancelled': {
      const fdPda = await deriveFlightDataPdaAddr(solana.deployment, entry);
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: fdPda,
          authority: solana.signer,
          flightId: entry.flightId,
          date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
        (await getSetCancelledInstructionAsync({
          flightData: fdPda,
          authority: solana.signer,
          flightId: entry.flightId,
          date: entry.date,
        })) as never,
      ];
    }

    case 'set_estimated_arrival_then_landed': {
      const fdPda = await deriveFlightDataPdaAddr(solana.deployment, entry);
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: fdPda,
          authority: solana.signer,
          flightId: entry.flightId,
          date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
        (await getSetLandedInstructionAsync({
          flightData: fdPda,
          authority: solana.signer,
          flightId: entry.flightId,
          date: entry.date,
          actualArrival: BigInt(action.actualArrivalUnixSec),
        })) as never,
      ];
    }
  }
}

async function deriveFlightDataPdaAddr(
  deployment: DeploymentArtifact,
  entry: ActiveFlightEntry,
) {
  // Reuse the helper from solana_client; small re-export here keeps the
  // imports tidy.
  const { PublicKey } = await import('@solana/web3.js');
  const dateBytes = Buffer.alloc(8);
  dateBytes.writeBigUInt64LE(entry.date);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('flight'), Buffer.from(entry.flightId, 'utf-8'), dateBytes],
    new PublicKey(deployment.programs.oracle_aggregator),
  );
  return kitAddress(pda.toBase58());
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const cluster = requireEnv('CLUSTER');
  const oracleKeypair = requireEnv('ORACLE_KEYPAIR');
  const aeroApiKey = requireEnv('AEROAPI_KEY');
  const rpcUrlOverride = process.env.SOLANA_RPC_URL;
  const aeroBaseUrl = process.env.AEROAPI_BASE_URL;

  const repoRoot = findRepoRoot();
  const solana = await createSolanaClient({
    cluster,
    repoRoot,
    keypairPath: oracleKeypair,
    rpcUrl: rpcUrlOverride,
  });
  const aero = createAeroApiClient({ apiKey: aeroApiKey, baseUrl: aeroBaseUrl });

  console.log(
    `[run-fetcher] cluster=${cluster} rpc=${solana.rpcUrl} ` +
      `oracle_authority=${solana.signer.address}`,
  );

  await runFetcherOnce({
    solana,
    aero,
    applyAction: async (entry, action) => {
      const ixs = await actionToIxs(solana, entry, action);
      if (ixs.length > 0) {
        await solana.sendIxs(ixs);
      }
    },
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[run-fetcher] missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function findRepoRoot(): string {
  // Walk up from the bundled script's __dirname until we find package.json
  // with name === 'sentinel-solana'.
  const start = dirname(fileURLToPath(import.meta.url));
  let cur = start;
  for (let i = 0; i < 10; i++) {
    const pkg = resolve(cur, 'package.json');
    try {
      const txt = require('node:fs').readFileSync(pkg, 'utf-8');
      const parsed = JSON.parse(txt) as { name?: string };
      if (parsed.name === 'sentinel-solana') return cur;
    } catch {
      /* keep walking */
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

const isMain = /\/run-fetcher\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[run-fetcher] failed:', (err as Error).message ?? err);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  });
}

// Re-export for the node-cron backend (Phase 10) to call without process.exit.
export { actionToIxs, decideFetcherActions, runFetcherOnce };
