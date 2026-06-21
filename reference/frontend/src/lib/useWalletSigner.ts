'use client';

import { useWalletSession } from '@solana/react-hooks';
import { createWalletTransactionSigner } from '@solana/client';
import type { TransactionSigner } from '@solana/kit';

/**
 * Returns the SAME wallet signer instance every time, keyed on the
 * underlying `WalletSession` reference. This is critical because
 * `@solana/kit` errors with "Multiple distinct signers were identified for
 * address X" if a transaction references two distinct signer JS objects
 * for the same wallet address (e.g. `createNoopSigner(wallet)` in the page
 * AND the auto-derived authority signer that `prepareAndSend` builds from
 * the session). Centralising the signer here keeps every reference
 * identity-equal across instructions and the fee-payer authority.
 *
 * The cache is keyed on the session object via `WeakMap`; if the user
 * disconnects and reconnects, a fresh session yields a fresh signer.
 */

type AnySession = NonNullable<ReturnType<typeof useWalletSession>>;

const cache = new WeakMap<AnySession, TransactionSigner>();

export function useWalletSigner(): TransactionSigner | undefined {
  const session = useWalletSession();
  if (!session) return undefined;
  const cached = cache.get(session);
  if (cached) return cached;
  const { signer } = createWalletTransactionSigner(session);
  cache.set(session, signer as TransactionSigner);
  return signer as TransactionSigner;
}
