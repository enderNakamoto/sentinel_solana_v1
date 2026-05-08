'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createNoopSigner, type Address } from '@solana/kit';
import { useWalletSession } from '@solana/react-hooks';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { Card } from '@/components/admin/Card';
import { useTheme } from '@/theme/ThemeProvider';
import { useRpc } from '@/lib/rpc';
import { useSendTx } from '@/lib/sendTx';
import { useToast } from '@/components/Toast';
import { fmtUsdc } from '@/lib/usdc';
import { userUsdcAta } from '@/lib/ata';
import { readMyPolicies, type MyPolicy } from '@/data';
import { getClaimInstructionAsync } from '@/clients/flight_pool/src/generated';
import { MOCK_USDC_MINT, PDAS, TOKEN_PROGRAM, explorerLink } from '@/config/devnet';

type Status = 'Active' | 'SettledOnTime' | 'SettledDelayed' | 'SettledCancelled';

const STATUS_LABEL: Record<Status, string> = {
  Active: 'Tracking',
  SettledOnTime: 'On time',
  SettledDelayed: 'Delayed',
  SettledCancelled: 'Cancelled',
};

const STATUS_BADGE: Record<Status, string> = {
  Active: 'amber',
  SettledOnTime: 'cyan',
  SettledDelayed: 'green',
  SettledCancelled: 'green',
};

function statusName(num: number): Status {
  return (['Active', 'SettledOnTime', 'SettledDelayed', 'SettledCancelled'] as Status[])[
    num
  ] ?? 'Active';
}

export default function PortfolioPage() {
  const { mode } = useTheme();
  const isFun = mode === 'fun';
  const session = useWalletSession();
  const wallet = session?.account.address as Address | undefined;
  const rpc = useRpc();
  const send = useSendTx();
  const { show } = useToast();

  const [policies, setPolicies] = useState<MyPolicy[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!wallet) {
      setPolicies([]);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const result = await readMyPolicies(rpc, wallet);
        if (!cancelled) setPolicies(result);
      } catch (e) {
        if (!cancelled) {
          show({
            kind: 'error',
            title: 'Failed to load policies',
            body: e instanceof Error ? e.message : String(e),
          });
          setPolicies([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, wallet, refreshTick, show]);

  const handleClaim = async (p: MyPolicy) => {
    if (!wallet) return;
    const signer = createNoopSigner(wallet);
    const usdcAta = await userUsdcAta(wallet);
    const [poolTreasuryAta] = await findAssociatedTokenPda({
      owner: PDAS.poolTreasuryAuthority,
      mint: MOCK_USDC_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
    const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: wallet,
      mint: MOCK_USDC_MINT,
    });
    const claimIx = await getClaimInstructionAsync({
      buyer: wallet,
      poolTreasury: poolTreasuryAta,
      usdcMint: MOCK_USDC_MINT,
      traveler: signer,
      flightId: p.pool.flightId,
      date: p.pool.date,
    });
    const r = await send([createAtaIx, claimIx], {
      successTitle: `Claim submitted · ${p.pool.flightId}`,
    });
    if (r.ok) refresh();
  };

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 18, maxWidth: 1280 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="h-eyebrow">{isFun ? 'Adventurer log' : 'Portfolio'}</div>
          <h1
            style={{
              fontSize: 44,
              fontWeight: 400,
              letterSpacing: '-0.03em',
              margin: 0,
            }}
          >
            Your{' '}
            <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--amber)' }}>
              {isFun ? 'quests + rewards.' : 'policies + claims.'}
            </span>
          </h1>
        </div>
        <button
          type="button"
          className="btn ghost"
          onClick={refresh}
          disabled={loading || !wallet}
          style={{ fontSize: 11 }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {!session && (
        <div
          className="panel"
          style={{ padding: 14, borderColor: 'var(--amber)', color: 'var(--amber)' }}
        >
          Connect your wallet to view your policies.
        </div>
      )}

      {wallet && policies !== null && policies.length === 0 && !loading && (
        <Card
          title="No policies yet"
          hint="You haven't bought any coverage. Head to /buy to start."
        >
          <Link href="/buy" className="btn primary" style={{ fontSize: 12 }}>
            Browse routes →
          </Link>
        </Card>
      )}

      {wallet && policies && policies.length > 0 && (
        <PoliciesTable policies={policies} onClaim={handleClaim} />
      )}
    </div>
  );
}

function PoliciesTable({
  policies,
  onClaim,
}: {
  policies: MyPolicy[];
  onClaim: (p: MyPolicy) => Promise<void>;
}) {
  const active = policies.filter((p) => p.buyerRecord.hasPolicy && !p.buyerRecord.claimed);
  const history = policies.filter((p) => p.buyerRecord.claimed);

  return (
    <>
      <Card title={`Active · ${active.length}`} hint="Live policies pending settlement.">
        <PolicyList policies={active} onClaim={onClaim} />
      </Card>
      <Card title={`History · ${history.length}`} hint="Settled or claimed policies.">
        <PolicyList policies={history} onClaim={onClaim} />
      </Card>
    </>
  );
}

function PolicyList({
  policies,
  onClaim,
}: {
  policies: MyPolicy[];
  onClaim: (p: MyPolicy) => Promise<void>;
}) {
  if (policies.length === 0) {
    return (
      <div className="muted mono" style={{ fontSize: 11 }}>
        Nothing here yet.
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 8 }}>
      {policies.map((p) => (
        <PolicyCard key={p.poolAddress} p={p} onClaim={onClaim} />
      ))}
    </div>
  );
}

