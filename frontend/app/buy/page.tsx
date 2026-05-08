'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createNoopSigner, unwrapOption, type Address } from '@solana/kit';
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
import { fmtUsdc, fmtUsdcLocal } from '@/lib/usdc';
import { freeCapital } from '@/lib/vault-math';
import { setComputeUnitLimitIx } from '@/lib/compute-budget';
import { userUsdcAta } from '@/lib/ata';
import {
  findFlightDataAddress,
  findFlightPoolAddress,
  readGovernanceConfig,
  readKnownRoutes,
  readVaultState,
  type RouteRow,
} from '@/data';
import { getBuyInsuranceInstructionAsync } from '@/clients/controller/src/generated';
import { findRoutePda } from '@/clients/governance/src/generated';
import { findBuyerRecordPda } from '@/clients/flight_pool/src/generated';
import { MOCK_USDC_MINT, PDAS, PROGRAMS, TOKEN_PROGRAM } from '@/config/devnet';

interface BuyState {
  routes: RouteRow[];
  defaults: { premium: bigint; payoff: bigint; delayHours: number };
  vault: { tma: bigint; locked: bigint; free: bigint };
}

export default function BuyPage() {
  const { mode } = useTheme();
  const isFun = mode === 'fun';
  const session = useWalletSession();
  const wallet = session?.account.address as Address | undefined;
  const rpc = useRpc();
  const send = useSendTx();
  const { show } = useToast();

  const [state, setState] = useState<BuyState | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFlight, setSelectedFlight] = useState<string | null>(null);
  const [date, setDate] = useState<string>(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  });
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [gov, vault, routes] = await Promise.all([
          readGovernanceConfig(rpc),
          readVaultState(rpc),
          readKnownRoutes(rpc),
        ]);
        if (cancelled) return;
        setState({
          routes,
          defaults: {
            premium: gov.data.defaultPremium,
            payoff: gov.data.defaultPayoff,
            delayHours: gov.data.defaultDelayHours,
          },
          vault: {
            tma: vault.data.totalManagedAssets,
            locked: vault.data.lockedCapital,
            free: freeCapital(vault.data.totalManagedAssets, vault.data.lockedCapital),
          },
        });
        if (!selectedFlight && routes.length > 0) {
          const firstApproved = routes.find((r) => r.account?.data.approved);
          setSelectedFlight(firstApproved?.seeds.flightId ?? routes[0]?.seeds.flightId ?? null);
        }
      } catch (e) {
        if (!cancelled) {
          show({
            kind: 'error',
            title: 'Failed to load routes',
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
  }, [rpc, refreshTick, show, selectedFlight]);

  const selected = state?.routes.find((r) => r.seeds.flightId === selectedFlight) ?? null;
  const resolvedTerms = useMemo(() => {
    if (!selected || !state) return null;
    const acct = selected.account?.data;
    return {
      premium: (acct ? unwrapOption(acct.premium) : null) ?? state.defaults.premium,
      payoff: (acct ? unwrapOption(acct.payoff) : null) ?? state.defaults.payoff,
      delayHours: (acct ? unwrapOption(acct.delayHours) : null) ?? state.defaults.delayHours,
      approved: acct?.approved === true,
    };
  }, [selected, state]);

  const dateAsUnix = useMemo(() => {
    if (!date) return 0n;
    const ms = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : 0n;
  }, [date]);

  const insufficientVault =
    state && resolvedTerms ? state.vault.free < resolvedTerms.payoff : false;

  const submit = async () => {
    if (!wallet || !selected || !resolvedTerms || !state) return;
    if (!resolvedTerms.approved) return;
    const signer = createNoopSigner(wallet);

    const [
      buyerAta,
      [routeAccount],
      flightData,
      flightPool,
      [poolTreasuryAta],
    ] = await Promise.all([
      userUsdcAta(wallet),
      findRoutePda({
        flightId: selected.seeds.flightId,
        origin: selected.seeds.origin,
        destination: selected.seeds.destination,
      }),
      findFlightDataAddress(selected.seeds.flightId, dateAsUnix),
      findFlightPoolAddress(selected.seeds.flightId, dateAsUnix),
      findAssociatedTokenPda({
        owner: PDAS.poolTreasuryAuthority,
        mint: MOCK_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM,
      }),
    ]);
    const [buyerRecord] = await findBuyerRecordPda({ pool: flightPool, buyer: wallet });

    const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: wallet,
      mint: MOCK_USDC_MINT,
    });
    const buyIx = await getBuyInsuranceInstructionAsync({
      governanceProgram: PROGRAMS.governance,
      governanceConfig: PDAS.governanceConfig,
      routeAccount,
      oracleProgram: PROGRAMS.oracle_aggregator,
      oracleConfig: PDAS.oracleConfig,
      flightData,
      flightPoolProgram: PROGRAMS.flight_pool,
      flightPoolConfig: PDAS.flightPoolConfig,
      flightPool,
      buyerRecord,
      buyerUsdcAccount: buyerAta,
      poolTreasury: poolTreasuryAta,
      vaultProgram: PROGRAMS.vault,
      vaultState: PDAS.vaultState,
      traveler: signer,
      flightId: selected.seeds.flightId,
      origin: selected.seeds.origin,
      destination: selected.seeds.destination,
      date: dateAsUnix,
    });
    const r = await send([setComputeUnitLimitIx(1_400_000), createAtaIx, buyIx], {
      successTitle: `Coverage purchased · ${selected.seeds.flightId}`,
      computeUnitLimit: 1_400_000,
    });
    if (r.ok) refresh();
  };

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 18, maxWidth: 1280 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="h-eyebrow">{isFun ? 'Cover a flight' : 'Buy Coverage'}</div>
          <h1
            style={{
              fontSize: 36,
              fontWeight: 400,
              letterSpacing: '-0.03em',
              margin: 0,
            }}
          >
            {isFun ? 'Plot a quest.' : 'Pick a route. Cover the delay.'}
          </h1>
        </div>
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

      {!session && (
        <div
          className="panel"
          style={{ padding: 14, borderColor: 'var(--amber)', color: 'var(--amber)' }}
        >
          Connect your wallet to purchase coverage.
        </div>
      )}

      {state && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18 }}>
          <Card title="Whitelisted Routes" hint={`${state.routes.length} routes seeded on devnet`}>
            <div className="col" style={{ gap: 6 }}>
              {state.routes.map((r) => {
                const acct = r.account?.data;
                const exists = !!acct;
                const approved = acct?.approved === true;
                const isSel = selectedFlight === r.seeds.flightId;
                return (
                  <button
                    key={r.seeds.flightId}
                    type="button"
                    onClick={() => exists && setSelectedFlight(r.seeds.flightId)}
                    disabled={!exists}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: 6,
                      cursor: exists ? 'pointer' : 'not-allowed',
                      background: isSel ? 'var(--bg-2)' : 'transparent',
                      border: `1px solid ${isSel ? 'var(--cyan)' : 'var(--line)'}`,
                      opacity: exists ? 1 : 0.5,
                    }}
                  >
                    <div className="row between">
                      <div className="row" style={{ gap: 10 }}>
                        <span className="num" style={{ fontSize: 13 }}>
                          {r.seeds.flightId}
                        </span>
                        <span className="mono muted" style={{ fontSize: 11 }}>
                          {r.seeds.origin} → {r.seeds.destination}
                        </span>
                      </div>
                      {!exists ? (
                        <span className="badge red" style={{ fontSize: 9 }}>
                          NOT SEEDED
                        </span>
                      ) : approved ? (
                        <span className="badge green" style={{ fontSize: 9 }}>
                          ACTIVE
                        </span>
                      ) : (
                        <span className="badge amber" style={{ fontSize: 9 }}>
                          DISABLED
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card
            title={selected ? `Cover ${selected.seeds.flightId}` : 'Pick a route'}
            hint={
              !selected
                ? '—'
                : `${selected.seeds.origin} → ${selected.seeds.destination}`
            }
          >
            {!selected || !resolvedTerms ? (
              <div className="muted mono" style={{ fontSize: 12 }}>
                Pick a whitelisted route on the left.
              </div>
            ) : (
              <>
                <div className="col" style={{ gap: 8 }}>
                  <KvRow k="premium" v={`${fmtUsdc(resolvedTerms.premium)} USDC`} />
                  <KvRow k="payoff" v={`${fmtUsdc(resolvedTerms.payoff)} USDC`} />
                  <KvRow k="delay threshold" v={`>${resolvedTerms.delayHours}h`} />
                </div>
                <div className="col" style={{ gap: 6, marginTop: 14 }}>
                  <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
                    FLIGHT DATE
                  </span>
                  <input
                    className="input"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>

                <div
                  className="col"
                  style={{
                    gap: 6,
                    marginTop: 14,
                    paddingTop: 12,
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  <KvRow k="vault free" v={`${fmtUsdcLocal(state.vault.free)} USDC`} />
                  <KvRow k="vault locked" v={`${fmtUsdcLocal(state.vault.locked)} USDC`} />
                </div>

                {!resolvedTerms.approved && (
                  <div
                    className="muted mono"
                    style={{ fontSize: 11, marginTop: 8, color: 'var(--amber)' }}
                  >
                    This route is currently disabled.
                  </div>
                )}
                {resolvedTerms.approved && insufficientVault && (
                  <div
                    className="muted mono"
                    style={{ fontSize: 11, marginTop: 8, color: 'var(--amber)' }}
                  >
                    Vault is over-utilized — free capital ({fmtUsdcLocal(state.vault.free)} USDC)
                    is below the payoff. Underwriters need to deposit on /earn first.
                  </div>
                )}

                <button
                  type="button"
                  className="btn primary lg"
                  style={{ width: '100%', marginTop: 14 }}
                  onClick={submit}
                  disabled={
                    !session ||
                    !resolvedTerms.approved ||
                    insufficientVault ||
                    dateAsUnix === 0n
                  }
                >
                  Cover {selected.seeds.flightId} · {fmtUsdc(resolvedTerms.premium)} USDC
                </button>
                <div
                  className="mono-tiny"
                  style={{
                    textAlign: 'center',
                    marginTop: 8,
                    color: 'var(--ink-4)',
                  }}
                >
                  Premium charged immediately. Payoff arrives if delayed beyond
                  the threshold.
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

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
