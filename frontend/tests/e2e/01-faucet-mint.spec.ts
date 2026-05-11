import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';
import { waitForBurst } from '../helpers/waitForBurst';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

/**
 * D1 — faucet smoke. Highest-value first test because:
 *   - Exercises Wallet Standard handshake (Phantom → framework-kit).
 *   - Exercises the /api/faucet/mint server route (no wallet signature
 *     needed; deployer pays + mock-pusd-authority signs server-side).
 *   - Exercises the tx-success burst pipeline + usePusdBalance hook
 *     (navbar pill should bump within ~6s of the success toast).
 *
 * Requires: surfpool running, frontend in surfpool mode, bootstrap-e2e
 * has airdropped SOL to the e2e-traveler address. Bootstrap doesn't pre-mint
 * USDC to the traveler — that's what this test does, on purpose, to
 * exercise the live faucet path.
 */
test('D1 faucet: mint mock USDC, navbar pill bumps without page reload', async ({
  context,
  page,
  phantomPage,
  extensionId,
}) => {
  const phantom = new Phantom(
    context,
    phantomPage,
    basicSetup.walletPassword,
    extensionId,
  );

  await page.goto('/faucet');
  await connectWallet(page, phantom);

  // Capture the navbar's USDC pill text before mint.
  const balPill = page.locator('.wallet .bal');
  await expect(balPill).toBeVisible();
  const before = (await balPill.textContent())?.trim() ?? '— USDC';

  // Click the public faucet button (no Phantom approval needed —
  // server-side signs).
  await page.getByRole('button', { name: /Mint 10,000 USDC/i }).click();

  // Wait for the 3-shot useTxSuccess burst to propagate to the
  // usePusdBalance hook.
  await waitForBurst(page);

  const after = (await balPill.textContent())?.trim() ?? '— USDC';
  expect(after).not.toBe(before);
  // Should now contain at least the 10,000 we just minted (formatted).
  expect(after).toMatch(/10,?000/);
});
