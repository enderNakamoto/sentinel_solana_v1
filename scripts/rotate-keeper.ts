/**
 * scripts/rotate-keeper.ts
 *
 * Rotate the on-chain `authorized_keeper` field on `ControllerConfig`
 * to a target pubkey. The `controller.set_authorized_keeper` ix is
 * gated by `has_one = owner` so only the deployer keypair can sign it.
 *
 * Default behavior: rotate keeper → deployer (so the deployer pays for
 * classifier + settler crons). Pass `--keeper <pubkey-or-keypair-path>`
 * to rotate to a different signer.
 *
 * Run:
 *   NO_DNA=1 pnpm rotate-keeper --cluster devnet
 *   NO_DNA=1 pnpm rotate-keeper --cluster devnet --keeper keys/devnet-keeper.json
 *   NO_DNA=1 pnpm rotate-keeper --cluster devnet --keeper FA6Bi...gzeNbywy
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
  fetchMaybeControllerConfig,
  findControllerConfigPda,
  getSetAuthorizedKeeperInstructionAsync,
} from './clients/controller/src/generated/index.ts';
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
  keeper?: string;
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
      case '--keeper':
        args.keeper = next;
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
    throw new Error(`Keypair not found: ${keypairPath}`);
  }
  const bytes = JSON.parse(readFileSync(keypairPath, 'utf-8')) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`Invalid keypair file: ${keypairPath}`);
  }
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

/**
 * Resolve the target keeper to a bare Address. Accepts either a
 * keypair file path (from which we extract the pubkey) or a literal
 * base58 address string.
 */
async function resolveKeeperAddress(value: string): Promise<Address> {
  const candidatePath = resolve(REPO_ROOT, value);
  if (existsSync(candidatePath)) {
    const signer = await loadKeypair(candidatePath);
    return signer.address;
  }
  return kitAddress(value);
}

async function sendIx(
  rpc: Rpc<SolanaRpcApi>,
  payer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
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

  // Default: rotate keeper → deployer (cron payer = deployer).
  const targetKeeper = args.keeper
    ? await resolveKeeperAddress(args.keeper)
    : deployer.address;

  console.log(`[rotate-keeper] cluster=${args.cluster} rpc=${rpcUrl}`);
  console.log(`[rotate-keeper] deployer=${deployer.address}`);
  console.log(`[rotate-keeper] new keeper=${targetKeeper}`);

  const rpc = createSolanaRpc(rpcUrl) as Rpc<SolanaRpcApi>;

  const [configPda] = await findControllerConfigPda();
  const existing = await fetchMaybeControllerConfig(rpc, configPda as Address);
  if (!existing.exists) {
    throw new Error(
      `ControllerConfig PDA not found at ${configPda}. Has the controller been initialized?`,
    );
  }
  const currentKeeper = existing.data.authorizedKeeper;
  const currentOwner = existing.data.owner;
  console.log(`[rotate-keeper] current keeper=${currentKeeper}`);
  console.log(`[rotate-keeper] config owner=${currentOwner}`);

  if (currentOwner !== deployer.address) {
    throw new Error(
      `Deployer ${deployer.address} is not the controller owner (${currentOwner}). ` +
        `Only the owner can rotate the keeper.`,
    );
  }
  if (currentKeeper === targetKeeper) {
    console.log(`[rotate-keeper] keeper already set to ${targetKeeper}, nothing to do.`);
    return;
  }

  const ix = await getSetAuthorizedKeeperInstructionAsync({
    owner: deployer,
    newKeeper: targetKeeper,
  });

  const sig = await sendIx(rpc, deployer, [ix]);
  console.log(`[rotate-keeper] tx sent: ${sig}`);
  await confirmSignature(rpc, sig);
  console.log(`[rotate-keeper] confirmed.`);

  const after = await fetchMaybeControllerConfig(rpc, configPda as Address);
  if (after.exists && after.data.authorizedKeeper === targetKeeper) {
    console.log(
      `[rotate-keeper] ✅ ControllerConfig.authorized_keeper now = ${after.data.authorizedKeeper}`,
    );
  } else {
    throw new Error('Post-tx ControllerConfig.authorized_keeper does not match target.');
  }
}

main().catch((err) => {
  console.error('[rotate-keeper] FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
