/**
 * executor/core/solana_client.ts
 *
 * Kit-based Solana client + helpers shared by all three crons:
 *   - reading the controller's `ActiveFlightList` PDA
 *   - reading a `FlightData` account's status
 *   - building/signing/sending an instruction batch
 *   - loading the Phase 7 deployment artifact
 *
 * Kept separate from the per-cron decision logic so the latter can be
 * unit-tested without an RPC.
 */

import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type DeploymentArtifact,
  FlightStatus,
} from './types.ts';

// ─── 1. Deployment artifact loader ───────────────────────────────────────

/**
 * Load `deployments/<cluster>-latest.json` produced by `scripts/deploy.ts`.
 * Throws if missing or malformed — the caller fixes their env or runs
 * the deploy script first.
 */
export function loadDeployment(repoRoot: string, cluster: string): DeploymentArtifact {
  const path = resolve(repoRoot, 'deployments', `${cluster}-latest.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Deployment artifact not found: ${path}\n  ` +
        `Run \`pnpm run deploy --cluster ${cluster} --owner <pubkey>\` first.`,
    );
  }
  const raw = readFileSync(path, 'utf-8');
  const artifact = JSON.parse(raw) as DeploymentArtifact;
  // Light shape validation — catches stale artifacts from older script runs.
  for (const key of ['cluster', 'rpcUrl', 'owner', 'stableMint', 'programs', 'pdas'] as const) {
    if (!(key in artifact)) {
      throw new Error(`Deployment artifact missing field "${key}": ${path}`);
    }
  }
  return artifact;
}

/**
 * Load a Solana keypair from a 64-byte JSON array file (the standard
 * `solana-keygen` format).
 */
export async function loadKeypairSigner(path: string): Promise<KeyPairSigner> {
  if (!existsSync(path)) {
    throw new Error(`Keypair file not found: ${path}`);
  }
  const bytes = JSON.parse(readFileSync(path, 'utf-8')) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`Invalid keypair file (must be 64-byte JSON array): ${path}`);
  }
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

// ─── 2. Active flight list reader ────────────────────────────────────────

export interface ActiveFlightEntry {
  flightId: string;
  date: bigint;
}

// ─── 3. Solana client interface (cron-agnostic) ──────────────────────────
//
// The runner constructs a concrete `SolanaClient` and the per-cron
// decision functions (in `flight_data_fetcher.ts`, etc.) consume it via
// this narrow interface. Mocked easily for unit tests.

export interface SolanaClient {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly rpcUrl: string;
  readonly signer: KeyPairSigner;
  readonly deployment: DeploymentArtifact;

  /** Read + decode the controller's `ActiveFlightList` PDA. */
  readActiveFlightList(): Promise<ActiveFlightEntry[]>;

  /** Read a FlightData PDA's `status` enum; null if account doesn't exist. */
  readFlightDataStatus(flightId: string, date: bigint): Promise<FlightStatus | null>;

  /** Read a FlightData PDA's full state; null if missing. */
  readFlightDataState(
    flightId: string,
    date: bigint,
  ): Promise<{ status: FlightStatus; estimatedArrivalTime: bigint; actualArrivalTime: bigint } | null>;

  /**
   * Read the vault's `WithdrawalQueue` PDA and return the
   * `claimable: Pubkey` field of each `WithdrawalRequest` in queue
   * order. Used by the Phase 10 settler to populate the trailing
   * remaining_accounts of `controller.execute_settlements`.
   */
  readWithdrawalQueueClaimables(): Promise<Address[]>;

  /** Send + confirm a single tx containing `ixs`. Signed by `signer`. */
  sendIxs(ixs: Instruction[]): Promise<string>;
}

export interface CreateSolanaClientOpts {
  /** Path to the keypair file used as both fee payer and ix signer. */
  keypairPath: string;
  /** Repo root — used to resolve the deployment artifact. */
  repoRoot: string;
  /** Cluster name — picks the deployment artifact + RPC URL. */
  cluster: string;
  /** Optional RPC URL override (defaults to `deployment.rpcUrl`). */
  rpcUrl?: string;
}

