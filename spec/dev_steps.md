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

## Phase 11 — End-to-End Cron Validation (Surfpool, no frontend)

**Goal:** Validate the full on-chain + cron loop on a live Surfpool deployment. Drive
multiple parameterized scenarios through the **real cron core functions**
(`runFetcherOnce` / `runClassifierOnce` / `runSettlerOnce`) with a mocked AeroAPI
returning scripted flight states. Asserts that money moves correctly across the full
protocol stack — vault, flight_pool, oracle_aggregator, controller — using the real
runner code paths, not LiteSVM simulators. The last sanity gate before frontend work
begins. **No contract changes** (constraint preserved from Phases 8–10).

**Deliverables:**
- `executor/src/test/mock_aero_api.ts` — `createMockAeroApi(initialState)` returns an
  `AeroApiClient`-shaped object whose `fetchFlightsForDay(ident, dateIso)` reads from
  an in-memory `Map<string, AeroFlight>`. State is mutated tick-by-tick by the test
  harness (e.g., flight goes `cancelled: true` at tick 3) so a single mock client can
  serve the full scenario timeline. Returns `null` when an ident isn't seeded (matches
  the real client's not-found behavior).
- `executor/src/core/aeroapi_client.ts` — extended error handling:
  - Parse the AeroAPI 4xx error envelope `{title, reason, detail, status}` and log
    the structured fields before returning null.
  - 5xx + network + JSON-parse failures continue to log + return null (already
    covered in Phase 8 — consolidate logging here).
  - Export an `AeroApiError` type so tests can assert the parsed envelope.
- `contracts/tests/integration/e2e-with-crons-deployed.test.ts` — Vitest integration
  test against a live Surfpool deployment. Skips with a warning when Surfpool isn't
  running OR no recent deployment artifact exists (same skip pattern as
  `full-flow-deployed.test.ts`). Loops over a parameterized `Scenario[]` table; each
  scenario describes one buyer, one flight, one mutation timeline, one expected
  outcome.
- `executor/tests/aeroapi_error_envelope.test.ts` — unit tests for the error envelope
  decode (well-formed 400 JSON, malformed body, missing fields, no content-type,
  non-JSON, 5xx).
- README "Running the e2e cron suite" section: prereqs (`pnpm dev:surfpool` running,
  fresh deploy), command (`pnpm test:e2e:crons`), what each scenario validates.

**Test scenarios (parameterized):**
1. **on-time landing** — cron sees `actual_in !== null` ≈ `scheduled_in`;
   FlightStatus → Active → Landed → ToBeSettledOnTime → Settled. Vault TMA ↑ by
   premium × buyers; locked ↓ by payoff × buyers. No payout ATA credited.
2. **delayed beyond threshold** — `actual_in - scheduled_in > delay_hours`;
   FlightStatus → Active → Landed → ToBeSettledDelayed → Settled. Pool treasury
   holds payoff × buyers; locked ↓ by payoff × buyers. Buyer can claim.
3. **cancelled before ETA-seed** — `cancelled: true` arrives while
   FlightStatus = NotInitiated; fetcher fires the **two-ix-in-one-tx** atomic
   path (set_estimated_arrival → set_cancelled). Settles to Cancelled. Buyer
   can claim.
4. **cancelled after ETA-seed** — `cancelled: true` arrives while
   FlightStatus = Active; fetcher fires single-ix `set_cancelled`. Settles.
5. **multi-flight in single settler tick** — 3 flights all in ToBeSettled*
   simultaneously; settler chunks at MAX_FLIGHTS_PER_TX = 2 → two txs
   ([2,1] split). Asserts both txs land, ActiveFlightList drains fully.
6. **withdrawal queued during active flight** — investor queues withdrawal at
   tick 0; settler tick post-settlement drains the queue and credits
   `ClaimableBalance`. Investor `collect()`s. Asserts Model B
   value-at-request-time semantics under live RPC.
7. **status-string-ignored invariant** — flight returned with
   `status: "Cancelled"` (string) but `cancelled: false` and `actual_in: null`.
   Fetcher ignores the string, treats as in-flight, no on-chain state change.
   Defends the boolean-only branching from a regression.

