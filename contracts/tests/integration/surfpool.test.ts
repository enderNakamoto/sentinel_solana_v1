/**
 * Phase 0 Surfpool integration smoke.
 *
 * Assumes a Surfnet is running at http://127.0.0.1:8899
 * (start it via `pnpm dev:surfpool` in a separate terminal).
 *
 * Subtask 47: assert at least one Kit RPC call against the live Surfnet
 * succeeds. The mock USDC mint may or may not be seeded yet — Surfpool.toml
 * carries a placeholder address but the `data_base64` blob is left as a
 * Phase 0 follow-up (see phase plan §Risks). When the seed lands, the
 * test below asserts `decimals === 6`; until then it skips with a notice.
 */

import { describe, it, expect } from 'vitest';
import {
  address as kitAddress,
  createSolanaRpc,
  fetchEncodedAccount,
} from '@solana/kit';
import { fetchMint } from '@solana-program/token';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SURFNET_RPC = process.env.SURFNET_RPC ?? 'http://127.0.0.1:8899';

describe('Phase 0 — Surfpool integration smoke', () => {
  it('Surfnet RPC is reachable + reports a version', async () => {
    const rpc = createSolanaRpc(SURFNET_RPC);
    const version = await rpc.getVersion().send();
    expect(version['solana-core']).toBeTypeOf('string');
    expect(version['solana-core'].length).toBeGreaterThan(0);
  });

  it('mock USDC mint @ keys/mock-usdc.pubkey is seeded with decimals = 6', async () => {
    const mintPubkey = readFileSync(resolve(REPO_ROOT, 'keys', 'mock-usdc.pubkey'), 'utf-8').trim();
    const mintAddress = kitAddress(mintPubkey);
    const rpc = createSolanaRpc(SURFNET_RPC);

    // Probe: does the mint account exist on this Surfnet?
    const acc = await fetchEncodedAccount(rpc, mintAddress);
    if (!acc.exists) {
      console.warn(
        `[integration] mock USDC mint not seeded on Surfnet — Surfpool.toml data_base64 blob is a Phase 0 follow-up. Skipping decimals assertion.`,
      );
      return;
    }

    // Mint exists — decode and assert decimals.
    const mint = await fetchMint(rpc, mintAddress);
    expect(mint.data.decimals).toBe(6);
  });
});
