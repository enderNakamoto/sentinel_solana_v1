/**
 * Executor entry point — Phase 0 smoke.
 *
 * Phase 0 just constructs the Kit client + queries `getVersion()` to
 * confirm the wiring works. Real cron logic (FlightDataFetcher,
 * FlightClassifier, SettlementExecutor) lands in Phases 8–10.
 */

import { createExecutorClient } from './lib/client.ts';

async function main() {
  const { client, rpcUrl } = await createExecutorClient();
  const { 'solana-core': solanaCore, 'feature-set': featureSet } = await client.rpc.getVersion().send();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    payer: client.payer.address,
    rpcUrl,
    cluster: { solanaCore, featureSet },
  }));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('executor smoke failed:', err);
  process.exit(1);
});
