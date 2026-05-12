# Sentinel × Acurast — TEE-attested keepers (proof of concept)

This folder is a **standalone** Acurast Cloud project that re-implements Sentinel's four cron jobs as TEE-attested deployments. It is intentionally not wired into the pnpm workspace — its only purpose is to demonstrate that the same on-chain writes done today by the Render-hosted Node daemon (`executor/`) can be performed from inside an Acurast processor with a hardware-attested ed25519 signer.

> **Scope.** This is a *proof*, not a production replacement. Reads of `ActiveFlightList` and other Anchor `Vec<...>` accounts are simplified to env-driven flight lists so the bundles can be exercised without bundling a borsh decoder. Production would deserialize those accounts the same way `executor/src/core/run_fetcher.ts` already does.

---

## Why this exists

Today the four crons run as a centralized Node process on Render. The signing keys (`authorized_oracle`, `authorized_keeper`, governance owner) live in plain base58 in environment variables — anyone with Render dashboard access can steal them.

Acurast runs the same TypeScript inside a hardware-attested TEE on a real Android phone (the "processor"). The key:
- Lives in the secure chip — even the phone owner cannot extract it.
- Is **exposed by `_STD_.job.getPublicKeys().ed25519`** so we know which Solana address to whitelist.
- Signs payloads only via `_STD_.signers.ed25519.sign(payloadHex)` — the script never holds the private key.

Solana transactions are ed25519-signed, so the same TEE primitive that signs Substrate/Ethereum payloads can sign a Solana message bit-for-bit identically. We just:

1. Build the versioned-transaction message bytes off-chain (in the bundle).
2. Hand those bytes to `_STD_.signers.ed25519.sign(...)`.
3. Glue the returned 64-byte signature back onto the transaction.
4. POST it to a Solana JSON-RPC endpoint via the global `fetch()`.

That's the entire trick. The on-chain authorities (`OracleConfig.authorized_oracle`, `ControllerConfig.authorized_keeper`, `governance_config.owner`) get rotated once to the TEE's ed25519 address and from that point forward the protocol is operationally decentralized at the keeper layer.

---

## Layout

```
acurast/
├── README.md
├── package.json              # 4 deploy scripts; deps: @solana/web3.js, @noble/hashes, bs58
├── tsconfig.json
├── webpack.config.js         # 4 entries → dist/{fetcher,classifier,settler,repricer}.bundle.js
├── acurast.json              # 4 project manifests (interval scheduling, env allowlists)
├── .env.example              # All env keys + canonical devnet addresses
└── src/
    ├── jobs/
    │   ├── fetcher.ts        # cron #1 — FlightDataFetcher (oracle write)
    │   ├── classifier.ts     # cron #2 — FlightClassifier (oracle write via controller)
    │   ├── settler.ts        # cron #3 — SettlementExecutor (keeper write)
    │   └── repricer.ts       # cron #4 — RouteRepricer (governance write)
    └── lib/
        ├── std.ts            # _STD_ shim — type defs + local-dev fallback signer
        ├── rpc.ts            # Solana JSON-RPC helpers via fetch()
        ├── tx.ts             # Build VersionedTransaction + sign via _STD_.signers.ed25519
        ├── anchor.ts         # sha256-based ix discriminator, LE numeric encoders
        ├── pdas.ts           # PDA seed → address (web3.js findProgramAddressSync)
        ├── aeroapi.ts        # FlightAware AeroAPI client
        ├── agent.ts          # Phase 22 XGBoost service client
        ├── grok.ts           # xAI Grok Agent Tools API client (web_search)
        └── ix/
            ├── oracle.ts     # set_estimated_arrival / set_landed / set_cancelled
            ├── controller.ts # classify_flights / execute_settlements
            └── governance.ts # update_route_terms / disable_route / whitelist_route
```

---

## Build + deploy

Install the Acurast CLI globally (or rely on the `devDependency` and `npx`):

```bash
cd acurast/
npm install
npx acurast init       # one-time — generates a mnemonic, drops it in .env
```

Build the four bundles:

```bash
npm run build
# → dist/fetcher.bundle.js
# → dist/classifier.bundle.js
# → dist/settler.bundle.js
# → dist/repricer.bundle.js
```

Deploy one at a time:

```bash
npm run deploy:fetcher
npm run deploy:classifier
npm run deploy:settler
npm run deploy:repricer
```

Or deploy all four with the manifests in `acurast.json`:

```bash
npm run deploy:all
```

The CLI will display each deployment's TEE-attested ed25519 address. Rotate the on-chain authorities to those addresses once:

```bash
# From the parent repo (one-time, irreversible without a re-rotation)
NO_DNA=1 pnpm rotate-oracle  --cluster devnet --to <fetcher TEE pubkey>
NO_DNA=1 pnpm rotate-keeper  --cluster devnet --to <classifier/settler TEE pubkey>
# Governance owner rotation is manual — call governance.transfer_ownership
# to the repricer TEE pubkey.
```

---

## Env vars (`_STD_.env`)

Acurast encrypts env vars at deployment time and only decrypts them inside the processor TEE at run time. Each project in `acurast.json` declares the subset it needs via `includeEnvironmentVariables` — that's the allowlist.

