/**
 * Build a Solana versioned transaction, sign the message bytes via the
 * Acurast TEE-attested ed25519 signer (_STD_.signers.ed25519.sign), and
 * submit it to the JSON-RPC endpoint.
 *
 * This is the core trick that makes Acurast a credible Solana oracle:
 * Acurast doesn't ship a native Solana signer, but Solana transactions
 * ARE ed25519, so the same TEE primitive that signs Substrate/Ethereum
 * payloads can sign Solana messages bit-for-bit identically — as long
 * as the message bytes are constructed off-runtime and only the raw
 * 32-byte ed25519 signature comes back from the TEE.
 *
 * The signing key never leaves the secure chip. We only ask it for a
 * detached signature over the already-serialized message bytes.
 */

import {
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { STD } from "./std";
import {
  getLatestBlockhash,
  sendRawTransaction,
  simulateTransaction,
} from "./rpc";

/**
 * The Solana address controlled by this Acurast deployment.
 *
 * Acurast exposes the ed25519 public key as a hex string under
 * `_STD_.job.getPublicKeys().ed25519`. Solana addresses are the base58
 * encoding of the raw 32-byte ed25519 pubkey, so we just rebuild a
 * `PublicKey` from the hex bytes.
 *
 * Rotate `OracleConfig.authorized_oracle` to *this* pubkey once the
 * deployment is provisioned — that's the moment the centralized cron
 * gets retired and the Acurast TEE becomes the sole oracle authority.
 */
export function teePubkey(): PublicKey {
  const hex = STD.job.getPublicKeys().ed25519;
  if (!hex) throw new Error("acurast: no ed25519 pubkey from _STD_.job");
  return new PublicKey(Buffer.from(hex, "hex"));
}

export interface BuildAndSendOpts {
  rpcUrl: string;
  instructions: TransactionInstruction[];
  /** Optional CU limit. Defaults to 600k — enough for any single-program ix. */
  computeUnitLimit?: number;
  /** When true, simulate first and skip the network send if simulation errs. */
  simulateFirst?: boolean;
}

export interface SendResult {
  signature: string;
  simulation?: { logs: string[] | null; unitsConsumed?: number };
}

export async function buildSignAndSend(opts: BuildAndSendOpts): Promise<SendResult> {
  const payer = teePubkey();

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: opts.computeUnitLimit ?? 600_000,
  });
  const allIxs = [cuIx, ...opts.instructions];

  const { blockhash } = await getLatestBlockhash(opts.rpcUrl, "confirmed");

  const message = MessageV0.compile({
    payerKey: payer,
    instructions: allIxs,
    recentBlockhash: blockhash,
  });

  const tx = new VersionedTransaction(message);

  // Hand the raw message bytes to the TEE. The TEE never sees the
  // higher-level transaction structure — just opaque bytes to sign.
  const msgBytes = tx.message.serialize();
  const sigHex = STD.signers.ed25519.sign(Buffer.from(msgBytes).toString("hex"));
  const signature = Uint8Array.from(Buffer.from(sigHex, "hex"));
  if (signature.length !== 64) {
    throw new Error(`acurast: ed25519 signer returned ${signature.length} bytes, expected 64`);
  }
  tx.addSignature(payer, signature);

  let simulation: { logs: string[] | null; unitsConsumed?: number } | undefined;
  if (opts.simulateFirst) {
    const sim = await simulateTransaction(opts.rpcUrl, tx);
    simulation = { logs: sim.logs, unitsConsumed: sim.unitsConsumed };
    if (sim.err) {
      throw new Error(
        `simulation failed: ${JSON.stringify(sim.err)}; logs: ${(sim.logs ?? []).join(" | ")}`,
      );
    }
  }

  const sigBase58 = await sendRawTransaction(opts.rpcUrl, tx);
  return { signature: sigBase58, simulation };
}
