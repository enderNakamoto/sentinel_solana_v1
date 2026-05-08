/**
 * scripts/seed-routes.ts
 *
 * Whitelist every route in `frontend/src/data/mock.ts::MOCK_FLIGHTS` against
 * the deployed governance program on the target cluster. Idempotent — checks
 * if a `RouteAccount` PDA already exists and skips it; only sends txs for
 * missing routes.
 *
 * Run:
 *   NO_DNA=1 pnpm seed-routes --cluster devnet
 *   NO_DNA=1 pnpm seed-routes --cluster devnet --deployer keys/devnet-deployer.json
 *   NO_DNA=1 pnpm seed-routes --cluster surfpool
 */

import {
  address as kitAddress,
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
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import {
  fetchMaybeRouteAccount,
  findRoutePda,
  getWhitelistRouteInstructionAsync,
  GOVERNANCE_PROGRAM_ADDRESS,
} from './clients/governance/src/generated/index.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const RPC_URLS: Record<string, string> = {
  surfpool: 'http://127.0.0.1:8899',
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

const DEFAULT_DEPLOYER_BY_CLUSTER: Record<string, string> = {
  surfpool: 'keys/surfpool-deployer.json',
  localnet: 'keys/localnet-deployer.json',
  devnet: 'keys/devnet-deployer.json',
  testnet: 'keys/testnet-deployer.json',
};

interface CliArgs {
  cluster: string;
  deployer?: string;
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
      case '--deployer':
        args.deployer = next;
        i++;
        break;
      case '--rpc-url':
        args.rpcUrl = next;
        i++;
        break;
    }
  }
  if (!args.cluster) {
    throw new Error('--cluster is required (surfpool|localnet|devnet|testnet)');
  }
  if (!RPC_URLS[args.cluster]) {
    throw new Error(`unsupported --cluster: ${args.cluster}`);
  }
  return args as CliArgs;
}

async function loadKeypair(keypairPath: string): Promise<KeyPairSigner> {
  if (!existsSync(keypairPath)) {
    throw new Error(`Deployer keypair not found: ${keypairPath}`);
  }
  const bytes = JSON.parse(readFileSync(keypairPath, 'utf-8')) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`Invalid keypair file: ${keypairPath}`);
  }
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

interface RouteSeed {
  flightId: string;
  origin: string;
  destination: string;
}

/**
 * Read MOCK_FLIGHTS directly from the source TS to avoid an import-cycle
 * shim. The file is plain TS with a literal array; we extract the (id,
 * from, to) triples via simple regex — far cheaper than a full TS bundler
 * call from a Node script.
 */
function loadSeedRoutes(): RouteSeed[] {
  const path = resolve(REPO_ROOT, 'frontend/src/data/mock.ts');
  const src = readFileSync(path, 'utf-8');
  // Scope to the MOCK_FLIGHTS array only; later definitions (MOCK_MY_POLICIES
  // etc.) re-use the same `id`/`from`/`to` keys but aren't whitelistable.
  const blockMatch = src.match(
    /export const MOCK_FLIGHTS:[\s\S]*?\[(?<body>[\s\S]*?)\];/,
  );
  if (!blockMatch?.groups?.body) {
    throw new Error('Could not locate MOCK_FLIGHTS array in mock.ts');
  }
  const rowRe = /\{\s*id:\s*'([^']+)',[^}]*?from:\s*'([^']+)',\s*to:\s*'([^']+)'/g;
  const seeds: RouteSeed[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(blockMatch.groups.body)) !== null) {
    seeds.push({
      flightId: m[1] as string,
      origin: m[2] as string,
      destination: m[3] as string,
    });
  }
  return seeds;
}

async function sendIx(
  rpc: Rpc<SolanaRpcApi>,
  deployer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deployer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wireTx = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);
  try {
    await rpc
      .sendTransaction(wireTx, { encoding: 'base64', preflightCommitment: 'confirmed' })
      .send();
  } catch (err) {
    const detail = (err as { context?: { logs?: string[] } }).context?.logs;
    if (detail && detail.length > 0) {
      throw new Error(
        `simulation failed:\n${detail.slice(-12).map((l) => '    ' + l).join('\n')}`,
      );
    }
    throw err;
  }
  return sig;
}

async function confirmSignature(
  rpc: Rpc<SolanaRpcApi>,
  sig: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await rpc.getSignatureStatuses([sig as never]).send();
    const status = value[0];
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      if (status.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tx ${sig} confirmation timeout after ${timeoutMs}ms`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const rpcUrl = args.rpcUrl ?? RPC_URLS[args.cluster];
  const deployerPath = resolve(
    REPO_ROOT,
    args.deployer ?? DEFAULT_DEPLOYER_BY_CLUSTER[args.cluster] ?? '',
  );
  const deployer = await loadKeypair(deployerPath);

  console.log(`[seed-routes] cluster=${args.cluster} rpc=${rpcUrl}`);
  console.log(`[seed-routes] deployer=${deployer.address}`);

  const rpc = createSolanaRpc(rpcUrl) as Rpc<SolanaRpcApi>;
  const seeds = loadSeedRoutes();
  console.log(`[seed-routes] ${seeds.length} routes to consider\n`);

  let whitelisted = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, s] of seeds.entries()) {
    const tag = `(${i + 1}/${seeds.length}) ${s.flightId} ${s.origin}→${s.destination}`;
    try {
      const [routePda] = await findRoutePda({
        flightId: s.flightId,
        origin: s.origin,
        destination: s.destination,
      });
      const existing = await fetchMaybeRouteAccount(rpc, routePda as Address);
      if (existing.exists) {
        console.log(`[seed-routes] ${tag} — already whitelisted, skipped.`);
        skipped++;
        continue;
      }

      const ix = await getWhitelistRouteInstructionAsync({
        caller: deployer,
        // When the deployer == GovernanceConfig.owner we must pass the
        // program ID as the "absent" sentinel for the optional adminRecord
        // PDA — otherwise the Codama builder auto-derives a real PDA that
        // doesn't exist on-chain and the program rejects it.
        adminRecord: GOVERNANCE_PROGRAM_ADDRESS,
        flightId: s.flightId,
        origin: s.origin,
        destination: s.destination,
        premium: null,
        payoff: null,
        delayHours: null,
      });
      const sig = await sendIx(rpc, deployer, [ix]);
      await confirmSignature(rpc, sig);
      console.log(`[seed-routes] ${tag} — whitelisted (${sig.slice(0, 8)}…).`);
      whitelisted++;
    } catch (err) {
      console.error(`[seed-routes] ${tag} — FAILED:`, (err as Error).message ?? err);
      failed++;
    }
  }

  console.log(
    `\n[seed-routes] done. whitelisted=${whitelisted} skipped=${skipped} failed=${failed}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[seed-routes] fatal:', err);
  process.exit(1);
});

// Silence unused-import warning when the helpers are only used at runtime.
void kitAddress;
