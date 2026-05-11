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
 *   - createMockPusdMint()  — pack `spl_token::Mint` and `setAccount` it at
 *                             the canonical mock-USDC pubkey
 *   - mintMockPusdTo()      — pack `spl_token::Account` (i.e. an ATA) and
 *                             `setAccount` at ATA(owner, mock-USDC).
 *                             Avoids needing the mint authority's signature.
 *   - bootstrapVault()      — initialise the vault program; return owner +
 *                             vault PDAs
 *   - getTokenAccountAmount() — decode an SPL Account's amount field
 */

import {
  AccountRole,
  address as kitAddress,
  generateKeyPairSigner,
  lamports,
  type Address,
  type Decoder,
  type Instruction,
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
  getInitializeInstructionAsync as getOracleInitializeInstructionAsync,
  getSetAuthorizedConsumerInstruction,
  findConfigPda as findOracleConfigPda,
  findFlightDataPda,
  getSetEstimatedArrivalInstructionAsync,
  getSetLandedInstructionAsync,
  getSetCancelledInstructionAsync,
  ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
} from './clients/oracle_aggregator/src/generated/index.ts';

import { findPoolPda } from './clients/flight_pool/src/generated/index.ts';
import {
  findSnapshotRecordPda,
  getDepositInstructionAsync,
} from './clients/vault/src/generated/index.ts';
import { getWhitelistRouteInstructionAsync } from './clients/governance/src/generated/index.ts';

import { getSetControllerInstruction as getVaultSetControllerInstruction } from './clients/vault/src/generated/index.ts';
import { getSetControllerInstruction as getFlightPoolSetControllerInstruction } from './clients/flight_pool/src/generated/index.ts';

import {
  getInitializeInstructionAsync as getControllerInitializeInstructionAsync,
  getClassifyFlightsInstructionAsync,
  getExecuteSettlementsInstructionAsync,
  findControllerConfigPda,
  findActiveFlightListPda,
  CONTROLLER_PROGRAM_ADDRESS,
} from './clients/controller/src/generated/index.ts';

