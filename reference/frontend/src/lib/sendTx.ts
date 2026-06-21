'use client';

import { useCallback } from 'react';
import { useSolanaClient, useWalletSession } from '@solana/react-hooks';
import type { TransactionInstructionInput } from '@solana/client';
import { useToast } from '@/components/Toast';
import { explorerLink } from '@/config/devnet';
import { emitTxSuccessBurst } from '@/lib/txEvents';
import { useWalletSigner } from '@/lib/useWalletSigner';

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

/**
 * Walk a SolanaError tree (`.context.transactionPlanResult`, `.cause`, nested
 * sequential/parallel results) and pull out the deepest meaningful message
 * plus any simulation logs. The framework-kit's outer `prepareAndSend` error
 * is a generic "transaction plan failed to execute" — the real reason lives
 * one or two levels down.
 */
function formatError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (!(e instanceof Error)) {
    try {
      return JSON.stringify(e);
    } catch {
      return 'Unknown error';
    }
  }

  const messages: string[] = [];
  const logs: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (node: unknown, depth = 0): void => {
    if (depth > 8 || node == null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (typeof obj.message === 'string' && obj.message) {
      messages.push(obj.message);
    }
    if (Array.isArray(obj.logs)) {
      for (const l of obj.logs) {
        if (typeof l === 'string') logs.push(l);
      }
    }

    for (const key of [
      'cause',
      'context',
      'transactionPlanResult',
      'error',
      'reason',
      'inner',
    ]) {
      if (key in obj) visit(obj[key], depth + 1);
    }
    for (const key of ['sequentialResults', 'parallelResults', 'results', 'errors']) {
      const arr = obj[key];
      if (Array.isArray(arr)) {
        for (const item of arr) visit(item, depth + 1);
      }
    }
  };

  visit(e);

  // Dedupe while preserving order. The outermost message ("transaction plan
  // failed to execute") is least useful — drop it if a more specific message
  // exists later in the chain.
  const unique = messages.filter((m, i) => messages.indexOf(m) === i);
  const filtered =
    unique.length > 1
      ? unique.filter((m) => !/transaction plan failed to execute/i.test(m))
      : unique;
  let result = filtered.join(' · ') || 'Transaction failed';

  if (logs.length > 0) {
    result += '\n\n' + logs.slice(-8).join('\n');
  }
  return result;
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
  const walletSigner = useWalletSigner();
  const { show } = useToast();

  return useCallback(
    async (
      instructions: readonly TransactionInstructionInput[],
      options: SendTxOptions = {},
    ): Promise<SendTxResult> => {
      if (!session || !walletSigner) {
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
          // Pass the cached wallet signer (NOT the raw session) so its
          // identity matches any signer reference inside `instructions`.
          // Mismatched instances → kit's "Multiple distinct signers" error.
          authority: walletSigner,
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
        // Three-shot refresh burst (0 / 1.5s / 4s). Single delays miss
        // devnet RPC propagation windows; the burst guarantees the next
        // refetch sees post-tx state.
        emitTxSuccessBurst({ signature: sigStr, source: 'send-tx' });
        return { ok: true, signature: sigStr };
      } catch (e) {
        // Surface the full error in devtools so the planner / sim logs can be
        // inspected when the wrapped message is too generic.
        // eslint-disable-next-line no-console
        console.error('[useSendTx] transaction failed:', e);
        const error = formatError(e);
        show({
          kind: 'error',
          title: options.errorTitle ?? 'Transaction failed',
          body: error.slice(0, 600),
        });
        return { ok: false, error };
      }
    },
    [client, session, walletSigner, show],
  );
}
