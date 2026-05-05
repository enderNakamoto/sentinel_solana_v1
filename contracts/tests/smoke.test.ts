/**
 * Smoke tests — verifies all 5 program binaries load into LiteSVM cleanly.
 *
 * As of Phase 5, every program in the workspace ships a real implementation
 * (governance, vault, flight_pool, oracle_aggregator, controller). The
 * Phase 0 "loop a no-op initialize per program" pattern is retired. This
 * file now serves as a binary-presence sanity check before the per-program
 * test suites run.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { address as kitAddress } from '@solana/kit';
import { makeClient, PROGRAMS } from './setup.ts';

describe('Smoke — program binaries loaded', () => {
  let client: Awaited<ReturnType<typeof makeClient>>;

  beforeAll(async () => {
    client = await makeClient();
  });

  it('all 5 program .so binaries are loaded and executable in LiteSVM', () => {
    for (const program of PROGRAMS) {
      const acc = client.svm.getAccount(kitAddress(program.idStr));
      expect(acc.exists, `program account missing for ${program.name}`).toBe(true);
      if (acc.exists) {
        expect(acc.executable, `${program.name} not executable`).toBe(true);
      }
    }
  });
});