export async function createSolanaClient(opts: CreateSolanaClientOpts): Promise<SolanaClient> {
  const deployment = loadDeployment(opts.repoRoot, opts.cluster);
  const rpcUrl = opts.rpcUrl ?? deployment.rpcUrl;
  const rpc = createSolanaRpc(rpcUrl);
  const signer = await loadKeypairSigner(opts.keypairPath);

  return {
    rpc,
    rpcUrl,
    signer,
    deployment,

    async readActiveFlightList() {
      const pda = deployment.pdas.activeFlightList as Address;
      const { value } = await rpc
        .getAccountInfo(pda, { encoding: 'base64' })
        .send();
      if (!value) return [];
      const dataB64 = Array.isArray(value.data) ? value.data[0] : (value.data as unknown as string);
      const buf = Buffer.from(dataB64, 'base64');
      // Anchor account layout: 8 disc | Vec<FlightEntry> { 4 len | n × (4 str_len + flight_id + 8 date) } | 1 bump
      // We hand-decode rather than pull in the Codama client here — keeps
      // this module Codama-import-free for cleaner test boundaries.
      return decodeActiveFlightList(buf);
    },

    async readFlightDataStatus(flightId, date) {
      const state = await readFlightDataStateImpl(rpc, deployment, flightId, date);
      return state?.status ?? null;
    },

    async readFlightDataState(flightId, date) {
      return readFlightDataStateImpl(rpc, deployment, flightId, date);
    },

    async readWithdrawalQueueClaimables() {
      const pda = deployment.pdas.withdrawalQueue as Address;
      const { value } = await rpc
        .getAccountInfo(pda, { encoding: 'base64' })
        .send();
      if (!value) return [];
      const dataB64 = Array.isArray(value.data) ? value.data[0] : (value.data as unknown as string);
      const buf = Buffer.from(dataB64, 'base64');
      return decodeWithdrawalQueueClaimables(buf);
    },

    async sendIxs(ixs) {
      const { value: blockhash } = await rpc.getLatestBlockhash().send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      );
      const signed = await signTransactionMessageWithSigners(message);
      const wireTx = getBase64EncodedWireTransaction(signed);
      const sig = getSignatureFromTransaction(signed);
      await rpc
        .sendTransaction(wireTx, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send();
      // Confirm — poll up to 30s.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const { value } = await rpc.getSignatureStatuses([sig]).send();
        const s = value[0];
        if (
          s?.confirmationStatus === 'confirmed' ||
          s?.confirmationStatus === 'finalized'
        ) {
          if (s.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
          return sig;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`tx ${sig} not confirmed within 30s`);
    },
  };
}

async function readFlightDataStateImpl(
  rpc: Rpc<SolanaRpcApi>,
  deployment: DeploymentArtifact,
  flightId: string,
  date: bigint,
): Promise<{ status: FlightStatus; estimatedArrivalTime: bigint; actualArrivalTime: bigint } | null> {
  const pda = await deriveFlightDataPda(
    deployment.programs.oracle_aggregator as Address,
    flightId,
    date,
  );
  const { value } = await rpc.getAccountInfo(pda, { encoding: 'base64' }).send();
  if (!value) return null;
  const dataB64 = Array.isArray(value.data) ? value.data[0] : (value.data as unknown as string);
  const buf = Buffer.from(dataB64, 'base64');
  return decodeFlightData(buf);
}

// ─── 4. Account decoders (hand-rolled, Codama-free) ──────────────────────
//
// We avoid importing from `executor/src/clients/...` here so this module
// can be loaded in tests without dragging in the Codama-generated chain
// (which has the directory-import quirk). Anchor account layout:
//   [8 byte discriminator] [borsh-encoded struct]

function decodeActiveFlightList(buf: Buffer): ActiveFlightEntry[] {
  // Skip 8-byte discriminator.
  let off = 8;
  // Vec<FlightEntry> length (u32 little-endian).
  const len = buf.readUInt32LE(off);
  off += 4;
  const entries: ActiveFlightEntry[] = [];
  for (let i = 0; i < len; i++) {
    // FlightEntry: { flight_id: String (4 + N bytes), date: u64 LE }
    const sLen = buf.readUInt32LE(off);
    off += 4;
    const flightId = buf.slice(off, off + sLen).toString('utf-8');
    off += sLen;
    const date = buf.readBigUInt64LE(off);
    off += 8;
    entries.push({ flightId, date });
  }
  return entries;
}

/**
 * Decode the vault's `WithdrawalQueue` account and extract the
 * `claimable: Pubkey` field from each `WithdrawalRequest` in queue order.
 *
 * Anchor account layout:
 *   8 disc | u32 vec_len | n × WithdrawalRequest | u8 bump
 *
 * WithdrawalRequest layout (88 bytes):
 *   32 owner | 8 shares | 8 pending_assets | 8 timestamp | 32 claimable
 */
function decodeWithdrawalQueueClaimables(buf: Buffer): Address[] {
  let off = 8; // discriminator
  const len = buf.readUInt32LE(off);
  off += 4;
  const claimables: Address[] = [];
  for (let i = 0; i < len; i++) {
    const reqOff = off + 32 + 8 + 8 + 8; // skip owner + shares + pending_assets + timestamp
    const pkBytes = buf.slice(reqOff, reqOff + 32);
    claimables.push(base58FromBytes(pkBytes) as Address);
    off += 88; // total WithdrawalRequest size
  }
  return claimables;
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58FromBytes(bytes: Buffer): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    out = BASE58_ALPHABET[r] + out;
  }
  return '1'.repeat(leading) + out;
}

function decodeFlightData(buf: Buffer): {
  status: FlightStatus;
  estimatedArrivalTime: bigint;
  actualArrivalTime: bigint;
} {
  // Skip 8-byte discriminator.
  let off = 8;
  // FlightData: { flight_id: String, date: u64, status: FlightStatus (u8 disc), eta: i64, actual: i64, bump: u8 }
  const sLen = buf.readUInt32LE(off);
  off += 4 + sLen; // skip flight_id
  off += 8; // skip date
  const status = buf.readUInt8(off) as FlightStatus;
  off += 1;
  const estimatedArrivalTime = buf.readBigInt64LE(off);
  off += 8;
  const actualArrivalTime = buf.readBigInt64LE(off);
  off += 8;
  return { status, estimatedArrivalTime, actualArrivalTime };
}

// ─── 5. PDA derivation (Codama-free) ─────────────────────────────────────

async function deriveFlightDataPda(
  oracleProgram: Address,
  flightId: string,
  date: bigint,
): Promise<Address> {
  // seeds = [b"flight", flight_id_bytes, &date.to_le_bytes()]
  const { PublicKey } = await import('@solana/web3.js');
  const dateBytes = Buffer.alloc(8);
  dateBytes.writeBigUInt64LE(date);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('flight'), Buffer.from(flightId, 'utf-8'), dateBytes],
    new PublicKey(oracleProgram.toString()),
  );
  // Cast back through Kit's branded Address type.
  return pda.toBase58() as unknown as Address;
}

export { decodeActiveFlightList, decodeFlightData, deriveFlightDataPda };
