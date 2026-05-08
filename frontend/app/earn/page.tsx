'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address, TransactionSigner } from '@solana/kit';
import { useWalletSession } from '@solana/react-hooks';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { Card } from '@/components/admin/Card';
import { useTheme } from '@/theme/ThemeProvider';
import { useToast } from '@/components/Toast';
import { useRpc } from '@/lib/rpc';
import { useSendTx } from '@/lib/sendTx';
import {
  readSnapshotHistory,
  readShareSupply,
  readUserVaultPosition,
  readVaultState,
  type SnapshotRecord,
  type UserVaultPosition,
} from '@/data';
import { fmtUsdc, fmtUsdcLocal, toUsdcUnits } from '@/lib/usdc';
import { userShareAta, userUsdcAta } from '@/lib/ata';
import { useTxSuccess } from '@/lib/txEvents';
import { useWalletSigner } from '@/lib/useWalletSigner';
import {
  currentSharePrice,
  freeCapital,
  previewSharesFromDeposit,
  previewUsdcFromRedeem,
} from '@/lib/vault-math';
import {
  getCancelWithdrawalInstructionAsync,
  getCollectInstructionAsync,
  getDepositInstructionAsync,
  getRedeemInstructionAsync,
  getRequestWithdrawalInstructionAsync,
  type VaultState,
} from '@/clients/vault/src/generated';
import { MOCK_USDC_MINT, PDAS, TOKEN_PROGRAM, explorerLink } from '@/config/devnet';

interface EarnState {
  vault: VaultState;
  shareSupply: bigint;
  position: UserVaultPosition;
  snapshots: Array<SnapshotRecord | null>;
}

export default function EarnPage() {
  const { mode } = useTheme();
  const isFun = mode === 'fun';
  const session = useWalletSession();
  const wallet = session?.account.address as Address | undefined;
  const rpc = useRpc();
  const send = useSendTx();
  const { show } = useToast();

  const [state, setState] = useState<EarnState | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);
  useTxSuccess(refresh);
  const noopSigner = useWalletSigner();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const vault = await readVaultState(rpc);
        const shareSupply = await readShareSupply(rpc);
        const snapshots = await readSnapshotHistory(rpc, 30).catch(
          () => [] as Array<SnapshotRecord | null>,
        );
        let position: UserVaultPosition = {
          rvsBalance: 0n,
          usdcBalance: 0n,
          claimable: 0n,
          queued: [],
        };
        if (wallet) {
          const [usdcAta, shareAta] = await Promise.all([
            userUsdcAta(wallet),
            userShareAta(wallet),
          ]);
          position = await readUserVaultPosition(rpc, wallet, usdcAta, shareAta);
        }
        if (cancelled) return;
        setState({ vault: vault.data, shareSupply, position, snapshots });
      } catch (e) {
        if (!cancelled) {
          show({
            kind: 'error',
            title: 'Failed to load vault state',
            body: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, wallet, refreshTick, show]);

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 18, maxWidth: 1280 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="h-eyebrow">{isFun ? 'Underwriter chest' : 'Earn'}</div>
          <h1
            style={{
              fontSize: 44,
              fontWeight: 400,
              letterSpacing: '-0.03em',
              margin: 0,
            }}
          >
            {isFun ? (
              <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-2)' }}>
                Underwrite the skies.
              </span>
            ) : (
              <>
                Underwrite delays.{' '}
                <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-2)' }}>
                  Earn premiums.
                </span>
              </>
            )}
          </h1>
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          {session && (
            <span
              className="mono"
              style={{
                fontSize: 11,
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--line)',
                background: 'var(--bg-2)',
                color: 'var(--ink-2)',
              }}
            >
              <span className="muted" style={{ marginRight: 6 }}>WALLET</span>
              {state ? `${fmtUsdcLocal(state.position.usdcBalance)} USDC` : '…'}
            </span>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={refresh}
            disabled={loading}
            style={{ fontSize: 11 }}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {!session && (
        <div
          className="panel"
          style={{ padding: 14, borderColor: 'var(--amber)', color: 'var(--amber)' }}
        >
          Connect your wallet to deposit, redeem, or queue withdrawals.
          Live vault state below works without a wallet.
        </div>
      )}

      <VaultMetricsCard state={state} />

      {state && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 18 }}>
            <DepositCard
              state={state}
              wallet={wallet}
              signer={noopSigner}
              send={send}
              onSuccess={refresh}
            />
            <RedeemCard
              state={state}
              wallet={wallet}
              signer={noopSigner}
              send={send}
              onSuccess={refresh}
            />
          </div>
          <QueueCard
            state={state}
            wallet={wallet}
            signer={noopSigner}
            send={send}
            onSuccess={refresh}
          />
          <ClaimableCard
            state={state}
            wallet={wallet}
            signer={noopSigner}
            send={send}
            onSuccess={refresh}
          />
        </>
      )}
    </div>
  );
}

