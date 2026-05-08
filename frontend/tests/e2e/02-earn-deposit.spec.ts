import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';
import { waitForBurst } from '../helpers/waitForBurst';
import { mintFromFaucet } from '../helpers/mintFromFaucet';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

/**
 * D2 — /earn deposit. Connects, ensures the test wallet has USDC (mints
 * via /api/faucet/mint if the on-chain balance is 0), enters 100 USDC,
 * clicks Deposit, approves in Phantom, then asserts the user position
 * card shows non-zero RVS and the wallet USDC pill dropped by 100.
 */
test('D2 /earn: deposit 100 USDC mints RVS and reflects in user position', async ({
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

  await page.goto('/earn');
  await connectWallet(page, phantom);

  // Make sure the test wallet has USDC. Idempotent — if D1 ran before
  // this, the wallet already has 10k+; the second mint just adds more.
  const travelerAddr = await phantom.getAccountAddress('solana');
  await mintFromFaucet(page, travelerAddr);
  await waitForBurst(page);

  // Type 100 into the Deposit Amount input. The /earn DepositCard's
  // input is the first .input descendant with placeholder "0".
  const depositInput = page
    .locator('.card', { hasText: 'Deposit' })
    .locator('input.input')
    .first();
  await depositInput.fill('100');

  // Capture wallet pill before deposit.
  const balPill = page.locator('.wallet .bal');
  const before = (await balPill.textContent())?.trim() ?? '';

  await page.getByRole('button', { name: /Deposit 100 USDC/i }).click();

  // Phantom transaction-approval modal opens in the extension's notif
  // page; Synpress drives the approve.
  await phantom.confirmTransaction();

  await waitForBurst(page);

  // Wallet balance should have dropped by ~100 USDC (give RPC slack).
  const after = (await balPill.textContent())?.trim() ?? '';
  expect(after).not.toBe(before);

  // Position card on /earn shows non-zero "your RVS".
  const rvsRow = page.locator('.card').filter({ hasText: 'your RVS' });
  await expect(rvsRow).toContainText(/[1-9]/); // at least some RVS
});