import {
  MintLayout,
  AccountLayout,
  MINT_SIZE,
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
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

  // Load the standard SPL programs (SPL Token, Token-2022, Associated Token,
  // Memo). `new LiteSVM()` does not include Token-2022 by default — without
  // this call, any Token-2022 CPI fails at the runtime with "missing
  // account" (the program account itself isn't in the SVM). PUSD is a
  // Token-2022 mint, so the vault/flight_pool ATAs require Token-2022 to
  // be loaded. D-Phase24-Litesvm.
  client.svm.withDefaultPrograms();

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
export function readMockPusdAddresses(): { mint: Address; authority: Address } {
  return {
    mint:      kitAddress(readPubkey(resolve(KEYS_DIR, 'mock-pusd.pubkey'))),
    authority: kitAddress(readPubkey(resolve(KEYS_DIR, 'mock-pusd-authority.pubkey'))),
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

/**
 * Classic SPL Token program. Used for the vault's RVS share mint, which is
 * not migrated to Token-2022 (D24-2: no extension benefit, we own the mint).
 */
const TOKEN_PROGRAM_ID_KIT: Address = kitAddress(TOKEN_PROGRAM_ID.toBase58());

/**
 * Token-2022 program. The mock PUSD mint is packed at this program id so
 * Anchor's `InterfaceAccount<Mint>` deserialiser routes through the
 * Token-2022 runtime — matching real PUSD's posture on mainnet
 * (`CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`, owner `TokenzQd...`).
 *
 * Exported so tests can reference it directly (every `getDeposit*` /
 * `getRedeem*` / `getCollect*` / `getSendPayout*` / `getBuyInsurance*` /
 * `getExecuteSettlements*` ix call needs to pass it as `stableTokenProgram`).
 */
export const TOKEN_2022_PROGRAM_ID_KIT: Address = kitAddress(
  TOKEN_2022_PROGRAM_ID.toBase58(),
);

/**
 * Lamports for rent exemption of an SPL Token Mint (82 bytes). Matches
 * `Rent::default().minimum_balance(82)` — slightly over-funded vs the
 * runtime calculation, which is fine for in-memory LiteSVM tests.
 */
const MINT_RENT_LAMPORTS = lamports(1_461_600n);
const TOKEN_ACCOUNT_RENT_LAMPORTS = lamports(2_039_280n);

/**
 * Pack a Token-2022 Mint state at the canonical mock-PUSD mint pubkey
 * (`keys/mock-pusd.pubkey`). The 82-byte base-mint layout is identical
 * for classic SPL and Token-2022 — what makes it Token-2022 is the
 * account owner program. We omit MetadataPointer + TokenMetadata extension
 * TLV data here since they're inert for transfer flows (no CPI hooks); the
 * Surfpool harness can clone the real-mainnet PUSD bytes if extension
 * fidelity is required (Phase 24 §E3).
 *
 * Mint: 6 decimals (matches PUSD), no freeze authority (matches PUSD which
 * has freeze authority unset on mainnet).
 */
export function createMockPusdMint(
  client: Client,
): { mint: Address; authority: Address } {
  const { mint, authority } = readMockPusdAddresses();

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
    programAddress: TOKEN_2022_PROGRAM_ID_KIT,
    space: BigInt(MINT_SIZE),
    data: new Uint8Array(buf),
  });

  return { mint, authority };
}

/**
 * Pack an SPL Token Account at the ATA(owner, mint) address with the
 * given amount. Bypasses the `MintTo` CPI (which would need the mint
 * authority's keypair). Used to fund test wallets with mock PUSD and to
 * pre-create share-mint ATAs.
 *
 * `tokenProgram` defaults to classic SPL (correct for the RVS share mint).
 * Pass `TOKEN_2022_PROGRAM_ID_KIT` when packing a PUSD ATA so the ATA
 * address derivation matches Anchor's `associated_token::token_program`
 * routing.
 */
export function setTokenAccount(
  client: Client,
  args: { mint: Address; owner: Address; amount: bigint; tokenProgram?: Address },
): { ata: Address } {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID_KIT;
  const tokenProgramLegacy =
    tokenProgram === TOKEN_2022_PROGRAM_ID_KIT
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
  const ataLegacy = getAssociatedTokenAddressSync(
    new Web3Pubkey(args.mint.toString()),
    new Web3Pubkey(args.owner.toString()),
    true, // allowOwnerOffCurve — vault_state is a PDA, off-curve
    tokenProgramLegacy,
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
    programAddress: tokenProgram,
    space: BigInt(ACCOUNT_SIZE),
    data: new Uint8Array(buf),
  });

  return { ata };
}

