# Development Steps

Phased build plan for Sentinel on Solana. Each phase has a single goal, concrete
deliverables, and clear "done when" criteria. Phases are sequenced so the on-chain
contracts ship first, then the off-chain crons, then the frontend, then E2E.

This file is the source-of-truth for `/plan-phase`, `/start-phase`, and
`/complete-phase` (see `workflow.md`).

---

## Repo Layout (target)

```
sentinel_solana/
├── contracts/                  # Anchor workspace — all 5 programs
│   ├── programs/
│   │   ├── governance/
│   │   ├── vault/
│   │   ├── flight_pool/
│   │   ├── oracle_aggregator/
│   │   └── controller/
│   ├── tests/                  # LiteSVM unit + Surfpool integration
│   ├── scripts/                # deploy, init, sync-idl
│   ├── target/                 # build artifacts (gitignored)
│   ├── Anchor.toml
│   ├── Cargo.toml
│   └── package.json
│
├── frontend/                   # Next.js dApp
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── idl/                # COPIED from contracts/target/ (gitignored)
│   │   └── ...
│   └── package.json
│
├── executor/                   # Off-chain cron backend
│   ├── src/core/               # AeroAPI client, Solana client, instruction builders
│   ├── src/backends/cron/      # node-cron entry point (3 schedules)
│   └── package.json
│
├── spec/                       # architecture.md, dev_steps.md, workflow.md, phases/
└── package.json                # root — runs sync-idl, orchestrates workspaces
```

**IDL bridge:** A root script `scripts/sync-idl.sh` runs `anchor build` in `contracts/`
and copies `target/idl/*.json` + `target/types/*.ts` into `frontend/src/idl/` and
`executor/src/idl/`. Codama then generates typed Kit clients into `frontend/src/clients/`
and `executor/src/clients/`. Consumers import from the generated clients (e.g.
`./clients/controller`, `./clients/oracle_aggregator`) — no symlinks, no monorepo magic.
The sync script runs as a `postbuild` hook in `contracts/package.json` and is also
invoked manually before frontend dev.

---

## Phase Index

| # | Name | Outputs |
|---|------|---------|
| 0 | Project Bootstrap | repo layout, IDL bridge, test harness |
| 1 | governance_program | program + unit tests |
| 2 | vault_program | program + unit tests |
| 3 | flight_pool_program | program + unit tests |
| 4 | oracle_aggregator_program | program + unit tests |
| 5 | controller_program | program + unit tests |
| 6 | Cross-Program Integration Tests | full-lifecycle tests |
| 7 | Devnet Deployment | deployed programs, init scripts |
| 8 | Oracle Cron — FlightDataFetcher | executor scaffold + cron #1 |
| 9 | Classifier Cron — FlightClassifier | cron #2 |
| 10 | Settlement Cron — SettlementExecutor | cron #3 + node-cron backend |
| 11 | Frontend Bootstrap | Next.js app, wallet, IDL imports |
| 12 | Frontend — Traveler Dashboard | buy / claim / my policies |
| 13 | Frontend — Underwriter Dashboard | deposit / redeem / queue / collect |
| 14 | Frontend — Admin Panel | governance + tunables |
| 15 | End-to-End Test | scripted browser test on devnet |

---

## Phase 0 — Project Bootstrap

**Goal:** Establish the workspace with `contracts/`, `frontend/`, `executor/`, the
IDL + typed-client bridge (Anchor IDL → Codama → Kit clients), and a baseline test
harness (LiteSVM unit + Surfpool integration) so subsequent phases can plug into it.

### Stack (locked)

| Layer | Tool |
|---|---|
| On-chain programs | Anchor (latest stable; verify via `compatibility-matrix.md`) |
| Client SDK (frontend + executor) | `@solana/kit` + `@solana-program/*` plugins |
| Frontend UI / wallet | framework-kit: `@solana/client` + `@solana/react-hooks` (Wallet Standard via `autoDiscover()`) |
| Legacy interop | `@solana/web3-compat` — boundary modules only |
| Typed program clients | Codama (generated from Anchor IDL) |
| Unit tests | LiteSVM (TypeScript, in-process) |
| Integration tests | Surfpool (local Surfnet, mainnet account cloning) |
| Package manager | pnpm workspaces |

> Programs are **five**, per `architecture.md` §Program Architecture:
> `governance`, `vault`, `flight_pool`, `oracle_aggregator`, `controller`. Do not consolidate at this stage.

### Deliverables

**Workspace root**
- `pnpm-workspace.yaml` covering `contracts/`, `frontend/`, `executor/`, `scripts/`.
- Root `package.json` scripts:
  - `sync-idl` — runs `anchor build` then `scripts/sync-idl.sh`
  - `gen-clients` — runs Codama on `contracts/target/idl/*.json` → `frontend/src/clients/` + `executor/src/clients/`
  - `dev:frontend`, `dev:executor`, `dev:surfpool`
  - `test:contracts` (LiteSVM unit), `test:integration` (Surfpool)
  - `build:all`, `clean`
- `.env.example` documenting `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_WS_URL`, `SOLANA_RPC_URL` (executor).
- `.gitignore` covering `target/`, `node_modules/`, `.anchor/`, `frontend/src/idl/`, `frontend/src/clients/`, `executor/src/idl/`, `executor/src/clients/`, `.surfpool/`, `.next/`, `.env.local`.
- `README.md` with one-command bring-up: `pnpm install && pnpm sync-idl && pnpm gen-clients && pnpm dev:frontend`. Document `NO_DNA=1` prefix for agent-driven CLI runs.

