/**
 * LiteSVM 1.0 unit-test harness — Kit-native end-to-end.
 *
 * LiteSVM 1.0 dropped its web3.js shape and now exposes Kit primitives
 * (`Address`, `Lamports`, `EncodedAccount`, Kit `Transaction`). The harness
 * reflects that — no `@solana/web3.js` types leak past this file.
 *
 * Phase 0 deliverables:
 *   - PROGRAMS              — 5-element catalogue of program ID + .so filename
 *   - makeClient()          — Kit client with `litesvm()` plugin, all 5 programs loaded
 *   - createMockUsdcMint()  — seeds the canonical mock USDC mint via setAccount
 *                            (deferred to Phase 1+ tests; scaffolded here)
 *   - advanceClock()        — fast-forward the LiteSVM clock sysvar
 */

import {
  address as kitAddress,
  lamports,
  type Address,
} from '@solana/kit';
import { litesvm } from '@solana/kit-plugin-litesvm';
import { airdropSigner, generatedSigner } from '@solana/kit-plugin-signer';
import { createClient } from '@solana/kit';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Repo paths ────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(__dirname, '..', '..');
const TARGET_DEPLOY = resolve(REPO_ROOT, 'contracts', 'target', 'deploy');
const KEYS_DIR = resolve(REPO_ROOT, 'keys');

// ─── Program catalogue ────────────────────────────────────────────────────
//
// Pubkeys must match each program's `declare_id!` AND `Anchor.toml`. They
// are rotated by `scripts/keys-bootstrap.sh` (Phase 0 subtask 39) before
// the first `anchor build`.
//
// `.so` filenames come from each crate's `[lib].name`.
export const PROGRAMS = [
  { name: 'governance',         soFile: 'governance.so',        idStr: 'Ex7rbjNscqZqsqL9b24etRAKrNegDr8Ez7ftMVietUPE', stateSeed: 'governance_state' },
  { name: 'vault',              soFile: 'vault.so',             idStr: '72r2c1RA5xsd9SgCquJLnNom11R7jMaaMTGbcdi26L9U', stateSeed: 'vault_state' },
  { name: 'flight_pool',        soFile: 'flight_pool.so',       idStr: 'GRQgy7DqWRmMSJbxRPrPdZ8NTqamwVtzEtfFgcC2b4kS', stateSeed: 'flight_pool_config' },
  { name: 'oracle_aggregator',  soFile: 'oracle_aggregator.so', idStr: 'GLSr6Ve5a34e5Pw1kS8cWX3EbjdDYkQ9eim2CvvbWgdD', stateSeed: 'oracle_config' },
  { name: 'controller',         soFile: 'controller.so',        idStr: '8mDGYcS1kjbYaJA8aWY8Ju7FnXZ5PYn2hCB9zBmJRGV', stateSeed: 'controller_config' },
] as const;

export type ProgramName = (typeof PROGRAMS)[number]['name'];

// ─── makeClient ───────────────────────────────────────────────────────────
/**
 * Build a Kit client backed by LiteSVM, with all 5 Sentinel programs loaded
 * and the payer airdropped 10 SOL.
 *
 * Each `.so` must exist under `contracts/target/deploy/` — the `pretest`
 * hook in `contracts/package.json` invokes `anchor build` to ensure that.
 */
export async function makeClient() {
  const client = await createClient()
    .use(generatedSigner())
    .use(litesvm())
    .use(airdropSigner(lamports(10_000_000_000n)));

  for (const p of PROGRAMS) {
    const soPath = resolve(TARGET_DEPLOY, p.soFile);
    if (!existsSync(soPath)) {
      throw new Error(
        `Missing program binary: ${soPath}\n` +
          `Run \`pnpm --filter @sentinel/contracts build\` first, or rely on the \`pretest\` hook.`,
      );
    }
    client.svm.addProgramFromFile(kitAddress(p.idStr), soPath);
  }

  return client;
}

// ─── advanceClock ─────────────────────────────────────────────────────────
/**
 * Move the LiteSVM Clock sysvar forward by `secondsForward` seconds.
 * Useful for testing flight-departure lead times, claim expiry windows,
 * and daily snapshots.
 */
export function advanceClock(svm: { getClock(): any; setClock(c: any): void }, secondsForward: number | bigint): void {
  const cur = svm.getClock();
  const delta = BigInt(secondsForward);
  svm.setClock({
    ...cur,
    unixTimestamp: cur.unixTimestamp + delta,
  });
}

// ─── Mock USDC mint (Phase 1+ — scaffolded for now) ──────────────────────
/**
 * Read the mock USDC mint pubkey + authority from `keys/`.
 * The actual seeding into LiteSVM is deferred until Phase 1+ tests need
 * an SPL Token mint. Phase 0 smoke tests do not exercise USDC.
 */
export function readMockUsdcAddresses(): { mint: Address; authority: Address } {
  return {
    mint:      kitAddress(readPubkey(resolve(KEYS_DIR, 'mock-usdc.pubkey'))),
    authority: kitAddress(readPubkey(resolve(KEYS_DIR, 'mock-usdc-authority.pubkey'))),
  };
}

function readPubkey(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `Pubkey missing: ${path}\n` +
        `Run \`bash scripts/keys-bootstrap.sh\` to generate keypair material (Phase 0 subtask 39).`,
    );
  }
  return readFileSync(path, 'utf-8').trim();
}