/** Convenience wrapper — fund an owner's mock-PUSD ATA (Token-2022). */
export function mintMockPusdTo(
  client: Client,
  owner: Address,
  amount: bigint,
): { ata: Address } {
  const { mint } = readMockPusdAddresses();
  return setTokenAccount(client, {
    mint,
    owner,
    amount,
    tokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
  });
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

/**
 * Derive the ATA address for `(mint, owner)` without writing it.
 * `tokenProgram` defaults to classic SPL — pass `TOKEN_2022_PROGRAM_ID_KIT`
 * for PUSD ATAs so the derivation matches Anchor's runtime.
 */
export function getAtaAddress(
  mint: Address,
  owner: Address,
  tokenProgram?: Address,
): Address {
  const tokenProgramLegacy =
    tokenProgram === TOKEN_2022_PROGRAM_ID_KIT
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
  const ataLegacy = getAssociatedTokenAddressSync(
    new Web3Pubkey(mint.toString()),
    new Web3Pubkey(owner.toString()),
    true, // allow off-curve owners (PDAs)
    tokenProgramLegacy,
  );
  return kitAddress(ataLegacy.toBase58());
}

/** Convenience: derive a PUSD ATA for a given owner. */
export function getPusdAta(owner: Address): Address {
  const { mint } = readMockPusdAddresses();
  return getAtaAddress(mint, owner, TOKEN_2022_PROGRAM_ID_KIT);
}

// ─── Vault bootstrap (Phase 2) ────────────────────────────────────────────

export interface VaultBootstrap {
  ownerSigner: KeyPairSigner;
  vaultStatePda: Address;
  withdrawalQueuePda: Address;
  shareMintPda: Address;
  vaultTokenAccount: Address;
  stableMint: Address;
}

/**
 * Initialise the vault program. The mock PUSD mint (Token-2022) must
 * already exist at `keys/mock-pusd.pubkey` (call `createMockPusdMint`
 * first). The vault holds two token programs:
 *  - `tokenProgram` (classic SPL, default): for the RVS share mint
 *    `MintTo`/`Burn` CPIs.
 *  - `stableTokenProgram` (Token-2022 here): for the stable-coin ATA init
 *    and `transfer_checked` CPIs.
 */
export async function bootstrapVault(
  client: Awaited<ReturnType<typeof makeClient>>,
): Promise<VaultBootstrap> {
  const { mint: stableMint } = readMockPusdAddresses();

  const ix = await getVaultInitializeInstructionAsync({
    owner: client.payer,
    stableMint,
    stableMintArg: stableMint,
    stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
  });
  await client.sendTransaction([ix]);

  const [vaultStatePda] = await findVaultStatePda();
  const [withdrawalQueuePda] = await findWithdrawalQueuePda();
  const [shareMintPda] = await findShareMintPda();
  // Vault's stable ATA is owned by Token-2022 (per `stableTokenProgram` arg
  // passed to initialize), so derive against Token-2022 program seed too.
  const vaultTokenAccount = getAtaAddress(
    stableMint,
    vaultStatePda,
    TOKEN_2022_PROGRAM_ID_KIT,
  );

  return {
    ownerSigner: client.payer,
    vaultStatePda,
    withdrawalQueuePda,
    shareMintPda,
    vaultTokenAccount,
    stableMint,
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
  programAddress: Address;
  stableMint: Address;
}

/**
 * Initialise the flight_pool program. The mock USDC mint must already exist
 * at `keys/mock-pusd.pubkey` (call `createMockPusdMint` first).
 */
export async function bootstrapFlightPool(
  client: Awaited<ReturnType<typeof makeClient>>,
): Promise<FlightPoolBootstrap> {
  const { mint: stableMint } = readMockPusdAddresses();

  const ix = await getFlightPoolInitializeInstructionAsync({
    owner: client.payer,
    stableMint,
    stableMintArg: stableMint,
    // flight_pool uses `Interface<TokenInterface>` as its single token
    // program — must explicitly pass Token-2022 (the Codama default of
    // classic SPL would mis-route the pool treasury ATA init).
    tokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
  });
  await client.sendTransaction([ix]);

  const [configPda] = await findFlightPoolConfigPda();
  const [treasuryAuthorityPda] = await findTreasuryAuthorityPda();
  const treasuryAta = getAtaAddress(
    stableMint,
    treasuryAuthorityPda,
    TOKEN_2022_PROGRAM_ID_KIT,
  );

  return {
    ownerSigner: client.payer,
    configPda,
    treasuryAuthorityPda,
    treasuryAta,
    programAddress: FLIGHT_POOL_PROGRAM_ADDRESS,
    stableMint,
  };
}

/** Re-export for tests that need it. */
export { FLIGHT_POOL_PROGRAM_ADDRESS };

// ─── Oracle aggregator bootstrap (Phase 4) ────────────────────────────────

export interface OracleBootstrap {
  ownerSigner: KeyPairSigner;
  oracleSigner: KeyPairSigner;
  configPda: Address;
  programAddress: Address;
}

/**
 * Initialise the oracle_aggregator program. Generates a fresh keypair as
 * the initial `authorized_oracle`. The owner is the client's payer; the
 * `authorized_consumer` is left at the `Pubkey::default()` sentinel until
 * tests wire it via `set_authorized_consumer` (Phase 5 wires the real
 * controller PDA).
 */
export async function bootstrapOracleAggregator(
  client: Awaited<ReturnType<typeof makeClient>>,
): Promise<OracleBootstrap> {
  const oracleSigner = await generateKeyPairSigner();

  const ix = await getOracleInitializeInstructionAsync({
    owner: client.payer,
    authorizedOracle: oracleSigner.address,
  });
  await client.sendTransaction([ix]);

  const [configPda] = await findOracleConfigPda();

  return {
    ownerSigner: client.payer,
    oracleSigner,
    configPda,
    programAddress: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
  };
}

/** Re-export for tests that need it. */
export { ORACLE_AGGREGATOR_PROGRAM_ADDRESS };

// ─── Controller full-system bring-up (Phase 5) ────────────────────────────

export interface ControllerBootstrap {
  ownerSigner: KeyPairSigner;
  keeperSigner: KeyPairSigner;
  controllerConfigPda: Address;
  activeFlightListPda: Address;
  programAddress: Address;
  // Sub-bootstraps (forwarded for test convenience).
  governanceConfigPda: Address;
  vault: VaultBootstrap;
  flightPool: FlightPoolBootstrap;
  oracle: OracleBootstrap;
  stableMint: Address;
}

/**
 * The Phase 5 full-system bring-up. Bootstraps all four prior programs,
 * initialises the controller, then wires the controller PDA as the
 * authority on vault / flight_pool / oracle. After this returns, the
 * five-program system is fully integrated and ready for `buy_insurance`,
 * `classify_flights`, `execute_settlements` flows.
 *
 * Tunables default to architecture-spec values:
 *   - solvencyRatio: 100 (fully collateralised)
 *   - minLeadTime: 3600 (1 hour before departure)
 *   - claimExpiryWindow: 5_184_000 (60 days)
 */
export async function bootstrapController(
  client: Awaited<ReturnType<typeof makeClient>>,
  overrides: { solvencyRatio?: number; minLeadTime?: bigint; claimExpiryWindow?: bigint } = {},
): Promise<ControllerBootstrap> {
  // Step 1: mock USDC mint + governance + vault + flight_pool + oracle.
  createMockPusdMint(client);
  await bootstrapGovernance(client);
  const vault = await bootstrapVault(client);
  const flightPool = await bootstrapFlightPool(client);
  const oracle = await bootstrapOracleAggregator(client);

  const [governanceConfigPda] = await findConfigPda();
  const [controllerConfigPda] = await findControllerConfigPda();
  const [activeFlightListPda] = await findActiveFlightListPda();

  const keeperSigner = await generateKeyPairSigner();
  // Keeper pays rent for SnapshotRecord PDAs each `execute_settlements`
  // call (vault.snapshot uses init_if_needed → system_program::create_account
  // when the day's record doesn't yet exist). Airdrop SOL so the keeper
  // can cover this. Phase 5 didn't need this because tests only hit
  // execute_settlements via the auth-fail revert path.
  await client.airdrop(keeperSigner.address, lamports(2_000_000_000n));

  // Step 2: controller.initialize.
  const initIx = await getControllerInitializeInstructionAsync({
    owner: client.payer,
    authorizedKeeper: keeperSigner.address,
    governanceProgram: GOVERNANCE_PROGRAM_ADDRESS,
    vaultProgram: VAULT_PROGRAM_ADDRESS,
    vaultState: vault.vaultStatePda,
    flightPoolProgram: FLIGHT_POOL_PROGRAM_ADDRESS,
    flightPoolConfig: flightPool.configPda,
    oracleProgram: ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
    oracleConfig: oracle.configPda,
    stableMint: vault.stableMint,
    solvencyRatio: overrides.solvencyRatio ?? 100,
    minLeadTime: overrides.minLeadTime ?? 3_600n,
    claimExpiryWindow: overrides.claimExpiryWindow ?? 5_184_000n,
  });
  await client.sendTransaction([initIx]);

  // Step 3: wire vault.set_controller / flight_pool.set_controller /
  //         oracle.set_authorized_consumer to the controller PDA. All three
  //         are owner-only on their respective programs; client.payer is the
  //         shared owner across all four programs in unit tests.
  await client.sendTransaction([
    getVaultSetControllerInstruction({
      vaultState: vault.vaultStatePda,
      owner: client.payer,
      controller: controllerConfigPda,
    }),
  ]);
  await client.sendTransaction([
    getFlightPoolSetControllerInstruction({
      config: flightPool.configPda,
      owner: client.payer,
      controller: controllerConfigPda,
    }),
  ]);
  await client.sendTransaction([
    getSetAuthorizedConsumerInstruction({
      config: oracle.configPda,
      owner: client.payer,
      consumer: controllerConfigPda,
    }),
  ]);

  return {
    ownerSigner: client.payer,
    keeperSigner,
    controllerConfigPda,
    activeFlightListPda,
    programAddress: CONTROLLER_PROGRAM_ADDRESS,
    governanceConfigPda,
    vault,
    flightPool,
    oracle,
    stableMint: vault.stableMint,
  };
}

/** Re-export for tests that need it. */
export { CONTROLLER_PROGRAM_ADDRESS };

// ─── Compute-budget helper (Phase 5 D20, promoted in Phase 6 B10) ────────
//
// Hand-rolled SetComputeUnitLimit instruction. Avoids adding
// `@solana-program/compute-budget` as a new dep. Buy_insurance chains 6
// CPIs and execute_settlements chains up to ~9 CPIs per call — both blow
// past the default 200K CU.
const COMPUTE_BUDGET_PROGRAM_ID: Address = kitAddress(
  'ComputeBudget111111111111111111111111111111',
);

export function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 0x02; // SetComputeUnitLimit discriminator
  new DataView(data.buffer).setUint32(1, units, true); // u32 LE
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ID,
    accounts: [],
    data,
  };
}

