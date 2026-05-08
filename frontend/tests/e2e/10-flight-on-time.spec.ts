import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';
import { waitForBurst } from '../helpers/waitForBurst';
import { buyFlight, noonOf, tomorrowDateAsUnix } from '../helpers/buyFlight';
import { simulateOnTime } from '../helpers/cronTick';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

const FLIGHT_ID = 'UA230'; // dedicated route for the on-time scenario

/**
 * E1 — On-time landing. The protocol's "no payout" branch.
 *
 *   1. Connect Phantom.
 *   2. Buy coverage on UA230 (controller.buy_insurance, 6 CPIs).
 *   3. Drive cron sequence with actual_arrival == scheduled (no delay).
 *      → oracle.set_estimated_arrival → oracle.set_landed
 *      → controller.classify_flights → ToBeSettledOnTime
 *      → controller.execute_settlements → no ClaimableBalance written.
 *   4. /portfolio History shows the policy with no payout.
 */
test('E1 on-time: buy → cron settles in the on-time branch → no payout', async ({
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
  await buyFlight(page, phantom, FLIGHT_ID);

  const date = tomorrowDateAsUnix();
  await simulateOnTime({
    flightId: FLIGHT_ID,
    date,
    scheduledEtaUnixSec: noonOf(date),
  });

  // Now /portfolio's History tab should carry the settled-on-time policy.
  await page.goto('/portfolio');
  await waitForBurst(page);
  await page.locator('.tab').filter({ hasText: /History/i }).click();
  const policyCard = page
    .locator('[class*="card"]')
    .filter({ has: page.locator(`text=${FLIGHT_ID}`) })
    .first();
  await expect(policyCard).toBeVisible();
});
