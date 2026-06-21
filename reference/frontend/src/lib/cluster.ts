/**
 * Env-driven cluster + RPC plugin selection.
 *
 * Reads `NEXT_PUBLIC_SOLANA_RPC_URL` to decide which `@solana/kit-plugin-rpc`
 * variant to install. Local Surfnet runs at 127.0.0.1:8899; devnet uses
 * Anza's default endpoint; mainnet requires an explicit URL.
 */

import { solanaDevnetRpc, solanaLocalRpc, solanaMainnetRpc, solanaRpc } from '@solana/kit-plugin-rpc';

export type Cluster = 'localnet' | 'devnet' | 'mainnet-beta' | 'custom';

export interface ClusterConfig {
  cluster: Cluster;
  rpcUrl: string;
  websocketUrl: string;
}

const DEFAULT_RPC = 'https://api.devnet.solana.com';
const DEFAULT_WS = 'wss://api.devnet.solana.com';

function detectCluster(rpcUrl: string): Cluster {
  if (rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')) return 'localnet';
  if (rpcUrl.includes('devnet')) return 'devnet';
  if (rpcUrl.includes('mainnet')) return 'mainnet-beta';
  return 'custom';
}

export function getClusterConfig(): ClusterConfig {
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? DEFAULT_RPC;
  const websocketUrl =
    process.env.NEXT_PUBLIC_SOLANA_WS_URL ??
    rpcUrl.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:'));
  return { cluster: detectCluster(rpcUrl), rpcUrl, websocketUrl };
}

/** Pick the matching `@solana/kit-plugin-rpc` plugin for the configured cluster. */
export function getRpcPlugin() {
  const { cluster, rpcUrl, websocketUrl } = getClusterConfig();
  switch (cluster) {
    case 'localnet':
      return solanaLocalRpc();
    case 'devnet':
      return solanaDevnetRpc();
    case 'mainnet-beta':
      return solanaMainnetRpc({ rpcUrl, rpcSubscriptionsUrl: websocketUrl });
    case 'custom':
    default:
      return solanaRpc({ rpcUrl, rpcSubscriptionsUrl: websocketUrl });
  }
}
