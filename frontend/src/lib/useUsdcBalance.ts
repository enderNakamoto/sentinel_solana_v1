'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWalletSession } from '@solana/react-hooks';
import type { Address } from '@solana/kit';
import { useRpc } from '@/lib/rpc';
import { userUsdcAta } from '@/lib/ata';
import { useTxSuccess } from '@/lib/txEvents';

export interface UsdcBalanceState {
  balance: bigint | null;
  loading: boolean;
  refresh: () => void;
}

export function useUsdcBalance(): UsdcBalanceState {
  const session = useWalletSession();
  const wallet = session?.account.address as Address | undefined;
  const rpc = useRpc();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!wallet) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const ata = await userUsdcAta(wallet);
        const r = await rpc.getTokenAccountBalance(ata).send();
        if (!cancelled) setBalance(BigInt(r.value.amount));
      } catch {
        if (!cancelled) setBalance(0n);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet, rpc, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  // Auto-refresh on any successful transaction in the app (deposit, mint,
  // claim, etc.) so the navbar/earn balance pill stays fresh without a
  // manual page reload.
  useTxSuccess(refresh);

  return { balance, loading, refresh };
}
