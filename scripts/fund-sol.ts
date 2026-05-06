/**
 * scripts/fund-sol.ts
 *
 * Fund a recipient pubkey with SOL on **Surfpool only**, via the standard
 * `requestAirdrop` JSON-RPC method. Surfpool's local validator answers
 * `requestAirdrop` without rate-limiting (unlike public devnet/testnet),
 * so this gives us effectively unlimited SOL for test-actor seeding.
 *
 * For devnet / testnet / mainnet the user pre-funds the deployer keypair
 * (per the phase plan locked decision); this script refuses on those
 * clusters with a clear remediation message.
 *
 * Run:
 *   pnpm fund-sol --cluster surfpool --recipient <pubkey> --amount <sol>
 *
 * Programmatic API:
 *   import { fundSol } from './scripts/fund-sol.ts';
 *   await fundSol({ cluster: 'surfpool', recipient: '<pubkey>', amountSol: 10 });
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SURFPOOL_RPC = 'http://127.0.0.1:8899';
const LAMPORTS_PER_SOL = 1_000_000_000n;

const SUPPORTED_CLUSTERS = new Set(['surfpool']);

export interface FundSolOpts {
  cluster: string;
  recipient: string;
  amountSol: number;
  /** Override RPC URL — useful when surfpool is bound to a non-default port. */
  rpcUrl?: string;
}

export interface FundSolResult {
  signature: string;
  lamports: bigint;
}

export async function fundSol(opts: FundSolOpts): Promise<FundSolResult> {
  if (!SUPPORTED_CLUSTERS.has(opts.cluster)) {
    throw new Error(
      `fund-sol.ts only works against surfpool. ` +
        `For devnet/testnet/mainnet, fund ${opts.recipient} manually.`,
    );
  }
  validatePubkey(opts.recipient);
  if (!Number.isFinite(opts.amountSol) || opts.amountSol <= 0) {
    throw new Error(`--amount must be a positive number of SOL (got ${opts.amountSol})`);
  }

  const lamports = solToLamports(opts.amountSol);
  const rpcUrl = opts.rpcUrl ?? SURFPOOL_RPC;

  // Standard Solana JSON-RPC method. Surfpool answers without rate-limiting.
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'requestAirdrop',
    params: [opts.recipient, Number(lamports)],
  };

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `requestAirdrop HTTP ${res.status}: ${await res.text().catch(() => '<no body>')}`,
    );
  }
  const json = (await res.json()) as {
    result?: string;
    error?: { code: number; message: string };
  };
  if (json.error) {
    throw new Error(
      `requestAirdrop error (${json.error.code}): ${json.error.message}. ` +
        `Is surfpool running on ${rpcUrl}? Start it with \`pnpm dev:surfpool\`.`,
    );
  }
  if (!json.result) {
    throw new Error(`requestAirdrop returned no signature for ${opts.recipient}`);
  }

  return { signature: json.result, lamports };
}

/**
 * Convert a SOL float to lamports (1 SOL = 1_000_000_000 lamports). Uses
 * a string-rounded path to avoid float drift on amounts like 0.1 SOL.
 */
function solToLamports(sol: number): bigint {
  // Limit to 9 decimal places (lamport precision).
  const fixed = sol.toFixed(9);
  const [whole, frac = ''] = fixed.split('.');
  const fracPadded = (frac + '000000000').slice(0, 9);
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fracPadded);
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function validatePubkey(s: string): void {
  if (!BASE58_RE.test(s)) {
    throw new Error(
      `--recipient must be a base58 Solana pubkey (32-44 chars). Got: ${s}`,
    );
  }
}

interface CliArgs {
  cluster: string;
  recipient: string;
  amount: string;
  rpcUrl?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--cluster':
        args.cluster = next;
        i++;
        break;
      case '--recipient':
        args.recipient = next;
        i++;
        break;
      case '--amount':
        args.amount = next;
        i++;
        break;
      case '--rpc-url':
        args.rpcUrl = next;
        i++;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        if (a.startsWith('--')) {
          throw new Error(`Unknown flag: ${a}`);
        }
    }
  }
  if (!args.cluster) throw new Error('--cluster <surfpool> is required');
  if (!args.recipient) throw new Error('--recipient <pubkey> is required');
  if (!args.amount) throw new Error('--amount <sol> is required');
  return args as CliArgs;
}

function printUsage(): void {
  console.log(`Usage: pnpm fund-sol --cluster surfpool --recipient <pubkey> --amount <sol>

Funds <pubkey> with <sol> SOL on a running Surfpool localnet.

Options:
  --cluster   Target cluster — must be 'surfpool'. Other clusters are refused.
  --recipient Base58 Solana pubkey to fund.
  --amount    Amount in SOL (decimal allowed, e.g. 1.5).
  --rpc-url   Override RPC endpoint (default ${SURFPOOL_RPC}).
  --help      Print this help.

Note: requires \`pnpm dev:surfpool\` running in another terminal.`);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[fund-sol] ${(err as Error).message}\n`);
    printUsage();
    process.exit(1);
  }

  const sol = Number(args.amount);
  const result = await fundSol({
    cluster: args.cluster,
    recipient: args.recipient,
    amountSol: sol,
    rpcUrl: args.rpcUrl,
  });
  console.log(
    `[fund-sol] ✓ ${args.recipient} +${sol} SOL (${result.lamports} lamports) on ${args.cluster}\n` +
      `         signature: ${result.signature}`,
  );
}

// Bundle-safe isMain check: when bundled separately into scripts/dist/fund-sol.mjs,
// argv[1] ends with `/fund-sol.mjs`. When inlined into deploy.mjs by esbuild,
// argv[1] ends with `/deploy.mjs` so this returns false and main() does not run.
const isMain = /\/fund-sol\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[fund-sol] failed:', (err as Error).message ?? err);
    process.exit(1);
  });
}

void __dirname; // silence unused warning when imported as a module
