/**
 * ATA helpers — derive the connected wallet's PUSD ATA and RVS share-mint
 * ATA given the program / mint constants from `src/config/devnet.ts`.
 *
 * PUSD is a Token-2022 mint (mainnet `CZzg...`, devnet/test `F5Kj...`) so
 * the stable-side ATA derivation routes through `STABLE_TOKEN_PROGRAM`
 * (Token-2022). The RVS share mint stays classic SPL (we own it; no
 * Token-2022 extensions add value), so its ATA routes through
 * `TOKEN_PROGRAM` (classic).
 */

import { findAssociatedTokenPda } from '@solana-program/token';
import type { Address } from '@solana/kit';
import {
  MOCK_PUSD_MINT,
  PDAS,
  STABLE_TOKEN_PROGRAM,
  TOKEN_PROGRAM,
} from '@/config/devnet';

export async function userStableAta(owner: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({
    owner,
    mint: MOCK_PUSD_MINT,
    tokenProgram: STABLE_TOKEN_PROGRAM,
  });
  return pda;
}

export async function userShareAta(owner: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({
    owner,
    mint: PDAS.shareMint,
    tokenProgram: TOKEN_PROGRAM,
  });
  return pda;
}
