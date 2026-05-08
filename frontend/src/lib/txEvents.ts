'use client';

import { useEffect, useRef } from 'react';

/**
 * App-wide tx-success event bus.
 *
 * Any successful transaction (wallet-signed via `useSendTx` OR server-signed
 * via the faucet API) calls `emitTxSuccess(...)`. Components that read
 * on-chain state subscribe via `useTxSuccess(refresh)` and re-fetch when
 * notified — so the navbar balance, the /earn vault metrics, etc. stay
 * fresh without a page reload.
 */

export interface TxSuccessDetail {
  signature: string;
  source?: string;
}

type Listener = (detail: TxSuccessDetail) => void;

const listeners = new Set<Listener>();

export function emitTxSuccess(detail: TxSuccessDetail): void {
  for (const l of listeners) {
    try {
      l(detail);
    } catch {
      // ignore — one bad listener shouldn't block the rest
    }
  }
}

/**
 * Emit a tx-success burst: immediately, then at +1.5s and +4s. Devnet RPC
 * propagation lags behind `confirmed` commitment unpredictably, so a single
 * refresh ping can land on a node that still serves pre-tx state. Three
 * pings give pages enough chances to pick up the new state without a
 * manual reload. Cheap (each subscriber's refresh is one RPC fan-out).
 */
export function emitTxSuccessBurst(detail: TxSuccessDetail): void {
  emitTxSuccess(detail);
  setTimeout(() => emitTxSuccess(detail), 1500);
  setTimeout(() => emitTxSuccess(detail), 4000);
}

export function useTxSuccess(onSuccess: Listener): void {
  const ref = useRef(onSuccess);
  ref.current = onSuccess;
  useEffect(() => {
    const handler: Listener = (d) => ref.current(d);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);
}