**`contracts/` — Anchor workspace**
- Initialised via `NO_DNA=1 anchor init contracts --no-git` (or equivalent), then five crates added under `programs/`:
  - `programs/governance/`
  - `programs/vault/`
  - `programs/flight_pool/`
  - `programs/oracle_aggregator/`
  - `programs/controller/`
- Each crate compiles a no-op `initialize` instruction with a no-op state account, declared via `declare_id!(...)`.
- `Anchor.toml` pins **deterministic localnet + devnet program IDs** generated once during Phase 0 (`anchor keys list` → committed). This prevents IDL/program-ID churn across CI runs.
- `Cargo.toml` workspace pins Anchor version (matching skill's `compatibility-matrix.md` recommendation).
- `package.json` devDeps: `litesvm`, `vitest`, `@types/node`, `@solana/kit`, `@solana/kit-plugin-signer`, `@solana-program/system`, `@solana-program/token`, `@solana/web3-compat` (LiteSVM bridge), `@solana/spl-token` (mock USDC mint construction).
- `tests/setup.ts` LiteSVM test harness exposing:
  - `makeSvm()` — constructs `LiteSVM`, loads all five `target/deploy/*.so` files, returns wrapped helpers
  - `airdrop(svm, pubkey, lamports)`
  - `createMockUsdcMint(svm, decimals = 6)` — returns mint pubkey + authority keypair
  - `fundAta(svm, mint, owner, amount)` — creates ATA if missing, mints tokens
  - `advanceClock(svm, secondsForward)` — wraps `svm.setSysvar(Clock, …)`
  - `web3CompatBoundary()` — narrow adapter exporting `toLegacyTx(kitTx)` / `toKitAddress(pubkey)` for the LiteSVM TS API which still uses `@solana/web3.js` types
- `tests/smoke.test.ts` — one smoke test per program asserting `program.programId` matches declared ID and `initialize` succeeds against a no-op state.

**`frontend/` — Next.js (App Router) + framework-kit**
- Bootstrapped via `NO_DNA=1 npx create-solana-dapp` with the kit-compatible Next.js + Tailwind template (or hand-rolled if template lags).
- TypeScript strict mode on.
- Deps: `@solana/client`, `@solana/react-hooks`, `@solana/kit`, `@solana/kit-plugin-rpc`, `@solana/kit-plugin-signer`, `@solana-program/system`, `@solana-program/token`, `tailwindcss`. **No** `@solana/wallet-adapter-react` (legacy).
- `app/providers.tsx` — single `createClient({ endpoint, websocketEndpoint, walletConnectors: autoDiscover() })`, wrapped in `<SolanaProvider>`.
- `app/layout.tsx` wraps children with `<Providers>`.
- `app/page.tsx` — minimal landing page that renders `useWalletConnection()` connect button to prove the wiring works.
- `src/idl/` — raw Anchor IDL JSON (generated, gitignored).
- `src/clients/` — Codama-generated typed instruction builders (gitignored).
- `src/lib/cluster.ts` — exports active cluster + `solanaLocalRpc()` / `solanaDevnetRpc()` plugin selection from env.

**`executor/` — TypeScript backend skeleton**
- `package.json`, `tsconfig.json` (NodeNext, strict), `src/index.ts` (empty `main()` placeholder).
- Deps: `@solana/kit`, `@solana/kit-plugin-rpc`, `@solana/kit-plugin-signer`, `@solana-program/system`, `@solana-program/token`, `dotenv`. No cron logic yet (deferred to Phase 7+).
- `src/idl/` + `src/clients/` (gitignored, populated by `sync-idl` + `gen-clients`).
- `src/lib/client.ts` — exports `createExecutorClient()` building a Kit client with `signerFromFile(process.env.EXECUTOR_KEYPAIR)` + `solanaRpc({ rpcUrl: process.env.SOLANA_RPC_URL })`. Smoke-imported by `index.ts` to prove wiring.

**`scripts/`**
- `sync-idl.sh` — runs `NO_DNA=1 anchor build` in `contracts/`, copies `target/idl/*.json` and `target/types/*.ts` into `frontend/src/idl/` and `executor/src/idl/`. Wired as `postbuild` hook in `contracts/package.json`.
- `gen-clients.ts` — Node script invoking Codama: reads `contracts/target/idl/*.json`, emits typed Kit clients (one per program) into `frontend/src/clients/` and `executor/src/clients/`.
- `dev-surfpool.sh` — `NO_DNA=1 surfpool start` (with optional `Surfpool.toml` for cloned mainnet USDC mint).
- `keys-bootstrap.sh` — one-time script that generates program keypairs into `contracts/target/deploy/`, prints them, and reminds the dev to commit `Anchor.toml` ID overrides.

**Mock USDC mint (single, reused everywhere)**
- One mock USDC mint keypair generated once during Phase 0, committed to `keys/mock-usdc.json` (gitignored — value-of-truth is the public address recorded in `keys/mock-usdc.pubkey`).
- 6 decimals, mint authority = a separate `keys/mock-usdc-authority.json` keypair (also committed pubkey-only).
- LiteSVM harness `createMockUsdcMint()` seeds the SAME pubkey via `svm.setAccount(...)` with an `spl_token::Mint` packed at that address.
- Surfpool seeds the SAME pubkey via `surfnet_setAccount` cheatcode in `Surfpool.toml`.
- Devnet deploy (Phase 6) reuses the same keypair via `spl-token create-token --decimals 6 keys/mock-usdc.json`.
- Result: USDC mint pubkey is identical across LiteSVM unit tests, Surfpool integration tests, and devnet — all instruction builders hard-code the same `Address`.

**`Surfpool.toml` (project root)**
- Seeds mock USDC mint at the address from `keys/mock-usdc.pubkey` via `surfnet_setAccount` on startup.
- Slot/clock defaults documented inline.
- No mainnet account cloning at this phase (stays self-contained).

### Done when

- `pnpm test:contracts` runs LiteSVM smoke tests (one per program) — all five pass.
- `pnpm sync-idl` produces five IDL JSON files in `contracts/target/idl/` and copies them into `frontend/src/idl/` + `executor/src/idl/`.
- `pnpm gen-clients` emits typed Kit clients in `frontend/src/clients/<program>/` and `executor/src/clients/<program>/`. A trivial `import { GovernanceClient } from '@/clients/governance'` typechecks.
- `pnpm dev:frontend` starts Next.js, the landing page renders, wallet connect button is visible, no console errors. Cluster is devnet by default.
- `pnpm dev:executor` runs `executor/src/index.ts` end-to-end (empty main, exits 0) and confirms the Kit client constructed against `SOLANA_RPC_URL`.
- `pnpm dev:surfpool` starts Surfnet successfully on `127.0.0.1:8899`, reachable via `solana cluster-version --url http://127.0.0.1:8899`.
- `pnpm test:integration` runs at least one stub test against a running Surfnet that fetches the seeded mock USDC mint at `keys/mock-usdc.pubkey` and asserts `decimals = 6`.
- `Anchor.toml` has committed program IDs; `anchor build` is reproducible (no ID drift).
- Repo passes `pnpm typecheck` across all workspaces.

### Depends on

—

### Out of scope (intentionally deferred)

- Real program logic (Phases 1–4)
- Mollusk CU benchmarking — defer to a dedicated benchmarking phase if needed; LiteSVM is sufficient for unit tests in Phase 0.
- Cron scheduling / AeroAPI client (Phases 7–9)
- UI dashboards (Phases 10–13)

---

## Phase 1 — governance_program

**Goal:** Ship the route registry and admin layer with full unit-test coverage.

**Deliverables:**
- Account types: `GovernanceConfig`, `RouteAccount`, `AdminRecord` (per
  architecture.md §governance_program).
- Instructions:
  - `initialize(default_premium, default_payoff, default_delay_hours)`
  - `set_defaults(...)`
  - `whitelist_route(flight_id, origin, dest, premium?, payoff?, delay_hours?)`
  - `disable_route(...)`
  - `update_route_terms(...)`
  - `add_admin(admin)` / `remove_admin(admin)`
  - `get_route_terms(...)` returning resolved `ResolvedTerms`
  - `is_route_whitelisted(...)`
- Authorization enforced with `has_one = owner` and `AdminRecord.is_active` checks.
- Custom errors enum (`UnauthorizedAdmin`, `RouteNotFound`, `RouteDisabled`, etc.).

**Unit tests** (in `contracts/tests/governance.test.ts`):
- `initialize` — sets defaults, owner.
- `set_defaults` — owner-only; non-owner reverts.
- `whitelist_route` — owner and admin both succeed; non-admin reverts.
- `whitelist_route` with no overrides → `get_route_terms` returns defaults.
- `whitelist_route` with overrides → `get_route_terms` returns overrides.
- `disable_route` flips `approved`; `is_route_whitelisted` returns `false`.
- `update_route_terms` — partial updates (some fields stay, others change/revert).
- `add_admin` / `remove_admin` — owner-only; record toggles `is_active`.
- Re-whitelisting a disabled route re-activates it.

**Done when:**
- All instructions implemented; all unit tests pass.
- `cargo build-sbf` produces a clean binary.
- IDL is synced into `frontend/src/idl/governance.json`.

**Depends on:** Phase 0.

---

## Phase 2 — vault_program

**Goal:** Ship the capital pool with share token, withdrawal queue, and snapshots.

**Deliverables:**
- Account types: `VaultState`, `WithdrawalQueue`, `ClaimableBalance`, `SnapshotRecord`.
- Share mint (RVS) created during `initialize`; vault PDA is mint authority.
- Instructions:
  - `initialize(usdc_mint)` (creates share mint, vault token account)
  - `set_controller(controller)` — settable once
  - Underwriter: `deposit`, `redeem`, `request_withdrawal`, `cancel_withdrawal`, `collect`
  - Controller-only: `increase_locked`, `decrease_locked`, `send_payout`,
    `record_premium_income`, `process_withdrawal_queue`, `snapshot`
- Virtual share offset (`VIRTUAL_SHARES = VIRTUAL_ASSETS = 1000`) baked into deposit/redeem math.
- `total_managed_assets` is an internal counter, NOT raw token balance.
- FIFO withdrawal queue stored in dedicated `WithdrawalQueue` account.
- `snapshot` is no-op if already snapshotted today.

**Unit tests** (in `contracts/tests/vault.test.ts`):
- Initialize — shares mint created, vault token account created with vault PDA as authority.
- `set_controller` succeeds once; second call reverts.
- `deposit` mints shares correctly with virtual offset; `total_managed_assets` increases.
- Direct USDC transfer to vault token account does NOT change share price.
- `redeem` immediate path — burns shares, transfers USDC, capped at free_capital.
- `redeem` reverts when shares > free_capital equivalent.
- `request_withdrawal` enqueues request in FIFO order.
- `cancel_withdrawal` removes request; only owner of request can cancel.
- Controller-only instructions revert when called by non-controller.
- `increase_locked` / `decrease_locked` track `locked_capital` correctly.
- `record_premium_income` increases `total_managed_assets`.
- `send_payout` transfers from vault token account to recipient.
- `process_withdrawal_queue` walks FIFO, credits `ClaimableBalance` until free_capital exhausted.
- `collect` transfers claimable amount and zeroes the balance.
- `snapshot` writes once per day; second call same day is a no-op.
- Inflation attack: a malicious first-depositor cannot steal subsequent depositor shares.

**Done when:**
- All instructions implemented; all unit tests pass.
- IDL synced.

**Depends on:** Phase 0.

---

## Phase 3 — flight_pool_program

**Goal:** Ship the per-flight pool registry, shared pool treasury, buyer records,
claim/sweep paths, and recovery accounting. This is the program that custodies all
in-flight USDC.

**Deliverables:**
- Account types: `FlightPoolConfig` (owner, controller, usdc_mint, pool_treasury,
  recovered_balance, is_controller_set), `FlightPool` (with `claimed_count`),
  `BuyerRecord`.
- Pool treasury PDA (`[b"pool_treasury"]`) + USDC token account, created at `initialize`.
- Instructions:
  - `initialize(usdc_mint)` — creates config + pool treasury.
  - `set_controller(controller)` — owner, settable once.
  - Controller-only: `register_pool(flight_id, date, premium, payoff, delay_hours)`,
    `add_buyer(flight_id, date)`, `settle_on_time(flight_id, date)`,
    `settle_delayed(flight_id, date, claim_expiry)`,
    `settle_cancelled(flight_id, date, claim_expiry)`.
  - Traveler: `claim(flight_id, date)` — pays from treasury (treasury PDA signs).
  - Anyone: `sweep_expired(flight_id, date)` — increments `recovered_balance`, sets
    `claimed_count = buyer_count` (idempotent).
  - Owner: `withdraw_recovered(amount)` — treasury → owner ATA.
- Custom errors enum.

**Unit tests** (`contracts/tests/flight_pool.test.ts`):
- `initialize` — creates config + treasury; usdc_mint matches; treasury authority is the
  expected PDA.
- `set_controller` succeeds once; second call reverts.
- Controller-only instructions revert when called by non-controller.
- `register_pool` — creates FlightPool with locked terms; reverts if pool already exists.
- `add_buyer` — creates BuyerRecord, increments buyer_count, transfers premium from
  traveler ATA to treasury (test passes traveler signature through CPI).
- `add_buyer` for same buyer-pool pair reverts (BuyerRecord PDA collision).
- `settle_on_time` — marks SettledOnTime, transfers `premium * buyer_count` from treasury
  to a recipient token account (vault token account in real flow; mock account in test).
- `settle_delayed` / `settle_cancelled` — sets status + claim_expiry; no transfer (vault
  is what tops up the treasury, tested in integration).
- `claim` happy path: BuyerRecord.claimed = true, claimed_count++, treasury → traveler.
- `claim` reverts: no policy; already claimed; status not SettledDelayed/Cancelled;
  past claim_expiry.
- `sweep_expired` — pre-expiry reverts; post-expiry: increments recovered_balance to
  `(buyer_count - claimed_count) * payoff`, sets claimed_count = buyer_count, second
  sweep is a no-op.
- `withdraw_recovered` — owner-only; decrements recovered_balance; transfers from
  treasury; reverts if amount > recovered_balance.
- Per-user query: `getProgramAccounts` with memcmp on BuyerRecord.buyer returns all
  policies for the connected wallet.

**Done when:**
- All instructions implemented; all unit tests pass.
- IDL synced.

**Depends on:** Phase 0.

---

## Phase 4 — oracle_aggregator_program

**Goal:** Ship the flight data feed. Owns `FlightData` accounts and the only program the
`authorized_oracle` keypair can sign for. Holds zero funds. Three authority types:
`owner`, `authorized_oracle`, `authorized_consumer` (= controller's `ControllerConfig`
PDA, set once).

**Deliverables:**
- Account types: `OracleConfig` (owner, authorized_oracle, authorized_consumer,
  is_consumer_set, bump), `FlightData`, `FlightStatus` enum.
- Instructions:
  - `initialize(authorized_oracle)` — owner sets initial state.
  - `set_authorized_oracle(new_oracle)` — owner-only.
  - `set_authorized_consumer(consumer)` — owner-only, settable once
    (`is_consumer_set == false`); reverts if already set.
  - `init_flight_data(flight_id, date)` — authorized_consumer only (CPI from controller
    on first buy). Creates `FlightData` PDA in `NotInitiated`.
  - `set_estimated_arrival(flight_id, date, eta)` — authorized_oracle only.
    `NotInitiated → Active`.
  - `set_landed(flight_id, date, actual_arrival)` — authorized_oracle only.
    `Active → Landed`.
  - `set_cancelled(flight_id, date)` — authorized_oracle only. `Active → Cancelled`.
  - `set_to_be_settled(flight_id, date, new_status)` — authorized_consumer only (CPI
    from controller's `classify_flights`). `Landed/Cancelled → ToBeSettled*`. Validates
    `new_status` is one of the three `ToBeSettled*` variants.
  - `set_settled(flight_id, date)` — authorized_consumer only (CPI from controller's
    `execute_settlements`). `ToBeSettled* → Settled`.
- Forward-only state-machine guards on every transition; reverse transitions revert.
- Custom errors enum (`UnauthorizedOracle`, `UnauthorizedConsumer`, `ConsumerAlreadySet`,
  `InvalidStateTransition`, etc.).

**Unit tests** (`contracts/tests/oracle_aggregator.test.ts`):
- `initialize` — owner stored; `is_consumer_set == false`.
- `set_authorized_oracle` — owner-only; non-owner reverts.
- `set_authorized_consumer` — succeeds once; second call reverts.
- `init_flight_data` reverts when called by non-consumer; succeeds when consumer signs
  (mock the controller PDA via `invoke_signed` in tests, or simulate by setting
  `authorized_consumer` to a test keypair).
- `set_estimated_arrival` happy path: NotInitiated → Active; estimated_arrival_time set.
- `set_estimated_arrival` reverts when called by non-oracle.
- `set_estimated_arrival` reverts when status != NotInitiated.
- `set_landed` happy path: Active → Landed; actual_arrival_time set.
- `set_landed` reverts when status != Active.
- `set_cancelled` happy path: Active → Cancelled.
- `set_to_be_settled` reverts when called by non-consumer.
- `set_to_be_settled` happy path for each ToBeSettled* variant.
- `set_to_be_settled` reverts when current status not Landed/Cancelled.
- `set_to_be_settled` reverts when new_status is not a ToBeSettled* variant.
- `set_settled` reverts when called by non-consumer; happy path: ToBeSettled* → Settled.
- All forward-only invariants: any reverse transition reverts.

**Done when:**
- All instructions implemented; all unit tests pass.
- IDL synced.

**Depends on:** Phase 0.

---

## Phase 5 — controller_program

**Goal:** Ship the orchestrator. Owns `ControllerConfig` + `ActiveFlightList`. Holds zero
user funds. Reads FlightData (account-passed, owner-checked); writes oracle state via
CPI for `init_flight_data`, `set_to_be_settled`, `set_settled`. CPIs to governance,
vault, flight_pool for the rest of the flow.

**Deliverables:**
- Account types: `ControllerConfig` (owner, authorized_keeper, governance_program,
  vault_program, vault_state, flight_pool_program, flight_pool_config, oracle_program,
  oracle_config, usdc_mint, solvency_ratio, min_lead_time, claim_expiry_window,
  aggregate counters, bump), `ActiveFlightList`.
- Instructions:
  - `initialize(InitializeParams)` — wires governance, vault, flight_pool, oracle, usdc_mint.
  - `set_authorized_keeper` (owner-only).
  - `buy_insurance(flight_id, origin, dest, date)` — orchestrator:
    1. CPI governance: `is_route_whitelisted` + `get_route_terms`.
    2. Enforce `min_lead_time`.
    3. If first buy:
       - CPI `oracle_aggregator.init_flight_data(flight_id, date)` — creates FlightData
         in NotInitiated; signed by `ControllerConfig` PDA.
       - Add to `ActiveFlightList`.
       - CPI `flight_pool.register_pool(...)`.
    4. Solvency check.
    5. CPI `flight_pool.add_buyer(...)` (transitively transfers premium → treasury).
    6. CPI `vault.increase_locked(payoff)`.
    7. Update aggregate counters.
  - Keeper: `classify_flights()` — for each flight in `Landed`/`Cancelled`:
    - Reads FlightData (account-passed, `owner = oracle_program`).
    - Reads `FlightPool.delay_hours`.
    - CPI `oracle_aggregator.set_to_be_settled(flight_id, date, ToBeSettled*)`.
  - Keeper: `execute_settlements()` — for each `ToBeSettled*` flight:
    - On-time: CPI `flight_pool.settle_on_time` + CPI `vault.record_premium_income` +
      CPI `vault.decrease_locked`.
    - Delayed/Cancelled: CPI `vault.send_payout` + CPI `vault.decrease_locked` +
      CPI `flight_pool.settle_delayed` (or `settle_cancelled`).
    - CPI `oracle_aggregator.set_settled(flight_id, date)`.
    - Remove from `ActiveFlightList`.
    Then CPI `vault.process_withdrawal_queue` + CPI `vault.snapshot`.
- `MAX_FLIGHTS_PER_TX` constant — set to ~2 given the additional oracle CPI per flight.

**Unit tests** (`contracts/tests/controller.test.ts`):
- `initialize` — config created; all program references stored correctly (governance,
  vault, vault_state, flight_pool, flight_pool_config, oracle_program, oracle_config).
- `buy_insurance` happy path: governance CPI returns terms; oracle.init_flight_data
  called on first buy; flight_pool.register_pool called on first buy; flight_pool.add_buyer
  called; vault.increase_locked called; BuyerRecord created in flight_pool; FlightData
  created in NotInitiated on oracle.
- `buy_insurance` reverts: route not whitelisted; route disabled; below min_lead_time;
  insufficient solvency.
- Second `buy_insurance` for same flight skips oracle.init_flight_data and
  flight_pool.register_pool, calls add_buyer only.
- `classify_flights` happy path: Landed with delay ≥ threshold → CPI oracle.set_to_be_settled
  with ToBeSettledDelayed; delay < threshold → ToBeSettledOnTime; Cancelled →
  ToBeSettledCancelled.
- `classify_flights` is idempotent on already-classified flights (skips entries not in
  Landed/Cancelled).
- `classify_flights` enforces `authorized_keeper`.
- `execute_settlements` on-time: vault TMA increases, vault locked decreases, treasury
  decreases by `premium * buyer_count`, oracle.set_settled called.
- `execute_settlements` delayed/cancelled: vault locked decreases, treasury increases by
  `(payoff - premium) * buyer_count`, flight_pool status set, claim_expiry set,
  oracle.set_settled called.
- `execute_settlements` end-of-batch: vault.process_withdrawal_queue and vault.snapshot
  invoked.
- `execute_settlements` enforces `authorized_keeper`.

**Done when:**
- All instructions implemented; all unit tests pass.
- IDL synced.
- `oracle_aggregator.set_authorized_consumer(controller_config_pda)` wiring works in
  test setup (called once during full-system bring-up in `tests/setup.ts`).

**Depends on:** Phase 1, Phase 2, Phase 3, Phase 4.

---

## Phase 6 — Cross-Program Integration Tests

**Goal:** Exercise the full lifecycle across all five programs in a single test harness.

**Deliverables:**
- `contracts/tests/e2e.test.ts` covering:
  - Whitelist route (governance) → underwriter deposits (vault) → traveler buys insurance
    (controller, with CPIs to governance + oracle + flight_pool + vault) → oracle key
    writes flight data on `oracle_aggregator_program` → classifier (on controller)
    transitions state via CPI to oracle → settler executes money flow + transitions
    FlightData to Settled via CPI to oracle → traveler claims (via flight_pool) or sweeps.
  - All three settlement outcomes (on-time, delayed, cancelled) in one test run with
    distinct flights, with money flow assertions per outcome.
  - Withdrawal queue draining: underwriter requests withdrawal while capital is locked,
    settles flights, verifies `process_withdrawal_queue` credits `ClaimableBalance`,
    underwriter `collect`s.
  - Solvency edge: try to buy when `free_capital < payoff * solvency_ratio` → reverts.
  - Concurrent flights: settle multiple flights in one `execute_settlements` call (under
    MAX_FLIGHTS_PER_TX, which is ~2 due to per-flight CPI overhead including the oracle CPI).
  - Snapshot: verify daily share-price snapshot record exists after settlement.
  - Authorization: vault.send_payout reverts unless caller is the controller PDA;
    flight_pool.settle_* reverts unless caller is the controller PDA;
    oracle.set_to_be_settled / set_settled / init_flight_data revert unless caller is
    the controller PDA (`authorized_consumer` check).
  - Authority isolation: `authorized_oracle` key cannot call any controller instruction;
    `authorized_keeper` key cannot call any oracle write instruction.
- Helper utilities in `contracts/tests/setup.ts` extended with full-protocol bring-up
  (governance + vault + flight_pool + oracle_aggregator + controller, with
  `vault.set_controller(controller_config_pda)`,
  `flight_pool.set_controller(controller_config_pda)`, and
  `oracle_aggregator.set_authorized_consumer(controller_config_pda)` all wired).

**Done when:**
- All integration tests pass.
- Coverage report (if `cargo-llvm-cov` is wired) shows all happy-path code reachable.

**Depends on:** Phases 1, 2, 3, 4, 5.

---

## Phase 7 — Devnet Deployment

**Goal:** Deploy all five programs to Solana devnet, wire references, smoke-test on-chain.

**Deliverables:**
- `contracts/scripts/deploy.ts` — Anchor migration:
  1. Deploy mock USDC mint (devnet only) — reuses `keys/mock-usdc.json`.
  2. Deploy governance, vault, flight_pool, oracle_aggregator, controller programs.
  3. Initialise each:
     - governance: defaults.
     - vault: `initialize(usdc_mint)`.
     - flight_pool: `initialize(usdc_mint)`.
     - oracle_aggregator: `initialize(authorized_oracle = placeholder)`.
     - controller: `initialize(...)` with all program references (governance, vault,
       vault_state, flight_pool, flight_pool_config, oracle_program, oracle_config,
       usdc_mint).
  4. Wire authorities (each settable once):
     - `vault.set_controller(controller_config_pda)`.
     - `flight_pool.set_controller(controller_config_pda)`.
     - `oracle_aggregator.set_authorized_consumer(controller_config_pda)`.
  5. Set `authorized_oracle` (on oracle_aggregator) and `authorized_keeper`
     (on controller) to placeholder keys (rotated in Phase 8/9/10).
- Anchor.toml networks block configured for devnet with deployed program IDs.
- Program IDs replaced in source `declare_id!` macros and re-built; types re-synced.
- `contracts/scripts/devnet-smoke.ts` — runs end-to-end against deployed programs:
  whitelist a route, deposit, buy_insurance, oracle write, classify, settle, claim.
- `.env.example` documenting the keypair paths and RPC URL.

**Done when:**
- `solana program show <ID>` returns metadata for all five programs.
- `devnet-smoke.ts` completes without error against the deployed programs.
- IDL files in `frontend/src/idl/` reflect the deployed program IDs.
- Codama clients in `frontend/src/clients/` and `executor/src/clients/` regenerated.

**Depends on:** Phase 6.

---

## Phase 8 — Oracle Cron (FlightDataFetcher)

**Goal:** Build cron #1 — pulls AeroAPI, writes flight data to FlightData accounts.
This phase also stands up the `executor/` scaffold that the next two crons reuse.

**Deliverables:**
- `executor/src/core/types.ts` — `FlightStatus`, `FlightData`, etc.
- `executor/src/core/solana_client.ts` — wraps Anchor client, handles tx build/sign/send,
  retries with backoff.
- `executor/src/core/aeroapi_client.ts` — typed AeroAPI client (uses `aero-api` skill
  for endpoints + parsing).
- `executor/src/core/flight_data_fetcher.ts` — main loop:
  - Reads `ActiveFlightList` via RPC.
  - For NotInitiated flights: fetch ETA → `set_estimated_arrival`.
  - For Active flights where `estimated_arrival + 1h < now`: fetch status →
    `set_landed` / `set_cancelled` / skip.
- `executor/src/scripts/run-fetcher.ts` — one-shot runner for manual + cron use.

**Tests** (`executor/tests/flight_data_fetcher.test.ts`):
- Mocked AeroAPI: NotInitiated flight → builds correct `set_estimated_arrival` instruction.
- Active flight + landed AeroAPI response → builds `set_landed`.
- Active flight + cancelled AeroAPI response → builds `set_cancelled`.
- Active flight before 1-hour buffer → skipped.
- AeroAPI HTTP error → flight skipped, retry-safe.
- Idempotency: re-running on the same state produces no extra transactions.

**Devnet integration:**
- Register a flight on devnet, run `run-fetcher.ts`, verify FlightData transitions.
- Rotate `authorized_oracle` to the fetcher's keypair via
  `oracle_aggregator.set_authorized_oracle(...)` (signed by oracle program owner).

**Done when:**
- Unit tests pass.
- One-shot run on devnet writes data to a real FlightData account.

**Depends on:** Phase 7.

---

## Phase 9 — Classifier Cron (FlightClassifier)

**Goal:** Build cron #2 — calls `controller.classify_flights()` periodically.

**Deliverables:**
- `executor/src/core/flight_classifier.ts` — builds + signs `classify_flights`
  instruction; submits via solana_client; handles `MAX_FLIGHTS_PER_TX` overflow by
  sending multiple sequential transactions until the active list is fully scanned.
- `executor/src/scripts/run-classifier.ts` — one-shot runner.

**Tests:**
- Unit: instruction is built with `authorized_keeper` as signer.
- Unit: when active list exceeds MAX_FLIGHTS_PER_TX, multiple transactions are submitted.
- Devnet integration:
  - Set up two flights: one Landed (delayed), one Cancelled.
  - Run classifier; assert FlightData status transitions to ToBeSettledDelayed and
    ToBeSettledCancelled respectively.

**Done when:**
- Unit tests pass.
- Devnet run flips two flights through classification.

**Depends on:** Phase 8.

---

## Phase 10 — Settlement Cron (SettlementExecutor) + Cron Backend

**Goal:** Build cron #3 — calls `execute_settlements()`, drains withdrawal queue,
snapshots. Also wire all three crons into the node-cron backend with health checks.

**Deliverables:**
- `executor/src/core/settlement_executor.ts` — builds + signs `execute_settlements`
  instruction; multi-tx fanout for MAX_FLIGHTS_PER_TX overflow.
- `executor/src/scripts/run-settler.ts` — one-shot runner.
- `executor/src/backends/cron/index.ts` — node-cron entry point with three schedules:
  - `0 */2 * * *` (every 2h) → FlightDataFetcher
  - `0 * * * *` (every 1h) → FlightClassifier
  - `*/5 * * * *` (every 5min) → SettlementExecutor
- `executor/src/backends/cron/config.ts` — loads `.env` for RPC URL, oracle keypair,
  keeper keypair, AeroAPI key.
- `executor/src/backends/cron/health.ts` — `/health` HTTP endpoint reporting last-run
  timestamp and success/failure for each schedule.
- `executor/Dockerfile` — single-image deployment.
- `executor/.env.example` documenting all required env vars.

**Tests:**
- Unit: settler instruction built correctly for all three settlement outcomes.
- Unit: queue-drain CPI included in instruction; snapshot CPI included.
- Devnet integration:
  - Set up three flights (on-time, delayed, cancelled), all in ToBeSettled* state.
  - Run settler; assert money flows match `architecture.md §Payout Math`:
    - On-time: vault TMA ↑ by premium × buyers; locked ↓ by payoff × buyers.
    - Delayed/cancelled: pool treasury holds payoff × buyers; locked ↓ by payoff × buyers.
  - Set up a queued withdrawal request; assert `ClaimableBalance` is credited after settlement.

**Done when:**
- All unit + devnet integration tests pass.
- `docker run executor` starts and `/health` returns 200 with all three schedules tracked.

**Depends on:** Phase 9.

---

## Phase 11 — Frontend Bootstrap

**Goal:** Connect a wallet, read on-chain state, render the app shell.

**Deliverables:**
- Next.js app with App Router, Tailwind, and **framework-kit** (`@solana/client` +
  `@solana/react-hooks`) with wallet-standard discovery (`autoDiscover()`). **No**
  `@solana/wallet-adapter-react`.
- `app/providers.tsx` with single `createClient(...)` wrapped in `<SolanaProvider>`,
  configured for devnet with the deployed program IDs.
- `src/idl/` populated by `pnpm sync-idl` (5 IDLs).
- `src/clients/` populated by `pnpm gen-clients` (Codama-generated typed Kit clients
  for all 5 programs).
- `src/hooks/useGovernance.ts`, `useVault.ts`, `useFlightPool.ts`, `useOracle.ts`,
  `useController.ts` — typed Kit clients scoped to the connected wallet via
  framework-kit hooks.
- App shell with navigation: Traveler / Underwriter / Admin.
- Landing page showing protocol vitals: TMA, locked capital, free capital, share price,
  total policies sold, total payouts distributed (read from `VaultState` and
  `ControllerConfig`).
- Toast / status notification component for tx status (Phantom-style).

**Tests:**
- Component tests for `WalletButton`, `ProtocolStats`.
- Manual smoke test: connect Phantom on devnet, see real values from deployed contracts.

**Done when:**
- `pnpm dev:frontend` renders the landing page with live devnet data.
- Wallet connect/disconnect works; readonly state shown without a connected wallet.

**Depends on:** Phase 7.

---

## Phase 12 — Frontend: Traveler Dashboard

**Goal:** Travelers can buy insurance, see their policies, and claim payouts.

**Deliverables:**
- Buy insurance form: flight_id, origin, destination, date inputs.
  - Pre-flight: read governance for resolved terms (preview premium / payoff /
    delay_hours), check route is whitelisted, check vault solvency, check lead time.
  - On submit: build + send `controller.buy_insurance` tx (resolves all CPI accounts
    from PDAs — governance, oracle_aggregator, flight_pool, vault), show toast.
- "My policies" view: `getProgramAccounts` + memcmp on BuyerRecord.buyer (against
  `flight_pool` program) for the connected wallet. Shows flight_id, date, policy status
  (Active / Settled / Claimed).
- Per-policy detail card: live FlightData status (from oracle_aggregator program),
  settlement status (from flight_pool's FlightPool), claim button if eligible (status
  SettledDelayed/Cancelled, not yet claimed, before claim_expiry).
- Claim transaction handler — calls `flight_pool.claim` directly (not via controller).

**Tests:**
- Component tests for the buy form (validation, button disabled states).
- Component tests for the my-policies list (renders empty state, populated state).
- Manual: full buy → claim flow on devnet against an oracle-driven settlement.

**Done when:**
- A new wallet can buy a policy on devnet via the UI.
- After settlement, the same wallet sees the policy and can click Claim to receive USDC.

**Depends on:** Phase 11, Phase 10 (so settlements actually happen on devnet).

---

## Phase 13 — Frontend: Underwriter Dashboard

**Goal:** Underwriters can deposit, redeem, queue withdrawals, and collect.

**Deliverables:**
- Vault metrics card: TMA, locked, free, share price (live), connected user's share
  balance + USDC equivalent.
- Deposit form: USDC amount → preview shares to receive (apply virtual offset math) →
  submit `deposit`.
- Redeem form: shares → preview USDC out → submit `redeem`. Show warning if
  free_capital < redemption (suggest queued path).
- Queued withdrawal form: shares → submit `request_withdrawal`. Show user's queue
  position and timestamp.
- Cancel queued request button (per row).
- Claimable balance card: shows pending USDC; "Collect" button → `vault.collect()`.
- Daily share-price chart (read snapshot records).

**Tests:**
- Component tests for deposit/redeem math previews.
- Manual: deposit → simulate locked capital → request_withdrawal → settle a flight →
  claimable balance appears → collect.

**Done when:**
- A wallet can deposit, redeem, queue, cancel, and collect via the UI on devnet.

**Depends on:** Phase 11.

---

## Phase 14 — Frontend: Admin Panel

**Goal:** Owner / admin can manage routes and tunables. Owner-only UI hidden for
non-owners.

**Deliverables:**
- Auth guard: read `GovernanceConfig.owner` and `AdminRecord` PDAs; show panel only
  for owner or active admin.
- Route management:
  - Whitelist route form (with optional override fields).
  - Disable route button.
  - Update route terms form (per-field "keep / override / revert to default" tri-state).
  - List of all routes with current status + resolved terms.
- Defaults form (owner-only): set_defaults.
- Admin management (owner-only): add_admin, remove_admin.
- Controller config tunables (owner-only): `set_authorized_keeper`.
- Oracle config tunables (owner-only): `set_authorized_oracle` (calls
  `oracle_aggregator_program`, not controller).
- Flight pool config tunables (owner-only): `withdraw_recovered` (calls
  `flight_pool_program`).

**Tests:**
- Component tests for route form and tri-state field control.
- Manual: walk through every admin action on devnet.

**Done when:**
- Owner wallet can perform every admin action via the UI.
- Non-owner wallet sees the read-only view.

**Depends on:** Phase 11.

---

## Phase 15 — End-to-End Test

**Goal:** A scripted test that drives a real browser through a full user journey on
a fresh devnet environment.

**Deliverables:**
- Playwright (or Cypress) test suite in `frontend/tests/e2e/`.
- A devnet-reset script: re-runs `contracts/scripts/deploy.ts` to a fresh program
  pair (or uses ephemeral keypairs) so each E2E run starts clean.
- Test programmatically generates and funds wallets (test owner, admin, underwriter,
  traveler).
- Single test scenario, top to bottom:
  1. Owner connects, sets defaults, whitelists a route.
  2. Underwriter connects, deposits 10,000 USDC.
  3. Traveler connects, buys insurance for the route.
  4. Test script (signing as `authorized_oracle`) directly calls
     `oracle_aggregator.set_estimated_arrival` then `oracle_aggregator.set_landed` with
     a delay > threshold (bypassing AeroAPI for determinism).
  5. Test script (signing as `authorized_keeper`) directly calls
     `controller.classify_flights` then `controller.execute_settlements`.
  6. Traveler refreshes "My Policies", clicks Claim, receives USDC.
  7. Underwriter refreshes Vault Metrics, sees correct locked/TMA values.
- CI workflow: runs nightly against devnet; uploads screenshots/video on failure.

**Done when:**
- The full Playwright scenario passes locally.
- CI workflow runs green on a scheduled trigger.

**Depends on:** Phases 12, 13, 14.

---

## Cross-cutting notes

- **Phase boundaries are firm:** a phase is "done" only when its `Done when` checklist
  is satisfied. Don't roll work forward — file it as a follow-up issue.
- **IDL must stay in sync:** every program change runs `pnpm sync-idl` before any
  frontend or executor work resumes.
- **Devnet keys live in env, not git:** the deploy script reads from `~/.config/solana/`
  by default; CI uses a sealed secret.
- **Mock USDC is dev-only:** mainnet config swaps in the canonical USDC mint
  (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) — no other code change.
