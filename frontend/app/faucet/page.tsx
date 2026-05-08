'use client';

import { useState } from 'react';
import { type Address } from '@solana/kit';
import { useWalletSession } from '@solana/react-hooks';
import { Card } from '@/components/admin/Card';
import { AddressBadge } from '@/components/admin/AddressBadge';
import { useToast } from '@/components/Toast';
import { emitTxSuccessBurst } from '@/lib/txEvents';
import { MOCK_USDC_AUTHORITY, MOCK_USDC_MINT, explorerLink } from '@/config/devnet';

interface MintResponse {
  ok: boolean;
  signature?: string;
  recipient?: string;
  amount?: number;
  error?: string;
  note?: string;
}

export default function FaucetPage() {
  const session = useWalletSession();
  const wallet = session?.account.address as Address | undefined;
  const { show } = useToast();
  const [recipient, setRecipient] = useState('');
  const [pending, setPending] = useState(false);

  const onMint = async () => {
    const target = (recipient || wallet || '').trim();
    if (!target) {
      show({
        kind: 'error',
        title: 'No recipient',
        body: 'Enter a wallet address or connect a wallet.',
      });
      return;
    }
    setPending(true);
    try {
      const r = await fetch('/api/faucet/mint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: target }),
      });
      const data = (await r.json()) as MintResponse;
      if (!r.ok || !data.ok) {
        show({
          kind: 'error',
          title: 'Faucet failed',
          body: (data.error ?? 'Unknown error').slice(0, 600),
        });
        return;
      }
      show({
        kind: 'success',
        title: `Minted ${data.amount ?? 10_000} USDC to ${target.slice(0, 4)}…`,
        body: data.signature
          ? `${data.signature.slice(0, 8)}… · ${explorerLink(data.signature, 'tx')}`
          : (data.note ?? ''),
      });
      if (data.signature) {
        emitTxSuccessBurst({ signature: data.signature, source: 'faucet' });
      }
    } catch (e) {
      show({
        kind: 'error',
        title: 'Faucet request failed',
        body: e instanceof Error ? e.message : String(e),
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
        hint="Public — anyone can mint mock USDC to any address. Mint authority signs server-side."
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
              mint authority
            </span>
            <AddressBadge address={MOCK_USDC_AUTHORITY} />
          </div>
        </div>

        <p style={{ fontSize: 12, color: 'var(--ink-2)', margin: 0, marginBottom: 12 }}>
          Mint <strong>10,000</strong> test USDC to any address. Leave blank to
          mint to your connected wallet. Creates the associated token account
          if it doesn&apos;t already exist.
        </p>

        <input
          className="input"
          placeholder={wallet ? wallet : 'recipient wallet address'}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          style={{ marginBottom: 10 }}
        />

        <button
          type="button"
          className="btn primary"
          disabled={pending || (!recipient && !wallet)}
          onClick={onMint}
        >
          {pending ? 'Minting…' : 'Mint 10,000 USDC'}
        </button>
        {!recipient && !wallet && (
          <div className="muted mono" style={{ fontSize: 11, marginTop: 8 }}>
            Enter an address above or connect a wallet to set the recipient.
          </div>
        )}
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
