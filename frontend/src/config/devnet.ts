/**
 * Devnet deployment constants — single source of truth for the frontend.
 *
 * Mirrors `deployments/devnet-latest.json` (deployed 2026-05-08). When the
 * deploy script regenerates the artifact, copy values here. Do NOT import
 * `deployments/*.json` directly — the deployments folder is gitignored
 * outside the frontend bundle.
 */

import type { Address } from '@solana/kit';

export const DEVNET_CLUSTER = 'devnet' as const;
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

export const DEPLOYER = 'FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy' as Address;
export const OWNER = DEPLOYER; // governance owner == deployer at init time
export const MOCK_USDC_MINT = 'epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K' as Address;

export const ORACLE_AUTHORITY = '3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv' as Address;
export const KEEPER_AUTHORITY = 'EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu' as Address;

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
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

export function explorerLink(addressOrSig: string, kind: 'address' | 'tx' = 'address'): string {
  return `https://explorer.solana.com/${kind}/${addressOrSig}?cluster=devnet`;
}
