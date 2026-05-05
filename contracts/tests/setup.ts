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
 *   - advanceClock()        — fast-forward the LiteSVM clock sysvar
 *
 * Phase 1 additions:
 *   - bootstrapGovernance() — initialise the governance program on a fresh
 *                             LiteSVM client and return owner + config PDA
 *   - sendAndDecodeReturnData() — send a tx and decode return-data
 *                             (used by `get_route_terms` /
 *                             `is_route_whitelisted` reader instructions)
 *
 * Phase 2 additions:
 *   - createMockUsdcMint()  — pack `spl_token::Mint` and `setAccount` it at
 *                             the canonical mock-USDC pubkey
 *   - mintMockUsdcTo()      — pack `spl_token::Account` (i.e. an ATA) and
 *                             `setAccount` at ATA(owner, mock-USDC).
 *                             Avoids needing the mint authority's signature.
 *   - bootstrapVault()      — initialise the vault program; return owner +
 *                             vault PDAs
 *   - getTokenAccountAmount() — decode an SPL Account's amount field
 */

import {
  address as kitAddress,
  lamports,
  type Address,
  type Decoder,
  type KeyPairSigner,
} from '@solana/kit';
import { litesvm } from '@solana/kit-plugin-litesvm';
import {
  airdropSigner,
  generatedSigner,
} from '@solana/kit-plugin-signer';
import { createClient } from '@solana/kit';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  getInitializeInstructionAsync,
  findConfigPda,
  GOVERNANCE_PROGRAM_ADDRESS,
} from './clients/governance/src/generated/index.ts';

import {
  getInitializeInstructionAsync as getVaultInitializeInstructionAsync,
  findVaultStatePda,
  findWithdrawalQueuePda,
  findShareMintPda,
  VAULT_PROGRAM_ADDRESS,
} from './clients/vault/src/generated/index.ts';

import {
  getInitializeInstructionAsync as getFlightPoolInitializeInstructionAsync,
  findConfigPda as findFlightPoolConfigPda,
  findTreasuryAuthorityPda,
  FLIGHT_POOL_PROGRAM_ADDRESS,
} from './clients/flight_pool/src/generated/index.ts';

import {
  MintLayout,
  AccountLayout,
  MINT_SIZE,
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  type RawMint,
  type RawAccount,
} from '@solana/spl-token';
import { PublicKey as Web3Pubkey } from '@solana/web3.js';

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
  { name: 'governance',         soFile: 'governance.so',        idStr: '6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT', stateSeed: 'governance_state' },
  { name: 'vault',              soFile: 'vault.so',             idStr: '3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p', stateSeed: 'vault_state' },
  { name: 'flight_pool',        soFile: 'flight_pool.so',       idStr: 'GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq', stateSeed: 'flight_pool_config' },
  { name: 'oracle_aggregator',  soFile: 'oracle_aggregator.so', idStr: 'EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6', stateSeed: 'oracle_config' },
  { name: 'controller',         soFile: 'controller.so',        idStr: 'G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot', stateSeed: 'controller_config' },
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
  // LiteSVM's `Clock` is a napi class, not a plain object — spread loses
  // the inner state. Mutate the bound property directly via the setter,
  // then pass the same instance back to `setClock`.
  const cur = svm.getClock();
  const delta = BigInt(secondsForward);
  cur.unixTimestamp = cur.unixTimestamp + delta;
  svm.setClock(cur);
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

// ─── Governance bootstrap (Phase 1) ───────────────────────────────────────
/**
 * Initialise the governance program against a fresh LiteSVM client. The
 * client's `payer` becomes the governance owner. Returns the locked-in
 * owner signer and config PDA so tests can derive admin / route PDAs and
 * authorise follow-up instructions.
 */
export interface GovernanceBootstrap {
  ownerSigner: KeyPairSigner;
  configPda: Address;
  programAddress: Address;
  defaults: { premium: bigint; payoff: bigint; delayHours: number };
}

