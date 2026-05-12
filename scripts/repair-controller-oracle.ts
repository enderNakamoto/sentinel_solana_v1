/**
 * scripts/repair-controller-oracle.ts
 *
 * One-shot repair: rewrite v2 ControllerConfig.oracle_config to point at the
 * v2 oracle_config PDA.
 *
 * Why this exists: during the Phase 24 v2 PDA migration, the controller was
 * init'd while the oracle_aggregator Codama client was still resolving the
 * v1 seed. The on-chain v2 ControllerConfig got `oracle_config = <v1 PDA>`
 * baked in, which trips `has_one = oracle_config @ ConfigMismatch` on every
 * buy_insurance / classify_flights / execute_settlements call.
 *
 * The controller program now exposes a one-shot owner-only
 * `repair_oracle_config_pointer(new_oracle_config)` ix. This script wraps
 * the call.
 *
 * Run (default = dry-run, simulate only):
 *   NO_DNA=1 node --experimental-strip-types scripts/repair-controller-oracle.ts
 *
 * To actually send (requires deployer keypair signature):
 *   NO_DNA=1 node --experimental-strip-types scripts/repair-controller-oracle.ts --send
 */

import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  findControllerConfigPda,
  getControllerConfigDecoder,
  getRepairOracleConfigPointerInstruction,
} from './clients/controller/src/generated/index.ts';
import { findConfigPda as findOracleConfigPda } from './clients/oracle_aggregator/src/generated/index.ts';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
// Resolve relative to cwd (repo root when invoked via `bash scripts/run.sh`).
const KEYPAIR_PATH = process.env.DEPLOYER_KEYPAIR
  ? resolve(process.env.DEPLOYER_KEYPAIR)
  : resolve(process.cwd(), 'keys', 'devnet-deployer.json');

async function main() {
  const send = process.argv.includes('--send');

  if (!existsSync(KEYPAIR_PATH)) {
    throw new Error(`Deployer keypair not found at ${KEYPAIR_PATH}`);
  }
  const bytes = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf-8')) as number[];
  const owner = await createKeyPairSignerFromBytes(new Uint8Array(bytes));

  const rpc = createSolanaRpc(RPC_URL);
  const [controllerConfigPda] = await findControllerConfigPda();
  const [oracleConfigPda] = await findOracleConfigPda();

  console.log('[repair] RPC                ', RPC_URL);
  console.log('[repair] owner (signer)     ', owner.address);
  console.log('[repair] controller_config  ', controllerConfigPda);
  console.log('[repair] new oracle_config  ', oracleConfigPda, '(v2)');

  // Read current state.
  const { value } = await rpc
    .getAccountInfo(controllerConfigPda, { encoding: 'base64' })
    .send();
  if (!value) {
    throw new Error(`controller_config not found at ${controllerConfigPda}`);
  }
  const dataB64 = Array.isArray(value.data) ? value.data[0] : (value.data as unknown as string);
  const decoded = getControllerConfigDecoder().decode(Buffer.from(dataB64, 'base64'));
  console.log('[repair] current oracle_config ', decoded.oracleConfig);

  if (decoded.oracleConfig === oracleConfigPda) {
    console.log('[repair] already correct — nothing to do');
    return;
  }
  if (decoded.owner !== owner.address) {
    throw new Error(
      `Loaded keypair ${owner.address} is NOT the controller owner ` +
        `(on-chain owner: ${decoded.owner}). Refusing to send.`,
    );
  }

  // Build + sign tx (kept identical for dry-run + send to surface signing issues early).
  const ix = getRepairOracleConfigPointerInstruction({
    controllerConfig: controllerConfigPda,
    owner,
    newOracleConfig: oracleConfigPda as Address,
  });
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);
  console.log('[repair] tx signature       ', sig);

  if (!send) {
    console.log('\n[repair] dry-run — tx built + signed but NOT broadcast.');
    console.log('[repair] re-run with `--send` to broadcast (preflight simulates server-side).');
    return;
  }

  // Send (preflightCommitment: 'confirmed' runs server-side simulation;
  // any program error surfaces here before the tx is included).
  console.log('[repair] sending tx', sig);
  await rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();

  // Wait for confirmation.
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const { value: statuses } = await rpc
      .getSignatureStatuses([sig as never])
      .send();
    const s = statuses[0];
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      if (s.err) throw new Error(`tx failed: ${JSON.stringify(s.err)}`);
      console.log('[repair] ✓ confirmed', sig);
      console.log(
        `[repair] explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tx ${sig} not confirmed within 30s`);
}

main().catch((err) => {
  console.error('[repair] ERROR:', err.message ?? err);
  process.exit(1);
});