**Tests:**
- Unit: AeroAPI error-envelope decode (in-process, mocked fetch).
- Integration: all 7 scenarios pass against a live Surfpool deployment.
- Total executor test count rises from 58 → 65+ (Phase 10 baseline + envelope tests).
- Test runtime budget: full integration suite under 5 minutes (Surfpool startup +
  deploy not counted; assumed pre-flight).

**Done when:**
- `pnpm test:e2e:crons` runs end-to-end against a live Surfpool deployment with all
  7 scenarios passing.
- AeroAPI client logs the structured error envelope (title/reason/detail/status) on
  4xx; unit tests cover the decode.
- README has a "Running the e2e cron suite" section.
- No contract changes.
- Executor unit tests still pass standalone (`pnpm --filter @sentinel/executor test`).

**Depends on:** Phase 10. (Phase 7's deploy script is the bootstrap; the test reads
`deployments/surfpool-latest.json`.)

---

## Phase 12 — Frontend Bootstrap

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

## Phase 13 — Frontend: Admin Panel

**Goal:** Owner / admin can manage routes and tunables. Owner-only UI hidden for
non-owners. Sequenced first among the role dashboards because every downstream
buy/deposit flow depends on whitelisted routes.

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
- Manual: walk through every admin action on devnet (whitelist a few demo routes,
  set defaults, add a co-admin, etc.) — proves the deployed governance program
  is reachable end-to-end.

**Done when:**
- Owner wallet can perform every admin action via the UI.
- Non-owner wallet sees the read-only view.
- A handful of demo routes are whitelisted on devnet (live data for Phase 14/15
  to read against).

**Depends on:** Phase 12.

---

## Phase 14 — Frontend: Underwriter Dashboard

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

**Depends on:** Phase 12.

---

## Phase 15 — Frontend: Traveler Dashboard

**Goal:** Travelers can buy insurance, see their policies, and claim payouts.
Sequenced after Admin (Phase 13) and Underwriter (Phase 14) so the buy flow
already has whitelisted routes + a solvent vault to land against on devnet —
no CLI seeding required.

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
- Manual: full buy → claim flow on devnet against an oracle-driven settlement.
  By Phase 15 the cron daemon (Phase 8–10) can be pointed at devnet to drive
  the settlement leg.

**Done when:**
- A new wallet can buy a policy on devnet via the UI.
- After settlement, the same wallet sees the policy and can click Claim to receive USDC.

**Depends on:** Phase 12, Phase 13 (whitelisted routes), Phase 14 (vault liquidity), Phase 11 (settlement pipeline tested).

---

## Phase 16 — End-to-End Test (Browser)

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

**Depends on:** Phases 13, 14, 15.

---

## Phase 17 — Cron Control Panel (Classifier + Settler)

**Goal:** Replace the mock `/crons` page with a real operator control surface
that triggers the FlightClassifier and SettlementExecutor crons on demand,
records each run to a persistent log, and surfaces last-run state + the live
ActiveFlightList. The FlightDataFetcher (oracle) cron is explicitly
out-of-scope — it ships in Phase 18 once the AeroAPI trust model is settled.

**Deliverables:**
- `frontend/app/api/cron/[id]/trigger/route.ts` — public-unauth POST handler
  that wraps `runClassifierOnce` / `runSettlerOnce` from `@sentinel/executor`
  and writes a structured run record to a JSONL log.
- `frontend/app/api/cron/runs/route.ts` — GET handler returning the last N
  records, optionally filtered by cron id.
- `frontend/app/api/cron/active-flights/route.ts` — GET handler returning
  the on-chain `ActiveFlightList` plus each entry's `FlightStatus`.
- `/crons` page rewritten to poll those routes, show last-run state per
  cron, expose a Trigger button per cron (disabled for fetcher),
  and render the ActiveFlightList live.
- Cluster-aware keypair loading (`CRON_KEEPER_BASE58 / CRON_KEEPER_PATH`)
  with sensible fallbacks.
- README runbook + JSONL/Vercel caveat documented.

