'use client';

import { useState } from 'react';
import { createNoopSigner, type Address } from '@solana/kit';
import { useWalletSession } from '@solana/react-hooks';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from '@solana-program/token';
import { Card } from '@/components/admin/Card';
import { AddressBadge } from '@/components/admin/AddressBadge';
import { useSendTx } from '@/lib/sendTx';
import { DEPLOYER, MOCK_USDC_MINT, TOKEN_PROGRAM, explorerLink } from '@/config/devnet';

const MINT_AMOUNT = 10_000n * 1_000_000n; // 10,000 USDC at 6 decimals

export default function FaucetPage() {
  const session = useWalletSession();
  const wallet = session?.account.address as Address | undefined;
  const send = useSendTx();
  const [recipient, setRecipient] = useState('');
  const [pending, setPending] = useState(false);

  const isDeployer = wallet === DEPLOYER;

  const onMint = async () => {
    if (!wallet) return;
    const target = (recipient || wallet) as Address;
    const signer = createNoopSigner(wallet);
    setPending(true);
    try {
      const [ata] = await findAssociatedTokenPda({
        owner: target,
        mint: MOCK_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM,
      });
      const createIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: target,
        mint: MOCK_USDC_MINT,
      });
      const mintIx = getMintToInstruction({
        mint: MOCK_USDC_MINT,
        token: ata,
        mintAuthority: signer,
        amount: MINT_AMOUNT,
      });
      await send([createIx, mintIx], {
        successTitle: `Minted 10,000 USDC to ${target.slice(0, 4)}…`,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 18, maxWidth: 800 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Faucet</h1>
        <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
          Test currency for the devnet deployment.
        </div>
      </div>

      <Card
        title="Test USDC Faucet"
        hint="Mint mock USDC for development & testing. Requires the deployer wallet."
      >
        <div className="col" style={{ gap: 8, marginBottom: 14 }}>
          <div className="row between">
            <span className="muted mono" style={{ fontSize: 11 }}>
              mint
            </span>
            <AddressBadge address={MOCK_USDC_MINT} />
          </div>
          <div className="row between">
            <span className="muted mono" style={{ fontSize: 11 }}>
              authority
            </span>
            <AddressBadge address={DEPLOYER} />
          </div>
        </div>

        <p style={{ fontSize: 12, color: 'var(--ink-2)', margin: 0, marginBottom: 12 }}>
          Mint <strong>10,000</strong> test USDC to any address. Leave blank to
          mint to your connected wallet. Creates the associated token account
          if it doesn&apos;t already exist.
        </p>

        <input
          className="input"
          placeholder={wallet ? wallet : 'Connect wallet…'}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          style={{ marginBottom: 10 }}
          disabled={!session}
        />

        {!session ? (
          <div
            className="muted mono"
            style={{ fontSize: 11, padding: '6px 0', color: 'var(--amber)' }}
          >
            Connect your wallet to mint test USDC.
          </div>
        ) : !isDeployer ? (
          <div
            className="muted mono"
            style={{ fontSize: 11, padding: '6px 0', color: 'var(--amber)' }}
          >
            Only the deployer wallet (
            <code className="mono" style={{ fontSize: 10 }}>
              {DEPLOYER.slice(0, 4)}…{DEPLOYER.slice(-4)}
            </code>
            ) holds the mint authority. Ask the deployer to mint test USDC for
            you, or run your own deployment.
          </div>
        ) : null}

        <button
          type="button"
          className="btn primary"
          disabled={!session || !isDeployer || pending}
          onClick={onMint}
        >
          {pending ? 'Minting…' : 'Mint 10,000 USDC'}
        </button>
      </Card>

      <Card
        title="SOL Faucet"
        hint="Need devnet SOL for transaction fees? Use the official Solana faucet."
      >
        <p style={{ fontSize: 12, color: 'var(--ink-2)', margin: 0, marginBottom: 12 }}>
          The Solana faucet hands out devnet SOL to any wallet. Sentinel
          doesn&apos;t mint SOL — only mock USDC for tests.
        </p>
        <a
          href="https://faucet.solana.com/"
          target="_blank"
          rel="noreferrer"
          className="btn primary"
          style={{ display: 'inline-block', textAlign: 'center' }}
        >
          Open faucet.solana.com ↗
        </a>
        {wallet && (
          <div style={{ marginTop: 12 }}>
            <span className="muted mono" style={{ fontSize: 11 }}>
              your wallet on explorer:
            </span>{' '}
            <a
              href={explorerLink(wallet, 'address')}
              target="_blank"
              rel="noreferrer"
              className="mono"
              style={{ fontSize: 11 }}
            >
              {wallet.slice(0, 4)}…{wallet.slice(-4)} ↗
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}
