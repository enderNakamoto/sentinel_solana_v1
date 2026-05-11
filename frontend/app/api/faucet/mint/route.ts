/**
 * POST /api/faucet/mint
 *
 * Public-facing mock-PUSD faucet. PUSD is a Token-2022 mint, so both the
 * ATA-create CPI and the mint_to CPI target the Token-2022 program id
 * (`TokenzQd...`). Two server-side keypairs sign:
 *   - Fee payer: deployer keypair (has SOL on devnet for fees + ATA rent).
 *   - Mint authority: mock-pusd-authority keypair (the only key the
 *     Token-2022 program will accept for `mint_to` against MOCK_PUSD_MINT).
 *
 * Source priority for each keypair:
 *   1. <X>_BASE58  — base58-encoded 64-byte secret key (prod / hosted)
 *   2. <X>_PATH    — path to a JSON `[64 bytes]` file
 *   3. ../keys/<default>.json (relative to cwd, dev default)
 *   4. keys/<default>.json
 *
 * Where <X> is FAUCET_FEE_PAYER for the fee payer (default
 * `devnet-deployer.json`) and FAUCET_MINT_AUTHORITY for the mint authority
 * (default `mock-pusd-authority.json`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
  type Signature,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from '@solana-program/token';

export const runtime = 'nodejs';

const MOCK_PUSD_MINT = 'F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE' as Address;
const STABLE_TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const DEFAULT_RPC = 'https://api.devnet.solana.com';
const DEFAULT_AMOUNT_PUSD = 10_000;
const MAX_AMOUNT_PUSD = 100_000;
const PUSD_FACTOR = 1_000_000n; // 6 decimals

interface MintRequestBody {
  recipient?: unknown;
  amount?: unknown;
}

interface SignerSource {
  envBase58: string;
  envPath: string;
  defaultFile: string;
}

const FEE_PAYER_SOURCE: SignerSource = {
  envBase58: 'FAUCET_FEE_PAYER_BASE58',
  envPath: 'FAUCET_FEE_PAYER_PATH',
  defaultFile: 'devnet-deployer.json',
};

const MINT_AUTHORITY_SOURCE: SignerSource = {
  envBase58: 'FAUCET_MINT_AUTHORITY_BASE58',
  envPath: 'FAUCET_MINT_AUTHORITY_PATH',
  defaultFile: 'mock-pusd-authority.json',
};

const cache = new Map<string, KeyPairSigner>();

async function loadSigner(src: SignerSource): Promise<KeyPairSigner> {
  const cached = cache.get(src.defaultFile);
  if (cached) return cached;

  const base58 = process.env[src.envBase58];
  if (base58) {
    const bytes = getBase58Encoder().encode(base58.trim());
    const signer = await createKeyPairSignerFromBytes(new Uint8Array(bytes));
    cache.set(src.defaultFile, signer);
    return signer;
  }

  const candidates = [
    process.env[src.envPath],
    resolve(process.cwd(), '..', 'keys', src.defaultFile),
    resolve(process.cwd(), 'keys', src.defaultFile),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const p of candidates) {
    if (existsSync(p)) {
      const bytes = JSON.parse(readFileSync(p, 'utf-8')) as number[];
      if (!Array.isArray(bytes) || bytes.length !== 64) {
        throw new Error(`Invalid keypair file: ${p}`);
      }
      const signer = await createKeyPairSignerFromBytes(new Uint8Array(bytes));
      cache.set(src.defaultFile, signer);
      return signer;
    }
  }

  throw new Error(
    `Keypair not found. Set ${src.envBase58} or ${src.envPath}, or place ${src.defaultFile} in keys/.`,
  );
}

export async function POST(req: Request) {
  let body: MintRequestBody;
  try {
    body = (await req.json()) as MintRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const recipientRaw = typeof body.recipient === 'string' ? body.recipient.trim() : '';
  if (!recipientRaw || !isAddress(recipientRaw)) {
    return NextResponse.json(
      { ok: false, error: '`recipient` must be a base58 Solana address' },
      { status: 400 },
    );
  }
  const recipient = recipientRaw as Address;

  const requestedAmount =
    typeof body.amount === 'number' && Number.isFinite(body.amount)
      ? body.amount
      : DEFAULT_AMOUNT_PUSD;
  if (requestedAmount <= 0 || requestedAmount > MAX_AMOUNT_PUSD) {
    return NextResponse.json(
      { ok: false, error: `\`amount\` must be 1 .. ${MAX_AMOUNT_PUSD}` },
      { status: 400 },
    );
  }

  let feePayer: KeyPairSigner;
  let mintAuthority: KeyPairSigner;
  try {
    [feePayer, mintAuthority] = await Promise.all([
      loadSigner(FEE_PAYER_SOURCE),
      loadSigner(MINT_AUTHORITY_SOURCE),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[faucet/mint] keypair load failed:', e);
    return NextResponse.json(
      { ok: false, error: `keypair load failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const rpcUrl = process.env.FAUCET_RPC_URL ?? DEFAULT_RPC;
  const rpc = createSolanaRpc(rpcUrl);

  try {
    // PUSD is Token-2022, so every ATA + mint_to CPI routes through
    // `STABLE_TOKEN_PROGRAM` (TokenzQd...). The instruction binary layout
    // is identical to classic SPL for these two ops; we re-use the
    // @solana-program/token builders and override the program id.
    const [ata] = await findAssociatedTokenPda({
      owner: recipient,
      mint: MOCK_PUSD_MINT,
      tokenProgram: STABLE_TOKEN_PROGRAM,
    });
    const createIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: feePayer,
      owner: recipient,
      mint: MOCK_PUSD_MINT,
      tokenProgram: STABLE_TOKEN_PROGRAM,
    });
    const mintIx = getMintToInstruction(
      {
        mint: MOCK_PUSD_MINT,
        token: ata,
        mintAuthority,
        amount: BigInt(Math.floor(requestedAmount)) * PUSD_FACTOR,
      },
      { programAddress: STABLE_TOKEN_PROGRAM },
    );

    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([createIx, mintIx], m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wireTx = getBase64EncodedWireTransaction(signed);
    const sig = getSignatureFromTransaction(signed);

    await rpc
      .sendTransaction(wireTx, { encoding: 'base64', preflightCommitment: 'confirmed' })
      .send();

    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const { value } = await rpc.getSignatureStatuses([sig as Signature]).send();
      const status = value[0];
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        if (status.err) {
          return NextResponse.json(
            { ok: false, error: `tx failed: ${JSON.stringify(status.err)}` },
            { status: 500 },
          );
        }
        return NextResponse.json({
          ok: true,
          signature: sig,
          recipient,
          amount: requestedAmount,
        });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return NextResponse.json({
      ok: true,
      signature: sig,
      recipient,
      amount: requestedAmount,
      note: 'confirmation timeout — tx may still land',
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[faucet/mint] failed for', recipient, ':', e);
    const detail = (e as { context?: { logs?: string[] } }).context?.logs;
    let message = (e as Error).message ?? String(e);
    if (Array.isArray(detail) && detail.length > 0) {
      message += '\n' + detail.slice(-8).join('\n');
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
