/**
 * Hand-rolled SetComputeUnitLimit ix — avoids pulling in
 * `@solana-program/compute-budget` (version-pinned to a different kit).
 *
 * Wire format:
 *   data    = [0x02, ...le_u32(units)]            (5 bytes)
 *   program = ComputeBudget111111111111111111111111111111
 *
 * Per Phase 5 D5: heavy-CPI txs (e.g. `controller.buy_insurance`) need to
 * raise the per-tx compute unit cap from the default 200K to Solana's
 * per-tx max (1.4M).
 */

import type { Address, Instruction } from '@solana/kit';

const COMPUTE_BUDGET_PROGRAM_ID =
  'ComputeBudget111111111111111111111111111111' as Address<'ComputeBudget111111111111111111111111111111'>;

export function setComputeUnitLimitIx(
  units = 1_400_000,
): Instruction<'ComputeBudget111111111111111111111111111111'> {
  const data = new Uint8Array(5);
  data[0] = 0x02; // SetComputeUnitLimit discriminator
  // little-endian u32
  const view = new DataView(data.buffer);
  view.setUint32(1, units, true);
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ID,
    accounts: [],
    data,
  };
}