function VaultMetricsCard({ state }: { state: EarnState | null }) {
  if (!state) {
    return (
      <Card title="Vault Metrics" hint="Loading on-chain state…">
        <div className="muted mono">…</div>
      </Card>
    );
  }
  const { vault, shareSupply, snapshots } = state;
  const tma = vault.totalManagedAssets;
  const locked = vault.lockedCapital;
  const free = freeCapital(tma, locked);
  const sharePrice = currentSharePrice({ tma, rvsSupply: shareSupply });
  const empty = tma === 0n && shareSupply === 0n;

  return (
    <Card
      title="Vault Metrics"
      hint={
        empty
          ? 'Vault not yet seeded — deposit to bootstrap.'
          : `${vault.withdrawalQueueCount} queued · last snapshot ${formatTs(vault.lastSnapshotTime)}`
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 18,
        }}
      >
        <Metric label="TVL" value={`${fmtUsdcLocal(tma)} USDC`} />
        <Metric label="Locked" value={`${fmtUsdcLocal(locked)} USDC`} />
        <Metric label="Free" value={`${fmtUsdcLocal(free)} USDC`} />
        <Metric label="Share Price" value={`${fmtUsdc(sharePrice)} USDC`} />
      </div>

      <div style={{ marginTop: 18 }}>
        <SnapshotChart snapshots={snapshots} />
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
        {label.toUpperCase()}
      </span>
      <span className="num" style={{ fontSize: 22 }}>
        {value}
      </span>
    </div>
  );
}

function SnapshotChart({ snapshots }: { snapshots: Array<SnapshotRecord | null> }) {
  const points = snapshots
    .map((s) => (s ? Number(s.sharePrice) / 1_000_000 : null))
    .filter((v): v is number => v !== null);

  if (points.length < 2) {
    return (
      <div className="muted mono" style={{ fontSize: 11, padding: '24px 0' }}>
        Share-price history will appear here after snapshots are recorded.
      </div>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 100 - ((v - min) / range) * 100;
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 80 }}>
      <path d={path} fill="none" stroke="var(--cyan)" strokeWidth="0.6" />
    </svg>
  );
}

interface FormProps {
  state: EarnState;
  wallet: Address | undefined;
  signer: TransactionSigner | undefined;
  send: ReturnType<typeof useSendTx>;
  onSuccess: () => void;
}

// ─────────────────────────────────────────────────────────────────────
// Deposit

function DepositCard({ state, wallet, signer, send, onSuccess }: FormProps) {
  const [amount, setAmount] = useState('');
  const { vault, shareSupply, position } = state;

  const usdcUnits = (() => {
    try {
      return amount ? toUsdcUnits(amount) : 0n;
    } catch {
      return 0n;
    }
  })();

  const previewShares = previewSharesFromDeposit({
    tma: vault.totalManagedAssets,
    rvsSupply: shareSupply,
    usdc: usdcUnits,
  });

  const insufficient = wallet && usdcUnits > position.usdcBalance;

  const submit = async () => {
    if (!wallet || !signer || usdcUnits <= 0n) return;
    const usdcAta = await userUsdcAta(wallet);
    const shareAta = await userShareAta(wallet);
    const createShareAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: wallet,
      mint: PDAS.shareMint,
    });
    const depositIx = await getDepositInstructionAsync({
      vaultTokenAccount: vault.vaultTokenAccount,
      depositorUsdcAccount: usdcAta,
      depositorShareAccount: shareAta,
      depositor: signer,
      usdcAmount: usdcUnits,
    });
    const r = await send([createShareAtaIx, depositIx], {
      successTitle: `Deposited ${amount} USDC · received ${fmtUsdc(previewShares)} RVS`,
    });
    if (r.ok) {
      setAmount('');
      onSuccess();
    }
  };

  return (
    <Card title="Deposit" hint="Mint RVS shares against the vault.">
      <KvRow k="your USDC" v={`${fmtUsdcLocal(position.usdcBalance)} USDC`} />
      <div className="col" style={{ gap: 6, marginTop: 14 }}>
        <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
          AMOUNT (USDC)
        </span>
        <input
          className="input"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          disabled={!signer}
        />
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          {[100, 500, 1000].map((v) => (
            <button
              key={v}
              type="button"
              className="btn ghost"
              style={{ fontSize: 10, padding: '4px 10px' }}
              onClick={() => setAmount(String(v))}
              disabled={!signer}
            >
              {v}
            </button>
          ))}
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 10, padding: '4px 10px' }}
            onClick={() => setAmount(fmtUsdc(position.usdcBalance))}
            disabled={!signer || position.usdcBalance === 0n}
          >
            MAX
          </button>
        </div>
      </div>

      <div className="col" style={{ gap: 6, marginTop: 12 }}>
        <KvRow k="you'll receive" v={`${fmtUsdc(previewShares)} RVS`} />
      </div>

      {insufficient && (
        <div
          className="muted mono"
          style={{ fontSize: 11, marginTop: 8, color: 'var(--red)' }}
        >
          Insufficient USDC balance. Mint test USDC at /faucet.
        </div>
      )}

      <button
        type="button"
        className="btn primary"
        style={{ width: '100%', marginTop: 14 }}
        onClick={submit}
        disabled={!signer || usdcUnits <= 0n || !!insufficient}
      >
        Deposit {amount || '0'} USDC
      </button>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Redeem