// ─── SPL Token program address (used as `token_program` arg in CPIs) ─────
export const TOKEN_PROGRAM_ADDRESS_KIT: Address = kitAddress(
  TOKEN_PROGRAM_ID.toBase58(),
);

// ─── Full-protocol bring-up (Phase 6 B11) ────────────────────────────────
//
// Thin wrapper over `bootstrapController` that additionally provisions a
// funded underwriter signer (with a USDC ATA + share-mint ATA pre-seeded)
// and a funded traveler signer (with a USDC ATA pre-seeded). The signers
// inherit the keeper / oracle from the underlying bootstrap.
//
// All three crons are simulated by direct in-test ix calls (see
// `simulateOracle`, `simulateClassifier`, `simulateSettler` below).

export interface FullProtocolBootstrap extends ControllerBootstrap {
  underwriter: KeyPairSigner;
  /** Initial USDC the underwriter holds (defaults to 10,000 USDC). */
  underwriterInitialPusd: bigint;
  underwriterStableAta: Address;
  underwriterShareAta: Address;
  /** Computed PDA: [b"claimable", underwriter]. */
  underwriterClaimablePda: Address;
}

export async function bootstrapFullProtocol(
  client: Awaited<ReturnType<typeof makeClient>>,
  overrides: {
    solvencyRatio?: number;
    minLeadTime?: bigint;
    claimExpiryWindow?: bigint;
    underwriterInitialPusd?: bigint;
  } = {},
): Promise<FullProtocolBootstrap> {
  const ctrl = await bootstrapController(client, overrides);

  // Provision underwriter with mock USDC + share-mint ATA. Generated
  // outside of `bootstrapController` because the spec for "underwriter"
  // is test-data, not part of program initialization.
  const underwriter = await generateKeyPairSigner();
  await client.airdrop(underwriter.address, lamports(2_000_000_000n));

  const underwriterInitialPusd =
    overrides.underwriterInitialPusd ?? 10_000_000_000n; // 10,000 USDC
  const { ata: underwriterStableAta } = mintMockPusdTo(
    client,
    underwriter.address,
    underwriterInitialPusd,
  );
  const { ata: underwriterShareAta } = setTokenAccount(client, {
    mint: ctrl.vault.shareMintPda,
    owner: underwriter.address,
    amount: 0n,
  });

  // ClaimableBalance PDA the vault will create on `request_withdrawal`.
  // Encoded directly (no Codama PDA helper for this seed pair).
  const underwriterClaimablePda = await findClaimablePdaForOwner(
    underwriter.address,
  );

  return {
    ...ctrl,
    underwriter,
    underwriterInitialPusd,
    underwriterStableAta,
    underwriterShareAta,
    underwriterClaimablePda,
  };
}

