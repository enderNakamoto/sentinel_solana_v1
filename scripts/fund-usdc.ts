/**
 * scripts/fund-usdc.ts
 *
 * Fund a recipient pubkey with mock USDC on Surfpool / localnet / devnet /
 * testnet. Mainnet is explicitly refused (real USDC has no mint authority).
 *
 * Two paths:
 *   1. **Surfpool**: try `surfnet_setTokenBalance` cheat-RPC first (instant,
 *      no SOL needed). If the cheat is unavailable in the running Surfpool
 *      version, fall back to the real `mint_to` path below.
 *   2. **Localnet / devnet / testnet**: real on-chain `mint_to_checked`
 *      transaction signed by `keys/mock-usdc-authority.json`. Idempotent
 *      ATA creation is done in the same tx. The mint authority pays the
 *      tx fee — on surfpool this script auto-airdrops SOL to the authority
 *      if its balance is low; on other clusters the user must pre-fund.
 *
 * Pre-condition: the mock USDC mint must exist at the canonical pubkey
 * (`keys/mock-usdc.pubkey`) on the target cluster. The deploy script
 * auto-creates it on first run; the error path below points the user at
 * the manual `spl-token create-token` command if missing.
 *
 * Run:
 *   pnpm fund-usdc --cluster <surfpool|localnet|devnet|testnet> --recipient <pubkey> --amount <usdc>
 *
 * Programmatic API:
 *   import { fundUsdc } from './scripts/fund-usdc.ts';
 *   await fundUsdc({ cluster: 'devnet', recipient: '<pubkey>', amount: 100 });
 */

import { createClient, address as kitAddress, type Address } from '@solana/kit';
import {
  solanaDevnetRpc,
  solanaLocalRpc,
  solanaRpc,
} from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
} from '@solana-program/token';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey as Web3Pubkey } from '@solana/web3.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fundSol } from './fund-sol.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(__dirname);

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(cur, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'sentinel-solana') return cur;
      } catch { /* keep walking */ }
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

const MINT_PUBKEY_PATH = resolve(REPO_ROOT, 'keys/mock-usdc.pubkey');
const MINT_AUTHORITY_KEYPAIR_PATH = resolve(
  REPO_ROOT,
  'keys/mock-usdc-authority.json',
);

const USDC_DECIMALS = 6;

const RPC_URLS: Record<string, string> = {
  surfpool: 'http://127.0.0.1:8899',
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

const SUPPORTED_CLUSTERS = new Set(Object.keys(RPC_URLS));

export interface FundUsdcOpts {
  cluster: string;
  recipient: string;
  /** Amount in whole USDC units (multiplied by 10^6 internally). */
  amount: number;
  /** Override RPC endpoint. */
  rpcUrl?: string;
  /** Override path to the mint-authority keypair. */
  mintAuthorityKeypairPath?: string;
}

export interface FundUsdcResult {
  ata: Address;
  amountUnits: bigint;
  /** "cheat" if surfnet_setTokenBalance succeeded, "mint_to" if real mint_to ran. */
  path: 'cheat' | 'mint_to';
  signature?: string;
}

export async function fundUsdc(opts: FundUsdcOpts): Promise<FundUsdcResult> {
  if (opts.cluster === 'mainnet') {
    throw new Error(
      `Real USDC has no mint authority — fund ${opts.recipient} via DEX or transfer.`,
    );
  }
  if (!SUPPORTED_CLUSTERS.has(opts.cluster)) {
    throw new Error(
      `--cluster must be one of ${[...SUPPORTED_CLUSTERS].join(', ')}; got ${opts.cluster}`,
    );
  }
  validatePubkey(opts.recipient);
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) {
    throw new Error(`--amount must be a positive number of USDC (got ${opts.amount})`);
  }

  const rpcUrl = opts.rpcUrl ?? RPC_URLS[opts.cluster];
  const mintPubkey = readMintPubkey();
  const recipient = kitAddress(opts.recipient);
  const amountUnits = usdcToRawUnits(opts.amount);

  // Pre-flight: confirm mint exists. If missing, error with the create-mint command.
  await ensureMintExists(rpcUrl, mintPubkey, opts.cluster);

  // Surfpool fast-path: surfnet_setTokenBalance cheat-RPC.
  if (opts.cluster === 'surfpool') {
    try {
      const ata = deriveAta(mintPubkey, recipient);
      await callSurfnetSetTokenBalance(rpcUrl, {
        ata,
        owner: recipient,
        mint: mintPubkey,
        amount: amountUnits,
      });
      return { ata, amountUnits, path: 'cheat' };
    } catch (cheatErr) {
      console.log(
        `[fund-usdc] surfnet_setTokenBalance unavailable (${(cheatErr as Error).message}); ` +
          `falling back to real mint_to.`,
      );
      // fall through to mint_to path
    }
  }

  // Real on-chain mint_to (localnet / devnet / testnet, and surfpool fallback).
  return mintToRecipient({
    cluster: opts.cluster,
    rpcUrl,
    mintPubkey,
    recipient,
    amountUnits,
    mintAuthorityKeypairPath:
      opts.mintAuthorityKeypairPath ?? MINT_AUTHORITY_KEYPAIR_PATH,
  });
}

