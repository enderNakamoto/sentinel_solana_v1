/**
 * scripts/bootstrap-test-actors.ts
 *
 * Generate keypairs for the 5 multi-actor integration test personae:
 *   investor-a, investor-b, buyer-a, buyer-b, buyer-c
 *
 * Output: keys/test-actors/<name>.json + keys/test-actors/<name>.pubkey
 *
 * Idempotent: skips any keypair file that already exists. `--reset`
 * regenerates everything (existing pubkeys will change — re-run
 * `pnpm fund-sol` / `pnpm fund-pusd` after a reset).
 *
 * Run: `pnpm bootstrap-test-actors [--reset]`
 *
 * Used by:
 *   - `contracts/tests/integration/full-flow-deployed.test.ts` (Phase 7
 *     integration test loads these keypairs to drive the multi-actor
 *     lifecycle against a deployed Surfpool).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ACTORS_DIR = resolve(REPO_ROOT, 'keys', 'test-actors');

export const TEST_ACTORS = [
  'investor-a',
  'investor-b',
  'buyer-a',
  'buyer-b',
  'buyer-c',
] as const;

export type TestActor = (typeof TEST_ACTORS)[number];

export function actorKeypairPath(actor: TestActor): string {
  return resolve(ACTORS_DIR, `${actor}.json`);
}

export function actorPubkeyPath(actor: TestActor): string {
  return resolve(ACTORS_DIR, `${actor}.pubkey`);
}

export function readActorPubkey(actor: TestActor): string {
  const p = actorPubkeyPath(actor);
  if (!existsSync(p)) {
    throw new Error(
      `Test actor pubkey missing: ${p}\n  Run \`pnpm bootstrap-test-actors\` first.`,
    );
  }
  return readFileSync(p, 'utf-8').trim();
}

interface BootstrapOpts {
  reset?: boolean;
}

export function bootstrapTestActors(opts: BootstrapOpts = {}): void {
  const keygenBin = resolveSolanaKeygen();
  if (!keygenBin) {
    throw new Error(
      'solana-keygen not found.\n  Install Solana CLI: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"',
    );
  }

  mkdirSync(ACTORS_DIR, { recursive: true });

  for (const actor of TEST_ACTORS) {
    const kpPath = actorKeypairPath(actor);
    const pkPath = actorPubkeyPath(actor);

    if (opts.reset && existsSync(kpPath)) {
      console.log(`[bootstrap-test-actors] removing stale: ${kpPath}`);
      rmSync(kpPath, { force: true });
      rmSync(pkPath, { force: true });
    }

    if (existsSync(kpPath)) {
      console.log(`[bootstrap-test-actors] ✓ exists: ${kpPath}`);
    } else {
      console.log(`[bootstrap-test-actors] + generating: ${kpPath}`);
      execSync(
        `"${keygenBin}" new --no-bip39-passphrase --silent --outfile "${kpPath}"`,
        { stdio: 'pipe' },
      );
    }

    if (!existsSync(pkPath)) {
      const pk = execSync(`"${keygenBin}" pubkey "${kpPath}"`, {
        encoding: 'utf-8',
      }).trim();
      writeFileSync(pkPath, `${pk}\n`);
      console.log(`[bootstrap-test-actors] + wrote pubkey: ${pkPath}`);
    }
  }

  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log('Test actor pubkeys (committed via .pubkey siblings):');
  console.log('──────────────────────────────────────────────────────────────────');
  for (const actor of TEST_ACTORS) {
    const pk = readFileSync(actorPubkeyPath(actor), 'utf-8').trim();
    console.log(`  ${actor.padEnd(12)} = ${pk}`);
  }
}

/**
 * Locate `solana-keygen`. Tries (in order):
 *   1. PATH lookup via `command -v`
 *   2. The standard Anza install location (`~/.local/share/solana/install/active_release/bin/`)
 *
 * Returns the absolute path or null. The fallback to the install dir means
 * scripts work even if the user's shell rc isn't loaded (e.g. agent
 * environments, fresh CI runners after installing via the Anza script).
 */
export function resolveSolanaKeygen(): string | null {
  try {
    const out = execSync('command -v solana-keygen', { encoding: 'utf-8' }).trim();
    if (out) return out;
  } catch {
    // not on PATH; fall through to standard-install probe
  }
  const standardPath = resolve(
    homedir(),
    '.local/share/solana/install/active_release/bin/solana-keygen',
  );
  if (existsSync(standardPath)) return standardPath;
  return null;
}

// Bundle-safe isMain check (see fund-sol.ts for rationale).
const isMain = /\/bootstrap-test-actors\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  const reset = process.argv.includes('--reset');
  try {
    bootstrapTestActors({ reset });
  } catch (err) {
    console.error('[bootstrap-test-actors] failed:', (err as Error).message ?? err);
    process.exit(1);
  }
}