export async function bootstrapGovernance(
  client: Awaited<ReturnType<typeof makeClient>>,
  defaults: { premium?: bigint; payoff?: bigint; delayHours?: number } = {},
): Promise<GovernanceBootstrap> {
  const premium = defaults.premium ?? 1_000_000n; // 1 USDC
  const payoff = defaults.payoff ?? 10_000_000n; // 10 USDC
  const delayHours = defaults.delayHours ?? 2;

  const ix = await getInitializeInstructionAsync({
    owner: client.payer,
    defaultPremium: premium,
    defaultPayoff: payoff,
    defaultDelayHours: delayHours,
  });
  await client.sendTransaction([ix]);

  const [configPda] = await findConfigPda();
  return {
    ownerSigner: client.payer,
    configPda,
    programAddress: GOVERNANCE_PROGRAM_ADDRESS,
    defaults: { premium, payoff, delayHours },
  };
}

// ─── Return-data send helper (Phase 1 D3) ────────────────────────────────
/**
 * Send a single instruction in LiteSVM and decode the program's return-data
 * slot using a Kit `Decoder<T>`. Used by Phase 1 reader instructions
 * (`get_route_terms`, `is_route_whitelisted`) which emit data via
 * `set_return_data` for CPI consumers and tests.
 *
 * The LiteSVM transaction plan executor stores the underlying
 * `TransactionMetadata` on `result.context.transactionMetadata`, exposing
 * `returnData()` with `programId()` and `data()` accessors.
 *
 * Throws if the transaction failed, if no return data was set, or if the
 * return program ID does not match `expectedProgram`.
 */
export async function sendAndDecodeReturnData<T>(
  client: Awaited<ReturnType<typeof makeClient>>,
  ix: unknown,
  decoder: Decoder<T>,
  expectedProgram?: Address,
): Promise<T> {
  // Read-only reader instructions (`get_route_terms`,
  // `is_route_whitelisted`) are commonly called with identical args
  // multiple times in a single test. With no other tx in between, the
  // recent-blockhash-derived signature collides and LiteSVM rejects the
  // duplicate as "transaction already processed". Rotate the blockhash
  // before each send so each invocation is a fresh tx.
  client.svm.expireBlockhash();
  const result = await client.sendTransaction([ix as never]);
  // Kit-plugin-litesvm executor populates `transactionMetadata` on the
  // successful single-plan result's context. See
  // node_modules/.../@solana/kit-plugin-litesvm/dist/types/transaction-plan-executor.d.ts.
  const ctx = (
    result as unknown as {
      context: { transactionMetadata: { returnData(): { programId(): Uint8Array; data(): Uint8Array } } };
    }
  ).context;
  const md = ctx.transactionMetadata;
  if (!md || typeof md.returnData !== 'function') {
    throw new Error('sendAndDecodeReturnData: no transactionMetadata on plan result');
  }
  const rd = md.returnData();
  const data = rd.data();
  if (data.length === 0) {
    throw new Error('sendAndDecodeReturnData: program emitted no return data');
  }
  if (expectedProgram) {
    const ridBytes = rd.programId();
    // Compare base58 form via Kit address; the bytes-to-address adapter is
    // not exported on this Kit version, so compare against the expected
    // program's raw bytes via `Buffer`-free conversion.
    const expectedBase58 = expectedProgram.toString();
    const ridBase58 = base58FromBytes(ridBytes);
    if (ridBase58 !== expectedBase58) {
      throw new Error(
        `sendAndDecodeReturnData: return data from ${ridBase58}, expected ${expectedBase58}`,
      );
    }
  }
  return decoder.decode(data);
}

// Tiny base58 encoder (no external dep) — only used for diagnostics in the
// helper above. Solana addresses are 32-byte base58 values.
function base58FromBytes(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  // Convert to big-int base 58 (small inputs — 32 bytes).
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    out = ALPHABET[r] + out;
  }
  return '1'.repeat(leadingZeros) + out;
}