/**
 * Vault's `[b"claimable", owner]` PDA address. Anchor uses this PDA as the
 * per-underwriter pending-withdrawal record. We derive client-side using
 * `findProgramAddressSync` since Codama doesn't auto-generate a PDA helper
 * for this seed pair.
 */
async function findClaimablePdaForOwner(owner: Address): Promise<Address> {
  // Lazy-import to avoid pulling web3.js into every consumer of setup.ts.
  const { PublicKey } = await import('@solana/web3.js');
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('claimable'), new PublicKey(owner.toString()).toBuffer()],
    new PublicKey(VAULT_PROGRAM_ADDRESS.toString()),
  );
  return kitAddress(pda.toBase58());
}

// ─── Cron simulators (Phase 6 B12) ───────────────────────────────────────
//
// In production these instructions are issued by the three off-chain crons
// (FlightDataFetcher / FlightClassifier / SettlementExecutor). For tests
// the helpers below stand in: same instruction shape, signed in-process.

export const simulateOracle = {
  /**
   * Sign as `authorized_oracle` (the oracle key from `bootstrapOracleAggregator`)
   * and write the estimated arrival time. NotInitiated → Active.
   */
  async setEstimatedArrival(
    client: Awaited<ReturnType<typeof makeClient>>,
    oracleSigner: KeyPairSigner,
    flightId: string,
    date: bigint,
    eta: bigint,
  ): Promise<void> {
    const [flightDataPda] = await findFlightDataPda({ flightId, date });
    await client.sendTransaction([
      await getSetEstimatedArrivalInstructionAsync({
        flightData: flightDataPda,
        authority: oracleSigner,
        flightId,
        date,
        eta,
      }),
    ]);
  },

  /** Active → Landed. */
  async setLanded(
    client: Awaited<ReturnType<typeof makeClient>>,
    oracleSigner: KeyPairSigner,
    flightId: string,
    date: bigint,
    actualArrival: bigint,
  ): Promise<void> {
    const [flightDataPda] = await findFlightDataPda({ flightId, date });
    await client.sendTransaction([
      await getSetLandedInstructionAsync({
        flightData: flightDataPda,
        authority: oracleSigner,
        flightId,
        date,
        actualArrival,
      }),
    ]);
  },

  /** Active → Cancelled. */
  async setCancelled(
    client: Awaited<ReturnType<typeof makeClient>>,
    oracleSigner: KeyPairSigner,
    flightId: string,
    date: bigint,
  ): Promise<void> {
    const [flightDataPda] = await findFlightDataPda({ flightId, date });
    await client.sendTransaction([
      await getSetCancelledInstructionAsync({
        flightData: flightDataPda,
        authority: oracleSigner,
        flightId,
        date,
      }),
    ]);
  },
};

