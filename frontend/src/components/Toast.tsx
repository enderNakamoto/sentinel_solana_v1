'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';

/**
 * Phantom-style transient toast. Phase 12 stub buttons (Cover / Deposit /
 * Redeem / Claim) dispatch fake-success toasts so the handler wiring is
 * proven; Phase 13–15 will extend with real tx-signature toasts.
 *
 * Usage:
 *   const { show } = useToast();
 *   show({ kind: 'success', title: 'Coverage purchased', body: 'TODO: real ix' });
 *
 * Layout wraps the app in <ToastProvider> and renders <ToastStack />
 * inside the same provider so the visual + the consumer hooks share context.
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

interface ToastContextValue {
  show: (t: Omit<ToastEntry, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const show = useCallback((t: Omit<ToastEntry, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((cur) => [...cur, { ...t, id }]);
    // Auto-dismiss after 4s.
    setTimeout(() => {
      setToasts((cur) => cur.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-host" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="toast-body">{t.body}</div>}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

/**
 * Mount point alias kept for layout symmetry. Layout renders
 * <ToastProvider> as a wrapper; <ToastHost /> is no longer needed but
 * exported in case any future phase wants a separate visual mount.
 */
export const ToastHost = ToastProvider;