**Done when:**
- Both triggers succeed end-to-end against either devnet or surfpool.
- `/crons` reflects the post-tick state without a page reload (uses the
  Phase 16 tx-success burst).
- Fetcher card is visibly gated with a "Phase 18 — pending oracle
  integration" indicator.

**Depends on:** Phases 9, 10, 13, 16.

---

## Phase 18 — FlightDataFetcher Oracle Integration (Centralized)

**Status: scope locked — centralised TypeScript cron.** A maintained
off-chain cron signs as `authorized_oracle` after fetching AeroAPI.
Lowest friction, weakest trust. The decentralised / TEE-attested
variants (Switchboard On-Demand v2 with SGX, Acurast mobile TEE,
Pyth-style adapter) are deferred to **Phase 19**. The on-chain surface
stays unchanged — `OracleConfig.authorized_oracle` is already a swap
point that Phase 19 can reuse.

**Operational shape:** the oracle signer keypair is the **deployer**
(`FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy`) so all three crons
(fetcher, classifier, settler) share one secret + one balance on the
deploy box. A one-shot `pnpm rotate-oracle --cluster devnet` rotates
`authorized_oracle` to the deployer pubkey (mirror of Phase 17's
`pnpm rotate-keeper`).

**Demo posture:** mock mode is first-class. Env flag
`AEROAPI_MOCK=1` + `AEROAPI_MOCK_SCENARIO=on_time|delayed|cancelled_pre_eta|cancelled_post_eta|not_found`
swaps the live AeroAPI client for a deterministic stub keyed off the
active flight's on-chain `date`. Real mode requires `AEROAPI_KEY`.

**Deliverables:**
- `scripts/rotate-oracle.ts` — owner-signed `set_authorized_oracle` rotation
  (mirror of `scripts/rotate-keeper.ts`). Idempotent.
- `pnpm rotate-oracle` entry in root `package.json`.
- `frontend/src/lib/cron-runs.ts` — `CronId` union extended with
  `'fetcher'`; rotation cap applied per-cron across all three buckets.
- `frontend/app/api/cron/[id]/trigger/route.ts` — fetcher branch
  replaces the current 400 gate. Builds AeroAPI client (live or mock)
  per env, runs `runFetcherOnce`, reuses Phase 17's mutex / capture /
  JSONL persistence patterns.
- `frontend/app/crons/page.tsx` — fetcher card ungated, signer = deployer,
  same activity feed shape as classifier + settler.
- README §"Cron control panel" updated with the fetcher row + AeroAPI
  env vars + `pnpm rotate-oracle` runbook.

**Done when:**
- `pnpm rotate-oracle --cluster devnet` confirms; post-tx
  `OracleConfig.authorized_oracle` equals the deployer pubkey.
- `pnpm -r typecheck` clean across all 3 workspaces.
- Mock-mode trigger from `/crons` advances at least one active flight
  through a `FlightStatus` transition; activity feed shows a green
  `OK · n acted, n skipped · X.Ys` row signed by the deployer.
- Real-mode trigger (with `AEROAPI_KEY`) hits live AeroAPI for at
  least one active flight without surfacing a red banner from
  transient HTTP errors (the AeroAPI client's "never throw, log + skip"
  contract holds end-to-end).

**Depends on:** Phases 4, 7, 8, 11, 17.

---

## Phase 19 — Acurast TEE Oracle (locked, deferred)

**Status: scope locked, execution deferred.** The trust model is
**Acurast TEE** — a mobile-TEE worker that runs the existing
FlightDataFetcher TS code from inside an enclave, holding `AEROAPI_KEY`
in TEE-protected memory and signing as `authorized_oracle`. The
on-chain surface stays exactly as Phase 4 shipped it; this phase is
a deployment + key-rotation exercise, not a program rewrite.