/**
 * Sign as `authorized_keeper` and call `controller.classify_flights` with
 * the supplied per-flight (FlightData, FlightPool) pairs as remaining_accounts.
 *
 * The keeper cron's job: for each Landed/Cancelled flight in the active
 * list, drive the ToBeSettled* transition via CPI to oracle.
 */
export async function simulateClassifier(
  client: Awaited<ReturnType<typeof makeClient>>,
  ctrl: ControllerBootstrap,
  flights: { flightId: string; date: bigint }[],
): Promise<void> {
  if (flights.length === 0) return;

  const baseIx = await getClassifyFlightsInstructionAsync({
    oracleProgram: ctrl.oracle.programAddress,
    oracleConfig: ctrl.oracle.configPda,
    keeper: ctrl.keeperSigner,
  });

  // Append (FlightData, FlightPool) pairs to remaining_accounts.
  const extraAccounts: { address: Address; role: AccountRole }[] = [];
  for (const f of flights) {
    const [fdPda] = await findFlightDataPda({ flightId: f.flightId, date: f.date });
    const [poolPda] = await findPoolPda({ flightId: f.flightId, date: f.date });
    // FlightData is mutated by oracle.set_to_be_settled (writable);
    // FlightPool is read-only here (controller only reads delay_hours).
    extraAccounts.push({ address: fdPda, role: AccountRole.WRITABLE });
    extraAccounts.push({ address: poolPda, role: AccountRole.READONLY });
  }

  const ix: Instruction = {
    ...baseIx,
    accounts: [...baseIx.accounts, ...extraAccounts],
  };
  await client.sendTransaction([setComputeUnitLimitIx(1_400_000), ix]);
}

/**
 * Sign as `authorized_keeper` and call `controller.execute_settlements`.
 *
 * @param flights      per-flight tuples to settle
 * @param claimables   ClaimableBalance PDAs for vault.process_withdrawal_queue
 *                     (in queue order; pass [] if none queued)
 * @param day          current day index (`unix_timestamp / 86_400`)
 *
 * Internally prepends `setComputeUnitLimitIx(1_400_000)` so a 2-flight
 * batch fits under the per-tx CU cap.
 */