function PolicyCard({
  p,
  onClaim,
}: {
  p: MyPolicy;
  onClaim: (p: MyPolicy) => Promise<void>;
}) {
  const status = statusName(p.pool.status as unknown as number);
  const flightDate = new Date(Number(p.pool.date) * 1000).toISOString().slice(0, 10);
  const claimExpiry = Number(p.pool.claimExpiry) * 1000;
  const now = Date.now();
  const expired = claimExpiry > 0 && now > claimExpiry;

  const eligible =
    !p.buyerRecord.claimed &&
    !expired &&
    (status === 'SettledDelayed' || status === 'SettledCancelled');

  const reason = (() => {
    if (p.buyerRecord.claimed) return 'Already claimed.';
    if (expired) return 'Claim window expired.';
    if (status === 'Active') return 'Awaiting settlement.';
    if (status === 'SettledOnTime') return 'On-time settlement — no payoff.';
    return null;
  })();

  return (
    <div
      className="panel"
      style={{
        padding: 14,
        display: 'grid',
        gridTemplateColumns: '1.1fr 1fr 1fr 1fr auto',
        gap: 12,
        alignItems: 'center',
      }}
    >
      <div>
        <div className="num" style={{ fontSize: 13 }}>
          {p.pool.flightId}
        </div>
        <div className="muted mono" style={{ fontSize: 10 }}>
          {flightDate}
        </div>
      </div>

      <div>
        <span className={`badge ${STATUS_BADGE[status]}`} style={{ fontSize: 9 }}>
          {STATUS_LABEL[status]}
        </span>
      </div>

      <div className="col" style={{ gap: 2 }}>
        <span className="muted mono" style={{ fontSize: 9 }}>
          PREMIUM PAID
        </span>
        <span className="num" style={{ fontSize: 12 }}>
          {fmtUsdc(p.pool.premium)} USDC
        </span>
      </div>

      <div className="col" style={{ gap: 2 }}>
        <span className="muted mono" style={{ fontSize: 9 }}>
          PAYOFF
        </span>
        <span className="num" style={{ fontSize: 12 }}>
          {fmtUsdc(p.pool.payoff)} USDC
        </span>
      </div>

      <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
        {eligible ? (
          <button
            type="button"
            className="btn primary"
            onClick={() => void onClaim(p)}
            style={{ fontSize: 11 }}
          >
            Claim {fmtUsdc(p.pool.payoff)}
          </button>
        ) : (
          <span className="muted mono" style={{ fontSize: 10 }}>
            {reason ?? '—'}
          </span>
        )}
        <a
          href={explorerLink(p.poolAddress, 'address')}
          target="_blank"
          rel="noreferrer"
          className="muted mono"
          style={{ fontSize: 9, textDecoration: 'none' }}
        >
          pool ↗
        </a>
      </div>
    </div>
  );
}
