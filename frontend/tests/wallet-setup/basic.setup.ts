import { defineWalletSetup } from '@synthetixio/synpress';
import { Phantom } from '@synthetixio/synpress/playwright';

/**
 * Synpress wallet-setup file. Builds the Phantom extension cache that
 * every Playwright test reuses.
 *
 * Run once (and again whenever the Phantom version pins move):
 *
 *     pnpm --filter @sentinel/frontend test:e2e:cache
 *
 * The seed phrase below is the well-known BIP-39 abandon-vector — a
 * SAFE-FOR-TESTS seed with no real value at any of its derived addresses
 * on any cluster. Don't fund this wallet on mainnet; do fund the derived
 * Solana address on Surfpool via the bootstrap script (which airdrops
 * SOL + mints mock USDC to it before tests run).
 *
 * Solana derivation path (Phantom default): m/44'/501'/0'/0' →
 *   pubkey = HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH
 *
 * If the test seed ever changes, update both this file AND the
 * bootstrap script's airdrop list (scripts/e2e/bootstrap-surfpool.ts).
 */

const SEED_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'Sentinel-e2e-1';

export default defineWalletSetup(PASSWORD, async (context, walletPage) => {
  const phantom = new Phantom(context, walletPage, PASSWORD);
  await phantom.importWallet(SEED_PHRASE);
});
