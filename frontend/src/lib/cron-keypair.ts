/**
 * frontend/src/lib/cron-keypair.ts
 *
 * Server-side keeper-keypair path resolver for the cron trigger
 * routes. Returns a filesystem path that the executor's
 * `createSolanaClient` factory can load.
 *
 * SERVER-SIDE ONLY. The keypair must never reach a client bundle.
 *
 * Priority:
 *   1. CRON_KEEPER_BASE58   — base58-encoded 64-byte secret key. We
 *      write it to a temp file on first use so `createSolanaClient`
 *      (which only accepts paths) can load it.
 *   2. CRON_KEEPER_PATH     — explicit on-disk path, resolved against
 *      the repo root.
 *   3. `keys/<cluster>-deployer.json` — cluster-aware default
 *      (`surfpool-deployer.json` if RPC points at 127.0.0.1, else
 *      `devnet-deployer.json`). The deployer is the controller owner
 *      and (after `pnpm rotate-keeper`) the authorized_keeper, so it
 *      pays for both classifier and settler crons by default.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { getBase58Encoder } from '@solana/kit';

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(cur, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'sentinel-solana') return cur;
      } catch {
        /* keep walking */
      }
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

export function repoRoot(): string {
  return findRepoRoot(process.cwd());
}

/**
 * Resolve the active cluster from the standard
 * `NEXT_PUBLIC_SOLANA_RPC_URL` env var. Surfpool/localnet runs on
 * 127.0.0.1; everything else assumes devnet.
 */
export function activeCluster(): 'surfpool' | 'devnet' {
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? '';
  return rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')
    ? 'surfpool'
    : 'devnet';
}

function defaultKeeperKeypairFile(): string {
  return activeCluster() === 'surfpool'
    ? 'keys/surfpool-deployer.json'
    : 'keys/devnet-deployer.json';
}

let cachedTempPath: string | null = null;

/**
 * Returns a filesystem path to the keeper keypair JSON. Throws if
 * neither the env vars nor the cluster-default file is present.
 */
export function resolveKeeperKeypairPath(): string {
  const base58 = process.env.CRON_KEEPER_BASE58;
  if (base58) {
    if (cachedTempPath && existsSync(cachedTempPath)) return cachedTempPath;
    const bytes = getBase58Encoder().encode(base58.trim());
    if (bytes.length !== 64) {
      throw new Error(
        `CRON_KEEPER_BASE58 must decode to 64 bytes (got ${bytes.length}).`,
      );
    }
    const dir = resolve(tmpdir(), 'sentinel-cron');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `keeper-${process.pid}.json`);
    writeFileSync(path, JSON.stringify(Array.from(bytes)));
    cachedTempPath = path;
    return path;
  }

  const root = repoRoot();
  const candidates = [
    process.env.CRON_KEEPER_PATH ? resolve(root, process.env.CRON_KEEPER_PATH) : null,
    resolve(root, defaultKeeperKeypairFile()),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    `Keeper keypair not found. Set CRON_KEEPER_BASE58 or CRON_KEEPER_PATH, ` +
      `or ensure ${defaultKeeperKeypairFile()} exists in the repo root.`,
  );
}

void dirname;
