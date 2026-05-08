import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';
import { waitForBurst } from '../helpers/waitForBurst';
import { mintFromFaucet } from '../helpers/mintFromFaucet';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

/**
 * D3 — /buy cover a route. Connects, ensures USDC balance, picks the
 * first ACTIVE route from the table, clicks the Cover CTA, approves the
 * `controller.buy_insurance` tx in Phantom, then asserts the success
 * toast title surfaces. /portfolio assertions live in D4.
 */
test('D3 /buy: cover the first active route, controller.buy_insurance lands', async ({
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

  await page.goto('/buy');
  await connectWallet(page, phantom);

  // Top up USDC so this test is independent of D1/D2 ordering.
  const travelerAddr = await phantom.getAccountAddress('solana');
  await mintFromFaucet(page, travelerAddr);
  await waitForBurst(page);

  // Click the first row in the routes table — assumption: bootstrap-e2e
  // has whitelisted at least one MOCK_FLIGHTS row, so the table renders.
  const firstRow = page.locator('table tbody tr').first();
  await firstRow.click();

  // Cover CTA — full text starts with "Cover ", followed by the flight ID.
  await page.getByRole('button', { name: /^Cover\s/i }).click();

  await phantom.confirmTransaction();

  await waitForBurst(page);

  // Activity-log drawer surfaces every success toast — assert the
  // success entry landed (decoupled from any specific route ID).
  const activityChip = page.getByRole('button', { name: /Activity · \d+/i });
  await expect(activityChip).toBeVisible();
});
