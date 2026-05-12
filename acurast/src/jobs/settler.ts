/**
 * SettlementExecutor — Acurast TEE-attested settler (Sentinel cron #3).
 *
 * Calls controller.execute_settlements(n_flights) once per execution.
 * The handler dispatches on FlightData.status (ToBeSettled*) and CPIs
 * into vault + flight_pool + oracle to pay out claims, release locked
 * capital, and drain the FIFO withdrawal queue.
 *
 * The accounts payload is large: per-flight slices + static sibling
 * accounts (vault_state, flight_pool_config, etc.). For the proof we
 * stub the static slice as an empty list — the deployment can be
 * wired up by filling `STATIC_SIBLINGS_BASE58` (comma-separated)
 * and `DEMO_FLIGHT_IDS` (also comma-separated) from operator env.
 * Production reads them from deployments/devnet-latest.json directly.
 */

import { PublicKey } from "@solana/web3.js";
import { envVar, requireEnv } from "../lib/std";
import { findFlightDataPda, findFlightPoolPda } from "../lib/pdas";
import {
  ControllerCoreAddrs,
  SettlementSiblings,
  executeSettlementsIx,
} from "../lib/ix/controller";
import { meta } from "../lib/anchor";
import { buildSignAndSend, teePubkey } from "../lib/tx";

const MAX_FLIGHTS_PER_TX = 2;

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SOLANA_RPC_URL");
  const controllerProgramId = new PublicKey(requireEnv("CONTROLLER_PROGRAM_ID"));
  const vaultProgramId = new PublicKey(requireEnv("VAULT_PROGRAM_ID"));
  const flightPoolProgramId = new PublicKey(requireEnv("FLIGHT_POOL_PROGRAM_ID"));
  const oracleProgramId = new PublicKey(requireEnv("ORACLE_PROGRAM_ID"));
  const controllerConfig = new PublicKey(requireEnv("CONTROLLER_CONFIG_PDA"));
  const activeFlights = new PublicKey(requireEnv("ACTIVE_FLIGHTS_PDA"));
  const authorizedKeeper = teePubkey();

  const flightIds = (envVar("DEMO_FLIGHT_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const staticSiblings = (envVar("STATIC_SIBLINGS_BASE58") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pk) => meta(new PublicKey(pk), false, true));

  console.log(
    `[settler] tee-keeper=${authorizedKeeper.toBase58()} flights=${flightIds.length}`,
  );

  if (flightIds.length === 0) {
    console.log("[settler] nothing to settle; skip");
    return;
  }

  for (let i = 0; i < flightIds.length; i += MAX_FLIGHTS_PER_TX) {
    const chunk = flightIds.slice(i, i + MAX_FLIGHTS_PER_TX);
    const perFlightAccounts = chunk.flatMap((flightId) => [
      meta(findFlightDataPda(flightId, oracleProgramId), false, true),
      meta(findFlightPoolPda(flightId, flightPoolProgramId), false, true),
    ]);

    const siblings: SettlementSiblings = {
      vaultProgram: vaultProgramId,
      flightPoolProgram: flightPoolProgramId,
      oracleProgram: oracleProgramId,
      staticSiblingAccounts: staticSiblings,
      perFlightAccounts,
    };

    const addrs: ControllerCoreAddrs = {
      programId: controllerProgramId,
      controllerConfig,
      activeFlights,
      authorizedKeeper,
    };

    try {
      const ix = executeSettlementsIx(addrs, chunk.length, siblings);
      const { signature } = await buildSignAndSend({
        rpcUrl,
        instructions: [ix],
        computeUnitLimit: 1_400_000,
      });
      console.log(`[settler] chunk(${chunk.length}) -> ${signature}`);
    } catch (err) {
      console.error(`[settler] chunk failed:`, err);
    }
  }
}

main().catch((err) => {
  console.error("[settler] fatal:", err);
  process.exit(1);
});
