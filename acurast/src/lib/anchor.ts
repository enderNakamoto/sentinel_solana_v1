/**
 * Anchor instruction encoding primitives.
 *
 * Anchor prefixes every instruction with an 8-byte discriminator computed as
 * sha256("global:<ix_name>").slice(0, 8). For an Acurast bundle we don't ship
 * the Anchor IDL or Codama clients — we just hand-roll the discriminators
 * and account metas. This file is small on purpose: it has to fit in the
 * bundle and stay readable in a TEE-bound proof.
 */

import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

export function anchorDiscriminator(ixName: string): Buffer {
  const tag = `global:${ixName}`;
  const hash = sha256(new TextEncoder().encode(tag));
  return Buffer.from(hash.slice(0, 8));
}

export function accountDiscriminator(accountName: string): Buffer {
  const tag = `account:${accountName}`;
  const hash = sha256(new TextEncoder().encode(tag));
  return Buffer.from(hash.slice(0, 8));
}

export interface AccountMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

export function meta(
  pubkey: PublicKey | string,
  isSigner: boolean,
  isWritable: boolean,
): AccountMeta {
  return {
    pubkey: typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey,
    isSigner,
    isWritable,
  };
}

// ─── Little-endian numeric encoders ──────────────────────────────────────

export function u8(n: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(n, 0);
  return b;
}

export function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

export function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

export function i64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}

/** Anchor string = u32 length prefix + utf8 bytes. */
export function anchorString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32le(bytes.length), bytes]);
}

/** Anchor `Option<T>` = 1-byte tag (0=None / 1=Some) + T encoding when Some. */
export function anchorOption(value: Buffer | null): Buffer {
  if (value === null) return u8(0);
  return Buffer.concat([u8(1), value]);
}
