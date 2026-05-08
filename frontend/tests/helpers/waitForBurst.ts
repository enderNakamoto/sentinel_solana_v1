import type { Page } from '@playwright/test';

/**
 * `useSendTx` and the faucet client emit a 3-shot tx-success burst at
 * 0ms / 1500ms / 4000ms after a confirmed tx. Pages auto-refetch on each
 * ping. After a successful action that triggers a tx, callers should
 * `await waitForBurst(page)` before asserting on UI numbers — otherwise
 * the assertion can race against an in-flight RPC fetch and see stale
 * state.
 *
 * Default budget is 6 seconds (4s burst tail + 2s fetch slack). Override
 * for slow devnet runs or when the assertion involves a state change
 * that takes longer to settle (e.g. cron-driven settlement).
 */
export async function waitForBurst(
  page: Page,
  budgetMs = 6_000,
): Promise<void> {
  await page.waitForTimeout(budgetMs);
}
