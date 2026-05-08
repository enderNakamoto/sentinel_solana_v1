/**
 * POST /api/faucet/mint
 *
 * Public-facing mock-USDC faucet. Two server-side keypairs sign:
 *   - Fee payer: deployer keypair (has SOL on devnet for fees + ATA rent).
 *   - Mint authority: mock-usdc-authority keypair (the only key the SPL
 *     Token program will accept for `mint_to` against MOCK_USDC_MINT).
 *
 * Source priority for each keypair:
 *   1. <X>_BASE58  — base58-encoded 64-byte secret key (prod / hosted)
 *   2. <X>_PATH    — path to a JSON `[64 bytes]` file
 *   3. ../keys/<default>.json (relative to cwd, dev default)
 *   4. keys/<default>.json
 *
 * Where <X> is FAUCET_FEE_PAYER for the fee payer (default
 * `devnet-deployer.json`) and FAUCET_MINT_AUTHORITY for the mint authority
 * (default `mock-usdc-authority.json`).
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

const MOCK_USDC_MINT = 'epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K' as Address;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const DEFAULT_RPC = 'https://api.devnet.solana.com';
const DEFAULT_AMOUNT_USDC = 10_000;
const MAX_AMOUNT_USDC = 100_000;
const USDC_FACTOR = 1_000_000n; // 6 decimals

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
  defaultFile: 'mock-usdc-authority.json',
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
      : DEFAULT_AMOUNT_USDC;
  if (requestedAmount <= 0 || requestedAmount > MAX_AMOUNT_USDC) {
    return NextResponse.json(
      { ok: false, error: `\`amount\` must be 1 .. ${MAX_AMOUNT_USDC}` },
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
    const [ata] = await findAssociatedTokenPda({
      owner: recipient,
      mint: MOCK_USDC_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
    const createIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: feePayer,
      owner: recipient,
      mint: MOCK_USDC_MINT,
    });
    const mintIx = getMintToInstruction({
      mint: MOCK_USDC_MINT,
      token: ata,
      mintAuthority,
      amount: BigInt(Math.floor(requestedAmount)) * USDC_FACTOR,
    });

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