interface MintToParams {
  cluster: string;
  rpcUrl: string;
  mintPubkey: Address;
  recipient: Address;
  amountUnits: bigint;
  mintAuthorityKeypairPath: string;
}

async function mintToRecipient(p: MintToParams): Promise<FundUsdcResult> {
  if (!existsSync(p.mintAuthorityKeypairPath)) {
    throw new Error(
      `Mint authority keypair missing: ${p.mintAuthorityKeypairPath}\n` +
        `Run \`bash scripts/keys-bootstrap.sh\` first.`,
    );
  }

  // On surfpool, top up the mint authority's SOL if it's low — the authority
  // pays the tx fee + ATA creation rent. Devnet/testnet/localnet require
  // user to pre-fund (per phase plan locked decision).
  if (p.cluster === 'surfpool') {
    const authorityPubkey = await pubkeyFromKeypairFile(p.mintAuthorityKeypairPath);
    const balance = await getBalance(p.rpcUrl, authorityPubkey);
    if (balance < 100_000_000n) {
      console.log(
        `[fund-usdc] mint authority ${authorityPubkey} has ${balance} lamports; airdropping 1 SOL on surfpool.`,
      );
      await fundSol({
        cluster: 'surfpool',
        recipient: authorityPubkey,
        amountSol: 1,
        rpcUrl: p.rpcUrl,
      });
    }
  }

  const client = await createClient()
    .use(signerFromFile(p.mintAuthorityKeypairPath))
    .use(pickRpcPlugin(p.cluster));

  const ata = deriveAta(p.mintPubkey, p.recipient);

  const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: client.payer,
    ata,
    owner: p.recipient,
    mint: p.mintPubkey,
  });
  const mintToIx = getMintToCheckedInstruction({
    mint: p.mintPubkey,
    token: ata,
    mintAuthority: client.identity,
    amount: p.amountUnits,
    decimals: USDC_DECIMALS,
  });

  await client.sendTransaction([createAtaIx, mintToIx]);
  return { ata, amountUnits: p.amountUnits, path: 'mint_to' };
}

interface SurfnetSetTokenParams {
  ata: Address;
  owner: Address;
  mint: Address;
  amount: bigint;
}

/**
 * Try the surfnet_setTokenBalance cheat-RPC. Param shape varies by Surfpool
 * version — we send a positional array with the most documented shape, and
 * also include the explicit ATA address as a sibling for versions that
 * accept that. Throws on any RPC error so the caller can fall back to
 * real mint_to.
 */
async function callSurfnetSetTokenBalance(
  rpcUrl: string,
  p: SurfnetSetTokenParams,
): Promise<void> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'surfnet_setTokenBalance',
    params: [
      p.owner.toString(),
      p.mint.toString(),
      Number(p.amount),
      // Some Surfpool versions accept a 4th param with the ATA address pre-derived.
      p.ata.toString(),
    ],
  };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`surfnet_setTokenBalance HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (json.error) {
    throw new Error(
      `surfnet_setTokenBalance error ${json.error.code}: ${json.error.message}`,
    );
  }
}

/**
 * Derive the canonical Associated Token Account (ATA) address for an
 * (owner, mint) pair via the legacy @solana/spl-token sync helper. We use
 * this instead of `findAssociatedTokenPda` from `@solana-program/token`
 * because the Codama-generated helper hits a runtime "Cannot read properties
 * of undefined" inside `assertIsAddress` against our pinned dep versions
 * (likely a peer-dep conflict between @solana/sysvars 4.x vs 6.x). The
 * legacy sync helper produces the same canonical ATA address.
 */
function deriveAta(mint: Address, owner: Address): Address {
  const ataLegacy = getAssociatedTokenAddressSync(
    new Web3Pubkey(mint.toString()),
    new Web3Pubkey(owner.toString()),
    true, // allowOwnerOffCurve — needed for PDA owners (vault state, treasury)
  );
  return kitAddress(ataLegacy.toBase58());
}

function readMintPubkey(): Address {
  if (!existsSync(MINT_PUBKEY_PATH)) {
    throw new Error(
      `Mock USDC mint pubkey missing: ${MINT_PUBKEY_PATH}\n` +
        `Run \`bash scripts/keys-bootstrap.sh\` to generate the mint keypair.`,
    );
  }
  return kitAddress(readFileSync(MINT_PUBKEY_PATH, 'utf-8').trim());
}

