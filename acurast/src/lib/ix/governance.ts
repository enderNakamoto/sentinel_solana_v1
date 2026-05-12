/**
 * governance_program instruction encoders — the three writes the
 * RouteRepricer cron emits:
 *
 *   - update_route_terms(flight_id, premium: U64Update, payout: U64Update,
 *                        delay_threshold: U32Update)
 *   - disable_route(flight_id)
 *   - whitelist_route(flight_id, premium, payout, delay_threshold)
 *
 * The tri-state {Set, Unset, NoChange} updates collapse to an Anchor enum:
 *   discriminator: 0=Set(T), 1=Unset, 2=NoChange.
 */

import { PublicKey, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import {
  AccountMeta,
  anchorDiscriminator,
  anchorString,
  meta,
  u32le,
  u64le,
  u8,
} from "../anchor";

export interface GovernanceAddrs {
  programId: PublicKey;
  governanceConfig: PublicKey;
  /** PDA: [b"route", flight_id]. */
  routeAccount: PublicKey;
  /** Governance owner (or rotated repricer authority). */
  authority: PublicKey;
  /** System program — Anchor `init`/`init_if_needed` paths need it. */
  systemProgram: PublicKey;
}

type U64Update =
  | { kind: "set"; value: bigint }
  | { kind: "unset" }
  | { kind: "noChange" };
type U32Update =
  | { kind: "set"; value: number }
  | { kind: "unset" }
  | { kind: "noChange" };

function encodeU64Update(u: U64Update): Buffer {
  switch (u.kind) {
    case "set":
      return Buffer.concat([u8(0), u64le(u.value)]);
    case "unset":
      return u8(1);
    case "noChange":
      return u8(2);
  }
}

function encodeU32Update(u: U32Update): Buffer {
  switch (u.kind) {
    case "set":
      return Buffer.concat([u8(0), u32le(u.value)]);
    case "unset":
      return u8(1);
    case "noChange":
      return u8(2);
  }
}

export function updateRouteTermsIx(
  addrs: GovernanceAddrs,
  flightId: string,
  premium: U64Update,
  payout: U64Update,
  delayThreshold: U32Update,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("update_route_terms"),
    anchorString(flightId),
    encodeU64Update(premium),
    encodeU64Update(payout),
    encodeU32Update(delayThreshold),
  ]);
  const keys: AccountMeta[] = [
    meta(addrs.governanceConfig, false, false),
    meta(addrs.routeAccount, false, true),
    meta(addrs.authority, true, false),
  ];
  return new TransactionInstruction({ programId: addrs.programId, keys, data });
}

export function disableRouteIx(
  addrs: GovernanceAddrs,
  flightId: string,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("disable_route"),
    anchorString(flightId),
  ]);
  const keys: AccountMeta[] = [
    meta(addrs.governanceConfig, false, false),
    meta(addrs.routeAccount, false, true),
    meta(addrs.authority, true, false),
  ];
  return new TransactionInstruction({ programId: addrs.programId, keys, data });
}

export function whitelistRouteIx(
  addrs: GovernanceAddrs,
  flightId: string,
  premiumBaseUnits: bigint,
  payoutBaseUnits: bigint,
  delayThresholdMinutes: number,
): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("whitelist_route"),
    anchorString(flightId),
    u64le(premiumBaseUnits),
    u64le(payoutBaseUnits),
    u32le(delayThresholdMinutes),
  ]);
  const keys: AccountMeta[] = [
    meta(addrs.governanceConfig, false, false),
    meta(addrs.routeAccount, false, true),
    meta(addrs.authority, true, true),
    meta(addrs.systemProgram, false, false),
    meta(SYSVAR_RENT_PUBKEY, false, false),
  ];
  return new TransactionInstruction({ programId: addrs.programId, keys, data });
}