function RedeemCard({ state, wallet, signer, send, onSuccess }: FormProps) {
  const [shareAmt, setShareAmt] = useState('');
  const { vault, shareSupply, position } = state;

  const sharesUnits = (() => {
    try {
      return shareAmt ? toUsdcUnits(shareAmt) : 0n;
    } catch {
      return 0n;
    }
  })();

  const previewUsdc = previewUsdcFromRedeem({
    tma: vault.totalManagedAssets,
    rvsSupply: shareSupply,
    shares: sharesUnits,
  });

  const free = freeCapital(vault.totalManagedAssets, vault.lockedCapital);
  const exceedsFree = previewUsdc > free;
  const exceedsBalance = wallet && sharesUnits > position.rvsBalance;

  const doRedeem = async () => {
    if (!wallet || !signer || sharesUnits <= 0n) return;
    const usdcAta = await userUsdcAta(wallet);
    const shareAta = await userShareAta(wallet);
    const createUsdcAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: wallet,
      mint: MOCK_USDC_MINT,
    });
    const redeemIx = await getRedeemInstructionAsync({
      vaultTokenAccount: vault.vaultTokenAccount,
      redeemerShareAccount: shareAta,
      redeemerUsdcAccount: usdcAta,
      redeemer: signer,
      shares: sharesUnits,
    });
    const r = await send([createUsdcAtaIx, redeemIx], {
      successTitle: `Redeemed ${shareAmt} RVS · received ${fmtUsdc(previewUsdc)} USDC`,
    });
    if (r.ok) {
      setShareAmt('');
      onSuccess();
    }
  };

  const doQueue = async () => {
    if (!wallet || !signer || sharesUnits <= 0n) return;
    const shareAta = await userShareAta(wallet);
    const ix = await getRequestWithdrawalInstructionAsync({
      requesterShareAccount: shareAta,
      requester: signer,
      shares: sharesUnits,
    });
    const r = await send([ix], {
      successTitle: `Queued ${shareAmt} RVS for withdrawal`,
    });
    if (r.ok) {
      setShareAmt('');
      onSuccess();
    }
  };

  return (
    <Card title="Redeem / Withdraw" hint="Burn RVS for USDC. Queue if free capital is short.">
      <KvRow k="your RVS" v={`${fmtUsdc(position.rvsBalance)} RVS`} />
      <KvRow k="vault free" v={`${fmtUsdcLocal(free)} USDC`} />

      <div className="col" style={{ gap: 6, marginTop: 14 }}>
        <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
          SHARES
        </span>
        <input
          className="input"
          value={shareAmt}
          onChange={(e) => setShareAmt(e.target.value)}
          placeholder="0"
          disabled={!signer}
        />
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 10, padding: '4px 10px' }}
            onClick={() => setShareAmt(fmtUsdc(position.rvsBalance))}
            disabled={!signer || position.rvsBalance === 0n}
          >
            MAX
          </button>
        </div>
      </div>

      <div className="col" style={{ gap: 6, marginTop: 12 }}>
        <KvRow k="you'll receive" v={`${fmtUsdc(previewUsdc)} USDC`} />
      </div>

      {exceedsBalance && (
        <div className="muted mono" style={{ fontSize: 11, marginTop: 8, color: 'var(--red)' }}>
          Exceeds your RVS balance.
        </div>
      )}

      {exceedsFree && !exceedsBalance && (
        <div className="muted mono" style={{ fontSize: 11, marginTop: 8, color: 'var(--amber)' }}>
          Vault is fully utilized. Use the queued path; settlements will drain
          your request as collateral unlocks.
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button
          type="button"
          className="btn primary"
          style={{ flex: 1 }}
          onClick={doRedeem}
          disabled={!signer || sharesUnits <= 0n || !!exceedsBalance || exceedsFree}
        >
          Redeem now
        </button>
        <button
          type="button"
          className="btn ghost"
          style={{ flex: 1 }}
          onClick={doQueue}
          disabled={!signer || sharesUnits <= 0n || !!exceedsBalance}
        >
          Queue withdrawal
        </button>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Queue

function QueueCard({ state, wallet, signer, send, onSuccess }: FormProps) {
  const queued = state.position.queued;
  if (!wallet) return null;

  return (
    <Card
      title="Your Queued Withdrawals"
      hint={
        queued.length === 0
          ? 'No queued requests.'
          : `${queued.length} request${queued.length === 1 ? '' : 's'} waiting for settlement drain.`
      }
    >
      {queued.length === 0 ? (
        <div className="muted mono" style={{ fontSize: 11 }}>
          When the vault is fully utilized, your "Queue withdrawal" requests
          will appear here.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 10 }}>
              <th align="left" style={cellStyle}>POS</th>
              <th align="right" style={cellStyle}>SHARES</th>
              <th align="right" style={cellStyle}>PENDING USDC</th>
              <th align="right" style={cellStyle}>QUEUED</th>
              <th align="right" style={cellStyle}></th>
            </tr>
          </thead>
          <tbody>
            {queued.map(({ index, request }) => (
              <tr key={index}>
                <td style={cellStyle}>
                  <span className="num">#{index + 1}</span>
                </td>
                <td align="right" style={cellStyle}>
                  <span className="num">{fmtUsdc(request.shares)}</span>
                </td>
                <td align="right" style={cellStyle}>
                  <span className="num">{fmtUsdc(request.pendingAssets)}</span>
                </td>
                <td align="right" style={cellStyle}>
                  <span className="muted mono" style={{ fontSize: 10 }}>
                    {formatTs(request.timestamp)}
                  </span>
                </td>
                <td align="right" style={cellStyle}>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={async () => {
                      if (!signer || !wallet) return;
                      const shareAta = await userShareAta(wallet);
                      const ix = await getCancelWithdrawalInstructionAsync({
                        requesterShareAccount: shareAta,
                        requester: signer,
                        queueIndex: index,
                      });
                      const r = await send([ix], {
                        successTitle: `Cancelled queue position #${index + 1}`,
                      });
                      if (r.ok) onSuccess();
                    }}
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Claimable + Collect

function ClaimableCard({ state, wallet, signer, send, onSuccess }: FormProps) {
  const claimable = state.position.claimable;
  if (!wallet) return null;

  const submit = async () => {
    if (!signer || !wallet) return;
    const usdcAta = await userUsdcAta(wallet);
    const createUsdcAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: wallet,
      mint: MOCK_USDC_MINT,
    });
    const ix = await getCollectInstructionAsync({
      vaultTokenAccount: state.vault.vaultTokenAccount,
      owner: wallet,
      collectorUsdcAccount: usdcAta,
      collector: signer,
    });
    const r = await send([createUsdcAtaIx, ix], {
      successTitle: `Collected ${fmtUsdc(claimable)} USDC`,
    });
    if (r.ok) onSuccess();
  };

  return (
    <Card
      title="Claimable Balance"
      hint="USDC made claimable when settlements drained your queued requests."
    >
      <div className="row between">
        <span className="muted mono" style={{ fontSize: 11 }}>
          claimable
        </span>
        <span className="num" style={{ fontSize: 16 }}>
          {fmtUsdc(claimable)} USDC
        </span>
      </div>
      <button
        type="button"
        className="btn primary"
        style={{ width: '100%', marginTop: 14 }}
        onClick={submit}
        disabled={!signer || claimable === 0n}
      >
        {claimable === 0n ? 'Nothing to collect' : `Collect ${fmtUsdc(claimable)} USDC`}
      </button>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// shared bits

const cellStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--line)',
  padding: '6px 8px',
};

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="row between">
      <span className="muted mono" style={{ fontSize: 11 }}>
        {k}
      </span>
      <span className="num" style={{ fontSize: 12 }}>
        {v}
      </span>
    </div>
  );
}

function formatTs(unix: bigint): string {
  if (unix === 0n) return '—';
  const ms = Number(unix) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  return date.toISOString().slice(0, 19) + 'Z';
}

void explorerLink;
