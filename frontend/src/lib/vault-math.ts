/**
 * Vault share-price math — mirrors the on-chain implementation in
 * `contracts/programs/vault/src/lib.rs`. Both deposit and redeem use a
 * **virtual share offset** of 1000 (i.e. `total_managed_assets + 1000`
 * over `rvs_supply + 1000`) to defeat inflation attacks on first deposit
 * and to keep rounding direction aligned with vault solvency.
 *
 * Deposits round shares DOWN (vault keeps a fraction).
 * Redemptions round shares DOWN — the user gets a fraction less PUSD.
 */

export const VIRTUAL_OFFSET = 1000n;

export interface VaultMathInput {
  /** Total managed assets in PUSD base units (6 decimals). */
  tma: bigint;
  /** RVS share-mint supply in share base units (6 decimals). */
  rvsSupply: bigint;
}

/**
 * Preview how many RVS shares a deposit of `pusd` PUSD base units would mint.
 * Matches vault.deposit's `shares = floor(pusd * (S + 1000) / (T + 1000))`.
 */
export function previewSharesFromDeposit({
  tma,
  rvsSupply,
  pusd,
}: VaultMathInput & { pusd: bigint }): bigint {
  if (pusd <= 0n) return 0n;
  const num = pusd * (rvsSupply + VIRTUAL_OFFSET);
  const den = tma + VIRTUAL_OFFSET;
  return num / den;
}

/**
 * Preview how much PUSD a redemption of `shares` RVS would return.
 * Matches vault.redeem's `pusd = floor(shares * (T + 1000) / (S + 1000))`.
 */
export function previewUsdcFromRedeem({
  tma,
  rvsSupply,
  shares,
}: VaultMathInput & { shares: bigint }): bigint {
  if (shares <= 0n) return 0n;
  const num = shares * (tma + VIRTUAL_OFFSET);
  const den = rvsSupply + VIRTUAL_OFFSET;
  return num / den;
}

/**
 * Current share price in PUSD base units, scaled by 1e6 to retain precision.
 * Matches the `SnapshotRecord.sharePrice` storage convention.
 *
 * Returns 1.000000 (= 1_000_000n) when the vault is empty.
 */
export function currentSharePrice({ tma, rvsSupply }: VaultMathInput): bigint {
  const num = (tma + VIRTUAL_OFFSET) * 1_000_000n;
  const den = rvsSupply + VIRTUAL_OFFSET;
  return num / den;
}

/** Free capital = total_managed_assets − locked_capital. */
export function freeCapital(tma: bigint, locked: bigint): bigint {
  return tma > locked ? tma - locked : 0n;
}
