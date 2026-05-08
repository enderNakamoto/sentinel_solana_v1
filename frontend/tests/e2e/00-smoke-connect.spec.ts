import { testWithSynpress } from '@synthetixio/synpress';
import { Phantom, phantomFixtures } from '@synthetixio/synpress/playwright';
import basicSetup from '../wallet-setup/basic.setup';
import { connectWallet } from '../helpers/connectWallet';

const test = testWithSynpress(phantomFixtures(basicSetup));
const { expect } = test;

test('smoke: wallet connects and topbar chip renders', async ({
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

  // Land on /faucet — connect button is in the topbar, mounted on every
  // non-landing route. /faucet is a safe target since it has no
  // wallet-gated reads on first paint.
  await page.goto('/faucet');
  await connectWallet(page, phantom);

  // Wallet chip should now show a truncated address pattern.
  const addr = page.locator('.wallet .addr');
  await expect(addr).toBeVisible();
  await expect(addr).toContainText(/[A-Za-z0-9]{4}…[A-Za-z0-9]{4}/);
});