// ─── SPL Token mocking (Phase 2 D9) ───────────────────────────────────────
//
// Helper alias — Kit-LiteSVM client. `client.svm` is the actual `LiteSVM`
// instance which exposes `setAccount(EncodedAccount)` /
// `getAccount(Address): MaybeEncodedAccount`. Use this type so the helpers
// downstream get the correct branded shapes.
type Client = AnyLiteSvmClient;
type AnyLiteSvmClient = Awaited<ReturnType<typeof makeClient>>;

const TOKEN_PROGRAM_ID_KIT: Address = kitAddress(TOKEN_PROGRAM_ID.toBase58());

/**
 * Lamports for rent exemption of an SPL Token Mint (82 bytes). Matches
 * `Rent::default().minimum_balance(82)` — slightly over-funded vs the
 * runtime calculation, which is fine for in-memory LiteSVM tests.
 */
const MINT_RENT_LAMPORTS = lamports(1_461_600n);
const TOKEN_ACCOUNT_RENT_LAMPORTS = lamports(2_039_280n);

/**
 * Pack an SPL Token Mint state and write it directly to the canonical
 * mock-USDC mint pubkey (`keys/mock-usdc.pubkey`). Bypasses any actual
 * `initialize_mint` CPI — LiteSVM doesn't care about provenance. The mint
 * is configured with 6 decimals (matching real USDC) and the canonical
 * authority from `keys/mock-usdc-authority.pubkey`.
 */
export function createMockUsdcMint(
  client: Client,
): { mint: Address; authority: Address } {
  const { mint, authority } = readMockUsdcAddresses();

  const buf = Buffer.alloc(MINT_SIZE);
  const raw: RawMint = {
    mintAuthorityOption: 1,
    mintAuthority: new Web3Pubkey(authority.toString()),
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: Web3Pubkey.default,
  };
  MintLayout.encode(raw, buf);

  client.svm.setAccount({
    address: mint,
    executable: false,
    lamports: MINT_RENT_LAMPORTS,
    programAddress: TOKEN_PROGRAM_ID_KIT,
    space: BigInt(MINT_SIZE),
    data: new Uint8Array(buf),
  });

  return { mint, authority };
}

/**
 * Pack an SPL Token Account at the ATA(owner, mint) address with the
 * given amount. Bypasses the `MintTo` CPI (which would need the mint
 * authority's keypair). Used to fund test wallets with mock USDC and to
 * pre-create share-mint ATAs.
 */
export function setTokenAccount(
  client: Client,
  args: { mint: Address; owner: Address; amount: bigint },
): { ata: Address } {
  const ataLegacy = getAssociatedTokenAddressSync(
    new Web3Pubkey(args.mint.toString()),
    new Web3Pubkey(args.owner.toString()),
    true, // allowOwnerOffCurve — vault_state is a PDA, off-curve
  );
  const ata: Address = kitAddress(ataLegacy.toBase58());

  const buf = Buffer.alloc(ACCOUNT_SIZE);
  const raw: RawAccount = {
    mint: new Web3Pubkey(args.mint.toString()),
    owner: new Web3Pubkey(args.owner.toString()),
    amount: args.amount,
    delegateOption: 0,
    delegate: Web3Pubkey.default,
    state: 1, // Initialized
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: Web3Pubkey.default,
  };
  AccountLayout.encode(raw, buf);

  client.svm.setAccount({
    address: ata,
    executable: false,
    lamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
    programAddress: TOKEN_PROGRAM_ID_KIT,
    space: BigInt(ACCOUNT_SIZE),
    data: new Uint8Array(buf),
  });

  return { ata };
}

/** Convenience wrapper — fund an owner's mock-USDC ATA. */
export function mintMockUsdcTo(
  client: Client,
  owner: Address,
  amount: bigint,
): { ata: Address } {
  const { mint } = readMockUsdcAddresses();
  return setTokenAccount(client, { mint, owner, amount });
}

