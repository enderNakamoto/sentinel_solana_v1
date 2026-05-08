import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';
import { waitForBurst } from '../helpers/waitForBurst';
import { buyFlight, noonOf, tomorrowDateAsUnix } from '../helpers/buyFlight';
import { simulateDelayed } from '../helpers/cronTick';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

const FLIGHT_ID = 'UA247'; // dedicated route for the delayed scenario
const DELAY_MINUTES = 90; // > 60-min threshold → triggers delayed branch

/**
 * E2 — Delayed landing. The protocol's "payout via vault" branch.
 *
 *   1. Connect Phantom + buy coverage on UA247.
 *   2. Drive cron with actual_arrival = scheduled + 90 min:
 *      → oracle.set_landed (delay 90 min)
 *      → classify → ToBeSettledDelayed
 *      → execute_settlements → ClaimableBalance written for buyer.
 *   3. /portfolio shows policy as claimable; click Claim.
 *   4. Phantom approves flight_pool.claim — buyer USDC ATA receives the
 *      payout from the pool treasury.
 *   5. Wallet pill bumps via the tx-success burst.
 */
test('E2 delayed: buy → 90-min delay → cron writes ClaimableBalance → claim → balance up', async ({
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
  await simulateDelayed({
    flightId: FLIGHT_ID,
    date,
    scheduledEtaUnixSec: noonOf(date),
    delayMinutes: DELAY_MINUTES,
  });

  // Snapshot wallet USDC balance pre-claim.
  await page.goto('/portfolio');
  await waitForBurst(page);

  const balPill = page.locator('.wallet .bal');
  const beforeClaim = (await balPill.textContent())?.trim() ?? '';

  // Active tab → claim CTA on the matching policy.
  await page.locator('.tab').filter({ hasText: /Active/i }).click();
  const claimBtn = page.getByRole('button', { name: /^Claim/i }).first();
  await claimBtn.click();
  await phantom.confirmTransaction();
  await waitForBurst(page);

  const afterClaim = (await balPill.textContent())?.trim() ?? '';
  expect(afterClaim).not.toBe(beforeClaim);
});
