'use client';

import { useSolanaClient } from '@solana/react-hooks';

/**
 * Thin hook returning the currently configured Solana RPC instance.
 *
 * Prefer this over reaching into `useSolanaClient().runtime.rpc` at every
 * call site — keeps imports tidy and gives us one place to swap the source
 * later if we move to a delegated RPC pool.
 */
export function useRpc() {
  const client = useSolanaClient();
  return client.runtime.rpc;
}
