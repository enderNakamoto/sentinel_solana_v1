import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';
import { waitForBurst } from '../helpers/waitForBurst';
import { buyFlight, noonOf, tomorrowDateAsUnix } from '../helpers/buyFlight';
import { simulateCancelled } from '../helpers/cronTick';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

const FLIGHT_ID = 'AS280'; // dedicated route for the cancelled scenario

/**
 * E3 — Cancelled flight. Always pays out (no threshold gate, per
 * controller.execute_settlements).
 *
 *   1. Connect Phantom + buy coverage on AS280.
 *   2. Drive cron with status=Cancelled before ETA:
 *      → oracle.set_cancelled
 *      → classify → ToBeSettledCancelled
 *      → execute_settlements → ClaimableBalance written for buyer.
 *   3. /portfolio shows policy as claimable; click Claim → confirm.
 *   4. Buyer USDC balance increases by the payout.
 */
test('E3 cancelled: buy → cancellation → cron writes payout → claim → balance up', async ({
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
  await simulateCancelled({
    flightId: FLIGHT_ID,
    date,
    scheduledEtaUnixSec: noonOf(date),
  });

  await page.goto('/portfolio');
  await waitForBurst(page);

  const balPill = page.locator('.wallet .bal');
  const beforeClaim = (await balPill.textContent())?.trim() ?? '';

  await page.locator('.tab').filter({ hasText: /Active/i }).click();
  const claimBtn = page.getByRole('button', { name: /^Claim/i }).first();
  await claimBtn.click();
  await phantom.confirmTransaction();
  await waitForBurst(page);

  const afterClaim = (await balPill.textContent())?.trim() ?? '';
  expect(afterClaim).not.toBe(beforeClaim);
});
