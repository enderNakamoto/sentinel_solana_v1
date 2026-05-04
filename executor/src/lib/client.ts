/**
 * Construct a single `@solana/kit` client for the executor.
 *
 * - `signerFromFile(EXECUTOR_KEYPAIR)` sets both `payer` and `identity`
 *   to the executor's keypair (the common case for an off-chain cron
 *   that is also the authorized oracle/keeper).
 * - `solanaRpc({ rpcUrl })` reads the cluster URL from the env.
 *
 * Per the `solana-dev` skill: signer plugin must come BEFORE the RPC
 * plugin in the `.use()` chain.
 */

import 'dotenv/config';
import { createClient } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';

export interface ExecutorClient {
  client: Awaited<ReturnType<typeof buildClient>>;
  rpcUrl: string;
}

async function buildClient() {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const keypairPath = process.env.EXECUTOR_KEYPAIR;
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not set in env');
  if (!keypairPath) throw new Error('EXECUTOR_KEYPAIR is not set in env');

  return createClient()
    .use(signerFromFile(keypairPath))
    .use(solanaRpc({ rpcUrl }));
}

export async function createExecutorClient(): Promise<ExecutorClient> {
  const client = await buildClient();
  return { client, rpcUrl: process.env.SOLANA_RPC_URL! };
}
