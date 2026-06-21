'use client';

import { useState } from 'react';
import { useToast } from '@/components/Toast';
import { AddressBadge } from '@/components/admin/AddressBadge';
import { useRpc } from '@/lib/rpc';
import {
  readControllerConfig,
  readFlightPoolConfig,
  readGovernanceConfig,
  readOracleConfig,
  readVaultState,
} from '@/data';
import { fetchActiveFlightList } from '@/clients/controller/src/generated';
import {
  fetchWithdrawalQueue,
  fetchMaybeSnapshotRecord,
  findShareMintPda,
  findVaultStatePda,
} from '@/clients/vault/src/generated';
import { PDAS, PROGRAMS } from '@/config/devnet';
import Link from 'next/link';

interface ProgramSurface {
  id: keyof typeof PROGRAMS;
  name: string;
  description: string;
  reads: ReadAction[];
  writeNote: string;
  writeLinks: { href: string; label: string }[];
}

interface ReadAction {
  label: string;
  fn: (rpc: ReturnType<typeof useRpc>) => Promise<unknown>;
}

const SURFACES: ProgramSurface[] = [
  {
    id: 'governance',
    name: 'Governance',
    description: 'Route registry · default terms · admin whitelist.',
    reads: [
      { label: 'Get Config', fn: (rpc) => readGovernanceConfig(rpc).then(stripDiscriminator) },
    ],
    writeNote: 'set_defaults · whitelist_route · disable_route · update_route_terms · add_admin · remove_admin',
    writeLinks: [{ href: '/admin', label: '/admin' }],
  },
  {
    id: 'vault',
    name: 'Vault',
    description: 'Capital pool · share mint · withdrawal queue · daily snapshots.',
    reads: [
      { label: 'Get VaultState', fn: (rpc) => readVaultState(rpc).then(stripDiscriminator) },
      {
        label: 'Get Withdrawal Queue',
        fn: async (rpc) => {
          const acct = await fetchWithdrawalQueue(rpc, PDAS.withdrawalQueue);
          return stripDiscriminator(acct);
        },
      },
      {
        label: 'Get Today’s Snapshot',
        fn: async (rpc) => {
          const today = BigInt(Math.floor(Date.now() / 1000 / 86400));
          try {
            const { findSnapshotRecordPda } = await import('@/clients/vault/src/generated');
            const [pda] = await findSnapshotRecordPda({ day: today });
            const maybe = await fetchMaybeSnapshotRecord(rpc, pda);
            return maybe.exists
              ? stripDiscriminator(maybe)
              : { day: today.toString(), exists: false };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
      },
      {
        label: 'PDAs',
        fn: async () => ({
          vaultState: PDAS.vaultState,
          withdrawalQueue: PDAS.withdrawalQueue,
          shareMint: (await findShareMintPda())[0],
          findVaultStatePda: (await findVaultStatePda())[0],
        }),
      },
    ],
    writeNote:
      'Underwriter writes (deposit · redeem · request_withdrawal · cancel_withdrawal · collect) live on /earn. Controller-only writes are CPI-only — not callable from the frontend.',
    writeLinks: [{ href: '/earn', label: '/earn' }],
  },
  {
    id: 'oracle_aggregator',
    name: 'Oracle Aggregator',
    description: 'Per-flight FlightData accounts · oracle-authority writes · holds zero funds.',
    reads: [{ label: 'Get Config', fn: (rpc) => readOracleConfig(rpc).then(stripDiscriminator) }],
    writeNote:
      'set_estimated_arrival · set_landed · set_cancelled · set_to_be_settled · set_settled. All require `authorized_oracle` (or controller via CPI). Driven by the cron daemon.',
    writeLinks: [
      { href: '/crons', label: '/crons' },
      { href: '/admin', label: '/admin (set_authorized_oracle)' },
    ],
  },
  {
    id: 'flight_pool',
    name: 'Flight Pool',
    description: 'Per-flight pool registry · buyer records · single shared treasury · claim accounting.',
    reads: [
      { label: 'Get Config', fn: (rpc) => readFlightPoolConfig(rpc).then(stripDiscriminator) },
    ],
    writeNote:
      'User writes (claim · sweep_expired) live on /portfolio. Owner write `withdraw_recovered` is on /admin. Controller-only writes (register_pool · add_buyer · settle_*) are CPI-only.',
    writeLinks: [
      { href: '/portfolio', label: '/portfolio' },
      { href: '/admin', label: '/admin (withdraw_recovered)' },
    ],
  },
  {
    id: 'controller',
    name: 'Controller',
    description: 'The orchestrator · buy_insurance (traveler) · classify_flights + execute_settlements (keeper).',
    reads: [
      { label: 'Get Config', fn: (rpc) => readControllerConfig(rpc).then(stripDiscriminator) },
      {
        label: 'Get Active Flights',
        fn: async (rpc) => {
          const acct = await fetchActiveFlightList(rpc, PDAS.activeFlightList);
          return stripDiscriminator(acct);
        },
      },
    ],
    writeNote:
      'buy_insurance lives on /buy. Keeper-only writes are stubbed on /crons; the off-chain cron daemon runs them.',
    writeLinks: [
      { href: '/buy', label: '/buy' },
      { href: '/crons', label: '/crons' },
      { href: '/admin', label: '/admin (set_authorized_keeper)' },
    ],
  },
];

function stripDiscriminator<T extends { data: unknown }>(acct: T): unknown {
  const data = acct.data as Record<string, unknown>;
  const { discriminator: _drop, ...rest } = data as { discriminator?: unknown };
  void _drop;
  return JSON.parse(
    JSON.stringify(rest, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

export default function ContractsPage() {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpenIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOpen = openIds.size === SURFACES.length;
  const setAll = (open: boolean) =>
    setOpenIds(open ? new Set(SURFACES.map((s) => s.id)) : new Set());

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 14, maxWidth: 1100 }}>
      <div className="row between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Contracts Explorer</h1>
          <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
            Live devnet PDAs · {SURFACES.length} programs · click a row to expand
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 10 }}
            onClick={() => setAll(true)}
            disabled={allOpen}
          >
            Expand all
          </button>
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 10 }}
            onClick={() => setAll(false)}
            disabled={openIds.size === 0}
          >
            Collapse all
          </button>
        </div>
      </div>

      <div className="col" style={{ gap: 6 }}>
        {SURFACES.map((s) => (
          <ProgramRow
            key={s.id}
            surface={s}
            open={openIds.has(s.id)}
            onToggle={() => toggle(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProgramRow({
  surface,
  open,
  onToggle,
}: {
  surface: ProgramSurface;
  open: boolean;
  onToggle: () => void;
}) {
  const rpc = useRpc();
  const { show } = useToast();
  const [output, setOutput] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (action: ReadAction) => {
    setBusy(action.label);
    try {
      const result = await action.fn(rpc);
      setOutput(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOutput({ error: msg });
      show({ kind: 'error', title: 'Read failed', body: msg.slice(0, 240) });
    } finally {
      setBusy(null);
    }
  };

  const programId = PROGRAMS[surface.id];

  return (
    <section
      className="panel"
      style={{
        padding: 0,
        overflow: 'hidden',
        borderColor: open ? 'var(--cyan)' : 'var(--line)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%',
          background: open ? 'var(--bg-2)' : 'transparent',
          border: 'none',
          padding: '14px 18px',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          color: 'var(--ink)',
          fontFamily: 'inherit',
          transition: 'background .15s',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 14,
            color: 'var(--ink-3)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform .15s',
          }}
        >
          ▶
        </span>
        <span className="num" style={{ fontSize: 14, minWidth: 130 }}>
          {surface.name}
        </span>
        <code
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--ink-3)',
            background: 'var(--bg)',
            padding: '2px 8px',
            borderRadius: 4,
          }}
        >
          {programId.slice(0, 4)}…{programId.slice(-4)}
        </code>
        <span className="muted mono" style={{ fontSize: 11, flex: 1 }}>
          {surface.description}
        </span>
        <span
          className="badge"
          style={{
            fontSize: 9,
            background: 'transparent',
            color: 'var(--ink-3)',
            border: '1px solid var(--line-2)',
          }}
        >
          {surface.reads.length} reads
        </span>
      </button>

      {open && (
        <div
          style={{
            padding: '0 18px 18px 46px',
            borderTop: '1px solid var(--line)',
          }}
        >
          <div style={{ marginTop: 14, marginBottom: 14 }}>
            <AddressBadge address={programId} label="program" />
          </div>

          <div className="col" style={{ gap: 10 }}>
            <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
              READS
            </span>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {surface.reads.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="btn ghost"
                  onClick={() => void run(a)}
                  disabled={busy === a.label}
                  style={{ fontSize: 11 }}
                >
                  {busy === a.label ? '…' : a.label}
                </button>
              ))}
              {output !== null && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setOutput(null)}
                  style={{ fontSize: 10, marginLeft: 8 }}
                >
                  Clear
                </button>
              )}
            </div>

            {output !== null && (
              <pre
                className="mono"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  padding: 12,
                  fontSize: 10.5,
                  maxHeight: 320,
                  overflow: 'auto',
                  margin: 0,
                  color: 'var(--ink)',
                }}
              >
                {JSON.stringify(output, null, 2)}
              </pre>
            )}
          </div>

          <div
            className="col"
            style={{
              gap: 8,
              marginTop: 16,
              paddingTop: 12,
              borderTop: '1px solid var(--line)',
            }}
          >
            <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
              WRITES
            </span>
            <p
              className="mono"
              style={{
                color: 'var(--ink-2)',
                fontSize: 11,
                margin: 0,
                lineHeight: 1.6,
              }}
            >
              {surface.writeNote}
            </p>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {surface.writeLinks.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="btn ghost"
                  style={{ fontSize: 10 }}
                >
                  {l.label} ↗
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