/**
 * Decode a packed SPL Token Account's `amount` field by pubkey. Returns
 * `null` if the account doesn't exist or has no data. Used by tests to
 * assert post-condition USDC / share balances.
 */
export function getTokenAccountAmount(
  client: Client,
  ata: Address,
): bigint | null {
  const acc = client.svm.getAccount(ata);
  if (!acc.exists) return null;
  const data = acc.data;
  if (data.length < ACCOUNT_SIZE) return null;
  const decoded = AccountLayout.decode(Buffer.from(data.subarray(0, ACCOUNT_SIZE)));
  return decoded.amount;
}

/** Derive the ATA address for `(mint, owner)` without writing it. */
export function getAtaAddress(mint: Address, owner: Address): Address {
  const ataLegacy = getAssociatedTokenAddressSync(
    new Web3Pubkey(mint.toString()),
    new Web3Pubkey(owner.toString()),
    true, // allow off-curve owners (PDAs)
  );
  return kitAddress(ataLegacy.toBase58());
}

// ─── Vault bootstrap (Phase 2) ────────────────────────────────────────────

export interface VaultBootstrap {
  ownerSigner: KeyPairSigner;
  vaultStatePda: Address;
  withdrawalQueuePda: Address;
  shareMintPda: Address;
  vaultTokenAccount: Address;
  usdcMint: Address;
}

/**
 * Initialise the vault program. The mock USDC mint must already exist
 * at `keys/mock-usdc.pubkey` (call `createMockUsdcMint` first).
 */
export async function bootstrapVault(
  client: Awaited<ReturnType<typeof makeClient>>,
): Promise<VaultBootstrap> {
  const { mint: usdcMint } = readMockUsdcAddresses();

  const ix = await getVaultInitializeInstructionAsync({
    owner: client.payer,
    usdcMint,
    usdcMintArg: usdcMint,
  });
  await client.sendTransaction([ix]);

  const [vaultStatePda] = await findVaultStatePda();
  const [withdrawalQueuePda] = await findWithdrawalQueuePda();
  const [shareMintPda] = await findShareMintPda();
  const vaultTokenAccount = getAtaAddress(usdcMint, vaultStatePda);

  return {
    ownerSigner: client.payer,
    vaultStatePda,
    withdrawalQueuePda,
    shareMintPda,
    vaultTokenAccount,
    usdcMint,
  };
}

/** Re-export for tests that need it. */
export { VAULT_PROGRAM_ADDRESS };

// ─── Flight pool bootstrap (Phase 3) ──────────────────────────────────────

export interface FlightPoolBootstrap {
  ownerSigner: KeyPairSigner;
  configPda: Address;
  treasuryAuthorityPda: Address;
  treasuryAta: Address;
  usdcMint: Address;
}

/**
 * Initialise the flight_pool program. The mock USDC mint must already exist
 * at `keys/mock-usdc.pubkey` (call `createMockUsdcMint` first).
 */
export async function bootstrapFlightPool(
  client: Awaited<ReturnType<typeof makeClient>>,
): Promise<FlightPoolBootstrap> {
  const { mint: usdcMint } = readMockUsdcAddresses();

  const ix = await getFlightPoolInitializeInstructionAsync({
    owner: client.payer,
    usdcMint,
    usdcMintArg: usdcMint,
  });
  await client.sendTransaction([ix]);

  const [configPda] = await findFlightPoolConfigPda();
  const [treasuryAuthorityPda] = await findTreasuryAuthorityPda();
  const treasuryAta = getAtaAddress(usdcMint, treasuryAuthorityPda);

  return {
    ownerSigner: client.payer,
    configPda,
    treasuryAuthorityPda,
    treasuryAta,
    usdcMint,
  };
}

/** Re-export for tests that need it. */
export { FLIGHT_POOL_PROGRAM_ADDRESS };
