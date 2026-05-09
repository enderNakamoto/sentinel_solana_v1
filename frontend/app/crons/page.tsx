'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/components/Toast';
import { Card } from '@/components/admin/Card';
import { CLUSTER, DEPLOYER, explorerLink } from '@/config/devnet';
import { emitTxSuccessBurst, useTxSuccess } from '@/lib/txEvents';

// ─── Types (mirror frontend/src/lib/cron-runs.ts) ────────────────────────

type CronId = 'classifier' | 'settler' | 'fetcher';

interface CronRunRecord {
  id: string;
  cron: CronId;
  ts: string;
  durationMs: number;
  ok: boolean;
  summary: string;
  signatures: string[];
  logs: string;
  error?: string;
}

interface ActiveFlight {
  flightId: string;
  date: string;
  status: string;
}

type FetcherMode = 'live' | 'mock';
type MockScenario = 'on_time' | 'delayed' | 'cancelled' | 'scheduled' | 'not_found';

interface FetcherConfig {
  liveAvailable: boolean;
  defaultMode: FetcherMode;
  defaultScenario: MockScenario;
  scenarios: readonly MockScenario[];
}

// ─── Static metadata per cron card ───────────────────────────────────────

interface CronMeta {
  id: CronId;
  name: string;
  cadence: string;
  description: string;
  signerLabel: string;
  signerPubkey?: string;
}