**Why Acurast over Switchboard On-Demand:** evaluated against
Switchboard On-Demand and ruled it out for this specific use case.
Switchboard's variable-override mechanism passes API keys from the
caller's process at fetch time — keys are NOT held inside the TEE,
so the secret-protection win is illusory. Switchboard also emits
numeric values only, forcing awkward i128-packing of our
`(status, eta, actual)` triple, and the queue's median-aggregation
multiplies AeroAPI quota burn by 4–8× without integrity gain when
the upstream is a single source. Acurast's general-purpose TEE
compute model fits cleanly: arbitrary TS, real secret protection,
zero on-chain changes, single API call per refresh. Switchboard
On-Demand stays on the table for a future numeric-oracle phase
(e.g. dynamic premium pricing, FX-pegged payouts).

**Deliverables (TBD when this phase is started):**
- Acurast worker bundle — port `executor/src/scripts/run-fetcher.ts`
  + Codama-generated oracle clients into an Acurast deployment package.
- Image hash published to IPFS so the published code is auditable.
- TEE-managed `authorized_oracle` keypair generated inside the
  enclave; pubkey rotated on-chain via `pnpm rotate-oracle --oracle <tee-pubkey>`.
- Operational runbook: `AEROAPI_KEY` provisioned to the Acurast
  deployment as a sealed secret; cadence configured (matches Phase 8's
  2-hour cron, or pull-driven from the `/crons` UI via a thin proxy).
- README + architecture.md updated to reflect the TEE trust model.

**Out of scope for this phase:**
- Numeric oracle integration (Switchboard On-Demand, Pyth) — that's
  a future phase if we add price-denominated features.
- Decentralised flight-data feeds — no Pyth/Chainlink-grade source
  exists for this data today; revisit only if one ships.
- Program changes — `OracleConfig.authorized_oracle` is already a
  swap-friendly indirection; this phase exercises that swap.

**Skip rationale:** the centralised Phase 18 oracle is acceptable for
the hackathon scope (devnet, single-operator deploy, public-unauth
trigger surface). Phase 19 is the "real-world hardening" follow-up.
Lock the architecture choice now (Acurast) so any future contributor
has direction without re-litigating the decision; defer execution
until production deployment is on the roadmap.

**Depends on:** Phase 18 (the operational surface is already in place;
Phase 19 swaps the signer underneath it).

---

## Phase 20 — Chrome Extension (Expedia Surface) (locked, deferred)

**Status: scope locked, execution deferred.** Out of hackathon scope —
the dApp at `/buy` already covers the same `controller.buy_insurance`
flow with the same Wallet Standard / framework-kit UX, so a separate
browser surface is not on the demo's critical path. Lock the design
choice now (Manifest V3 + sideload + Codama-typed clients reused from
`frontend/`) so a future contributor has direction without re-litigating
the architecture; defer execution until post-hackathon.

Ship a Manifest V3 Chrome extension that injects
on Expedia flight pages, parses the route + date out of the DOM, and
lets the user buy delay insurance via the existing
`controller.buy_insurance` flow. This phase is the **extension
chassis** — wallet UX assumes the user has Phantom (or any
Wallet-Standard-compatible wallet) installed, identical to the
current `/buy` page on the dApp. Phase 21 retrofits walletless
onboarding + sponsored gas on top of this chassis.

**Deliverables:**
- New `extension/` pnpm workspace alongside `frontend/` and `executor/`.
- Manifest V3 manifest (background service worker + content script + popup).
- Content script: Expedia DOM parser → `(flight_id, origin, dest, date)`.
  Resilient to layout drift (selector fallbacks + a manual-entry escape hatch).
- Popup UI: matches the frontend design system; shows route, premium,
  payoff, claim window, "Insure" CTA.
- Wallet Standard connect via framework-kit (`@solana/client` +
  `@solana/react-hooks`, `autoDiscover()` — same locked stack as the
  frontend; **NO** `@solana/wallet-adapter-*`).
- Reuses Codama-generated typed clients (`@/clients/controller/...`)
  for `buy_insurance`. Either (a) imports them from `frontend/src/clients`
  via a workspace path alias, or (b) re-runs `pnpm gen-clients` to emit
  them into `extension/src/clients/` (gitignored, same pattern as
  frontend / executor).
