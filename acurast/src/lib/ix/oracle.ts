/**
 * oracle_aggregator_program instruction encoders.
 *
 * Only the three writes the FlightDataFetcher needs:
 *   - set_estimated_arrival(flight_id: String, eta: i64)
 *   - set_landed(flight_id: String, actual_arrival: i64)
 *   - set_cancelled(flight_id: String)
 *
 * Discriminators are derived at runtime from sha256("global:<name>"), so
 * if the ix is renamed upstream the bundle picks up the new tag the next
 * time it's built. Account orders match programs/oracle_aggregator/src/
 * lib.rs in the canonical Sentinel repo (Phase 4).
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AccountMeta,
  anchorDiscriminator,
  anchorString,
  i64le,
  meta,
} from "../anchor";

export interface OracleAddrs {
  programId: PublicKey;
  oracleConfig: PublicKey;
  /** PDA for the per-flight FlightData record — derived from [b"flight_data", flightId]. */
  flightData: PublicKey;
  /** The TEE-attested signer that is OracleConfig.authorized_oracle on chain. */
  authorizedOracle: PublicKey;
}

function buildOracleIx(
  ixName: string,
  flightId: string,
  trailing: Buffer,
  addrs: OracleAddrs,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator(ixName),
    anchorString(flightId),
    trailing,
  ]);
  const keys: AccountMeta[] = [
    meta(addrs.oracleConfig, false, false),
    meta(addrs.flightData, false, true),
    meta(addrs.authorizedOracle, true, false),
  ];
  return new TransactionInstruction({
    programId: addrs.programId,
    keys,
    data,
  });
}

export function setEstimatedArrivalIx(
  addrs: OracleAddrs,
  flightId: string,
  etaUnix: bigint,
): TransactionInstruction {
  return buildOracleIx("set_estimated_arrival", flightId, i64le(etaUnix), addrs);
}

export function setLandedIx(
  addrs: OracleAddrs,
  flightId: string,
  actualArrivalUnix: bigint,
): TransactionInstruction {
  return buildOracleIx("set_landed", flightId, i64le(actualArrivalUnix), addrs);
}

export function setCancelledIx(
  addrs: OracleAddrs,
  flightId: string,
): TransactionInstruction {
  return buildOracleIx("set_cancelled", flightId, Buffer.alloc(0), addrs);
}
