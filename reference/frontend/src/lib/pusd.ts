/**
 * PUSD + share decimal helpers. Both PUSD (Token-2022) and the vault's
 * RVS share mint (classic SPL) use 6 decimals.
 */

const PUSD_DECIMALS = 6;
const FACTOR = 1_000_000n;

export const SHARE_DECIMALS = PUSD_DECIMALS;

export function toPusdUnits(amount: string | number): bigint {
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) {
    throw new Error(`Invalid PUSD amount: ${amount}`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const padded = frac.padEnd(PUSD_DECIMALS, '0');
  return BigInt(whole) * FACTOR + BigInt(padded || '0');
}

export function fmtPusd(units: bigint, opts?: { trim?: boolean }): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / FACTOR;
  const frac = abs % FACTOR;
  let fracStr = String(frac).padStart(PUSD_DECIMALS, '0');
  if (opts?.trim ?? true) fracStr = fracStr.replace(/0+$/, '');
  if (fracStr === '') fracStr = '0';
  return `${negative ? '-' : ''}${whole}.${fracStr}`;
}

/** Convenience: format with comma thousand separators on the whole part. */
export function fmtPusdLocal(units: bigint): string {
  const [whole, frac = '0'] = fmtPusd(units).split('.');
  const wholeWithCommas = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === '0' ? wholeWithCommas : `${wholeWithCommas}.${frac}`;
}

export const toShares = toPusdUnits;
export const fmtShares = fmtPusd;
