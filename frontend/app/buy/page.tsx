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
import { MOCK_FLIGHTS } from '@/data/mock';
import { FlightRoute } from '@/components/FlightRoute';
import { RiskBar } from '@/components/RiskBar';
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
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;

  // Index the mock display data by `flightId|origin|destination` so we can
  // join carrier / depTs / risk onto each on-chain RouteRow without a second
  // RPC fetch. The on-chain RouteAccount only stores terms, not display fields.
  const mockByKey = useMemo(() => {
    const m = new Map<
      string,
      { carrier: string; depTs: string; risk: number; premium: number; payout: number; threshold: number }
    >();
    for (const f of MOCK_FLIGHTS) {
      m.set(`${f.id}|${f.from}|${f.to}`, {
        carrier: f.carrier,
        depTs: f.depTs,
        risk: f.risk,
        premium: f.premium,
        payout: f.payout,
        threshold: f.threshold,
      });
    }
    return m;
  }, []);
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
              fontSize: 44,
              fontWeight: 400,
              letterSpacing: '-0.03em',
              margin: 0,
            }}
          >
            {isFun ? (
              <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--amber)' }}>
                Plot a quest.
              </span>
            ) : (
              <>
                Pick a route.{' '}
                <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--amber)' }}>
                  Cover the delay.
                </span>
              </>
            )}
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
          <RoutesTable
            routes={state.routes}
            defaults={state.defaults}
            mockByKey={mockByKey}
            search={search}
            setSearch={(v) => {
              setSearch(v);
              setPage(0);
            }}
            page={page}
            setPage={setPage}
            pageSize={PAGE_SIZE}
            selectedFlight={selectedFlight}
            onSelect={(id) => setSelectedFlight(id)}
          />

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

interface MockMeta {
  carrier: string;
  depTs: string;
  risk: number;
  premium: number;
  payout: number;
  threshold: number;
}

interface RoutesTableProps {
  routes: RouteRow[];
  defaults: { premium: bigint; payoff: bigint; delayHours: number };
  mockByKey: Map<string, MockMeta>;
  search: string;
  setSearch: (v: string) => void;
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  selectedFlight: string | null;
  onSelect: (flightId: string) => void;
}

function RoutesTable({
  routes,
  defaults,
  mockByKey,
  search,
  setSearch,
  page,
  setPage,
  pageSize,
  selectedFlight,
  onSelect,
}: RoutesTableProps) {
  // Filter to whitelisted (approved) routes; non-existent / disabled are
  // excluded from the buy table — they show on /admin if you need to see them.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return routes.filter((r) => {
      const acct = r.account?.data;
      if (!acct?.approved) return false;
      if (!q) return true;
      const meta = mockByKey.get(
        `${r.seeds.flightId}|${r.seeds.origin}|${r.seeds.destination}`,
      );
      const hay = [
        r.seeds.flightId,
        r.seeds.origin,
        r.seeds.destination,
        `${r.seeds.origin}→${r.seeds.destination}`,
        `${r.seeds.origin} ${r.seeds.destination}`,
        meta?.carrier ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [routes, search, mockByKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const slice = filtered.slice(
    safePage * pageSize,
    safePage * pageSize + pageSize,
  );

  return (
    <Card
      title="Whitelisted Routes"
      hint={`${filtered.length} of ${routes.length} routes`}
    >
      <input
        type="text"
        className="input"
        placeholder="Search by flight, route or carrier…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr
              style={{
                color: 'var(--ink-3)',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '.1em',
              }}
            >
              <th align="left" style={tableCell}>FLIGHT</th>
              <th align="left" style={tableCell}>ROUTE</th>
              <th align="left" style={tableCell}>DEPARTS</th>
              <th align="left" style={tableCell}>RISK</th>
              <th align="right" style={tableCell}>PREMIUM</th>
              <th align="right" style={tableCell}>PAYOUT</th>
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...tableCell, padding: 24 }}>
                  <div className="muted mono" style={{ fontSize: 11, textAlign: 'center' }}>
                    No routes match “{search}”.
                  </div>
                </td>
              </tr>
            ) : (
              slice.map((r) => {
                const acct = r.account!.data;
                const meta = mockByKey.get(
                  `${r.seeds.flightId}|${r.seeds.origin}|${r.seeds.destination}`,
                );
                const ovPrem = unwrapOption(acct.premium);
                const ovPay = unwrapOption(acct.payoff);
                const premiumUnits = ovPrem ?? defaults.premium;
                const payoffUnits = ovPay ?? defaults.payoff;
                const isSel = selectedFlight === r.seeds.flightId;
                return (
                  <tr
                    key={`${r.seeds.flightId}-${r.seeds.origin}-${r.seeds.destination}`}
                    onClick={() => onSelect(r.seeds.flightId)}
                    style={{
                      cursor: 'pointer',
                      background: isSel ? 'var(--bg-2)' : 'transparent',
                      borderLeft: `2px solid ${isSel ? 'var(--amber)' : 'transparent'}`,
                    }}
                  >
                    <td style={tableCell}>
                      <div className="num" style={{ fontSize: 13 }}>
                        {r.seeds.flightId}
                      </div>
                      <div
                        className="muted mono"
                        style={{ fontSize: 10, marginTop: 2 }}
                      >
                        {meta?.carrier ?? '—'}
                      </div>
                    </td>
                    <td style={tableCell}>
                      <FlightRoute from={r.seeds.origin} to={r.seeds.destination} minWidth={110} />
                    </td>
                    <td style={tableCell}>
                      <span className="muted mono" style={{ fontSize: 11 }}>
                        {meta?.depTs ?? '—'}
                      </span>
                    </td>
                    <td style={{ ...tableCell, minWidth: 120 }}>
                      {meta ? <RiskBar risk={meta.risk} /> : <span className="muted mono">—</span>}
                    </td>
                    <td align="right" style={tableCell}>
                      <span className="num">{fmtUsdc(premiumUnits)}</span>
                    </td>
                    <td align="right" style={tableCell}>
                      <span className="num" style={{ color: 'var(--cyan)' }}>
                        {fmtUsdc(payoffUnits)}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div
          className="row between"
          style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}
        >
          <span className="muted mono" style={{ fontSize: 10 }}>
            Page {safePage + 1} / {pageCount} ·{' '}
            {filtered.length === 0
              ? '0 results'
              : `${safePage * pageSize + 1}–${Math.min(
                  (safePage + 1) * pageSize,
                  filtered.length,
                )} of ${filtered.length}`}
          </span>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setPage(safePage - 1)}
              disabled={safePage === 0}
              style={{ fontSize: 10, padding: '4px 10px' }}
            >
              ‹ Prev
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setPage(safePage + 1)}
              disabled={safePage >= pageCount - 1}
              style={{ fontSize: 10, padding: '4px 10px' }}
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

const tableCell: React.CSSProperties = {
  borderBottom: '1px solid var(--line)',
  padding: '8px 8px',
};