export async function simulateSettler(
  client: Awaited<ReturnType<typeof makeClient>>,
  ctrl: ControllerBootstrap,
  args: {
    flights: { flightId: string; date: bigint }[];
    claimables?: Address[];
    day: bigint;
  },
): Promise<void> {
  const { flights, claimables = [], day } = args;
  const [snapshotRecordPda] = await findSnapshotRecordPda({ day });

  const baseIx = await getExecuteSettlementsInstructionAsync({
    vaultProgram: VAULT_PROGRAM_ADDRESS,
    flightPoolProgram: ctrl.flightPool.programAddress,
    oracleProgram: ctrl.oracle.programAddress,
    flightPoolConfig: ctrl.flightPool.configPda,
    oracleConfig: ctrl.oracle.configPda,
    vaultState: ctrl.vault.vaultStatePda,
    vaultTokenAccount: ctrl.vault.vaultTokenAccount,
    withdrawalQueue: ctrl.vault.withdrawalQueuePda,
    shareMint: ctrl.vault.shareMintPda,
    snapshotRecord: snapshotRecordPda,
    poolTreasury: ctrl.flightPool.treasuryAta,
    treasuryAuthority: ctrl.flightPool.treasuryAuthorityPda,
    stableMint: ctrl.vault.stableMint,
    keeper: ctrl.keeperSigner,
    stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
    day,
    nFlights: flights.length,
  });

  // remaining_accounts layout (controller's SCHEMA):
  //   [0..n_flights*2]: per-flight (flight_data writable, flight_pool writable)
  //   [n_flights*2..]:  ClaimableBalance writables (vault.process_withdrawal_queue)
  const extraAccounts: { address: Address; role: AccountRole }[] = [];
  for (const f of flights) {
    const [fdPda] = await findFlightDataPda({ flightId: f.flightId, date: f.date });
    const [poolPda] = await findPoolPda({ flightId: f.flightId, date: f.date });
    extraAccounts.push({ address: fdPda, role: AccountRole.WRITABLE });
    extraAccounts.push({ address: poolPda, role: AccountRole.WRITABLE });
  }
  for (const c of claimables) {
    extraAccounts.push({ address: c, role: AccountRole.WRITABLE });
  }

  const ix: Instruction = {
    ...baseIx,
    accounts: [...baseIx.accounts, ...extraAccounts],
  };
  await client.sendTransaction([setComputeUnitLimitIx(1_400_000), ix]);
}

// ─── Convenience: whitelist + deposit (used by integration tests) ────────

/**
 * Whitelist a route on governance with explicit override terms. Owner is
 * `client.payer` (matches the bootstrap convention — same payer for all
 * 5 programs in tests).
 */
export async function whitelistRoute(
  client: Awaited<ReturnType<typeof makeClient>>,
  args: {
    flightId: string;
    origin: string;
    destination: string;
    premium: bigint;
    payoff: bigint;
    delayHours: number;
  },
): Promise<void> {
  await client.sendTransaction([
    await getWhitelistRouteInstructionAsync({
      caller: client.payer,
      // Phase 1 D11: pass the program address as the None sentinel for
      // the optional `admin_record` (owner-as-caller branch).
      adminRecord: GOVERNANCE_PROGRAM_ADDRESS,
      flightId: args.flightId,
      origin: args.origin,
      destination: args.destination,
      premium: args.premium,
      payoff: args.payoff,
      delayHours: args.delayHours,
    }),
  ]);
}

/**
 * Underwriter deposits PUSD into the vault (mints shares to their share-mint
 * ATA). The underwriter must already have a funded PUSD ATA + a 0-balance
 * share ATA (both pre-seeded by `bootstrapFullProtocol`).
 */
export async function depositToVault(
  client: Awaited<ReturnType<typeof makeClient>>,
  ctrl: FullProtocolBootstrap,
  stableAmount: bigint,
): Promise<void> {
  await client.sendTransaction([
    await getDepositInstructionAsync({
      vaultState: ctrl.vault.vaultStatePda,
      shareMint: ctrl.vault.shareMintPda,
      vaultTokenAccount: ctrl.vault.vaultTokenAccount,
      depositorStableAccount: ctrl.underwriterStableAta,
      depositorShareAccount: ctrl.underwriterShareAta,
      stableMint: ctrl.vault.stableMint,
      depositor: ctrl.underwriter,
      stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
      stableAmount,
    }),
  ]);
}
