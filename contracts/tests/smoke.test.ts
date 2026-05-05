/**
 * Phase 0 smoke tests — one per program.
 *
 * Asserts:
 *   1. The `.so` loaded into LiteSVM at the declared program address is
 *      executable.
 *   2. `initialize` succeeds against a fresh state PDA (Anchor v1 layout).
 *
 * Hand-rolled Kit instructions (no Codama dep) — keeps the test
 * self-contained and verifies the program binaries directly. Real
 * Codama-generated builders are exercised end-to-end in Phase 1+ tests.
 *
 * Initialize discriminator: sha256("global:initialize")[0..8] — the Anchor
 * v1 default for an instruction handler named `initialize`.
 *
 * Phase 1 note: the `governance` program is now skipped here. Its
 * `initialize` signature changed (3 args) and its state PDA seed is
 * `governance_config` rather than `governance_state`. End-to-end coverage
 * for governance lives in `governance.test.ts`. The other 4 programs
 * remain Phase 0 no-op skeletons until their respective phases.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  AccountRole,
  address as kitAddress,
  getProgramDerivedAddress,
  getBytesEncoder,
  type Address,
} from '@solana/kit';
import { sha256 } from '@noble/hashes/sha256';
import { makeClient, PROGRAMS } from './setup.ts';

const INITIALIZE_DISCRIMINATOR = new Uint8Array(
  sha256(new TextEncoder().encode('global:initialize')).slice(0, 8),
);

const SYSTEM_PROGRAM = kitAddress('11111111111111111111111111111111');

describe('Phase 0 — program smoke tests', () => {
  let client: Awaited<ReturnType<typeof makeClient>>;

  beforeAll(async () => {
    client = await makeClient();
  });

  // Phases 1+: programs that have real implementations (i.e. not the Phase 0
  // no-op `initialize` signature) are excluded from the smoke loop. Each
  // program ships its own test suite once implemented.
  const REAL_PROGRAMS = new Set(['governance', 'vault', 'flight_pool']);
  const NO_OP_PROGRAMS = PROGRAMS.filter((p) => !REAL_PROGRAMS.has(p.name));

  for (const program of NO_OP_PROGRAMS) {
    it(`${program.name}: program loaded and initialize succeeds`, async () => {
      const programAddress = kitAddress(program.idStr);

      // (1) The .so loaded at this address resolves to an executable account.
      const programAcc = client.svm.getAccount(programAddress);
      expect(programAcc.exists, `program account missing for ${program.name}`).toBe(true);
      if (programAcc.exists) {
        expect(programAcc.executable, `${program.name} not executable`).toBe(true);
      }

      // (2) Derive the state PDA from the program-specific seed.
      const [statePda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [getBytesEncoder().encode(new TextEncoder().encode(program.stateSeed))],
      });

      // (3) Build + send the `initialize` instruction.
      const instruction = {
        programAddress,
        accounts: [
          { address: statePda, role: AccountRole.WRITABLE },
          { address: client.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: client.payer },
          { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        ],
        data: INITIALIZE_DISCRIMINATOR,
      };

      await client.sendTransaction([instruction]);

      // (4) State PDA exists post-init with at least the 8-byte discriminator + bump.
      const stateAcc = client.svm.getAccount(statePda);
      expect(stateAcc.exists, `state PDA not created for ${program.name}`).toBe(true);
      if (stateAcc.exists) {
        expect(stateAcc.data.length).toBeGreaterThanOrEqual(8);
      }
    });
  }
});
