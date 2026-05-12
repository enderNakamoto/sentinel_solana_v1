/**
 * PDA derivation helpers — pure web3.js, no Anchor SDK needed.
 *
 * Seeds match contracts/programs/*/src/lib.rs v2 (post-Phase-24).
 */

import { PublicKey } from "@solana/web3.js";

export function findFlightDataPda(
  flightId: string,
  oracleProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("flight_data"), Buffer.from(flightId, "utf8")],
    oracleProgramId,
  );
  return pda;
}

export function findRouteAccountPda(
  flightId: string,
  governanceProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("route"), Buffer.from(flightId, "utf8")],
    governanceProgramId,
  );
  return pda;
}

export function findFlightPoolPda(
  flightId: string,
  flightPoolProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("flight_pool"), Buffer.from(flightId, "utf8")],
    flightPoolProgramId,
  );
  return pda;
}
