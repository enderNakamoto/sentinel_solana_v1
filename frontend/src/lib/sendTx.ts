'use client';

import { useCallback } from 'react';
import { useSolanaClient, useWalletSession } from '@solana/react-hooks';
import type { TransactionInstructionInput } from '@solana/client';
import { useToast } from '@/components/Toast';
import { explorerLink } from '@/config/devnet';

export type SendTxResult =
  | { ok: true; signature: string }
  | { ok: false; error: string };

export interface SendTxOptions {
  /** Toast title shown on success. */
  successTitle?: string;
  /** Toast title shown on error. */
  errorTitle?: string;
  /** Pre-flight compute-unit-limit hint (defaults to framework-kit auto). */
  computeUnitLimit?: number;
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

/**
 * `useSendTx()` — returns a function that builds, signs (via wallet standard),
 * and sends a transaction. Surfaces toast notifications for success / error,
 * and returns the signature so the caller can update local state.
 *
 * Pattern (from CLAUDE.md guardrail W009):
 * 1. Refuse to build a tx without a connected wallet
 * 2. Use `client.transaction.prepareAndSend` — framework-kit handles the
 *    blockhash + fee-payer + simulate-before-sign cycle
 * 3. Toast the result with an explorer link
 */
export function useSendTx() {
  const client = useSolanaClient();
  const session = useWalletSession();
  const { show } = useToast();

  return useCallback(
    async (
      instructions: readonly TransactionInstructionInput[],
      options: SendTxOptions = {},
    ): Promise<SendTxResult> => {
      if (!session) {
        show({
          kind: 'error',
          title: options.errorTitle ?? 'Wallet not connected',
          body: 'Connect a wallet to sign and send the transaction.',
        });
        return { ok: false, error: 'Wallet not connected' };
      }

      try {
        const sig = await client.transaction.prepareAndSend({
          instructions,
          authority: session,
          ...(options.computeUnitLimit
            ? { computeUnitLimit: options.computeUnitLimit }
            : {}),
        });

        const sigStr = String(sig);
        show({
          kind: 'success',
          title: options.successTitle ?? 'Transaction sent',
          body: `${sigStr.slice(0, 8)}…${sigStr.slice(-8)} · ${explorerLink(sigStr, 'tx')}`,
        });
        return { ok: true, signature: sigStr };
      } catch (e) {
        const error = formatError(e);
        show({
          kind: 'error',
          title: options.errorTitle ?? 'Transaction failed',
          body: error.slice(0, 240),
        });
        return { ok: false, error };
      }
    },
    [client, session, show],
  );
}
