/**
 * Narrow boundary between Solana Kit (`Address`, transaction messages) and
 * the legacy `@solana/web3.js` types (`PublicKey`, `Transaction`) that the
 * LiteSVM TypeScript API still requires.
 *
 * Per phase-00 §Risks, web3.js types must NOT leak into program-specific
 * test files. Import from this module only inside the harness (setup.ts)
 * or in adapters; tests work with Kit `Address` values.
 */

import { PublicKey } from '@solana/web3.js';
import type { Address } from '@solana/kit';
import { address as toAddress } from '@solana/kit';

/** Convert a Kit `Address` (branded base58 string) to a web3.js `PublicKey`. */
export function toLegacyPubkey(addr: Address | string): PublicKey {
  return new PublicKey(addr.toString());
}

/** Convert a web3.js `PublicKey` to a Kit `Address`. */
export function toKitAddress(pk: PublicKey): Address {
  return toAddress(pk.toBase58());
}
