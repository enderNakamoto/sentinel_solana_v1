/**
 * ATA helpers — derive the connected wallet's USDC ATA and share-mint ATA
 * given the program / mint constants from `src/config/devnet.ts`.
 */

import { findAssociatedTokenPda } from '@solana-program/token';
import type { Address } from '@solana/kit';
import { MOCK_USDC_MINT, PDAS, TOKEN_PROGRAM } from '@/config/devnet';

export async function userUsdcAta(owner: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({
    owner,
    mint: MOCK_USDC_MINT,
    tokenProgram: TOKEN_PROGRAM,
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
