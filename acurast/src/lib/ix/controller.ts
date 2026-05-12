/**
 * controller_program instruction encoders.
 *
 * Two keeper-only entry points:
 *   - classify_flights() — for each Landed/Cancelled FlightData, transitions
 *     into ToBeSettled{OnTime, Delayed, Cancelled}. Iterates active flights
 *     via remaining_accounts pairs (FlightData PDA + RouteAccount PDA).
 *   - execute_settlements(n_flights: u8) — for each ToBeSettled* flight,
 *     CPIs into vault + flight_pool + oracle. remaining_accounts layout is
 *     described in contracts/programs/controller/src/lib.rs.
 *
 * For the proof, the encoders accept already-computed remaining_accounts
 * lists. Building those off-chain (the keeper walks ActiveFlightList,
 * derives each PDA, joins state) is identical to what executor/src/core/
 * already does in production.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { AccountMeta, anchorDiscriminator, meta, u8 } from "../anchor";

export interface ControllerCoreAddrs {
  programId: PublicKey;
  controllerConfig: PublicKey;
  activeFlights: PublicKey;
  /** The TEE-attested signer that is ControllerConfig.authorized_keeper. */
  authorizedKeeper: PublicKey;
}

export function classifyFlightsIx(
  addrs: ControllerCoreAddrs,
  remainingAccounts: AccountMeta[],
): TransactionInstruction {
  const data = anchorDiscriminator("classify_flights");
  const keys: AccountMeta[] = [
    meta(addrs.controllerConfig, false, false),
    meta(addrs.activeFlights, false, true),
    meta(addrs.authorizedKeeper, true, false),
    ...remainingAccounts,
  ];
  return new TransactionInstruction({ programId: addrs.programId, keys, data });
}

export interface SettlementSiblings {
  vaultProgram: PublicKey;
  flightPoolProgram: PublicKey;
  oracleProgram: PublicKey;
  /** Static accounts the controller CPIs into (vault_state, flight_pool_config, etc). */
  staticSiblingAccounts: AccountMeta[];
  /** Per-flight slices the controller walks via Vec::remove. */
  perFlightAccounts: AccountMeta[];
}

export function executeSettlementsIx(
  addrs: ControllerCoreAddrs,
  nFlights: number,
  siblings: SettlementSiblings,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("execute_settlements"),
    u8(nFlights),
  ]);
  const keys: AccountMeta[] = [
    meta(addrs.controllerConfig, false, false),
    meta(addrs.activeFlights, false, true),
    meta(addrs.authorizedKeeper, true, false),
    meta(siblings.vaultProgram, false, false),
    meta(siblings.flightPoolProgram, false, false),
    meta(siblings.oracleProgram, false, false),
    ...siblings.staticSiblingAccounts,
    ...siblings.perFlightAccounts,
  ];
  return new TransactionInstruction({ programId: addrs.programId, keys, data });
}
