'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

/**
 * Toast + activity-log surface.
 *
 * - Success / info toasts auto-dismiss after 4s.
 * - Error toasts stick until the user closes them — so transaction failure
 *   messages can actually be read and copied.
 * - Every toast is also pushed into a module-level ring buffer
 *   (`toastHistory`); use `useToastHistory()` to render an activity log.
 *   `<ActivityLog />` is mounted automatically by the layout's
 *   `<ToastProvider>` and exposes the history as a collapsible drawer.
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  /** When true, toast doesn't auto-dismiss. Errors default to sticky. */
  sticky?: boolean;
  /** Wall-clock timestamp captured at show time (for the activity log). */
  ts: number;
}

interface ToastContextValue {
  show: (t: Omit<ToastEntry, 'id' | 'ts'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be inside <ToastProvider>');
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────
// Activity log (module-level so it survives across components but resets
// on page refresh — for persistence across reloads we'd need sessionStorage).

const HISTORY_LIMIT = 50;
let toastHistory: ToastEntry[] = [];
const historyListeners = new Set<(h: ToastEntry[]) => void>();

function pushHistory(entry: ToastEntry): void {
  toastHistory = [entry, ...toastHistory].slice(0, HISTORY_LIMIT);
  for (const l of historyListeners) l(toastHistory);
}

/**
 * Fire-and-forget bridge: mirror every toast to the Next.js dev-server
 * stdout via /api/log/event so anyone tailing the terminal (e.g. Claude
 * Code) sees the same text the user sees. Failures are swallowed — the
 * UX must not depend on the log endpoint being reachable.
 */
function mirrorToServer(entry: ToastEntry): void {
  if (typeof window === 'undefined') return;
  try {
    void fetch('/api/log/event', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        ts: entry.ts,
        url: window.location.pathname + window.location.search,
      }),
    }).catch(() => undefined);
  } catch {
    // ignore — diagnostic only
  }
}

function clearHistoryInternal(): void {
  toastHistory = [];
  for (const l of historyListeners) l(toastHistory);
}

export function useToastHistory(): {
  history: ToastEntry[];
  clear: () => void;
} {
  const [history, setHistory] = useState<ToastEntry[]>(toastHistory);
  useEffect(() => {
    historyListeners.add(setHistory);
    return () => {
      historyListeners.delete(setHistory);
    };
  }, []);
  return { history, clear: clearHistoryInternal };
}

// ─────────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const show = useCallback((t: Omit<ToastEntry, 'id' | 'ts'>) => {
    const id = Date.now() + Math.random();
    const sticky = t.sticky ?? t.kind === 'error';
    const entry: ToastEntry = { ...t, id, sticky, ts: Date.now() };
    setToasts((cur) => [...cur, entry]);
    pushHistory(entry);
    mirrorToServer(entry);
    if (!sticky) {
      setTimeout(() => {
        setToasts((cur) => cur.filter((x) => x.id !== id));
      }, 4000);
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-host" role="status" aria-live="polite">
          {toasts.map((t) => (
            <ToastItem key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      )}
      <ActivityLog />
    </ToastContext.Provider>
  );
}

function ToastItem({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = entry.body ? `${entry.title}\n${entry.body}` : entry.title;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  return (
    <div
      className={`toast ${entry.kind}`}
      style={{ position: 'relative', cursor: 'pointer' }}
      onClick={copy}
      title="Click to copy"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          background: 'transparent',
          border: 'none',
          color: 'var(--ink-3)',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: 2,
        }}
      >
        ×
      </button>
      <div className="toast-title" style={{ paddingRight: 18 }}>
        {entry.title}
      </div>
      {entry.body && (
        <div
          className="toast-body"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {entry.body}
        </div>
      )}
      {copied && (
        <div
          className="muted mono"
          style={{ fontSize: 10, marginTop: 4, color: 'var(--cyan)' }}
        >
          copied
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ActivityLog — floating chip + drawer showing the toast history.

function ActivityLog() {
  const { history, clear } = useToastHistory();
  const [open, setOpen] = useState(false);
  const errorCount = history.filter((e) => e.kind === 'error').length;

  if (history.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mono"
        style={{
          position: 'fixed',
          bottom: 12,
          right: 12,
          zIndex: 80,
          padding: '6px 10px',
          fontSize: 11,
          borderRadius: 6,
          background: 'var(--bg-2)',
          border: `1px solid ${errorCount > 0 ? 'var(--red)' : 'var(--line)'}`,
          color: errorCount > 0 ? 'var(--red)' : 'var(--ink-2)',
          cursor: 'pointer',
        }}
        title="Toggle activity log"
      >
        Activity · {history.length}
        {errorCount > 0 ? ` · ${errorCount} err` : ''}
      </button>

      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 48,
            right: 12,
            zIndex: 80,
            width: 420,
            maxHeight: '60vh',
            overflowY: 'auto',
            background: 'var(--bg-1)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: '0 10px 30px rgba(0,0,0,.4)',
          }}
        >
          <div
            className="row between"
            style={{
              padding: '10px 12px',
              borderBottom: '1px solid var(--line)',
              alignItems: 'center',
            }}
          >
            <span className="card-title">Activity log</span>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 10, padding: '3px 8px' }}
                onClick={clear}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 10, padding: '3px 8px' }}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
          <div>
            {history.map((e) => (
              <ActivityEntry key={e.id} entry={e} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ActivityEntry({ entry }: { entry: ToastEntry }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const time = new Date(entry.ts).toLocaleTimeString();
  const accent =
    entry.kind === 'error'
      ? 'var(--red)'
      : entry.kind === 'success'
        ? 'var(--green)'
        : 'var(--ink-3)';

  const text = entry.body ? `${entry.title}\n${entry.body}` : entry.title;
  const copy = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  const longBody = !!entry.body && entry.body.length > 160;
  const bodyToShow =
    !entry.body || expanded ? entry.body : `${entry.body.slice(0, 160)}…`;

  return (
    <div
      style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--line)',
        cursor: longBody ? 'pointer' : 'default',
      }}
      onClick={longBody ? () => setExpanded((v) => !v) : undefined}
    >
      <div className="row between" style={{ alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: accent, fontFamily: 'var(--mono)' }}>
          ● {entry.kind.toUpperCase()}
        </span>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted mono" style={{ fontSize: 10 }}>
            {time}
          </span>
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 9, padding: '2px 6px' }}
            onClick={copy}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, fontWeight: 500 }}>{entry.title}</div>
      {entry.body && (
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--ink-2)',
            marginTop: 4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {bodyToShow}
        </div>
      )}
      {longBody && (
        <div className="muted mono" style={{ fontSize: 9, marginTop: 4 }}>
          {expanded ? '· tap to collapse ·' : '· tap to expand ·'}
        </div>
      )}
    </div>
  );
}

/**
 * Mount point alias kept for layout symmetry. Layout renders
 * <ToastProvider> as a wrapper; <ToastHost /> is no longer needed but
 * exported in case any future phase wants a separate visual mount.
 */
export const ToastHost = ToastProvider;
