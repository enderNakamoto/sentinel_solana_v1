/**
 * scripts/bootstrap-e2e.ts
 *
 * One-shot orchestrator that brings a blank Surfpool ledger to a state
 * the Phase 16 e2e suite can run against. Idempotent — safe to re-run.
 *
 * Steps (in order):
 *   1. Health-check that Surfpool is reachable on 127.0.0.1:8899.
 *   2. `pnpm deploy --cluster surfpool` — deploys all 5 programs and
 *      runs init / wire-authorities (deploy.ts is itself idempotent).
 *   3. `pnpm bootstrap-test-actors` — generates investor-a / buyer-a /
 *      etc keypairs if missing.
 *   4. `pnpm seed-routes --cluster surfpool` — whitelists every
 *      MOCK_FLIGHTS route on-chain.
 *   5. Derive the e2e-traveler Solana address from the BIP-39
 *      abandon-vector seed at Phantom's default derivation
 *      (m/44'/501'/0'/0'). This must match the seed in
 *      frontend/tests/wallet-setup/basic.setup.ts so the Synpress
 *      Phantom and the on-chain account agree.
 *   6. Airdrop SOL to investor-a (the e2e underwriter) and to the
 *      traveler address.
 *   7. Mint 50,000 mock USDC to investor-a so they can fund the vault.
 *   8. Underwriter deposit: investor-a signs vault.deposit(20,000 USDC)
 *      so the pool has liquidity for the traveler scenarios.
 *
 * Run:
 *   pnpm bootstrap-e2e
 *
 * Re-run after `surfpool start` to re-seed a fresh ledger.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

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
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

import {
  findShareMintPda,
  findVaultStatePda,
  getDepositInstructionAsync,
} from './clients/vault/src/generated/index.ts';

import { fundSol } from './fund-sol.ts';
import { fundUsdc } from './fund-usdc.ts';

// ─── Constants (must mirror frontend/tests/wallet-setup/basic.setup.ts) ─

const TRAVELER_SEED_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

const SURFPOOL_RPC = 'http://127.0.0.1:8899';
const UNDERWRITER_USDC_AMOUNT = 50_000; // mock-USDC units the underwriter receives
const UNDERWRITER_DEPOSIT_USDC = 20_000n * 1_000_000n; // 20k USDC, 6 decimals
const TRAVELER_AIRDROP_SOL = 5;
const UNDERWRITER_AIRDROP_SOL = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(__dirname);

// `__dirname` is `scripts/dist/` after esbuild bundling, so resolve(.., '..')
// would land on `scripts/`. Walk up looking for the workspace root
// `package.json` whose name is `sentinel-solana`.
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

const UNDERWRITER_KEYPAIR_PATH = resolve(
  REPO_ROOT,
  'keys/test-actors/investor-a.json',
);
const MOCK_PUSD_MINT_PUBKEY_PATH = resolve(REPO_ROOT, 'keys/mock-pusd.pubkey');

// ─── Step 1: surfpool reachable ──────────────────────────────────────────

async function ensureSurfpoolReachable(): Promise<Rpc<SolanaRpcApi>> {
  const rpc = createSolanaRpc(SURFPOOL_RPC) as Rpc<SolanaRpcApi>;
  try {
    const v = await rpc.getVersion().send();
    console.log(`[bootstrap-e2e] surfpool ok — solana-core ${v['solana-core']}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Surfpool not reachable at ${SURFPOOL_RPC}: ${msg}\n` +
        `  Run \`pnpm dev:surfpool\` in another tab and retry.`,
    );
  }
  return rpc;
}

// ─── Steps 2/3/4: shell out to existing pnpm scripts ─────────────────────

function runPnpm(scriptName: string, args: string[] = []): void {
  // pnpm 9 has builtin commands like `deploy` that shadow workspace
  // scripts of the same name. Use `pnpm run <name>` to force the
  // workspace-script lookup; trailing args pass through directly.
  const cmd = `pnpm run ${scriptName} ${args.join(' ')}`.trim();
  console.log(`[bootstrap-e2e] $ ${cmd}`);
  execSync(cmd, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NO_DNA: '1' },
  });
}

// ─── Step 5: derive traveler address from seed ───────────────────────────

interface DerivedKey {
  pubkey: Address;
  base58Secret: string; // 64-byte secret; useful for diagnostics
}

function deriveTravelerAddress(): DerivedKey {
  const seed = mnemonicToSeedSync(TRAVELER_SEED_PHRASE);
  const derived = derivePath(SOLANA_DERIVATION_PATH, seed.toString('hex'));
  const kp = nacl.sign.keyPair.fromSeed(derived.key);
  const pubkeyBase58 = bs58.encode(kp.publicKey);
  const fullSecret = new Uint8Array(64);
  fullSecret.set(kp.secretKey, 0); // tweetnacl returns 64-byte secret already
  return {
    pubkey: pubkeyBase58 as Address,
    base58Secret: bs58.encode(kp.secretKey),
  };
}

// ─── Step 6 + 7: airdrop SOL + mint USDC ─────────────────────────────────

function readPubkeyFile(path: string): Address {
  if (!existsSync(path)) {
    throw new Error(`Pubkey file missing: ${path}`);
  }
  return readFileSync(path, 'utf-8').trim() as Address;
}

async function airdrop(recipient: Address, amountSol: number): Promise<void> {
  console.log(
    `[bootstrap-e2e] airdrop ${amountSol} SOL → ${recipient.slice(0, 4)}…${recipient.slice(-4)}`,
  );
  await fundSol({ cluster: 'surfpool', recipient, amountSol });
}

async function mintUsdcTo(recipient: Address, amount: number): Promise<void> {
  console.log(
    `[bootstrap-e2e] mint ${amount} mock USDC → ${recipient.slice(0, 4)}…${recipient.slice(-4)}`,
  );
  await fundUsdc({ cluster: 'surfpool', recipient, amount });
}

// ─── Step 8: underwriter deposit ─────────────────────────────────────────

async function loadUnderwriterSigner(): Promise<KeyPairSigner> {
  if (!existsSync(UNDERWRITER_KEYPAIR_PATH)) {
    throw new Error(
      `Underwriter keypair missing: ${UNDERWRITER_KEYPAIR_PATH}\n` +
        `  Run \`pnpm bootstrap-test-actors\` first.`,
    );
  }
  const bytes = JSON.parse(readFileSync(UNDERWRITER_KEYPAIR_PATH, 'utf-8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

async function underwriterDeposit(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  const underwriter = await loadUnderwriterSigner();
  const stableMint = readPubkeyFile(MOCK_PUSD_MINT_PUBKEY_PATH);

  const [vaultStatePda] = await findVaultStatePda();
  const [shareMintPda] = await findShareMintPda();

  const [vaultUsdcAta] = await findAssociatedTokenPda({
    owner: vaultStatePda,
    mint: stableMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [depositorUsdcAta] = await findAssociatedTokenPda({
    owner: underwriter.address,
    mint: stableMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [depositorShareAta] = await findAssociatedTokenPda({
    owner: underwriter.address,
    mint: shareMintPda,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const createShareAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: underwriter,
    owner: underwriter.address,
    mint: shareMintPda,
  });

  const depositIx = await getDepositInstructionAsync({
    vaultTokenAccount: vaultUsdcAta,
    depositorStableAccount: depositorUsdcAta,
    depositorShareAccount: depositorShareAta,
    depositor: underwriter,
    stableAmount: UNDERWRITER_DEPOSIT_USDC,
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(underwriter, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([createShareAtaIx, depositIx], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(signed);
  const wireTx = getBase64EncodedWireTransaction(signed);

  await rpc
    .sendTransaction(wireTx, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  await confirmSig(rpc, sig);
  console.log(
    `[bootstrap-e2e] underwriter deposit landed: ${sig.slice(0, 8)}…  (20,000 USDC)`,
  );
}

async function confirmSig(
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
      if (status.err) {
        throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tx ${sig} confirmation timeout after ${timeoutMs}ms`);
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('[bootstrap-e2e] starting…');

  const rpc = await ensureSurfpoolReachable();

  // Steps 2–4. Each is idempotent and exits 0 on no-op.
  // Reuse the devnet-deployer keypair for surfpool too — single owner
  // address (FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy) keeps
  // governance constants identical across clusters.
  const DEVNET_DEPLOYER_OWNER = 'FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy';
  const DEVNET_DEPLOYER_KEY = 'keys/devnet-deployer.json';
  runPnpm('deploy', [
    '--cluster',
    'surfpool',
    '--owner',
    DEVNET_DEPLOYER_OWNER,
    '--deployer',
    DEVNET_DEPLOYER_KEY,
  ]);
  runPnpm('bootstrap-test-actors');
  runPnpm('seed-routes', [
    '--cluster',
    'surfpool',
    '--deployer',
    DEVNET_DEPLOYER_KEY,
  ]);

  const traveler = deriveTravelerAddress();
  console.log(
    `[bootstrap-e2e] e2e-traveler derived: ${traveler.pubkey} (from BIP-39 abandon-vector @ m/44'/501'/0'/0')`,
  );

  const underwriter = await loadUnderwriterSigner();
  console.log(
    `[bootstrap-e2e] underwriter (investor-a): ${underwriter.address}`,
  );

  await airdrop(traveler.pubkey, TRAVELER_AIRDROP_SOL);
  await airdrop(underwriter.address, UNDERWRITER_AIRDROP_SOL);
  await mintUsdcTo(underwriter.address, UNDERWRITER_USDC_AMOUNT);
  await underwriterDeposit(rpc);

  console.log('\n[bootstrap-e2e] DONE — surfpool ready for e2e tests.');
  console.log('  • run `pnpm dev:frontend:surfpool` in a tab');
  console.log('  • run `pnpm --filter @sentinel/frontend test:e2e` in another');
}

main().catch((err) => {
  console.error('[bootstrap-e2e] fatal:', err);
  process.exit(1);
});
