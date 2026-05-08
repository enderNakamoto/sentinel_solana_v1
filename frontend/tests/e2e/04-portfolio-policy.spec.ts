import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';
import { waitForBurst } from '../helpers/waitForBurst';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

/**
 * D4 — /portfolio shows at least one Active policy after D3 ran. The
 * BuyerRecord PDA from D3's `buy_insurance` is discovered via
 * getProgramAccounts + double-memcmp (discriminator + buyer @ offset 8).
 */
test('D4 /portfolio: previously-bought policy renders in Active tab', async ({
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

  await page.goto('/portfolio');
  await connectWallet(page, phantom);

  // Page does an initial read on connect; give it time.
  await waitForBurst(page);

  // Active tab pill carries a count badge; expect ≥ 1 after D3.
  const activeTab = page.locator('.tab').filter({ hasText: /^Active/i });
  await expect(activeTab).toBeVisible();
  await expect(activeTab).toContainText(/[1-9]/);

  // At least one policy card visible.
  const policyCard = page.locator('[class*="card"]').filter({ has: page.locator('text=/Premium paid/i') }).first();
  await expect(policyCard).toBeVisible();
});
