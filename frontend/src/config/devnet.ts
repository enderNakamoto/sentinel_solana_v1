/**
 * Cluster-aware deployment constants — single source of truth for the
 * frontend.
 *
 * The same protocol is deployed at the SAME program IDs and PDAs on devnet
 * and on Surfpool (locked: never rotate program/mint keypairs — see
 * keys-safety rule in MEMORY.md). Only four things differ per cluster:
 *
 *   1. RPC URL                — derived from NEXT_PUBLIC_SOLANA_RPC_URL via
 *                                `lib/cluster.ts` and consumed by `Providers`.
 *   2. ORACLE_AUTHORITY       — different keypair on devnet vs surfpool.
 *   3. KEEPER_AUTHORITY       — different keypair on devnet vs surfpool.
 *   4. explorerLink behaviour — devnet hits Solana Explorer with
 *                                ?cluster=devnet; localnet has no public
 *                                explorer so the link is suppressed.
 *
 * Everything else (program IDs, PDAs, mock PUSD mint, mock-pusd-authority,
 * token program) is identical across clusters. Rotating any of those
 * values would require re-bootstrapping every deployment in lockstep, so
 * we keep them stable.
 *
 * Filename is `devnet.ts` for legacy import-stability reasons; the module
 * is fully cluster-aware now.
 */

import type { Address } from '@solana/kit';
import { getClusterConfig, type Cluster } from '@/lib/cluster';

const { cluster, rpcUrl } = getClusterConfig();

export const CLUSTER: Cluster = cluster;
export const RPC_URL: string = rpcUrl;

// ─── Cluster-invariant constants ──────────────────────────────────────────

export const DEPLOYER = 'FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy' as Address;
export const OWNER = DEPLOYER; // governance owner == deployer at init time

// Mock PUSD mint for tests / devnet (Token-2022, 6 decimals). The keypair
// at keys/mock-pusd.json mints to this address. Pubkeys match
// keys/mock-pusd{,-authority}.pubkey on disk.
export const MOCK_PUSD_MINT = 'F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE' as Address;
export const MOCK_PUSD_AUTHORITY = '5JbXjGvf2UDtBqbAdQwXr8zDUToDjbnDgaXNFLY1wstD' as Address;

/**
 * Live Palm USD (PUSD) mainnet mint. Token-2022 with MetadataPointer +
 * TokenMetadata extensions only (no transfer fee, no transfer hook,
 * no freeze authority). 6 decimals. For surfpool fork tests / mainnet
 * deployments — devnet does NOT use this mint (it uses MOCK_PUSD_MINT).
 */
export const PUSD_MAINNET_MINT = 'CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s' as Address;

export const PROGRAMS = {
  governance: '6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT' as Address,
  vault: '3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p' as Address,
  oracle_aggregator: 'EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6' as Address,
  flight_pool: 'GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq' as Address,
  controller: 'G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot' as Address,
} as const;

export const PDAS = {
  governanceConfig: 'AsVZzrc2ong7kU1bkfE4FM4q8mE5kVdRTa3pDW5yr74x' as Address,
  vaultState: 'FpUBQSCehFHhSLjLhspNwFeknqTKeLG8FhjZqunaEkxw' as Address,
  shareMint: 'JS95NxFcdefTANTiLNL8mjmAHrirR8qQJJGUpYkvZPr' as Address,
  withdrawalQueue: 'AdrAPEPqELwJUAcqmZkx2tigBkEKdSXdZwTRRFSaKVER' as Address,
  oracleConfig: 'jkTcNGgvbPVXRsUF6QSdk28jN7g9f7AYhYUP7DniBPg' as Address,
  flightPoolConfig: '89YRV2EdUtCi321YgLfuMCzzHWKJyEtoNo3c8gLsvXkq' as Address,
  poolTreasuryAuthority: '491ShdDXTEGFpYhzhLmdAPyEMXSuQms2iygBqepuRZxa' as Address,
  controllerConfig: 'mCKrLhjbapVxbD4AGK99jPg1s3neXfpezQLMZFfNPTR' as Address,
  activeFlightList: '8c64now3ENjNohx7NNyoJbtd2p6T1w1qaUner6boh6X1' as Address,
} as const;

export const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;

/**
 * Classic SPL Token program. Used by the RVS vault share mint (we own it
 * for share-accounting; no Token-2022 extensions provide value there).
 */
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

/**
 * Token-2022 program. The stable mint (PUSD on mainnet, mock-PUSD on
 * devnet) is a Token-2022 mint, so every stable-side ATA derivation and
 * transfer_checked CPI routes through this program.
 */
export const STABLE_TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;

// ─── Cluster-specific constants ───────────────────────────────────────────

interface ClusterAuthorities {
  oracle: Address;
  keeper: Address;
}

const AUTHORITIES_BY_CLUSTER: Record<Cluster, ClusterAuthorities> = {
  devnet: {
    oracle: '3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv' as Address,
    keeper: 'EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu' as Address,
  },
  localnet: {
    oracle: 'HqE3w6HzeGfegHkiCQGEv5ivWpyXFKkGCrqcr96HULaq' as Address,
    keeper: '89iazjLWxwSpArhK6MbbBTS3BY8UFF9zygqarp4U3QA6' as Address,
  },
  // Mainnet / custom clusters reuse the devnet authorities by default —
  // override at deploy time once the protocol launches on mainnet.
  'mainnet-beta': {
    oracle: '3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv' as Address,
    keeper: 'EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu' as Address,
  },
  custom: {
    oracle: '3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv' as Address,
    keeper: 'EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu' as Address,
  },
};

const authorities = AUTHORITIES_BY_CLUSTER[cluster];

export const ORACLE_AUTHORITY: Address = authorities.oracle;
export const KEEPER_AUTHORITY: Address = authorities.keeper;

// ─── Explorer link ────────────────────────────────────────────────────────

/**
 * Returns a Solana Explorer URL for an address or signature, scoped to the
 * current cluster. On localnet (Surfpool) there is no public explorer, so
 * we return an empty string — UI surfaces should treat that as "no link"
 * and either hide the link or fall back to plain text.
 */
export function explorerLink(
  addressOrSig: string,
  kind: 'address' | 'tx' = 'address',
): string {
  if (cluster === 'localnet') return '';
  const param =
    cluster === 'devnet' ? '?cluster=devnet' : cluster === 'mainnet-beta' ? '' : '?cluster=custom';
  return `https://explorer.solana.com/${kind}/${addressOrSig}${param}`;
}

// ─── Back-compat aliases ──────────────────────────────────────────────────

/** @deprecated Use CLUSTER. Kept for callers that imported the old name. */
export const DEVNET_CLUSTER = cluster;
/** @deprecated Use RPC_URL. Kept for callers that imported the old name. */
export const DEVNET_RPC_URL = rpcUrl;
