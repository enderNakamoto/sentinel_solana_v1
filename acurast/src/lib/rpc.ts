/**
 * Solana JSON-RPC helpers — kept thin so the bundle stays small.
 *
 * Acurast processors run a modern Node, so we just use the global `fetch`
 * (same pattern the official `app-fetch` example uses). No connection
 * pooling, no retries — the cron is short-lived and re-fires on the next
 * Acurast interval if anything errors out.
 */

import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export type Commitment = "processed" | "confirmed" | "finalized";

export interface RpcEnvelope<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`rpc ${method} http ${res.status}: ${await res.text()}`);
  }
  const envelope = (await res.json()) as RpcEnvelope<T>;
  if (envelope.error) {
    throw new Error(`rpc ${method} err ${envelope.error.code}: ${envelope.error.message}`);
  }
  if (envelope.result === undefined) {
    throw new Error(`rpc ${method} returned no result`);
  }
  return envelope.result;
}

export async function getLatestBlockhash(
  url: string,
  commitment: Commitment = "confirmed",
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const result = await rpc<{
    context: unknown;
    value: { blockhash: string; lastValidBlockHeight: number };
  }>(url, "getLatestBlockhash", [{ commitment }]);
  return result.value;
}

export interface AccountInfo {
  data: [string, "base64"];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
}

export async function getAccountInfo(
  url: string,
  pubkey: PublicKey | string,
  commitment: Commitment = "confirmed",
): Promise<AccountInfo | null> {
  const addr = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  const result = await rpc<{
    context: unknown;
    value: AccountInfo | null;
  }>(url, "getAccountInfo", [addr, { encoding: "base64", commitment }]);
  return result.value;
}

export async function getAccountData(
  url: string,
  pubkey: PublicKey | string,
): Promise<Buffer | null> {
  const info = await getAccountInfo(url, pubkey);
  if (!info) return null;
  return Buffer.from(info.data[0], "base64");
}

export interface ProgramAccount {
  pubkey: string;
  account: AccountInfo;
}

export async function getProgramAccounts(
  url: string,
  programId: PublicKey | string,
  opts: {
    filters?: Array<
      | { dataSize: number }
      | { memcmp: { offset: number; bytes: string; encoding?: "base58" | "base64" } }
    >;
    commitment?: Commitment;
  } = {},
): Promise<ProgramAccount[]> {
  const addr = typeof programId === "string" ? programId : programId.toBase58();
  return rpc<ProgramAccount[]>(url, "getProgramAccounts", [
    addr,
    {
      encoding: "base64",
      commitment: opts.commitment ?? "confirmed",
      filters: opts.filters,
    },
  ]);
}

export async function sendRawTransaction(
  url: string,
  tx: VersionedTransaction,
  opts: { skipPreflight?: boolean } = {},
): Promise<string> {
  const wire = Buffer.from(tx.serialize()).toString("base64");
  return rpc<string>(url, "sendTransaction", [
    wire,
    {
      encoding: "base64",
      skipPreflight: opts.skipPreflight ?? false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
    },
  ]);
}

export async function simulateTransaction(
  url: string,
  tx: VersionedTransaction,
): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }> {
  const wire = Buffer.from(tx.serialize()).toString("base64");
  const result = await rpc<{
    context: unknown;
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
  }>(url, "simulateTransaction", [wire, { encoding: "base64", sigVerify: false }]);
  return result.value;
}
