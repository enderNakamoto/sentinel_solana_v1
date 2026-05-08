/**
 * On-chain reads for the operator pages (Phase 13).
 *
 * These are the FIRST functions in the data layer that hit a real RPC —
 * earlier reads (`getOpenMarkets`, `getMyPolicies`, vault stats) stay on
 * mock data until Phases 14–15 swap them.
 *
 * All functions take an explicit `rpc` argument so they can be called from
 * either a hook context (via `useRpc()`) or a server-side caller. Errors
 * propagate; the caller decides how to surface them.
 */

import {
  fetchAllMaybeRouteAccount,
  fetchGovernanceConfig,
  fetchMaybeAdminRecord,
  fetchMaybeRouteAccount,
  findAdminRecordPda,
  findRoutePda,
  type AdminRecord,
  type GovernanceConfig,
  type RouteAccount,
} from '@/clients/governance/src/generated';
import {
  BUYER_RECORD_DISCRIMINATOR,
  fetchAllMaybeBuyerRecord,
  fetchAllMaybeFlightPool,
  fetchFlightPoolConfig,
  fetchMaybeFlightPool,
  findPoolPda,
  findBuyerRecordPda,
  type BuyerRecord,
  type FlightPool,
  type FlightPoolConfig,
} from '@/clients/flight_pool/src/generated';
import {
  fetchMaybeFlightData,
  fetchOracleConfig,
  findFlightDataPda,
  type FlightData,
  type OracleConfig,
} from '@/clients/oracle_aggregator/src/generated';
import {
  fetchControllerConfig,
  type ControllerConfig,
} from '@/clients/controller/src/generated';
import {
  fetchClaimableBalance,
  fetchMaybeClaimableBalance,
  fetchMaybeSnapshotRecord,
  fetchVaultState,
  fetchWithdrawalQueue,
  findClaimablePda,
  findSnapshotRecordPda,
  type ClaimableBalance,
  type SnapshotRecord,
  type VaultState,
  type WithdrawalQueue,
  type WithdrawalRequest,
} from '@/clients/vault/src/generated';
import type {
  Account,
  Address,
  GetTokenAccountBalanceApi,
  GetTokenSupplyApi,
  MaybeAccount,
  Rpc as KitRpc,
} from '@solana/kit';
import { PDAS, PROGRAMS } from '@/config/devnet';
import { MOCK_FLIGHTS } from './mock';
import { getBase58Decoder } from '@solana/kit';

// The runtime RPC supports single + multi-account fetches plus the token
// balance / supply API surface. Intersect all required APIs so the same
// handle works for every reader in this module.
type Rpc = Parameters<typeof fetchGovernanceConfig>[0] &
  Parameters<typeof fetchAllMaybeRouteAccount>[0] &
  KitRpc<
    GetTokenAccountBalanceApi &
      GetTokenSupplyApi &
      import('@solana/kit').GetProgramAccountsApi
  >;

export async function readGovernanceConfig(
  rpc: Rpc,
): Promise<Account<GovernanceConfig>> {
  return fetchGovernanceConfig(rpc, PDAS.governanceConfig);
}

export async function readFlightPoolConfig(
  rpc: Rpc,
): Promise<Account<FlightPoolConfig>> {
  return fetchFlightPoolConfig(rpc, PDAS.flightPoolConfig);
}

export async function readOracleConfig(rpc: Rpc): Promise<Account<OracleConfig>> {
  return fetchOracleConfig(rpc, PDAS.oracleConfig);
}

export async function readControllerConfig(
  rpc: Rpc,
): Promise<Account<ControllerConfig>> {
  return fetchControllerConfig(rpc, PDAS.controllerConfig);
}

export async function readVaultState(rpc: Rpc): Promise<Account<VaultState>> {
  return fetchVaultState(rpc, PDAS.vaultState);
}

export interface RouteSeeds {
  flightId: string;
  origin: string;
  destination: string;
}

/** Default seed list — the 12 mock-catalog routes Phase 13 whitelists on devnet. */
export const SEED_ROUTES: readonly RouteSeeds[] = MOCK_FLIGHTS.map((f) => ({
  flightId: f.id,
  origin: f.from,
  destination: f.to,
}));

export interface RouteRow {
  seeds: RouteSeeds;
  pda: Address;
  account: Account<RouteAccount> | undefined;
}

/**
 * Read every Phase 13 route via known seeds. Cheaper and easier than
 * `getProgramAccounts` — bounded at 12 entries; no encoding/filter quirks.
 */
