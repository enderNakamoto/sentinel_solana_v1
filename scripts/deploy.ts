/**
 * scripts/deploy.ts
 *
 * Cluster-parameterized deploy + initialize for the 5-program Sentinel
 * protocol. Single command spins up the full system on Surfpool localnet,
 * Solana devnet, testnet, or mainnet from a fresh slate.
 *
 * Run:
 *   NO_DNA=1 pnpm deploy --cluster <surfpool|devnet|testnet|mainnet> \
 *                        --owner <pubkey> \
 *                        [--oracle <pubkey>] [--keeper <pubkey>] [--usdc <pubkey>] \
 *                        [--deployer <keypair-path>] \
 *                        [--dry-run] [--skip-deploy] [--skip-init] \
 *                        [--confirm-mainnet]
 *
 * Phases:
 *   1. Validate args + resolve RPC + load deployer keypair
 *   2. Mainnet guardrail (--confirm-mainnet + typed prompt)
 *   3. Pre-flight SOL balance check (auto-airdrop on surfpool only)
 *   4. anchor build (if .so files stale or missing)
 *   5. Ensure mock USDC mint exists at the canonical pubkey
 *   6. Deploy 5 programs (anchor deploy, sequentially)
 *   7. Verify each program is on-chain (solana program show)
 *   8. Initialize all 5 programs (idempotent — skip if config PDA exists)
 *   9. Wire authorities (vault.set_controller, flight_pool.set_controller,
 *      oracle_aggregator.set_authorized_consumer — settable-once on chain;
 *      script reads state and skips if already wired)
 *  10. Verify final state (fetch each config, assert references)
 *  11. Emit deployments/<cluster>-<unix-ts>.json artifact
 *
 * Dry-run mode: prints the full plan + cost preview, simulates each
 * init/wire ix via simulateTransaction, exits 0 without sending real txs.
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
import { execSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';

import {
  GOVERNANCE_PROGRAM_ADDRESS,
  findConfigPda as findGovernanceConfigPda,
  getGovernanceConfigDecoder,
  getInitializeInstructionAsync as getGovernanceInitializeIxAsync,
} from './clients/governance/src/generated/index.ts';
import {
  VAULT_PROGRAM_ADDRESS,
  findShareMintPda,
  findVaultStatePda,
  findWithdrawalQueuePda,
  getInitializeInstructionAsync as getVaultInitializeIxAsync,
  getSetControllerInstruction as getVaultSetControllerIx,
  getVaultStateDecoder,
} from './clients/vault/src/generated/index.ts';
import {
  ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
  findConfigPda as findOracleConfigPda,
  getInitializeInstructionAsync as getOracleInitializeIxAsync,
  getOracleConfigDecoder,
  getSetAuthorizedConsumerInstruction as getOracleSetConsumerIx,
} from './clients/oracle_aggregator/src/generated/index.ts';
import {
  FLIGHT_POOL_PROGRAM_ADDRESS,
  findConfigPda as findFlightPoolConfigPda,
  findTreasuryAuthorityPda,
  getFlightPoolConfigDecoder,
  getInitializeInstructionAsync as getFlightPoolInitializeIxAsync,
  getSetControllerInstruction as getFlightPoolSetControllerIx,
} from './clients/flight_pool/src/generated/index.ts';
import {
  CONTROLLER_PROGRAM_ADDRESS,
  findActiveFlightListPda,
  findControllerConfigPda,
  getControllerConfigDecoder,
  getInitializeInstructionAsync as getControllerInitializeIxAsync,
} from './clients/controller/src/generated/index.ts';

import { fundSol } from './fund-sol.ts';

// ─── Constants ────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(__dirname);
const CONTRACTS_DIR = resolve(REPO_ROOT, 'contracts');
const TARGET_DEPLOY_DIR = resolve(CONTRACTS_DIR, 'target', 'deploy');
const KEYS_DIR = resolve(REPO_ROOT, 'keys');
const DEPLOYMENTS_DIR = resolve(REPO_ROOT, 'deployments');

const DEFAULT_DEPLOYER_KEYPAIR = resolve(homedir(), '.config/solana/id.json');
const SOLANA_BIN_DIR = resolve(homedir(), '.local/share/solana/install/active_release/bin');

const PROGRAMS = [
  { name: 'governance', soFile: 'governance.so', address: GOVERNANCE_PROGRAM_ADDRESS },
  { name: 'vault', soFile: 'vault.so', address: VAULT_PROGRAM_ADDRESS },
  { name: 'oracle_aggregator', soFile: 'oracle_aggregator.so', address: ORACLE_AGGREGATOR_PROGRAM_ADDRESS },
  { name: 'flight_pool', soFile: 'flight_pool.so', address: FLIGHT_POOL_PROGRAM_ADDRESS },
  { name: 'controller', soFile: 'controller.so', address: CONTROLLER_PROGRAM_ADDRESS },
] as const;

const RPC_URLS: Record<string, string> = {
  surfpool: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

const ANCHOR_NETWORK: Record<string, string> = {
  surfpool: 'localnet',
  devnet: 'devnet',
  testnet: 'testnet',
  mainnet: 'mainnet',
};

const SUPPORTED_CLUSTERS = new Set(Object.keys(RPC_URLS));

const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000n;

// Tunables — match the values used in `bootstrapController` test setup.
const SOLVENCY_RATIO = 100;        // 100% = fully collateralised
const MIN_LEAD_TIME = 3_600n;      // 1 hour before departure
const CLAIM_EXPIRY_WINDOW = 5_184_000n; // 60 days

// Default route terms — owner can update via governance.set_defaults later.
const DEFAULT_PREMIUM = 1_000_000n;     // 1 USDC
const DEFAULT_PAYOFF = 10_000_000n;     // 10 USDC
const DEFAULT_DELAY_HOURS = 2;

// ─── CLI parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  cluster: string;
  owner: string;
  oracle?: string;
  keeper?: string;
  usdc?: string;
  deployer: string;
  dryRun: boolean;
  skipDeploy: boolean;
  skipInit: boolean;
  confirmMainnet: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    deployer: process.env.DEPLOYER_KEYPAIR ?? DEFAULT_DEPLOYER_KEYPAIR,
    dryRun: false,
    skipDeploy: false,
    skipInit: false,
    confirmMainnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--cluster': args.cluster = next; i++; break;
      case '--owner': args.owner = next; i++; break;
      case '--oracle': args.oracle = next; i++; break;
      case '--keeper': args.keeper = next; i++; break;
      case '--usdc': args.usdc = next; i++; break;
      case '--deployer': args.deployer = next; i++; break;
      case '--dry-run': args.dryRun = true; break;
      case '--skip-deploy': args.skipDeploy = true; break;
      case '--skip-init': args.skipInit = true; break;
      case '--confirm-mainnet': args.confirmMainnet = true; break;
      case '--help': case '-h': printUsage(); process.exit(0);
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.cluster) throw new Error('--cluster <surfpool|devnet|testnet|mainnet> is required');
  if (!args.owner) throw new Error('--owner <pubkey> is required');
  return args as CliArgs;
}

function printUsage(): void {
  console.log(`Usage: NO_DNA=1 pnpm deploy --cluster <surfpool|devnet|testnet|mainnet> \\
                            --owner <pubkey> \\
                            [--oracle <pubkey>] [--keeper <pubkey>] [--usdc <pubkey>] \\
                            [--deployer <keypair-path>] \\
                            [--dry-run] [--skip-deploy] [--skip-init] \\
                            [--confirm-mainnet]

Cluster-parameterized deploy + initialize for the 5-program Sentinel protocol.

Required:
  --cluster   surfpool / devnet / testnet / mainnet
  --owner     Pubkey for governance/vault/oracle/controller admin slots

Optional:
  --oracle    Pubkey for oracle_aggregator.authorized_oracle (the FlightDataFetcher
              cron's signing key). If omitted, generates a fresh keypair at
              keys/<cluster>-oracle.json.
  --keeper    Pubkey for controller.authorized_keeper (the Classifier + Settler
              crons' signing key). If omitted, generates keys/<cluster>-keeper.json.
  --usdc      Override USDC mint pubkey. Defaults to the mock mint at
              keys/mock-usdc.pubkey (auto-created on first run for surfpool/
              localnet/devnet/testnet). Required on mainnet.
  --deployer  Path to deployer keypair (default ~/.config/solana/id.json or
              \$DEPLOYER_KEYPAIR env var). Pays for all program deploy + init rent
              and tx fees.
  --dry-run   Print plan + cost preview, simulate init/wire ixs, exit without sending.
  --skip-deploy Skip the program-deploy step (assume already on-chain).
  --skip-init Skip init + wire-up (deploys only).
  --confirm-mainnet Required for --cluster mainnet. Prompts for typed confirmation.`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (!SUPPORTED_CLUSTERS.has(args.cluster)) {
    throw new Error(
      `--cluster must be one of ${[...SUPPORTED_CLUSTERS].join(', ')}; got ${args.cluster}`,
    );
  }
  validatePubkey(args.owner, '--owner');
  if (args.oracle) validatePubkey(args.oracle, '--oracle');
  if (args.keeper) validatePubkey(args.keeper, '--keeper');
  if (args.usdc) validatePubkey(args.usdc, '--usdc');

  if (args.cluster === 'mainnet' && !args.confirmMainnet) {
    throw new Error(
      `Mainnet deploys require --confirm-mainnet. Re-run with --confirm-mainnet ` +
        `to see the cost preview + typed-confirmation prompt.`,
    );
  }
  if (args.cluster === 'mainnet' && !args.usdc) {
    throw new Error(
      `Mainnet deploys require an explicit --usdc <real-usdc-mint>. ` +
        `Mock USDC must not be used on mainnet.`,
    );
  }

  const rpcUrl = RPC_URLS[args.cluster];
  const rpc = createSolanaRpc(rpcUrl);

  const owner = kitAddress(args.owner);
  const deployerKeypair = await loadKeypair(args.deployer);
  console.log(`[deploy] cluster=${args.cluster} rpc=${rpcUrl}`);
  console.log(`[deploy] deployer=${deployerKeypair.address}`);
  console.log(`[deploy] owner=${owner}`);

  // The Anchor programs set config.owner from the init signer's key —
  // there is no transfer-owner instruction. So the deployer keypair must
  // be the owner. Reject the call early if they differ instead of letting
  // the verify phase catch the mismatch after side-effects.
  if (owner !== deployerKeypair.address) {
    throw new Error(
      `--owner ${owner} does not match the deployer keypair ${deployerKeypair.address}.\n` +
        `  The deployer signs the init txs and becomes config.owner — they must be the same keypair.\n` +
        `  To deploy with a different owner, pass --deployer <path-to-owner-keypair> (and ensure that keypair has SOL).`,
    );
  }

  // Resolve oracle / keeper pubkeys (generating ephemeral keypairs if not passed).
  const { oracle, oraclePath } = await resolveAuthority(args.oracle, 'oracle', args.cluster);
  const { keeper: keeperAddr, keeperPath } = await resolveKeeperAuthority(args.keeper, args.cluster);
  console.log(`[deploy] oracle=${oracle}${oraclePath ? ` (keypair ${oraclePath})` : ''}`);
  console.log(`[deploy] keeper=${keeperAddr}${keeperPath ? ` (keypair ${keeperPath})` : ''}`);

  // Resolve USDC mint pubkey (mock by default, real on mainnet).
  const usdcMint = args.usdc
    ? kitAddress(args.usdc)
    : kitAddress(readMintPubkeyFile(resolve(KEYS_DIR, 'mock-usdc.pubkey')));
  console.log(`[deploy] usdc_mint=${usdcMint}`);

  // ─── Phase 1: pre-flight ─────────────────────────────────────────
  await preflightSolBalance({
    cluster: args.cluster,
    rpc,
    rpcUrl,
    deployer: deployerKeypair.address,
    skipDeploy: args.skipDeploy,
  });

  if (args.cluster === 'mainnet') {
    await mainnetTypedConfirmation({
      deployer: deployerKeypair.address,
      owner,
      usdcMint,
    });
  }

  if (args.dryRun) {
    console.log('[deploy] --dry-run: skipping all side effects.');
    console.log('[deploy] Plan:');
    console.log('  - anchor build (skipped in dry-run)');
    console.log('  - ensure mock USDC mint exists');
    console.log(`  - deploy ${PROGRAMS.length} programs`);
    console.log('  - init governance/vault/oracle/flight_pool/controller (idempotent)');
    console.log('  - wire vault.set_controller, flight_pool.set_controller, oracle.set_authorized_consumer');
    console.log('  - emit deployments/<cluster>-<ts>.json artifact');
    return;
  }

  // ─── Phase 2: build ──────────────────────────────────────────────
  if (!args.skipDeploy) {
    ensureBuilt();
  }

  // ─── Phase 3: ensure mock USDC mint ──────────────────────────────
  if (!args.usdc) {
    await ensureMockUsdcMint({
      cluster: args.cluster,
      rpcUrl,
      mintPubkey: usdcMint,
      deployerKeypairPath: args.deployer,
    });
  }

  // ─── Phase 4: deploy programs ────────────────────────────────────
  if (!args.skipDeploy) {
    deployPrograms({
      cluster: args.cluster,
      rpcUrl,
      deployerKeypairPath: args.deployer,
    });
  }

  // ─── Phase 5: init + wire ────────────────────────────────────────
  if (!args.skipInit) {
    await initAndWire({
      rpc,
      rpcUrl,
      deployer: deployerKeypair,
      owner,
      oracle,
      keeper: keeperAddr,
      usdcMint,
    });
  }

  // ─── Phase 6: verify + artifact ──────────────────────────────────
  const artifact = await verifyAndArtifact({
    rpc,
    cluster: args.cluster,
    rpcUrl,
    deployer: deployerKeypair.address,
    owner,
    oracle,
    keeper: keeperAddr,
    usdcMint,
    oraclePath,
    keeperPath,
  });
  console.log(`[deploy] ✓ artifact written: ${artifact}`);
}

// ─── Helpers: keypair / pubkey ────────────────────────────────────────────

async function loadKeypair(keypairPath: string): Promise<KeyPairSigner> {
  if (!existsSync(keypairPath)) {
    throw new Error(
      `Deployer keypair not found: ${keypairPath}\n` +
        `  Pass --deployer <path> or set DEPLOYER_KEYPAIR env var or create a default at\n` +
        `  ${DEFAULT_DEPLOYER_KEYPAIR} via \`solana-keygen new\`.`,
    );
  }
  const bytes = JSON.parse(readFileSync(keypairPath, 'utf-8')) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`Invalid keypair file: ${keypairPath}`);
  }
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

async function resolveAuthority(
  passedPubkey: string | undefined,
  role: 'oracle',
  cluster: string,
): Promise<{ oracle: Address; oraclePath?: string }> {
  if (passedPubkey) {
    return { oracle: kitAddress(passedPubkey) };
  }
  // Generate or read ephemeral keypair at keys/<cluster>-<role>.json.
  const path = resolve(KEYS_DIR, `${cluster}-${role}.json`);
  const pkPath = resolve(KEYS_DIR, `${cluster}-${role}.pubkey`);
  if (!existsSync(path)) {
    console.log(`[deploy] generating ephemeral ${role} keypair at ${path}`);
    runShell(`"${solanaKeygen()}" new --no-bip39-passphrase --silent --outfile "${path}"`);
    const pk = runShell(`"${solanaKeygen()}" pubkey "${path}"`).trim();
    writeFileSync(pkPath, pk + '\n');
  }
  const pk = readFileSync(pkPath, 'utf-8').trim();
  return { oracle: kitAddress(pk), oraclePath: path };
}

async function resolveKeeperAuthority(
  passedPubkey: string | undefined,
  cluster: string,
): Promise<{ keeper: Address; keeperPath?: string }> {
  if (passedPubkey) {
    return { keeper: kitAddress(passedPubkey) };
  }
  const path = resolve(KEYS_DIR, `${cluster}-keeper.json`);
  const pkPath = resolve(KEYS_DIR, `${cluster}-keeper.pubkey`);
  if (!existsSync(path)) {
    console.log(`[deploy] generating ephemeral keeper keypair at ${path}`);
    runShell(`"${solanaKeygen()}" new --no-bip39-passphrase --silent --outfile "${path}"`);
    const pk = runShell(`"${solanaKeygen()}" pubkey "${path}"`).trim();
    writeFileSync(pkPath, pk + '\n');
  }
  const pk = readFileSync(pkPath, 'utf-8').trim();
  return { keeper: kitAddress(pk), keeperPath: path };
}

function readMintPubkeyFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `Mock USDC mint pubkey missing: ${path}\n` +
        `  Run \`bash scripts/keys-bootstrap.sh\` first.`,
    );
  }
  return readFileSync(path, 'utf-8').trim();
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function validatePubkey(s: string, flag: string): void {
  if (!BASE58_RE.test(s)) {
    throw new Error(`${flag} must be a base58 Solana pubkey (32-44 chars). Got: ${s}`);
  }
}

// ─── Helpers: pre-flight ──────────────────────────────────────────────────

interface PreflightOpts {
  cluster: string;
  rpc: Rpc<SolanaRpcApi>;
  rpcUrl: string;
  deployer: Address;
  skipDeploy: boolean;
}

async function preflightSolBalance(p: PreflightOpts): Promise<void> {
  const balance = await getDeployerBalance(p.rpc, p.deployer);
  const sizes = readSoSizes();
  const estimateSol = estimateDeploySolCost(sizes, p.skipDeploy);
  const balanceSol = Number(balance) / Number(LAMPORTS_PER_SOL);

  console.log(
    `[deploy] balance check: deployer has ${balanceSol.toFixed(3)} SOL; ` +
      `estimated cost ~${estimateSol.toFixed(2)} SOL (deploy + init rent + fees + 20% buffer)`,
  );

  if (balanceSol >= estimateSol) {
    return;
  }

  if (p.cluster === 'surfpool') {
    const top = Math.ceil(estimateSol * 2);
    console.log(`[deploy] surfpool: auto-airdropping ${top} SOL to deployer.`);
    await fundSol({
      cluster: 'surfpool',
      recipient: p.deployer,
      amountSol: top,
      rpcUrl: p.rpcUrl,
    });
    return;
  }

  throw new Error(
    `Deployer ${p.deployer} on ${p.cluster} has ${balanceSol.toFixed(3)} SOL, ` +
      `needs ~${estimateSol.toFixed(2)} SOL. Fund and retry.`,
  );
}

async function getDeployerBalance(
  rpc: Rpc<SolanaRpcApi>,
  pubkey: Address,
): Promise<bigint> {
  const { value } = await rpc.getBalance(pubkey).send();
  return BigInt(value);
}

function readSoSizes(): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const p of PROGRAMS) {
    const path = resolve(TARGET_DEPLOY_DIR, p.soFile);
    sizes[p.name] = existsSync(path) ? statSync(path).size : 0;
  }
  return sizes;
}

function estimateDeploySolCost(
  sizes: Record<string, number>,
  skipDeploy: boolean,
): number {
  // Solana rent: ~6.96 lamports/byte/year × 2 years exemption → ~13.93 lamports/byte.
  // Program account is rent-exempt for the .so size + per-program-data overhead.
  // Empirical: ~10 SOL per ~500KB program. Use 0.0035 SOL/KB as the rule of thumb.
  let total = 0;
  if (!skipDeploy) {
    for (const name of Object.keys(sizes)) {
      total += (sizes[name] / 1024) * 0.0035 * 2; // ×2 for safety (BPFLoaderUpgradeable doubles for buffer)
    }
  }
  // Init phase: ~0.01 SOL per init/wire-up tx + ATA creation rent.
  total += 0.5;
  // 20% buffer.
  return total * 1.2;
}

// ─── Helpers: mainnet typed confirmation ──────────────────────────────────

interface MainnetConfirmOpts {
  deployer: Address;
  owner: Address;
  usdcMint: Address;
}

async function mainnetTypedConfirmation(p: MainnetConfirmOpts): Promise<void> {
  console.log('\n────────────────────────────── MAINNET DEPLOY ──────────────────────────────');
  console.log(`  deployer:  ${p.deployer}`);
  console.log(`  owner:     ${p.owner}`);
  console.log(`  usdc_mint: ${p.usdcMint}`);
  console.log('  programs:');
  for (const prog of PROGRAMS) {
    console.log(`    ${prog.name.padEnd(20)} ${prog.address}`);
  }
  console.log('───────────────────────────────────────────────────────────────────────────');
  console.log("Type 'deploy to mainnet' to proceed (anything else aborts):");
  const rl = createInterface({ input, output });
  const answer = await rl.question('> ');
  rl.close();
  if (answer.trim() !== 'deploy to mainnet') {
    throw new Error('Mainnet confirmation declined; aborting.');
  }
  console.log('[deploy] mainnet confirmed; proceeding.');
}

// ─── Helpers: build ───────────────────────────────────────────────────────

function ensureBuilt(): void {
  const allExist = PROGRAMS.every((p) =>
    existsSync(resolve(TARGET_DEPLOY_DIR, p.soFile)),
  );
  if (!allExist) {
    console.log('[deploy] one or more .so files missing — running anchor build...');
    runShell(`NO_DNA=1 anchor build`, { cwd: CONTRACTS_DIR });
  } else {
    console.log('[deploy] .so files present; skipping anchor build.');
  }
  // Always run sync-idl + gen-clients so the script's typed clients are fresh.
  runShell('bash scripts/sync-idl.sh', { cwd: REPO_ROOT });
  runShell('node --experimental-strip-types scripts/gen-clients.ts', { cwd: REPO_ROOT });
}

// ─── Helpers: ensure mock USDC mint exists ────────────────────────────────

interface EnsureMintOpts {
  cluster: string;
  rpcUrl: string;
  mintPubkey: Address;
  deployerKeypairPath: string;
}

async function ensureMockUsdcMint(p: EnsureMintOpts): Promise<void> {
  const exists = await accountExists(p.rpcUrl, p.mintPubkey);
  if (exists) {
    console.log(`[deploy] mock USDC mint exists at ${p.mintPubkey}; skipping create.`);
    return;
  }
  console.log(`[deploy] mock USDC mint missing on ${p.cluster}; creating via spl-token CLI...`);

  const mintKeypair = resolve(KEYS_DIR, 'mock-usdc.json');
  const mintAuthority = resolve(KEYS_DIR, 'mock-usdc-authority.json');
  if (!existsSync(mintKeypair) || !existsSync(mintAuthority)) {
    throw new Error(
      `Mock USDC keypair files missing in ${KEYS_DIR}.\n` +
        `  Run \`bash scripts/keys-bootstrap.sh\` first.`,
    );
  }

  const splToken = resolve(SOLANA_BIN_DIR, 'spl-token');
  const cmd = [
    `"${splToken}"`,
    'create-token',
    '--decimals', String(USDC_DECIMALS),
    '--url', p.rpcUrl,
    '--fee-payer', `"${p.deployerKeypairPath}"`,
    '--mint-authority', `"${mintAuthority}"`,
    `"${mintKeypair}"`,
  ].join(' ');

  console.log(`[deploy] $ ${cmd}`);
  runShell(cmd);
  console.log(`[deploy] ✓ mock USDC mint created at ${p.mintPubkey}`);
}

// ─── Helpers: program deploy ──────────────────────────────────────────────

interface DeployProgramsOpts {
  cluster: string;
  rpcUrl: string;
  deployerKeypairPath: string;
}

function deployPrograms(p: DeployProgramsOpts): void {
  const network = ANCHOR_NETWORK[p.cluster];
  console.log(`[deploy] deploying ${PROGRAMS.length} programs to ${p.cluster} (anchor network: ${network})...`);
  for (const prog of PROGRAMS) {
    const so = resolve(TARGET_DEPLOY_DIR, prog.soFile);
    const programKeypair = resolve(TARGET_DEPLOY_DIR, `${prog.name}-keypair.json`);
    if (!existsSync(so)) {
      throw new Error(`.so missing: ${so}. Run \`anchor build\` first.`);
    }
    if (!existsSync(programKeypair)) {
      throw new Error(
        `Program keypair missing: ${programKeypair}. Run \`bash scripts/keys-bootstrap.sh\` first.`,
      );
    }
    const solana = resolve(SOLANA_BIN_DIR, 'solana');
    const cmd = [
      `"${solana}"`,
      'program', 'deploy',
      '--url', p.rpcUrl,
      '--keypair', `"${p.deployerKeypairPath}"`,
      '--program-id', `"${programKeypair}"`,
      `"${so}"`,
    ].join(' ');
    console.log(`[deploy] $ ${cmd}`);
    runShell(cmd, { stdio: 'inherit' });
    console.log(`[deploy] ✓ deployed ${prog.name} (${prog.address})`);
  }
}

// ─── Helpers: init + wire ─────────────────────────────────────────────────

interface InitWireOpts {
  rpc: Rpc<SolanaRpcApi>;
  rpcUrl: string;
  deployer: KeyPairSigner;
  owner: Address;
  oracle: Address;
  keeper: Address;
  usdcMint: Address;
}

async function initAndWire(p: InitWireOpts): Promise<void> {
  console.log('[deploy] init phase: governance → vault → oracle → flight_pool → controller');

  // ── 1. Governance ──
  const [governanceConfigPda] = await findGovernanceConfigPda();
  if (await accountExists(p.rpcUrl, governanceConfigPda)) {
    console.log(`[deploy] ✓ governance already initialized (${governanceConfigPda})`);
  } else {
    const ix = await getGovernanceInitializeIxAsync({
      owner: p.deployer,
      defaultPremium: DEFAULT_PREMIUM,
      defaultPayoff: DEFAULT_PAYOFF,
      defaultDelayHours: DEFAULT_DELAY_HOURS,
    });
    await sendIx(p, [ix], 'governance.initialize');
    console.log(`[deploy] ✓ governance initialized at ${governanceConfigPda}`);
  }

  // ── 2. Vault ──
  const [vaultStatePda] = await findVaultStatePda();
  if (await accountExists(p.rpcUrl, vaultStatePda)) {
    console.log(`[deploy] ✓ vault already initialized (${vaultStatePda})`);
  } else {
    const ix = await getVaultInitializeIxAsync({
      owner: p.deployer,
      usdcMint: p.usdcMint,
      usdcMintArg: p.usdcMint,
    });
    await sendIx(p, [ix], 'vault.initialize');
    console.log(`[deploy] ✓ vault initialized at ${vaultStatePda}`);
  }

  // ── 3. Oracle aggregator ──
  const [oracleConfigPda] = await findOracleConfigPda();
  if (await accountExists(p.rpcUrl, oracleConfigPda)) {
    console.log(`[deploy] ✓ oracle_aggregator already initialized (${oracleConfigPda})`);
  } else {
    const ix = await getOracleInitializeIxAsync({
      owner: p.deployer,
      authorizedOracle: p.oracle,
    });
    await sendIx(p, [ix], 'oracle.initialize');
    console.log(`[deploy] ✓ oracle_aggregator initialized at ${oracleConfigPda}`);
  }

  // ── 4. Flight pool ──
  const [flightPoolConfigPda] = await findFlightPoolConfigPda();
  if (await accountExists(p.rpcUrl, flightPoolConfigPda)) {
    console.log(`[deploy] ✓ flight_pool already initialized (${flightPoolConfigPda})`);
  } else {
    const ix = await getFlightPoolInitializeIxAsync({
      owner: p.deployer,
      usdcMint: p.usdcMint,
      usdcMintArg: p.usdcMint,
    });
    await sendIx(p, [ix], 'flight_pool.initialize');
    console.log(`[deploy] ✓ flight_pool initialized at ${flightPoolConfigPda}`);
  }

  // ── 5. Controller ──
  const [controllerConfigPda] = await findControllerConfigPda();
  if (await accountExists(p.rpcUrl, controllerConfigPda)) {
    console.log(`[deploy] ✓ controller already initialized (${controllerConfigPda})`);
  } else {
    const ix = await getControllerInitializeIxAsync({
      owner: p.deployer,
      authorizedKeeper: p.keeper,
      governanceProgram: GOVERNANCE_PROGRAM_ADDRESS,
      vaultProgram: VAULT_PROGRAM_ADDRESS,
      vaultState: vaultStatePda,
      flightPoolProgram: FLIGHT_POOL_PROGRAM_ADDRESS,
      flightPoolConfig: flightPoolConfigPda,
      oracleProgram: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
      oracleConfig: oracleConfigPda,
      usdcMint: p.usdcMint,
      solvencyRatio: SOLVENCY_RATIO,
      minLeadTime: MIN_LEAD_TIME,
      claimExpiryWindow: CLAIM_EXPIRY_WINDOW,
    });
    await sendIx(p, [ix], 'controller.initialize');
    console.log(`[deploy] ✓ controller initialized at ${controllerConfigPda}`);
  }

  console.log('[deploy] wire phase: vault.set_controller, flight_pool.set_controller, oracle.set_authorized_consumer');

  // ── 6. vault.set_controller ──
  const vaultState = await fetchAccount(p.rpc, vaultStatePda, getVaultStateDecoder());
  if (vaultState && vaultState.isControllerSet) {
    console.log(`[deploy] ✓ vault.controller already set (${vaultState.controller})`);
  } else {
    const ix = getVaultSetControllerIx({
      vaultState: vaultStatePda,
      owner: p.deployer,
      controller: controllerConfigPda,
    });
    await sendIx(p, [ix], 'vault.set_controller');
    console.log(`[deploy] ✓ vault.set_controller(${controllerConfigPda})`);
  }

  // ── 7. flight_pool.set_controller ──
  const fpConfig = await fetchAccount(p.rpc, flightPoolConfigPda, getFlightPoolConfigDecoder());
  if (fpConfig && fpConfig.isControllerSet) {
    console.log(`[deploy] ✓ flight_pool.controller already set (${fpConfig.controller})`);
  } else {
    const ix = getFlightPoolSetControllerIx({
      config: flightPoolConfigPda,
      owner: p.deployer,
      controller: controllerConfigPda,
    });
    await sendIx(p, [ix], 'flight_pool.set_controller');
    console.log(`[deploy] ✓ flight_pool.set_controller(${controllerConfigPda})`);
  }

  // ── 8. oracle.set_authorized_consumer ──
  const oracleConfig = await fetchAccount(p.rpc, oracleConfigPda, getOracleConfigDecoder());
  if (oracleConfig && oracleConfig.isConsumerSet) {
    console.log(`[deploy] ✓ oracle.authorized_consumer already set (${oracleConfig.authorizedConsumer})`);
  } else {
    const ix = getOracleSetConsumerIx({
      config: oracleConfigPda,
      owner: p.deployer,
      consumer: controllerConfigPda,
    });
    await sendIx(p, [ix], 'oracle.set_authorized_consumer');
    console.log(`[deploy] ✓ oracle.set_authorized_consumer(${controllerConfigPda})`);
  }
}

async function sendIx(
  p: InitWireOpts,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
  label: string,
): Promise<void> {
  const { value: blockhash } = await p.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(p.deployer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wireTx = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);
  try {
    await p.rpc
      .sendTransaction(wireTx, { encoding: 'base64', preflightCommitment: 'confirmed' })
      .send();
  } catch (err) {
    console.error(`[deploy] ${label} send failed:`, (err as Error).message ?? err);
    throw err;
  }
  await confirmSignature(p.rpc, sig);
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
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (status.err) {
        throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await sleep(500);
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
}

// ─── Helpers: account fetch + decode ──────────────────────────────────────

async function accountExists(rpcUrl: string, pubkey: Address): Promise<boolean> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [pubkey.toString(), { encoding: 'base64' }],
  };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return false;
  const json = (await res.json()) as { result?: { value: unknown } };
  return Boolean(json.result?.value);
}

async function fetchAccount<T>(
  rpc: Rpc<SolanaRpcApi>,
  pubkey: Address,
  decoder: { decode(data: Uint8Array): T },
): Promise<T | null> {
  const { value } = await rpc.getAccountInfo(pubkey, { encoding: 'base64' }).send();
  if (!value) return null;
  const dataB64 = Array.isArray(value.data) ? value.data[0] : (value.data as unknown as string);
  return decoder.decode(Buffer.from(dataB64, 'base64'));
}

// ─── Helpers: verify + emit artifact ──────────────────────────────────────

interface VerifyOpts {
  rpc: Rpc<SolanaRpcApi>;
  cluster: string;
  rpcUrl: string;
  deployer: Address;
  owner: Address;
  oracle: Address;
  keeper: Address;
  usdcMint: Address;
  oraclePath?: string;
  keeperPath?: string;
}

async function verifyAndArtifact(p: VerifyOpts): Promise<string> {
  console.log('[deploy] verify phase: fetching all configs and asserting state...');
  const [governanceConfigPda] = await findGovernanceConfigPda();
  const [vaultStatePda] = await findVaultStatePda();
  const [oracleConfigPda] = await findOracleConfigPda();
  const [flightPoolConfigPda] = await findFlightPoolConfigPda();
  const [controllerConfigPda] = await findControllerConfigPda();
  const [activeFlightListPda] = await findActiveFlightListPda();
  const [shareMintPda] = await findShareMintPda();
  const [withdrawalQueuePda] = await findWithdrawalQueuePda();
  const [poolTreasuryAuthority] = await findTreasuryAuthorityPda();

  const governance = await fetchAccount(p.rpc, governanceConfigPda, getGovernanceConfigDecoder());
  const vaultState = await fetchAccount(p.rpc, vaultStatePda, getVaultStateDecoder());
  const oracleConfig = await fetchAccount(p.rpc, oracleConfigPda, getOracleConfigDecoder());
  const fpConfig = await fetchAccount(p.rpc, flightPoolConfigPda, getFlightPoolConfigDecoder());
  const ctrlConfig = await fetchAccount(p.rpc, controllerConfigPda, getControllerConfigDecoder());

  const checks: [string, boolean][] = [
    ['governance.owner == --owner', governance?.owner === p.owner],
    ['vault.owner == --owner', vaultState?.owner === p.owner],
    ['vault.usdcMint == --usdc', vaultState?.usdcMint === p.usdcMint],
    ['vault.controller == controller_pda', vaultState?.controller === controllerConfigPda],
    ['oracle.owner == --owner', oracleConfig?.owner === p.owner],
    ['oracle.authorizedOracle == --oracle', oracleConfig?.authorizedOracle === p.oracle],
    ['oracle.authorizedConsumer == controller_pda', oracleConfig?.authorizedConsumer === controllerConfigPda],
    ['flight_pool.owner == --owner', fpConfig?.owner === p.owner],
    ['flight_pool.usdcMint == --usdc', fpConfig?.usdcMint === p.usdcMint],
    ['flight_pool.controller == controller_pda', fpConfig?.controller === controllerConfigPda],
    ['controller.owner == --owner', ctrlConfig?.owner === p.owner],
    ['controller.usdcMint == --usdc', ctrlConfig?.usdcMint === p.usdcMint],
    ['controller.authorizedKeeper == --keeper', ctrlConfig?.authorizedKeeper === p.keeper],
  ];

  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) allOk = false;
  }
  if (!allOk) {
    throw new Error('verify phase failed: one or more state assertions failed; see above.');
  }

  // ─── Emit artifact ──
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  const artifact = {
    cluster: p.cluster,
    rpcUrl: p.rpcUrl,
    deployer: p.deployer,
    owner: p.owner,
    authorities: {
      oracle: p.oracle,
      keeper: p.keeper,
    },
    keypairPaths: {
      oracle: p.oraclePath ? p.oraclePath.replace(REPO_ROOT + '/', '') : null,
      keeper: p.keeperPath ? p.keeperPath.replace(REPO_ROOT + '/', '') : null,
    },
    usdcMint: p.usdcMint,
    programs: Object.fromEntries(PROGRAMS.map((p) => [p.name, p.address.toString()])),
    pdas: {
      governanceConfig: governanceConfigPda,
      vaultState: vaultStatePda,
      shareMint: shareMintPda,
      withdrawalQueue: withdrawalQueuePda,
      oracleConfig: oracleConfigPda,
      flightPoolConfig: flightPoolConfigPda,
      poolTreasuryAuthority,
      controllerConfig: controllerConfigPda,
      activeFlightList: activeFlightListPda,
    },
    deployedAt: new Date().toISOString(),
    deployedAtUnix: ts,
  };
  const stampedPath = resolve(DEPLOYMENTS_DIR, `${p.cluster}-${ts}.json`);
  const latestPath = resolve(DEPLOYMENTS_DIR, `${p.cluster}-latest.json`);
  writeFileSync(stampedPath, JSON.stringify(artifact, null, 2) + '\n');
  writeFileSync(latestPath, JSON.stringify(artifact, null, 2) + '\n');
  return stampedPath;
}

// ─── Helpers: shell ───────────────────────────────────────────────────────

function runShell(
  cmd: string,
  opts: { cwd?: string; stdio?: 'pipe' | 'inherit' } = {},
): string {
  const stdio = opts.stdio ?? 'pipe';
  const result = spawnSync('bash', ['-c', cmd], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf-8',
    stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_DNA: '1', PATH: `${SOLANA_BIN_DIR}:${process.env.PATH ?? ''}` },
  });
  if (result.status !== 0) {
    const errOut = (result.stderr ?? '') + '\n' + (result.stdout ?? '');
    throw new Error(`shell command failed (exit ${result.status}): ${cmd}\n${errOut}`);
  }
  return result.stdout ?? '';
}

function solanaKeygen(): string {
  // Prefer PATH lookup; fall back to standard install location.
  try {
    return execSync('command -v solana-keygen', { encoding: 'utf-8' }).trim();
  } catch {
    const standard = resolve(SOLANA_BIN_DIR, 'solana-keygen');
    if (existsSync(standard)) return standard;
    throw new Error('solana-keygen not found in PATH or ~/.local/share/solana/install/active_release/bin/');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Walk up from `start` looking for the workspace-root `package.json`
 * (the one with `name: "sentinel-solana"`). Works whether the script is
 * loaded from source (`scripts/`) or from the esbuild bundle (`scripts/dist/`).
 */
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
  // Fallback: pnpm-script invocations run with cwd == workspace root.
  return process.cwd();
}

// ─── Entry point ─────────────────────────────────────────────────────────

// Bundle-safe isMain check (see fund-sol.ts for rationale).
const isMain = /\/deploy\.(ts|mjs|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  main().catch((err) => {
    console.error('[deploy] failed:', (err as Error).message ?? err);
    process.exit(1);
  });
}