- Reads `deployments/devnet-latest.json` for program IDs + PDAs.
- Activity feed in the popup showing recent purchases (reuses Phase 17's
  JSONL pattern at `extension/.cache-extension-runs.jsonl`, gitignored).
- Sideload-ready `.zip` build + README runbook (`pnpm extension:build`).

**Done when:**
- Sideload the extension in Chrome → navigate to an Expedia flight
  detail page → extension recognises the route → click Insure → Phantom
  signs the `buy_insurance` tx → BuyerRecord exists on devnet →
  `/portfolio` on the dApp shows the new policy.
- `pnpm -r typecheck` clean across all 4 workspaces (contracts, frontend,
  executor, extension).

**Out of scope:**
- Walletless / embedded-wallet onboarding (Phase 21).
- Sponsored gas / fee-payer relay (Phase 21).
- Onramp (card → USDC) — deferred indefinitely; USDC funding stays
  manual in Phase 20 (Phantom user already holds USDC, or uses the
  existing `/faucet` route).
- Chrome Web Store publish — phase ships as sideload-only.

**Depends on:** Phase 7 (devnet deployment + canonical addresses),
Phase 13 (admin patterns), Phase 15 (frontend `/buy` flow — the
Codama call site this phase clones).

---

## Phase 21 — Walletless + Sponsored Gas (Privy + Relay) (locked, deferred)

**Status: scope locked, execution deferred.** Out of hackathon scope —
requires an Anchor schema change on `controller.buy_insurance` (split
`buyer` from a new `rent_payer: Signer`) and a one-time controller
redeploy, which is too invasive for the locked stack at this stage.
Privy + sponsored gas is also orthogonal to the core demo narrative
(AI-priced premiums via Phase 22 + Phase 23). Lock the design choice
now (Privy embedded wallet + relay route + D18 `rent_payer` schema +
devnet faucet drop) so a future contributor can ship without
re-litigating; defer execution until Phase 20 ships and there is a real
walletless surface to plug into. Depends on Phase 20.