export async function readKnownRoutes(
  rpc: Rpc,
  seeds: readonly RouteSeeds[] = SEED_ROUTES,
): Promise<RouteRow[]> {
  const pdaTuples = await Promise.all(
    seeds.map((s) => findRoutePda(s).then((p) => p[0])),
  );
  const maybes = await fetchAllMaybeRouteAccount(rpc, pdaTuples);
  return seeds.map((s, i) => {
    const m = maybes[i];
    const pda = pdaTuples[i] as Address;
    return {
      seeds: s,
      pda,
      account: m && m.exists ? (m as Account<RouteAccount>) : undefined,
    };
  });
}

/**
 * Look up a single AdminRecord PDA for a given admin pubkey.
 */
export async function readAdminRecord(
  rpc: Rpc,
  admin: Address,
): Promise<MaybeAccount<AdminRecord>> {
  const [pda] = await findAdminRecordPda({ admin });
  return fetchMaybeAdminRecord(rpc, pda);
}

/**
 * Resolve the role of a connected wallet against the deployed governance
 * program — `'owner'` if it matches `GovernanceConfig.owner`, `'admin'` if
 * an active `AdminRecord` exists, else `'visitor'`.
 */
export type AdminRole = 'owner' | 'admin' | 'visitor';

export async function resolveRole(
  rpc: Rpc,
  walletAddress: Address | undefined,
  config: Account<GovernanceConfig>,
): Promise<AdminRole> {
  if (!walletAddress) return 'visitor';
  if (config.data.owner === walletAddress) return 'owner';
  const record = await readAdminRecord(rpc, walletAddress);
  if (record.exists && record.data.isActive) return 'admin';
  return 'visitor';
}

export async function findRouteAddress(
  flightId: string,
  origin: string,
  destination: string,
): Promise<Address> {
  const [pda] = await findRoutePda({ flightId, origin, destination });
  return pda;
}

// ─────────────────────────────────────────────────────────────────────────
// Vault helpers (Phase 14 — underwriter dashboard)

export async function readWithdrawalQueue(
  rpc: Rpc,
): Promise<Account<WithdrawalQueue>> {
  return fetchWithdrawalQueue(rpc, PDAS.withdrawalQueue);
}

export async function findClaimableBalanceAddress(owner: Address): Promise<Address> {
  const [pda] = await findClaimablePda({ collector: owner });
  return pda;
}

export async function readClaimableBalance(
  rpc: Rpc,
  owner: Address,
): Promise<bigint> {
  const pda = await findClaimableBalanceAddress(owner);
  const maybe = await fetchMaybeClaimableBalance(rpc, pda);
  return maybe.exists ? (maybe.data as ClaimableBalance).amount : 0n;
}

export interface UserQueuedRequest {
  index: number; // queue position (0-based)
  request: WithdrawalRequest;
}

export interface UserVaultPosition {
  rvsBalance: bigint;
  usdcBalance: bigint;
  claimable: bigint;
  queued: UserQueuedRequest[];
}

/**
 * Read everything the /earn page needs about a connected wallet in one
 * concurrent batch. Token-balance fetches use `getTokenAccountBalance`;
 * if the ATA doesn't exist yet we report 0 instead of throwing.
 */
export async function readUserVaultPosition(
  rpc: Rpc,
  wallet: Address,
  userUsdcAta: Address,
  userShareAta: Address,
): Promise<UserVaultPosition> {
  const [usdcBal, rvsBal, claimable, queue] = await Promise.all([
    safeTokenAmount(rpc, userUsdcAta),
    safeTokenAmount(rpc, userShareAta),
    readClaimableBalance(rpc, wallet),
    readWithdrawalQueue(rpc),
  ]);
  const queued: UserQueuedRequest[] = [];
  queue.data.requests.forEach((r, i) => {
    if (r.owner === wallet) queued.push({ index: i, request: r });
  });
  return { rvsBalance: rvsBal, usdcBalance: usdcBal, claimable, queued };
}

