'use client';

import { useWalletConnection, useWalletSession } from '@solana/react-hooks';
import { getClusterConfig } from '@/lib/cluster';

/**
 * Phase 0 landing page — just enough to prove the framework-kit wiring works.
 *
 * Shows:
 *   - the active cluster + RPC endpoint (env-driven)
 *   - a Wallet Standard connect button via `useWalletConnection()`
 *   - the connected account address (truncated) via `useWalletSession()`
 *
 * Phase 11 replaces this with the real protocol-stats landing page (TMA,
 * locked, free, share price, etc.) plus a real connector picker.
 */
export default function HomePage() {
  const { cluster, rpcUrl } = getClusterConfig();
  const { connectors, connect, disconnect, connected, connecting } = useWalletConnection();
  const session = useWalletSession();

  // Phase 0 placeholder: connect to the first available connector. Phase 11
  // will replace this with a real picker showing all `connectors`.
  const primaryConnector = connectors[0];
  const address = session?.account.address;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold mb-2">Sentinel Protocol</h1>
      <p className="text-sm opacity-70 mb-10">Decentralised flight delay insurance on Solana.</p>

      <section className="rounded-lg border border-white/10 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider opacity-60">Cluster</span>
          <code className="text-sm">{cluster}</code>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider opacity-60">RPC</span>
          <code className="text-xs opacity-80">{rpcUrl}</code>
        </div>
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs uppercase tracking-wider opacity-60">Wallet</span>
          {connected && address ? (
            <button
              type="button"
              onClick={() => void disconnect()}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15"
            >
              Disconnect ({address.slice(0, 4)}…{address.slice(-4)})
            </button>
          ) : (
            <button
              type="button"
              disabled={!primaryConnector || connecting}
              onClick={() => primaryConnector && void connect(primaryConnector.id)}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connecting ? 'Connecting…' : primaryConnector ? `Connect ${primaryConnector.name}` : 'No wallet detected'}
            </button>
          )}
        </div>
      </section>

      <p className="mt-10 text-xs opacity-50">
        Phase 0 — bootstrap. See <code>spec/progress.md</code> for the build plan.
      </p>
    </main>
  );
}
