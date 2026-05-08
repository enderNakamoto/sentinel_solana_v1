import type { Page } from '@playwright/test';
import type { Phantom } from '@synthetixio/synpress/playwright';

/**
 * Drive the Sentinel topbar's Connect button → connector picker
 * (a Wallet Standard modal, not Phantom's own UI) → Phantom approval.
 *
 * Assumes the dapp is already at a connectable page (any route except
 * `/` will do — the topbar is mounted on every non-landing page).
 */
export async function connectWallet(page: Page, phantom: Phantom): Promise<void> {
  // Topbar's "Connect" button is a `.btn.primary` whose accessible name is
  // the literal "Connect" string while disconnected.
  const connectBtn = page.getByRole('button', { name: 'Connect' });
  await connectBtn.click();

  // Picker modal lists detected wallets. Phantom advertises itself as
  // "Phantom" via Wallet Standard.
  await page.getByRole('button', { name: /phantom/i }).click();

  // Phantom's approve-connect modal pops in the extension page.
  await phantom.connectToDapp();

  // Once connected, the topbar swaps to a wallet chip. Wait for it.
  await page.locator('.wallet').waitFor({ state: 'visible', timeout: 15_000 });
}
