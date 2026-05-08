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
  findAdminRecordPda,
  findRoutePda,
  type AdminRecord,
  type GovernanceConfig,
  type RouteAccount,
} from '@/clients/governance/src/generated';
import {
  fetchFlightPoolConfig,
  type FlightPoolConfig,
} from '@/clients/flight_pool/src/generated';
import {
  fetchOracleConfig,
  type OracleConfig,
} from '@/clients/oracle_aggregator/src/generated';
import {
  fetchControllerConfig,
  type ControllerConfig,
} from '@/clients/controller/src/generated';
import {
  fetchVaultState,
  type VaultState,
} from '@/clients/vault/src/generated';
import type { Account, Address, MaybeAccount } from '@solana/kit';
import { PDAS } from '@/config/devnet';
import { MOCK_FLIGHTS } from './mock';

// The runtime RPC supports both single + multi-account fetches; widen the
// parameter type so we can pass the same handle to all of these readers.
type Rpc = Parameters<typeof fetchGovernanceConfig>[0] &
  Parameters<typeof fetchAllMaybeRouteAccount>[0];

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
