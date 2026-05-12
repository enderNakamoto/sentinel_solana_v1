/**
 * FlightDataFetcher — Acurast TEE-attested oracle (Sentinel cron #1).
 *
 * Lifecycle (one Acurast execution):
 *   1. Read the on-chain ActiveFlightList PDA via Solana JSON-RPC.
 *   2. For each flight whose ETA window is open, hit FlightAware AeroAPI.
 *   3. Dispatch to oracle_aggregator:
 *        - set_estimated_arrival(eta)      → first sighting of ETA
 *        - set_landed(actual_arrival)      → flight landed
 *        - set_cancelled                   → flight cancelled
 *   4. Each tx is signed by _STD_.signers.ed25519 (the TEE-attested key)
 *      and submitted directly to Solana RPC — the signing key never
 *      leaves the secure chip.
 *
 * For the proof, step 1 reads ActiveFlightList raw bytes but does NOT
 * fully deserialize the Anchor Vec<FlightEntry> layout — that requires
 * either the IDL or a hand-rolled borsh decoder which would bloat the
 * bundle. Instead, the demo reads a comma-separated flight list from
 * the env var `DEMO_FLIGHT_IDS` so the operator can prove the signing
 * path end-to-end without writing a deserializer. Production swaps this
 * for the same Anchor-Vec decoder executor/src/core/run_fetcher.ts uses.
 */

import { PublicKey } from "@solana/web3.js";
import { envVar, requireEnv } from "../lib/std";
import { fetchFlightSummary } from "../lib/aeroapi";
import { findFlightDataPda } from "../lib/pdas";
import {
  OracleAddrs,
  setCancelledIx,
  setEstimatedArrivalIx,
  setLandedIx,
} from "../lib/ix/oracle";
import { buildSignAndSend, teePubkey } from "../lib/tx";

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SOLANA_RPC_URL");
  const oracleProgramId = new PublicKey(requireEnv("ORACLE_PROGRAM_ID"));
  const oracleConfig = new PublicKey(requireEnv("ORACLE_CONFIG_PDA"));
  const authorizedOracle = teePubkey();
  const flightIds = (envVar("DEMO_FLIGHT_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(
    `[fetcher] tee-oracle=${authorizedOracle.toBase58()} flights=${flightIds.length}`,
  );

  if (flightIds.length === 0) {
    console.log("[fetcher] no flights to poll; exiting");
    return;
  }

  for (const flightId of flightIds) {
    try {
      const summary = await fetchFlightSummary(flightId);
      if (!summary) {
        console.log(`[fetcher] ${flightId} no aeroapi data; skip`);
        continue;
      }

      const addrs: OracleAddrs = {
        programId: oracleProgramId,
        oracleConfig,
        flightData: findFlightDataPda(flightId, oracleProgramId),
        authorizedOracle,
      };

      let ix;
      if (summary.cancelled) {
        ix = setCancelledIx(addrs, flightId);
      } else if (summary.actualArrivalUnix !== null) {
        ix = setLandedIx(addrs, flightId, BigInt(summary.actualArrivalUnix));
      } else if (summary.etaUnix !== null) {
        ix = setEstimatedArrivalIx(addrs, flightId, BigInt(summary.etaUnix));
      } else {
        console.log(`[fetcher] ${flightId} no actionable timestamps; skip`);
        continue;
      }

      const { signature } = await buildSignAndSend({
        rpcUrl,
        instructions: [ix],
      });
      console.log(`[fetcher] ${flightId} -> ${signature}`);
    } catch (err) {
      console.error(`[fetcher] ${flightId} failed:`, err);
    }
  }
}

main().catch((err) => {
  console.error("[fetcher] fatal:", err);
  process.exit(1);
});