async function safeTokenAmount(rpc: Rpc, ata: Address): Promise<bigint> {
  try {
    const r = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

/** RVS share-mint total supply. Required for share-price math. */
export async function readShareSupply(rpc: Rpc): Promise<bigint> {
  try {
    const r = await rpc.getTokenSupply(PDAS.shareMint).send();
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Read the most recent N daily snapshots. Reads the present-day PDA, then
 * walks backward fetching `Maybe`s — gaps appear as `null` so the caller
 * can plot only existing days.
 */
export async function readSnapshotHistory(
  rpc: Rpc,
  days = 30,
): Promise<Array<SnapshotRecord | null>> {
  const today = BigInt(Math.floor(Date.now() / 1000 / 86400));
  const out: Array<SnapshotRecord | null> = [];
  const pdas = await Promise.all(
    Array.from({ length: days }, (_, i) =>
      findSnapshotRecordPda({ day: today - BigInt(days - 1 - i) }).then(
        (p) => p[0],
      ),
    ),
  );
  const maybes = await Promise.all(pdas.map((p) => fetchMaybeSnapshotRecord(rpc, p)));
  for (const m of maybes) {
    out.push(m.exists ? (m.data as SnapshotRecord) : null);
  }
  return out;
}

export { fetchClaimableBalance };
export type { ClaimableBalance, SnapshotRecord, WithdrawalQueue, WithdrawalRequest };

// ─────────────────────────────────────────────────────────────────────────
// Traveler helpers (Phase 15)

export async function readRoute(
  rpc: Rpc,
  flightId: string,
  origin: string,
  destination: string,
): Promise<RouteAccount | undefined> {
  const [pda] = await findRoutePda({ flightId, origin, destination });
  const maybe = await fetchMaybeRouteAccount(rpc, pda);
  return maybe.exists ? maybe.data : undefined;
}

export async function findFlightPoolAddress(
  flightId: string,
  date: bigint,
): Promise<Address> {
  const [pda] = await findPoolPda({ flightId, date });
  return pda;
}

export async function findFlightDataAddress(
  flightId: string,
  date: bigint,
): Promise<Address> {
  const [pda] = await findFlightDataPda({ flightId, date });
  return pda;
}

export interface MyPolicy {
  buyerRecord: BuyerRecord;
  buyerRecordAddress: Address;
  pool: FlightPool;
  poolAddress: Address;
  flightData: FlightData | undefined;
}

/**
 * Read every BuyerRecord owned by `wallet` via getProgramAccounts +
 * memcmp on `buyer @ offset 8` (Anchor discriminator + first field).
 * Joins with the parent FlightPool and the FlightData oracle status so
 * the UI can compute eligibility for claim.
 */
export async function readMyPolicies(
  rpc: Rpc,
  wallet: Address,
): Promise<MyPolicy[]> {
  const { getAddressEncoder } = await import('@solana/kit');
  const walletBytes = getAddressEncoder().encode(wallet);
  const walletB58 = getBase58Decoder().decode(walletBytes);
  const discB58 = getBase58Decoder().decode(
    new Uint8Array(BUYER_RECORD_DISCRIMINATOR),
  );

  // The `bytes` filter field is typed as Base58EncodedBytes (a branded
  // string). The decoder above returns a plain string — cast through to
  // satisfy the RPC type. The RPC layer accepts the base58 string literally.
  type Base58 = import('@solana/kit').Base58EncodedBytes;
  const accounts = await rpc
    .getProgramAccounts(PROGRAMS.flight_pool, {
      encoding: 'base64',
      filters: [
        { memcmp: { offset: 0n, bytes: discB58 as Base58, encoding: 'base58' } },
        { memcmp: { offset: 8n, bytes: walletB58 as Base58, encoding: 'base58' } },
      ],
    })
    .send();

  if (accounts.length === 0) return [];

  // Re-fetch each BuyerRecord by address through the typed helper for clean decoding.
  const buyerAddrs = accounts.map((a) => a.pubkey);
  const records = await fetchAllMaybeBuyerRecord(rpc, buyerAddrs);
  const present = records
    .map((r, i) => (r.exists ? { addr: buyerAddrs[i] as Address, rec: r.data } : null))
    .filter((x): x is { addr: Address; rec: BuyerRecord } => x !== null);

  if (present.length === 0) return [];

  const poolAddrs = present.map((p) => p.rec.pool);
  const pools = await fetchAllMaybeFlightPool(rpc, poolAddrs);

  const out: MyPolicy[] = [];
  for (let i = 0; i < present.length; i++) {
    const p = pools[i];
    if (!p?.exists) continue;
    const pool = p.data as FlightPool;
    const fdAddr = await findFlightDataAddress(pool.flightId, pool.date);
    const fdMaybe = await fetchMaybeFlightData(rpc, fdAddr);
    const presentItem = present[i]!;
    out.push({
      buyerRecord: presentItem.rec,
      buyerRecordAddress: presentItem.addr,
      pool,
      poolAddress: poolAddrs[i] as Address,
      flightData: fdMaybe.exists ? (fdMaybe.data as FlightData) : undefined,
    });
  }
  return out;
}

export type { BuyerRecord, FlightData, FlightPool };
export { fetchMaybeFlightPool, fetchMaybeFlightData, findBuyerRecordPda };
