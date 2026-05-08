import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Sentinel e2e suite.
 *
 * Tests assume a Surfpool ledger is running at 127.0.0.1:8899 with the
 * protocol bootstrapped (see `pnpm test:e2e:bootstrap`) AND the frontend
 * is up via `pnpm dev:frontend:surfpool` on http://localhost:3000.
 *
 * The Synpress wallet cache must be built ONCE before running tests:
 *
 *     pnpm --filter @sentinel/frontend test:e2e:cache
 *
 * That command runs `synpress --phantom` and produces `.cache-synpress/`
 * inside this workspace; subsequent test runs reuse it.
 *
 * Chromium-only — Synpress drives a real Phantom extension which is a
 * Chrome MV3 build, so Firefox / WebKit are not supported.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Synpress + a single browser-extension wallet cache means tests must
  // run sequentially; parallelising would race over the Phantom session.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Synpress-driven Phantom approval modals can take a beat; bump
    // default action timeout from 5s to 15s.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  // Default 30s per test isn't enough — buy/deposit txs go through the
  // tx-success-burst (4s) plus on-chain confirmation. 90s leaves headroom.
  timeout: 90_000,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
