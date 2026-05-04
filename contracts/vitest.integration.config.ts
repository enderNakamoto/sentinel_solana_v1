import { defineConfig } from 'vitest/config';

/**
 * Vitest config for integration tests.
 *
 * Unlike `vitest.config.ts`, this includes `tests/integration/**` and
 * skips the `pretest` build hook (integration tests assume a Surfnet is
 * already running externally — start it with `pnpm dev:surfpool`).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['tests/integration/**/*.test.ts'],
  },
});