Layer walletless onboarding + full gas sponsorship
onto the Phase 20 extension. User signs in with Google via Privy; an
embedded Solana wallet is provisioned in the extension; a backend
relay sponsors **all** SOL costs (tx fee + rent for `BuyerRecord` and
the buyer's USDC ATA); user pays only the USDC premium itself. Onramp
(card → USDC) is **explicitly deferred** — USDC is faucet-dropped to
freshly-created embedded wallets so the demo flow never blocks on
fiat infrastructure.

**Deliverables:**
- Privy SDK integration in `extension/` — Solana embedded wallet,
  Google + email login, MV3-compatible popup auth flow. Replaces the
  Phase 20 wallet-standard connect on the extension surface only
  (the dApp keeps its existing wallet UX).
- New backend route `/api/sponsor/relay` (Next.js, `extension`-aware)
  — builds the `buy_insurance` tx with `feePayer = sponsor`,
  user signs as `buyer`, sponsor co-signs as both `feePayer` and
  `rent_payer`, backend submits to RPC. Mirrors the Phase 17 cron
  route pattern (mutex + JSONL log + concise-error contract).
- New backend route `/api/sponsor/faucet-usdc` — **devnet-only**
  one-shot drop of USDC to a freshly-created embedded wallet on
  first login. Reuses the existing `keys/mock-usdc-authority.json`
  mint-authority signer.
- **Anchor schema change** on `controller.buy_insurance`: add a
  separate `rent_payer: Signer` field (D18 pattern — already applied
  to `vault.snapshot`, `oracle.init_flight_data`,
  `flight_pool.register_pool` per MEMORY). `BuyerRecord` and the
  buyer USDC ATA `init`s use `payer = rent_payer`. The `buyer` field
  remains a `Signer` for authorisation invariants but no longer
  pays SOL. Anchor v1 single-lifetime form per Phase 6 D-Phase6-5.
- Controller program recompile + redeploy (canonical program ID
  stays the same per MEMORY); IDL regen + Codama regen across
  `frontend/`, `executor/`, `extension/` workspaces. Frontend `/buy`
  page updated to set `rent_payer = buyer` (preserves existing UX —
  Phantom users keep paying their own rent).
- Sponsor keypair generation + funding runbook
  (`scripts/bootstrap-sponsor.ts`); pubkey committed at
  `keys/devnet-sponsor.pubkey`, secret gitignored. Documented top-up
  cadence + estimated SOL burn per signup
  (~890K lamports BuyerRecord rent + ~2M lamports ATA rent + ~5K tx fee).
- Rate-limiting on `/api/sponsor/relay` — IP-based or
  embedded-wallet-pubkey-based, whichever Privy exposes cleanly.
  Document mainnet hardening (Turnstile / Captcha / shared-secret
  header) as a follow-up.
- Extension UI: replace Phase 20's wallet-standard connect with the
  Privy login button. Show a "Gas sponsored" indicator in the popup.
  Activity feed annotates which tx was sponsored.

**Done when:**
- A user with **no Phantom installed, no SOL, no USDC** sideloads the
  extension → navigates to Expedia flight page → clicks "Sign in with
  Google" → embedded Solana wallet provisioned → faucet drops 100
  mock USDC → clicks Insure → relay returns sponsored tx signature →
  BuyerRecord exists on devnet → user's lamport balance is `0` from
  start to finish.
- `pnpm -r typecheck` clean; all four programs still pass their
  existing test suites after the schema change (88+ tests today).
- Operator runbook: `keys/devnet-sponsor.json` funding command,
  per-signup cost sheet, top-up trigger threshold.

**Out of scope:**
- Onramp (card → USDC). Real-USDC users on mainnet would need it;
  hackathon-grade demo runs entirely off the devnet faucet.
- Mainnet sponsor economics — sponsor budget, abuse vectors, KYC,
  rate-limiting at scale. Devnet only.
- Gasless **claim** flow. Phase 21 sponsors `buy_insurance` only;
  `flight_pool.claim` remains buyer-paid (acceptable — claims happen
  rarely and post-payout, where the user has USDC and can fund SOL
  separately if they want).
- Lazorkit / passkey alternative to Privy — evaluated, deferred.
  Privy is the lowest-risk MV3 path today.

**Depends on:** Phase 20 (extension chassis), and a one-time
controller-program redeploy with the `rent_payer` schema change.

---

## Phase 22 — Premium Pricing Agent (FastAPI + XGBoost)

**Status: planned.** Stand up `agent/` as a fourth workspace alongside
`frontend/`, `executor/`, and `contracts/`. Train and export an XGBoost
model on the [Kaggle "Flight Delays Fall 2018"](https://www.kaggle.com/competitions/flight-delays-fall-2018)
dataset, then wrap it in a tiny FastAPI service that maps a flight tuple to a USDC premium clamped to
`[$1, $5]` via `premium_usdc = clamp(1 + 4 * p_delay, 1, 5)`. Hackathon-
grade pricing — proof-of-concept only, not actuarially sound. The agent has
no on-chain authority; the only consumer is Phase 23's `RouteRepricer` cron
via `POST /price`.

**Deliverables:**
- New `agent/` workspace (Python; sibling of `frontend/`/`executor/`/
  `contracts/` but NOT in `pnpm-workspace.yaml`). Layout: `agent/app/`,
  `agent/training/`, `agent/data/` (gitignored), `agent/artifacts/`
  (gitignored), `agent/tests/`.
- `agent/training/train.py` — 1:1 port of the notebook's modelling cells.
  Loads `agent/data/flight_delays_train.csv`, applies the same
  OHE pipeline (cat features `[Month, DayofMonth, DayOfWeek, UniqueCarrier,
  Origin, Dest]`, num features `[DepTime, Distance]`), fits `XGBClassifier`
  with the locked hyperparameters
  (`n_estimators=200, learning_rate=0.1, max_depth=9, subsample=0.8,
  colsample_bytree=0.8, random_state=42`). Persists `model.joblib`,
  `encoder.joblib`, `feature_names.json`, `model_version.txt`.
- `agent/app/main.py` — FastAPI app. `POST /price` with Pydantic
  request/response schemas; clamp formula applied in the handler;
  response carries both `premium_usdc` (float) and `premium_base_units`
  (int, USDC 6-decimals). `GET /healthz` returns model version + load time.
- `agent/Dockerfile` (multi-stage; `python:3.11-slim` final). Artifacts
  copied in at build time — training is a precondition, not part of the
  image build.
- `agent/tests/test_price.py` — pytest covering known route, unknown
  carrier (no 500), `/healthz`, base-units rounding.
- Top-level `Makefile` — `make train`, `make serve`, `make test`,
  `make download-data`, `make clean`.
- `.gitignore` updates for `agent/data/`, `agent/artifacts/`,
  `agent/__pycache__/`, `agent/.venv/`, `agent/.pytest_cache/`.
- Root `README.md` §"Premium pricing agent (Phase 22)" — deploy choice
  (co-host vs separate dyno), env vars, Phase 23 consumer reference.

**Done when:**
- `make train` produces all four artifacts deterministically; printed
  validation ROC AUC within ±0.005 of the notebook's ~0.75 reference.
- `make serve` boots; `curl POST /price` returns valid JSON with
  `premium_usdc ∈ [1.0, 5.0]` in <100ms warm.
- `make test` passes.
- `docker build -t sentinel-agent agent/` succeeds on a clean machine.
- `pnpm -r typecheck` still clean (Python workspace doesn't break the TS
  check).

**Out of scope:**
- Re-labelling against Sentinel's actual `Delayed`/`Cancelled` payout
  trigger (the Kaggle target is `dep_delayed_15min` — known proxy
  mismatch, documented in the README).
- Probability calibration (Platt/isotonic). Note in README; revisit only
  if predictions look bunched in the demo.
- Auth on the endpoint. POC is unauthenticated; the cron in Phase 23 is
  the only caller. Mainnet hardening = shared-secret header
  (`X-AGENT-TOKEN`), deferred.
- Online retraining / new datasets / payout-side prediction.

**Depends on:** the [Kaggle "Flight Delays Fall 2018"](https://www.kaggle.com/competitions/flight-delays-fall-2018)
dataset + the canonical XGBoost notebook for it (manual download per
Kaggle ToS).

---

## Phase 23 — Route Repricer Cron (TS + Grok)

**Status: planned.** Add a 4th cron — `RouteRepricer` — that iterates every
whitelisted `RouteAccount` on devnet, calls the Phase 22 agent for a
baseline premium, asks Grok (xAI Live Search) whether geopolitical news
justifies a multiplier or full disable, and submits the resulting
`update_route_terms` / `disable_route` / idempotent `whitelist_route`
re-enable tx signed by the deployer. Surfaces on `/crons` as a 4th card
with the same trigger / mutex / activity-feed posture as the existing three
crons. Trigger-on-demand only (matches Phase 17/18); daily auto-cadence is
deferred. No on-chain program changes.

**Deliverables:**
- `executor/src/core/agent_client.ts` — typed HTTP client for the Phase 22
  endpoint, with mock-mode (`AGENT_MOCK=1` + `AGENT_MOCK_PREMIUM_USDC`).
- `executor/src/core/grok_client.ts` — typed xAI client. Live mode uses
  `https://api.x.ai/v1/chat/completions` with `model: "grok-4"`,
  `search_parameters: { mode: "on", sources: [{ type: "news" }] }`, and
  `response_format: json_schema`. Mock-mode `GROK_MOCK=1` +
  `GROK_MOCK_VERDICT=ok|raise:1.5|disable`. Failure-safe default:
  `{ action: "ok", multiplier: 1.0, reason: "grok unavailable; baseline only" }`.
- `executor/src/core/decide_route_actions.ts` — pure decision module
  emitting one of `noop`, `update_premium(new_bps)`, `disable`,
  `reenable_with_terms(new_bps)`. Drift threshold: skip
  `update_premium` if `|new − current| < 100_000` base units (10¢).
  Re-enable gate: only re-enable routes this cron disabled (tracked via a
  `disabledByRepricer` field in the JSONL).
- `executor/src/core/route_repricer.ts` — `runRepricerOnce` orchestrator;
  `getProgramAccounts(governanceProgramId)` filtered by the
  `RouteAccount` discriminator; per-route loop calling agent + grok +
  decision module; returns the per-route decision array.
- `executor/tests/decide_route_actions.test.ts` +
  `executor/tests/grok_client.test.ts` — unit tests covering each action
  variant, drift threshold, re-enable gate, and Grok failure fallback.
- New frontend route `frontend/app/api/cron/repricer/trigger/route.ts` —
  per-cron mutex, pre-flight env + agent reachability validation, captured-
  console sink, JSONL append, `routeActionToIxs` inline translator
  (Phase 17/18 precedent), green/red response shape. Per-request mode
  override `?mode=mock|live` and `?dryRun=1`.
- `frontend/app/api/cron/repricer/config/route.ts` — `GET` returning
  `{ liveAvailable, agentReachable, defaultMode, agentBaseUrl }` (no
  keys leaked).
- `frontend/src/lib/cron-runs.ts` extended — `'repricer'` added to
  `CronId` union; rotation cap (100) applied per-cron across all four
  buckets.
- `frontend/app/api/cron/runs/route.ts` accepts `?cron=repricer`.
- `frontend/app/crons/page.tsx` — 4th cron card matching fetcher's layout
  1:1; new `RepricerControls` component (Live/Mock toggle, dry-run
  checkbox); decision histogram + Grok `reason` surfaced in the activity
  feed.
- New env vars documented: `AGENT_BASE_URL`, `XAI_API_KEY`, `GROK_MOCK`,
  `GROK_MOCK_VERDICT`, `AGENT_MOCK`, `AGENT_MOCK_PREMIUM_USDC`,
  `REPRICER_DRY_RUN`.
- README §Cron control panel rewritten for 4 crons.
- `spec/architecture.md` §Off-Chain Executor Layer updated — 3 crons → 4
  crons; the new dependency on Phase 22 + xAI documented as a centralised
  trust assumption.

**Done when:**
- `pnpm -r typecheck` passes across all 3 TS workspaces.
- All `decide_route_actions.test.ts` + `grok_client.test.ts` unit tests
  pass.
- Trigger from `/crons` repricer card on devnet **in mock mode** (both
  `GROK_MOCK=1` and `AGENT_MOCK=1`) walks at least 3 whitelisted routes,
  emits per-route decision logs, applies the resulting txs, and reports
  green.
- Trigger with `XAI_API_KEY` set and `AGENT_BASE_URL` reachable hits real
  Grok + real agent for at least 1 route, surfaces a non-empty `reason`
  field in the record.
- One route exercised through each of the three actions (`update_premium`,
  `disable`, `reenable_with_terms`) — verifiable in `/admin` after the
  run.
- `REPRICER_DRY_RUN=1` returns the planned actions without sending any
  tx; activity feed shows the 💭 indicator.
- Concurrent button-mash returns 409.
- The repricer run record persists across a page reload (proves JSONL
  rotation includes the new bucket).

**Out of scope:**
- Daily auto-cadence via `node-cron`. Trigger-on-demand from `/crons` is
  sufficient for the demo. Documented as a follow-up.
- Per-region Grok batching (one global query for "geopolitical airspace
  risk this week" applied to many routes). Cleaner but more product-
  design than POC needs.
- Auto-retraining of the Phase 22 model on settled flights from
  `flight_pool_program`. Belongs in a future `agent` v2 phase.
- Hardened auth on the trigger endpoint. Same posture as Phases 17/18 —
  public-unauth, shared-secret follow-up documented.
- Multi-cluster (surfpool) support. Devnet only, per Phase 18 precedent.
- On-chain program changes. Every action routes through existing
  governance ixs (`update_route_terms`, `disable_route`, idempotent
  `whitelist_route`).

**Depends on:** Phase 22 (the agent endpoint contract is the API
boundary), Phase 1 (`governance_program` ixs verified), Phase 7 (devnet
deployer keypair), Phase 17 (cron control panel patterns), Phase 18
(closest sibling — mock-mode + config endpoint + mode-override patterns).

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
