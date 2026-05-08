'use client';

import { useToast } from '@/components/Toast';
import { Card } from '@/components/admin/Card';
import { explorerLink } from '@/config/devnet';

interface CronCard {
  id: 'fetcher' | 'classifier' | 'settler';
  name: string;
  cadence: string;
  description: string;
  authority: string;
  lastRun: { ts: string; status: 'OK' | 'idle' | 'failed'; processed: number };
  recent: Array<{ ts: string; flight: string; outcome: string }>;
}

// Mock activity feed — shape mirrors what the future event reader will return.
const CRONS: readonly CronCard[] = [
  {
    id: 'fetcher',
    name: 'Flight Data Fetcher',
    cadence: 'every 2h',
    description:
      'Reads active flights from the oracle, calls AeroAPI for arrival data, and updates on-chain status.',
    authority: '3GjT…3DNv',
    lastRun: { ts: '2026-05-08T14:00:12Z', status: 'OK', processed: 8 },
    recent: [
      { ts: '14:00:12Z', flight: 'UA1437', outcome: 'set_estimated_arrival(+12m)' },
      { ts: '14:00:11Z', flight: 'BA286', outcome: 'set_estimated_arrival(+22m)' },
      { ts: '12:00:09Z', flight: 'EK202', outcome: 'set_landed' },
    ],
  },
  {
    id: 'classifier',
    name: 'Flight Classifier',
    cadence: 'every 1h',
    description:
      'Calls Controller.classify_flights() to compute delay vs threshold and set ToBeSettled* status.',
    authority: 'EXZZ…yEJu',
    lastRun: { ts: '2026-05-08T15:00:03Z', status: 'OK', processed: 4 },
    recent: [
      { ts: '15:00:03Z', flight: 'UA1437', outcome: 'classified → on_time' },
      { ts: '15:00:03Z', flight: 'AA118', outcome: 'classified → delayed (>60m)' },
      { ts: '14:00:01Z', flight: 'NH101', outcome: 'no decision yet' },
    ],
  },
  {
    id: 'settler',
    name: 'Settlement Executor',
    cadence: 'every 5min',
    description:
      'Calls Controller.execute_settlements() to process payouts and the withdrawal queue.',
    authority: 'EXZZ…yEJu',
    lastRun: { ts: '2026-05-08T15:05:00Z', status: 'OK', processed: 1 },
    recent: [
      { ts: '15:05:00Z', flight: 'AA118', outcome: 'settled_delayed (paid 150 USDC)' },
      { ts: '15:05:00Z', flight: '—', outcome: 'process_withdrawal_queue (0 drained)' },
      { ts: '15:00:00Z', flight: '—', outcome: 'snapshot recorded' },
    ],
  },
];

export default function CronsPage() {
  const { show } = useToast();

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 18, maxWidth: 1100 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Cron Jobs</h1>
          <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
            Three off-chain crons keep the protocol ticking. HTTP control surface
            ships in a later phase — buttons below are stubs.
          </div>
        </div>
        <span className="badge amber" style={{ fontSize: 9 }}>
          STUBBED
        </span>
      </div>

      {CRONS.map((c) => (
        <Card
          key={c.id}
          title={c.name}
          hint={`${c.cadence} · signer ${c.authority}`}
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
            {c.description}
          </p>

          <div className="row between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
            <div className="col" style={{ gap: 4 }}>
              <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
                LAST RUN
              </span>
              <span className="mono" style={{ fontSize: 12 }}>
                {c.lastRun.ts}
              </span>
            </div>
            <div className="col" style={{ gap: 4 }}>
              <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
                STATUS
              </span>
              <span
                className={`badge ${
                  c.lastRun.status === 'OK'
                    ? 'green'
                    : c.lastRun.status === 'failed'
                      ? 'red'
                      : 'amber'
                }`}
                style={{ fontSize: 10 }}
              >
                {c.lastRun.status}
              </span>
            </div>
            <div className="col" style={{ gap: 4 }}>
              <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
                PROCESSED
              </span>
              <span className="num" style={{ fontSize: 12 }}>
                {c.lastRun.processed}
              </span>
            </div>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                console.warn(`TODO: wire up cron trigger — ${c.id}`);
                show({
                  kind: 'info',
                  title: `${c.name}: Run Now`,
                  body: 'Cron triggers will land in a later phase.',
                });
              }}
            >
              Run Now
            </button>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
              RECENT EVENTS
            </span>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <tbody>
                {c.recent.map((row, i) => (
                  <tr key={i}>
                    <td
                      className="mono muted"
                      style={{ padding: '4px 8px', borderTop: '1px dashed var(--line)' }}
                    >
                      {row.ts}
                    </td>
                    <td
                      className="num"
                      style={{ padding: '4px 8px', borderTop: '1px dashed var(--line)' }}
                    >
                      {row.flight}
                    </td>
                    <td
                      className="mono"
                      style={{
                        padding: '4px 8px',
                        borderTop: '1px dashed var(--line)',
                        color: 'var(--ink-2)',
                      }}
                    >
                      {row.outcome}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      <div className="muted mono" style={{ fontSize: 10, marginTop: 8 }}>
        Daemon: the cron daemon ships separately (`pnpm cron-daemon`).
        See README §"Running the crons". Devnet keypair authorities:{' '}
        <a href={explorerLink('3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv')} target="_blank" rel="noreferrer">
          oracle
        </a>
        ,{' '}
        <a href={explorerLink('EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu')} target="_blank" rel="noreferrer">
          keeper
        </a>
        .
      </div>
    </div>
  );
}
