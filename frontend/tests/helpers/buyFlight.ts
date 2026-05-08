import type { Page } from '@playwright/test';
import type { Phantom } from '@synthetixio/synpress/playwright';
import { mintFromFaucet } from './mintFromFaucet';
import { waitForBurst } from './waitForBurst';

/**
 * Drive the /buy flow for a specific flight ID. Assumes the wallet
 * is already connected. Tops up USDC via the public faucet, types
 * the flight ID into the search box to filter the table to one row,
 * clicks it, clicks `Cover {flight_id}`, and approves the
 * `controller.buy_insurance` tx in Phantom.
 */
export async function buyFlight(
  page: Page,
  phantom: Phantom,
  flightId: string,
): Promise<void> {
  await page.goto('/buy');
  await waitForBurst(page, 1500);

  // Top up USDC so the buyer can afford the premium regardless of test
  // ordering.
  const traveler = await phantom.getAccountAddress('solana');
  await mintFromFaucet(page, traveler);
  await waitForBurst(page);

  // The /buy page has a search input — typing the flight ID narrows
  // the table to one row.
  const searchInput = page.getByPlaceholder(/search/i);
  await searchInput.fill(flightId);
  await page.locator('table tbody tr').first().click();

  // Cover button — accessible name starts with "Cover " and includes
  // the flight ID.
  await page.getByRole('button', { name: new RegExp(`^Cover\\s+${flightId}`, 'i') }).click();
  await phantom.confirmTransaction();
  await waitForBurst(page);
}

/**
 * Compute the same date the /buy page uses by default (tomorrow's
 * UTC midnight, expressed as unix seconds). Test scripts pass this
 * to the cronTick helper so the simulator targets the right
 * (flight_id, date) PDA.
 */
export function tomorrowDateAsUnix(): bigint {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

/** Scheduled ETA = noon UTC on the same day as the date arg. */
export function noonOf(dateAsUnix: bigint): bigint {
  return dateAsUnix + 12n * 3600n;
}
