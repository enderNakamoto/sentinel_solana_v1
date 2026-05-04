'use client';

import { SolanaProvider } from '@solana/react-hooks';
import { autoDiscover, createClient } from '@solana/client';
import { useMemo, type ReactNode } from 'react';
import { getClusterConfig } from '@/lib/cluster';

/**
 * Single Solana client for the entire app.
 *
 * Per CLAUDE.md `Locked stack` — framework-kit only. No `@solana/wallet-adapter-*`.
 * Wallet Standard discovery via `autoDiscover()`.
 */
export function Providers({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const { rpcUrl, websocketUrl } = getClusterConfig();
    return createClient({
      endpoint: rpcUrl,
      websocketEndpoint: websocketUrl,
      walletConnectors: autoDiscover(),
    });
  }, []);

  return <SolanaProvider client={client}>{children}</SolanaProvider>;
}
