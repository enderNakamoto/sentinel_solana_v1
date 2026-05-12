/**
 * Acurast runtime (_STD_) type declarations + a local-dev shim.
 *
 * Inside the Acurast TEE, the runtime injects a global `_STD_` object that
 * exposes env vars, the deployment identity, and (most importantly) the
 * attested ed25519 signer. Outside the TEE — `npm start:*` for local
 * smoke — we shim it with a dev-only signer wired off DEV_KEYPAIR so the
 * bundle can be exercised end-to-end before paying for an Acurast deploy.
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export interface AcurastStd {
  env: Record<string, string | undefined>;
  job: {
    getId: () => unknown;
    getPublicKeys: () => { p256: string; secp256k1: string; ed25519: string };
  };
  device: {
    getAddress: () => string;
  };
  app_info: {
    version: string;
  };
  signers: {
    ed25519: {
      /** payloadHex → signatureHex (64 bytes). */
      sign: (payloadHex: string) => string;
    };
  };
}

declare const _STD_: any;

function makeDevShim(): AcurastStd {
  // For local dev only. Load a keypair from DEV_KEYPAIR_BASE58, or generate
  // a fresh ephemeral one. NEVER ship this path to production — Acurast's
  // injected _STD_ uses a TEE-attested key the script cannot extract.
  const base58 = process.env.DEV_KEYPAIR_BASE58;
  const kp = base58
    ? Keypair.fromSecretKey(bs58.decode(base58))
    : Keypair.generate();
  const pubHex = Buffer.from(kp.publicKey.toBytes()).toString("hex");
  const secret = kp.secretKey;

  return {
    env: { ...process.env } as Record<string, string | undefined>,
    job: {
      getId: () => "local-dev",
      getPublicKeys: () => ({
        p256: "",
        secp256k1: "",
        ed25519: pubHex,
      }),
    },
    device: { getAddress: () => "local-dev" },
    app_info: { version: "local-dev" },
    signers: {
      ed25519: {
        sign: (payloadHex: string) => {
          // Local-dev: re-implement what Acurast's TEE signer does using
          // the dev keypair's secret. tweetnacl ships with @solana/web3.js
          // as a transitive dep, so no extra install.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const nacl = require("tweetnacl");
          const msg = Uint8Array.from(Buffer.from(payloadHex, "hex"));
          const sig = nacl.sign.detached(msg, secret);
          return Buffer.from(sig).toString("hex");
        },
      },
    },
  };
}

const std: AcurastStd =
  typeof _STD_ !== "undefined" ? (_STD_ as AcurastStd) : makeDevShim();

if (typeof (globalThis as any)._STD_ === "undefined") {
  (globalThis as any)._STD_ = std;
}

export { std as STD };

/** Resolve an env var either from `_STD_.env` (TEE) or `process.env` (dev shim). */
export function envVar(name: string): string | undefined {
  return std.env[name] ?? process.env[name];
}

/** Throw-on-missing variant for required keys. */
export function requireEnv(name: string): string {
  const v = envVar(name);
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}