| Var | Used by | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | all 4 | JSON-RPC endpoint (devnet recommended for the proof) |
| `AEROAPI_KEY` | fetcher | FlightAware API key |
| `AGENT_BASE_URL` | repricer | Phase 22 XGBoost service URL |
| `XAI_API_KEY` | repricer | xAI Grok key (Agent Tools API) |
| `REPRICER_DRY_RUN` | repricer | `"1"` = decide actions, skip on-chain writes |
| `ORACLE_PROGRAM_ID`, `CONTROLLER_PROGRAM_ID`, `VAULT_PROGRAM_ID`, `FLIGHT_POOL_PROGRAM_ID`, `GOVERNANCE_PROGRAM_ID` | various | Canonical from `deployments/devnet-latest.json` |
| `ORACLE_CONFIG_PDA`, `CONTROLLER_CONFIG_PDA`, `ACTIVE_FLIGHTS_PDA`, `GOVERNANCE_CONFIG_PDA` | various | v2 PDAs (post-Phase-24) |
| `DEMO_FLIGHT_IDS` | fetcher / classifier / settler | Comma-separated list — used in lieu of a full Anchor-Vec decoder. e.g. `AA100,UA200,DL300` |
| `DEMO_ROUTE_IDS` | repricer | Semicolon-separated specs `flight\|carrier\|origin\|dest\|hhmm\|distance` |
| `DEV_KEYPAIR_BASE58` | local dev only | Bypass the _STD_ shim with a real Solana keypair for end-to-end smoke |

---

## Local dev (without paying for an Acurast deploy)

The `_STD_` shim in `src/lib/std.ts` detects the absence of the real runtime and falls back to a local ed25519 signer backed by `tweetnacl` (a transitive dep of `@solana/web3.js`). You can:

```bash
# Drop into acurast/.env (or export inline)
DEV_KEYPAIR_BASE58=$(cat ../keys/devnet-deployer.json \
  | node -e "const fs=require('fs');const b=require('bs58');\
            process.stdout.write(b.default.encode(\
              new Uint8Array(JSON.parse(fs.readFileSync('/dev/stdin','utf-8')))))")

# Run any bundle locally
npm run start:fetcher
```

Locally, the script:
- Reads env from `process.env` instead of `_STD_.env`.
- Uses the devnet deployer keypair as the "TEE signer" so the same signing path is exercised.
- Submits real txs to whatever `SOLANA_RPC_URL` points at.

This is the cheapest way to confirm the build + signing + RPC plumbing works before paying any Acurast Canary fees.

---

## What's stubbed vs. real

| Path | Acurast bundle | Production `executor/` |
|---|---|---|
| Read `ActiveFlightList` Vec | **stubbed** (env-driven) — would need a borsh decoder in the bundle | Real Codama-generated reader |
| AeroAPI fetch | Real (same endpoint, same shape) | Real |
| Solana JSON-RPC | Real (`fetch()`) | `@solana/kit` RPC plugin |
| Ix encoding | Hand-rolled discriminators + borsh primitives | Codama-generated typed builders |
| Tx signing | **Real `_STD_.signers.ed25519.sign(...)`** ← the proof | Local Ed25519 keypair from base58 env |
| Tx submit | Real `sendTransaction` JSON-RPC | Real |
| Pricing agent + Grok | Real (same Phase 22 service, same xAI Agent Tools API) | Real |
| Snap-back on error | Per-flight try/catch — never aborts a tick | Same |

The single load-bearing claim of the proof: **`_STD_.signers.ed25519.sign(messageHex)` returns a Solana-valid signature** when applied to a versioned-transaction message. Everything else is plumbing already proved in the production cron.

---

## Caveats

- **Acurast Canary network only** for now (`network: "canary"` in `acurast.json`). Mainnet (`acurast`) deployments require ACU and a stable processor pool.
- **Single replica.** `numberOfReplicas: 1`; running 2 would double-submit every tick.
- **Interval drift.** Acurast's interval scheduler has a configurable `maxAllowedStartDelayInMs` slack — each bundle is short-lived so missed ticks are harmless; the next interval picks up.
- **No persistent state.** The ring-buffer log lives in the Node process for ~one tick; for audit history use `getSignaturesForAddress` against the TEE pubkey.
- **Bundle size.** `@solana/web3.js` is ~300KB after webpack. Well within Acurast limits; just be aware adding `@solana/kit` or the full Codama clients would bloat it significantly.

---

## References

- [Acurast deploy-first-app guide](https://docs.acurast.com/developers/deploy-first-app)
- [Acurast Node.js runtime API surface](https://docs.acurast.com/developers/build/nodejs-runtime-environment)
- [`app-webserver` example](https://github.com/Acurast/acurast-example-apps/tree/26ebfb27b1f0bdf4a146acafa792d47c155a34d5/apps/app-webserver)
- [`app-fetch` example](https://github.com/Acurast/acurast-example-apps/tree/26ebfb27b1f0bdf4a146acafa792d47c155a34d5/apps/app-fetch)
- Sentinel production crons: [`executor/src/core/`](../executor/src/core/)