const CRON_META: readonly CronMeta[] = [
  {
    id: 'fetcher',
    name: 'Flight Data Fetcher',
    cadence: 'every 2h',
    description:
      'Centralised AeroAPI cron — signed by the deployer. Phase 19 will swap this for a TEE / Switchboard oracle. Set AEROAPI_MOCK=1 for demo mode without an API key.',
    signerLabel: 'authorized_oracle',
    signerPubkey: DEPLOYER,
  },
  {
    id: 'classifier',
    name: 'Flight Classifier',
    cadence: 'every 1h',
    description:
      'Calls Controller.classify_flights() to compute delay vs threshold and set ToBeSettled* status.',
    signerLabel: 'authorized_keeper',
    signerPubkey: DEPLOYER,
  },
  {
    id: 'settler',
    name: 'Settlement Executor',
    cadence: 'every 5min',
    description:
      'Calls Controller.execute_settlements() to process payouts and the withdrawal queue.',
    signerLabel: 'authorized_keeper',
    signerPubkey: DEPLOYER,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function statusColor(status: string): string {
  if (status === 'Active' || status === 'Landed') return 'var(--cyan)';
  if (status.startsWith('ToBeSettled')) return 'var(--amber)';
  if (status === 'Settled') return 'var(--green)';
  if (status === 'Cancelled') return 'var(--red)';
  return 'var(--ink-3)';
}

// ─── Page ────────────────────────────────────────────────────────────────

export default function CronsPage() {
  const { show } = useToast();
  const [runs, setRuns] = useState<CronRunRecord[]>([]);
  const [activeFlights, setActiveFlights] = useState<ActiveFlight[] | null>(null);
  const [activeFlightsErr, setActiveFlightsErr] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<CronId | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [fetcherCfg, setFetcherCfg] = useState<FetcherConfig | null>(null);
  const [fetcherMode, setFetcherMode] = useState<FetcherMode>('mock');
  const [fetcherScenario, setFetcherScenario] = useState<MockScenario>('on_time');

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);
  useTxSuccess(refresh);

  // One-shot: read the server-side fetcher config so we know whether
  // live mode is even available and what the env defaults are.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/cron/fetcher/config')
      .then((r) => r.json())
      .then((data: { ok: boolean } & FetcherConfig) => {
        if (cancelled || !data.ok) return;
        setFetcherCfg(data);
        setFetcherMode(data.defaultMode);
        setFetcherScenario(data.defaultScenario);
      })
      .catch(() => {
        /* fall back to defaults; UI stays usable */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll runs + active flights every 10s.
  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      try {
        const [rRuns, rActive] = await Promise.all([
          fetch('/api/cron/runs?limit=20').then((r) => r.json()),
          fetch('/api/cron/active-flights').then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (rRuns.ok) setRuns(rRuns.runs as CronRunRecord[]);
        if (rActive.ok) {
          setActiveFlights(rActive.flights as ActiveFlight[]);
          setActiveFlightsErr(null);
        } else {
          setActiveFlightsErr(rActive.error ?? 'unknown error');
        }
      } catch (e) {
        if (!cancelled) {
          setActiveFlightsErr(e instanceof Error ? e.message : String(e));
        }
      }
    };
    void fetchAll();
    const t = setInterval(fetchAll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refreshTick]);

  const runsByCron = useMemo(() => {
    const map: Record<CronId, CronRunRecord[]> = {
      classifier: [],
      settler: [],
      fetcher: [],
    };
    for (const r of runs) {
      if (
        r.cron === 'classifier' ||
        r.cron === 'settler' ||
        r.cron === 'fetcher'
      ) {
        map[r.cron].push(r);
      }
    }
    return map;
  }, [runs]);

  const failedCount = useMemo(() => {
    let n = 0;
    for (const cron of ['classifier', 'settler', 'fetcher'] as const) {
      const last = runsByCron[cron][0];
      if (last && !last.ok) n++;
    }
    return n;
  }, [runsByCron]);

  const trigger = async (id: CronId) => {
    setPendingId(id);
    try {
      let url = `/api/cron/${id}/trigger`;
      if (id === 'fetcher') {
        const params = new URLSearchParams({ mode: fetcherMode });
        if (fetcherMode === 'mock') params.set('scenario', fetcherScenario);
        url += `?${params.toString()}`;
      }
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await r.json()) as {
        ok: boolean;
        summary?: string;
        error?: string;
      };
      if (r.status === 409) {
        show({
          kind: 'error',
          title: `${id} already running`,
          body: data.error ?? 'Another tick is in flight.',
        });
        return;
      }
      if (!r.ok || !data.ok) {
        show({
          kind: 'error',
          title: `${id} failed`,
          body: (data.error ?? 'Unknown error').slice(0, 600),
        });
        return;
      }
      show({
        kind: 'success',
        title: `${id}: ${data.summary ?? 'OK'}`,
      });
      // The trigger may have written tx state — bump the burst so the
      // navbar pill / other pages also refetch.
      emitTxSuccessBurst({ signature: 'cron-tick', source: `cron-${id}` });
      refresh();
    } catch (e) {
      show({
        kind: 'error',
        title: `${id} request failed`,
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 18, maxWidth: 1100 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Cron Jobs</h1>
          <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
            Operator control panel · cluster {CLUSTER}
          </div>
        </div>
        <span className="badge cyan" style={{ fontSize: 9 }}>
          {CLUSTER.toUpperCase()}
        </span>
      </div>

      {failedCount > 0 && (
        <div
          className="panel"
          style={{
            padding: 12,
            borderColor: 'var(--red)',
            color: 'var(--red)',
            fontSize: 12,
          }}
        >
          ⚠ {failedCount} cron{failedCount > 1 ? 's' : ''} failed on the most
          recent run. Scroll to the matching card for the error.
        </div>
      )}

      <ActivePanel flights={activeFlights} error={activeFlightsErr} />

      {CRON_META.map((meta) => (
        <CronCard
          key={meta.id}
          meta={meta}
          runs={runsByCron[meta.id] ?? []}
          pending={pendingId === meta.id}
          expandedRunId={expandedRunId}
          onToggleExpand={(id) =>
            setExpandedRunId((cur) => (cur === id ? null : id))
          }
          onTrigger={() => void trigger(meta.id)}
          fetcherCfg={meta.id === 'fetcher' ? fetcherCfg : null}
          fetcherMode={meta.id === 'fetcher' ? fetcherMode : null}
          fetcherScenario={meta.id === 'fetcher' ? fetcherScenario : null}
          onFetcherModeChange={meta.id === 'fetcher' ? setFetcherMode : undefined}
          onFetcherScenarioChange={meta.id === 'fetcher' ? setFetcherScenario : undefined}
        />
      ))}

      <div className="muted mono" style={{ fontSize: 10, marginTop: 8 }}>
        Daemon: the cron daemon ships separately (`pnpm cron-daemon`).
        Triggers above call the same `runFetcherOnce` / `runClassifierOnce`
        / `runSettlerOnce` helpers as the daemon — single source of truth.
      </div>
    </div>
  );
}

// ─── Active flight list panel ────────────────────────────────────────────

function ActivePanel({
  flights,
  error,
}: {
  flights: ActiveFlight[] | null;
  error: string | null;
}) {
  return (
    <Card title="Active Flights" hint="What the next cron tick would see.">
      {error ? (
        <div
          className="muted mono"
          style={{ fontSize: 11, color: 'var(--red)' }}
        >
          {error}
        </div>
      ) : flights === null ? (
        <div className="muted mono" style={{ fontSize: 11 }}>
          loading…
        </div>
      ) : flights.length === 0 ? (
        <div className="muted mono" style={{ fontSize: 11 }}>
          No active flights — buy coverage on /buy to populate the list.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
              <th align="left" style={cellHead}>FLIGHT</th>
              <th align="left" style={cellHead}>DATE (unix-day)</th>
              <th align="left" style={cellHead}>STATUS</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((f) => (
              <tr key={`${f.flightId}-${f.date}`}>
                <td style={cellBody}>
                  <span className="num">{f.flightId}</span>
                </td>
                <td style={cellBody}>
                  <span className="mono muted" style={{ fontSize: 10 }}>
                    {f.date}
                  </span>
                </td>
                <td style={cellBody}>
                  <span style={{ color: statusColor(f.status), fontFamily: 'var(--mono)' }}>
                    {f.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

const cellHead: React.CSSProperties = {
  borderBottom: '1px solid var(--line)',
  padding: '6px 8px',
  fontSize: 10,
  letterSpacing: '.08em',
};
const cellBody: React.CSSProperties = {
  borderBottom: '1px dashed var(--line)',
  padding: '5px 8px',
};

// ─── Per-cron card ───────────────────────────────────────────────────────

interface CardProps {
  meta: CronMeta;
  runs: CronRunRecord[];
  pending: boolean;
  expandedRunId: string | null;
  onToggleExpand: (id: string) => void;
  onTrigger: () => void;
  /** Fetcher-only — null for classifier/settler cards. */
  fetcherCfg: FetcherConfig | null;
  fetcherMode: FetcherMode | null;
  fetcherScenario: MockScenario | null;
  onFetcherModeChange?: (m: FetcherMode) => void;
  onFetcherScenarioChange?: (s: MockScenario) => void;
}

function CronCard({
  meta,
  runs,
  pending,
  expandedRunId,
  onToggleExpand,
  onTrigger,
  fetcherCfg,
  fetcherMode,
  fetcherScenario,
  onFetcherModeChange,
  onFetcherScenarioChange,
}: CardProps) {
  const last = runs[0];
  const lastBadge = !last
    ? { color: 'var(--ink-3)', label: 'IDLE' }
    : last.ok
      ? { color: 'var(--green)', label: 'OK' }
      : { color: 'var(--red)', label: 'FAILED' };

  return (
    <Card
      title={meta.name}
      hint={`${meta.cadence} · signer ${meta.signerLabel}${
        meta.signerPubkey ? ` (${meta.signerPubkey.slice(0, 4)}…${meta.signerPubkey.slice(-4)})` : ''
      }`}
    >
      <p
        style={{
          color: 'var(--ink-2)',
          fontSize: 13,
          lineHeight: 1.5,
          margin: 0,
          marginBottom: 14,
        }}
      >
        {meta.description}
      </p>

      {meta.id === 'fetcher' &&
        fetcherMode &&
        onFetcherModeChange &&
        onFetcherScenarioChange && (
          <FetcherControls
            cfg={fetcherCfg}
            mode={fetcherMode}
            scenario={fetcherScenario ?? 'on_time'}
            onModeChange={onFetcherModeChange}
            onScenarioChange={onFetcherScenarioChange}
          />
        )}

      <div className="row between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div className="col" style={{ gap: 4 }}>
          <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
            LAST RUN
          </span>
          <span className="mono" style={{ fontSize: 12 }}>
            {last ? relativeTime(last.ts) : 'idle'}
          </span>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
            STATUS
          </span>
          <span
            className="badge"
            style={{
              fontSize: 10,
              background: 'transparent',
              border: `1px solid ${lastBadge.color}`,
              color: lastBadge.color,
            }}
          >
            {lastBadge.label}
          </span>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={pending}
          onClick={onTrigger}
        >
          {pending ? 'Running…' : 'Trigger now'}
        </button>
      </div>

      <div className="col" style={{ gap: 6 }}>
        <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
          ACTIVITY
        </span>
        {runs.length === 0 ? (
          <div className="muted mono" style={{ fontSize: 11 }}>
            no runs yet — click Trigger now to fire one
          </div>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 6,
            }}
          >
            {runs.map((r) => (
              <RunRow
                key={r.id}
                record={r}
                expanded={expandedRunId === r.id}
                onToggle={() => onToggleExpand(r.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ─── Fetcher Mock/Live controls ──────────────────────────────────────────

const SCENARIO_LABEL: Record<MockScenario, string> = {
  on_time: 'on-time landing',
  delayed: 'delayed landing (>45 min)',
  cancelled: 'cancelled flight',
  scheduled: 'scheduled (no resolution yet)',
  not_found: 'AeroAPI returned no rows',
};

function FetcherControls({
  cfg,
  mode,
  scenario,
  onModeChange,
  onScenarioChange,
}: {
  cfg: FetcherConfig | null;
  mode: FetcherMode;
  scenario: MockScenario;
  onModeChange: (m: FetcherMode) => void;
  onScenarioChange: (s: MockScenario) => void;
}) {
  const liveAvailable = cfg?.liveAvailable ?? false;
  const scenarios = cfg?.scenarios ?? (
    ['on_time', 'delayed', 'cancelled', 'scheduled', 'not_found'] as const
  );

  const accent = mode === 'live' ? 'var(--cyan)' : 'var(--amber)';
  const headline =
    mode === 'live'
      ? 'LIVE — calls FlightAware AeroAPI'
      : `MOCK — ${scenario} (${SCENARIO_LABEL[scenario]})`;
  const subline =
    mode === 'live'
      ? 'Each trigger sends a real HTTP request to api.flightaware.com using AEROAPI_KEY. Counts against your quota.'
      : 'No HTTP calls — deterministic in-process stub. Pick a scenario below to drive the next state transition.';

  const ToggleButton = ({
    value,
    label,
    color,
    disabled,
    title,
  }: {
    value: FetcherMode;
    label: string;
    color: string;
    disabled?: boolean;
    title?: string;
  }) => {
    const active = mode === value;
    return (
      <button
        type="button"
        onClick={() => !disabled && onModeChange(value)}
        disabled={disabled}
        title={title}
        style={{
          flex: '1 1 0',
          padding: '10px 14px',
          fontSize: 12,
          fontFamily: 'var(--mono)',
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          fontWeight: active ? 700 : 400,
          background: active ? color : 'transparent',
          color: active ? 'var(--bg-0)' : disabled ? 'var(--ink-3)' : 'var(--ink-1)',
          border: `1px solid ${active ? color : 'var(--ink-3)'}`,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 120ms, color 120ms',
        }}
      >
        <span style={{ marginRight: 8 }}>{active ? '●' : '○'}</span>
        {label}
        {value === 'live' && !liveAvailable && (
          <span style={{ marginLeft: 8, fontSize: 9, opacity: 0.7 }}>
            (no key)
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 14,
        border: `1px solid ${accent}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 4,
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      {/* Big status headline */}
      <div className="col" style={{ gap: 4, marginBottom: 12 }}>
        <span
          className="mono"
          style={{
            fontSize: 9,
            letterSpacing: '.14em',
            color: 'var(--ink-3)',
          }}
        >
          AERO API SOURCE
        </span>
        <span
          className="mono"
          style={{
            fontSize: 14,
            color: accent,
            fontWeight: 600,
            letterSpacing: '.04em',
          }}
        >
          {headline}
        </span>
        <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>
          {subline}
        </span>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8 }}>
        <ToggleButton
          value="live"
          label="Live"
          color="var(--cyan)"
          disabled={!liveAvailable}
          title={
            liveAvailable
              ? 'Calls api.flightaware.com using AEROAPI_KEY'
              : 'AEROAPI_KEY not set in frontend/.env.local — Live mode unavailable'
          }
        />
        <ToggleButton
          value="mock"
          label="Mock"
          color="var(--amber)"
          title="Deterministic in-process stub. No API calls. Great for demos."
        />
      </div>

      {/* Scenario picker — only when mock is active */}
      {mode === 'mock' && (
        <div className="col" style={{ gap: 6, marginTop: 12 }}>
          <span
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: '.14em',
              color: 'var(--ink-3)',
            }}
          >
            MOCK SCENARIO
          </span>
          <select
            value={scenario}
            onChange={(e) => onScenarioChange(e.target.value as MockScenario)}
            style={{
              padding: '8px 10px',
              fontSize: 12,
              fontFamily: 'var(--mono)',
              background: 'var(--bg-1)',
              color: 'var(--ink-1)',
              border: `1px solid var(--amber)`,
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            {scenarios.map((s) => (
              <option key={s} value={s} style={{ background: 'var(--bg-1)' }}>
                {s} — {SCENARIO_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Live-mode key status — only when live is active */}
      {mode === 'live' && liveAvailable && (
        <div
          style={{
            marginTop: 10,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            color: 'var(--cyan)',
            letterSpacing: '.04em',
          }}
        >
          AEROAPI_KEY detected · loaded from frontend/.env.local
        </div>
      )}
    </div>
  );
}

// ─── Per-record row ──────────────────────────────────────────────────────

function RunRow({
  record,
  expanded,
  onToggle,
}: {
  record: CronRunRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const ok = record.ok;
  const accent = ok ? 'var(--green)' : 'var(--red)';
  const tsLabel = relativeTime(record.ts);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = JSON.stringify(record, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <li
      style={{
        padding: '8px 10px',
        border: `1px solid ${ok ? 'var(--line)' : 'var(--red)'}`,
        borderRadius: 6,
        background: ok ? 'transparent' : 'rgba(255,80,80,.05)',
      }}
    >
      <div
        className="row"
        style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <span
          className="badge"
          style={{
            fontSize: 9,
            background: 'transparent',
            border: `1px solid ${accent}`,
            color: accent,
          }}
        >
          {ok ? 'OK' : 'FAILED'}
        </span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
          {tsLabel}
        </span>
        <span
          className="mono"
          style={{ fontSize: 11, color: ok ? 'var(--ink)' : 'var(--red)' }}
        >
          {record.summary}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn ghost"
          style={{ fontSize: 10, padding: '2px 8px' }}
          onClick={onToggle}
        >
          {expanded ? 'Hide log' : 'View log'}
        </button>
        {expanded && (
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 10, padding: '2px 8px' }}
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {record.signatures.length > 0 && (
            <div className="col" style={{ gap: 4, marginBottom: 8 }}>
              <span className="muted mono" style={{ fontSize: 9, letterSpacing: '.1em' }}>
                SIGNATURES
              </span>
              {record.signatures.map((sig) => (
                <a
                  key={sig}
                  href={explorerLink(sig, 'tx') || undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{ fontSize: 11 }}
                >
                  {sig.slice(0, 16)}…{sig.slice(-8)} ↗
                </a>
              ))}
            </div>
          )}
          <pre
            style={{
              fontSize: 10,
              fontFamily: 'var(--mono)',
              color: 'var(--ink-2)',
              background: 'var(--bg-2)',
              padding: 8,
              borderRadius: 4,
              maxHeight: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
            }}
          >
            {record.logs || '(no captured output)'}
          </pre>
        </div>
      )}
    </li>
  );
}