async function ensureMintExists(
  rpcUrl: string,
  mint: Address,
  cluster: string,
): Promise<void> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [mint.toString(), { encoding: 'base64' }],
  };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `getAccountInfo HTTP ${res.status} on ${rpcUrl}: is the RPC reachable?`,
    );
  }
  const json = (await res.json()) as {
    result?: { value: unknown };
    error?: { code: number; message: string };
  };
  if (json.error) {
    throw new Error(`getAccountInfo error: ${JSON.stringify(json.error)}`);
  }
  if (!json.result || !json.result.value) {
    throw new Error(
      `Mock USDC not found on ${cluster} at ${mint.toString()}.\n` +
        `  Option 1: run \`pnpm deploy --cluster ${cluster} --owner <pubkey>\` first ` +
        `(it auto-creates the mint).\n` +
        `  Option 2: run \`spl-token create-token --decimals 6 --url ${rpcUrl} ` +
        `keys/mock-usdc.json --mint-authority keys/mock-usdc-authority.json\` manually.`,
    );
  }
}

async function getBalance(rpcUrl: string, pubkey: string): Promise<bigint> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: [pubkey],
  };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return 0n;
  const json = (await res.json()) as { result?: { value: number } };
  return BigInt(json.result?.value ?? 0);
}

async function pubkeyFromKeypairFile(path: string): Promise<string> {
  // The keypair file is a 64-byte JSON array — secret key bytes 0..32 are
  // the seed, bytes 32..64 are the public key. Read the public key bytes
  // directly to avoid spawning solana-keygen.
  const bytes = JSON.parse(readFileSync(path, 'utf-8')) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`Invalid keypair file: ${path}`);
  }
  const pubkeyBytes = new Uint8Array(bytes.slice(32));
  return base58Encode(pubkeyBytes);
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    out = BASE58_ALPHABET[r] + out;
  }
  return '1'.repeat(leading) + out;
}

function pickRpcPlugin(cluster: string) {
  switch (cluster) {
    case 'surfpool':
    case 'localnet':
      return solanaLocalRpc();
    case 'devnet':
      return solanaDevnetRpc();
    case 'testnet':
      // No dedicated testnet plugin; use the generic `solanaRpc`. Testnet
      // is the validator-test cluster, less reliable for app dev — included
      // for completeness but not part of the gate.
      return solanaRpc({ rpcUrl: RPC_URLS.testnet });
    default:
      throw new Error(`No RPC plugin for cluster: ${cluster}`);
  }
}

function usdcToRawUnits(usdc: number): bigint {
  // 6 decimals; clamp precision to avoid float drift on values like 0.1 USDC.
  const fixed = usdc.toFixed(USDC_DECIMALS);
  const [whole, frac = ''] = fixed.split('.');
  const fracPadded = (frac + '000000').slice(0, USDC_DECIMALS);
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function validatePubkey(s: string): void {
  if (!BASE58_RE.test(s)) {
    throw new Error(`pubkey must be 32-44 base58 chars; got: ${s}`);
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
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.cluster) throw new Error('--cluster is required');
  if (!args.recipient) throw new Error('--recipient <pubkey> is required');
  if (!args.amount) throw new Error('--amount <usdc> is required');
  return args as CliArgs;
}

function printUsage(): void {
  console.log(`Usage: pnpm fund-usdc --cluster <surfpool|localnet|devnet|testnet> --recipient <pubkey> --amount <usdc>

Mints <usdc> mock USDC to the recipient's ATA, signed by keys/mock-usdc-authority.json.

Options:
  --cluster   surfpool / localnet / devnet / testnet (mainnet refused).
  --recipient Base58 Solana pubkey to mint to.
  --amount    Amount in whole USDC units (e.g. 100 = 100 USDC).
  --rpc-url   Override RPC endpoint.
  --help      Print this help.

The mock USDC mint must already exist on the target cluster. The deploy
script auto-creates it on first run; alternatively, run:
  spl-token create-token --decimals 6 --url <rpc> keys/mock-usdc.json --mint-authority keys/mock-usdc-authority.json`);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[fund-usdc] ${(err as Error).message}\n`);
    printUsage();
    process.exit(1);
  }

  const result = await fundUsdc({
    cluster: args.cluster,
    recipient: args.recipient,
    amount: Number(args.amount),
    rpcUrl: args.rpcUrl,
  });
  console.log(
    `[fund-usdc] ✓ ${args.recipient} (ata ${result.ata}) +${args.amount} USDC ` +
      `(${result.amountUnits} raw units) on ${args.cluster} via ${result.path}` +
      (result.signature ? `\n         signature: ${result.signature}` : ''),
  );
}

// Bundle-safe isMain check (see fund-sol.ts for rationale).
const isMain = /\/fund-usdc\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[fund-usdc] failed:', (err as Error).message ?? err);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  });
}
