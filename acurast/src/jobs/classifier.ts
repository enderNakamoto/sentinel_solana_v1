/**
 * FlightClassifier — Acurast TEE-attested classifier (Sentinel cron #2).
 *
 * Calls controller.classify_flights() once per execution. The handler
 * iterates remaining_accounts (FlightData + RouteAccount pairs) and
 * transitions each Landed/Cancelled flight into ToBeSettled{OnTime,
 * Delayed, Cancelled}. The Acurast TEE signs as ControllerConfig
 * .authorized_keeper.
 *
 * The remaining_accounts list is built off-chain from ActiveFlightList
 * — same shape as executor/src/core/run_classifier.ts. For the proof,
 * the list is sourced from the env var `DEMO_FLIGHT_IDS` so the
 * deployment can be exercised without a full Anchor-Vec decoder.
 */

import { PublicKey } from "@solana/web3.js";
import { envVar, requireEnv } from "../lib/std";
import { findFlightDataPda, findRouteAccountPda } from "../lib/pdas";
import {
  ControllerCoreAddrs,
  classifyFlightsIx,
} from "../lib/ix/controller";
import { meta } from "../lib/anchor";
import { buildSignAndSend, teePubkey } from "../lib/tx";

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SOLANA_RPC_URL");
  const controllerProgramId = new PublicKey(requireEnv("CONTROLLER_PROGRAM_ID"));
  const oracleProgramId = new PublicKey(requireEnv("ORACLE_PROGRAM_ID"));
  const governanceProgramId = new PublicKey(
    envVar("GOVERNANCE_PROGRAM_ID") ??
      "6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT",
  );
  const controllerConfig = new PublicKey(requireEnv("CONTROLLER_CONFIG_PDA"));
  const activeFlights = new PublicKey(requireEnv("ACTIVE_FLIGHTS_PDA"));
  const authorizedKeeper = teePubkey();
  const flightIds = (envVar("DEMO_FLIGHT_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(
    `[classifier] tee-keeper=${authorizedKeeper.toBase58()} flights=${flightIds.length}`,
  );

  if (flightIds.length === 0) {
    console.log("[classifier] active flights empty; skip");
    return;
  }

  const remainingAccounts = flightIds.flatMap((flightId) => [
    meta(findFlightDataPda(flightId, oracleProgramId), false, true),
    meta(findRouteAccountPda(flightId, governanceProgramId), false, false),
  ]);

  const addrs: ControllerCoreAddrs = {
    programId: controllerProgramId,
    controllerConfig,
    activeFlights,
    authorizedKeeper,
  };

  try {
    const ix = classifyFlightsIx(addrs, remainingAccounts);
    const { signature } = await buildSignAndSend({
      rpcUrl,
      instructions: [ix],
      computeUnitLimit: 1_200_000,
    });
    console.log(`[classifier] classified ${flightIds.length} -> ${signature}`);
  } catch (err) {
    console.error("[classifier] tx failed:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[classifier] fatal:", err);
  process.exit(1);
});
