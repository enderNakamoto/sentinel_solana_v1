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
├── contracts/                  # Anchor workspace — all 4 programs
│   ├── programs/
│   │   ├── governance/
│   │   ├── vault/
│   │   ├── flight_pool/
│   │   └── insurance/
│   ├── tests/                  # Anchor TS tests (LiteSVM / Bankrun)
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
`executor/src/idl/`. Both consumers `import` from `./idl/insurance` etc. — no symlinks,
no monorepo magic. The script runs as a `postbuild` hook in `contracts/package.json` and
is also invoked manually before frontend dev.

---

## Phase Index

| # | Name | Outputs |
|---|------|---------|
| 0 | Project Bootstrap | repo layout, IDL bridge, test harness |
| 1 | governance_program | program + unit tests |
| 2 | vault_program | program + unit tests |
| 3 | flight_pool_program | program + unit tests |
| 4 | insurance_program | program + unit tests |
| 5 | Cross-Program Integration Tests | full-lifecycle tests |
| 6 | Devnet Deployment | deployed programs, init scripts |
| 7 | Oracle Cron — FlightDataFetcher | executor scaffold + cron #1 |
| 8 | Classifier Cron — FlightClassifier | cron #2 |
| 9 | Settlement Cron — SettlementExecutor | cron #3 + node-cron backend |
| 10 | Frontend Bootstrap | Next.js app, wallet, IDL imports |
| 11 | Frontend — Traveler Dashboard | buy / claim / my policies |
| 12 | Frontend — Underwriter Dashboard | deposit / redeem / queue / collect |
| 13 | Frontend — Admin Panel | governance + tunables |
| 14 | End-to-End Test | scripted browser test on devnet |

---

## Phase 0 — Project Bootstrap

**Goal:** Establish the workspace with `contracts/`, `frontend/`, `executor/`, the
IDL bridge, and a baseline test harness so subsequent phases can plug into it.

**Deliverables:**
- `contracts/` Anchor workspace initialised (`anchor init`), with four empty
  program crates: `governance`, `vault`, `flight_pool`, `insurance`. Each compiles a no-op program.
- `frontend/` Next.js (App Router) app with TypeScript, Tailwind, and
  `@solana/wallet-adapter-react` (or framework-kit equivalent).
- `executor/` TypeScript project skeleton (no logic yet — just `package.json`,
  `tsconfig.json`, empty `src/`).
- `scripts/sync-idl.sh` — runs `anchor build`, then copies generated IDL JSON +
  TypeScript types into `frontend/src/idl/` and `executor/src/idl/`.
- Root `package.json` with `sync-idl`, `dev:frontend`, `dev:executor`, and
  `test:contracts` scripts.
- `contracts/tests/setup.ts` test harness: helpers for creating a mock USDC
  mint, funding ATAs, advancing the clock — usable from any test file.
- One smoke test per program that asserts `program.programId` matches the
  declared ID and an `initialize` instruction succeeds against a no-op state.
- `.gitignore` covering `target/`, `node_modules/`, `frontend/src/idl/`, `.anchor/`.
- README with one-command bring-up: `pnpm install && pnpm sync-idl && pnpm dev:frontend`.

**Done when:**
- `pnpm test:contracts` passes the four smoke tests.
- `pnpm sync-idl` produces four IDL files in `frontend/src/idl/`.
- `pnpm dev:frontend` starts the dev server and the page renders without errors.

**Depends on:** —

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

## Phase 4 — insurance_program

**Goal:** Ship the orchestrator: controller logic and oracle aggregator. Holds zero user
funds — every money movement is delegated to flight_pool_program (treasury) or
vault_program (capital).

**Deliverables:**
- Account types: `InsuranceConfig` (with `flight_pool_program`, `flight_pool_config`,
  vault refs, governance refs, no treasury), `FlightData`, `ActiveFlightList`.
- Instructions:
  - `initialize(InitializeParams)` — wires governance, vault, flight_pool, usdc_mint.
  - `set_authorized_oracle`, `set_authorized_keeper` (owner-only).
  - `buy_insurance(flight_id, origin, dest, date)` — orchestrator:
    1. CPI governance: `is_route_whitelisted` + `get_route_terms`.
    2. Enforce `min_lead_time`.
    3. If first buy: init FlightData (NotInitiated) + ActiveFlightList entry, then
       CPI `flight_pool.register_pool(...)`.
    4. Solvency check.
    5. CPI `flight_pool.add_buyer(...)` (transitively transfers premium → treasury).
    6. CPI `vault.increase_locked(payoff)`.
    7. Update aggregate counters.
  - Oracle: `set_estimated_arrival`, `set_landed`, `set_cancelled` — forward-only state
    machine.
  - Keeper: `classify_flights()` — reads FlightData + reads `FlightPool.delay_hours`
    via passed-in account; transitions to ToBeSettled*. No money movement.
  - Keeper: `execute_settlements()` — for each ToBeSettled* flight:
    - On-time: CPI `flight_pool.settle_on_time` + CPI `vault.record_premium_income` +
      CPI `vault.decrease_locked`.
    - Delayed/Cancelled: CPI `vault.send_payout` + CPI `vault.decrease_locked` +
      CPI `flight_pool.settle_delayed` (or `settle_cancelled`).
    - Mark FlightData Settled, remove from ActiveFlightList.
    Then CPI `vault.process_withdrawal_queue` + CPI `vault.snapshot`.
- `MAX_FLIGHTS_PER_TX` constant — set to ~3 given CPI overhead per flight.

**Unit tests** (`contracts/tests/insurance.test.ts`):
- `initialize` — creates config; all program references stored correctly.
- `buy_insurance` happy path: governance CPI returns terms; flight_pool.register_pool
  called on first buy; flight_pool.add_buyer called; vault.increase_locked called;
  BuyerRecord (in flight_pool) created; FlightData created in NotInitiated.
- `buy_insurance` reverts: route not whitelisted; route disabled; below min_lead_time;
  insufficient solvency.
- Second `buy_insurance` for same flight skips register, calls add_buyer only.
- Oracle instructions enforce `authorized_oracle`.
- State machine: NotInitiated → Active, Active → Landed/Cancelled. Reverse reverts.
- `classify_flights` — Landed with delay ≥ threshold → ToBeSettledDelayed;
  delay < threshold → ToBeSettledOnTime; Cancelled → ToBeSettledCancelled.
- `classify_flights` is idempotent on already-classified flights.
- `execute_settlements` on-time: vault TMA increases, vault locked decreases, treasury
  decreases by premium × buyer_count.
- `execute_settlements` delayed/cancelled: vault locked decreases, treasury increases by
  payoff − premium × buyer_count, flight_pool status set, claim_expiry set.
- `execute_settlements` end-of-batch: vault.process_withdrawal_queue and vault.snapshot
  invoked.

**Done when:**
- All instructions implemented; all unit tests pass.
- IDL synced.

**Depends on:** Phase 1, Phase 2, Phase 3.

---

## Phase 5 — Cross-Program Integration Tests

**Goal:** Exercise the full lifecycle across all four programs in a single test harness.

**Deliverables:**
- `contracts/tests/e2e.test.ts` covering:
  - Whitelist route (governance) → underwriter deposits (vault) → traveler buys
    insurance (insurance, with CPIs to governance + flight_pool + vault) → oracle pushes
    data → classifier transitions state → settler executes money flow → traveler claims
    (via flight_pool) or sweeps.
  - All three settlement outcomes (on-time, delayed, cancelled) in one test run with
    distinct flights, with money flow assertions per outcome.
  - Withdrawal queue draining: underwriter requests withdrawal while capital is locked,
    settles flights, verifies `process_withdrawal_queue` credits `ClaimableBalance`,
    underwriter `collect`s.
  - Solvency edge: try to buy when `free_capital < payoff * solvency_ratio` → reverts.
  - Concurrent flights: settle multiple flights in one `execute_settlements` call (under
    MAX_FLIGHTS_PER_TX, which is now ~3 due to per-flight CPI overhead).
  - Snapshot: verify daily share-price snapshot record exists after settlement.
  - Authorization: vault.send_payout reverts unless caller is the controller PDA;
    flight_pool.settle_* reverts unless caller is the controller PDA.
- Helper utilities in `contracts/tests/setup.ts` extended with full-protocol bring-up
  (governance + vault + flight_pool + insurance, with both `set_controller` calls wired
  to the insurance config PDA).

**Done when:**
- All integration tests pass.
- Coverage report (if `cargo-llvm-cov` is wired) shows all happy-path code reachable.

**Depends on:** Phases 1, 2, 3, 4.

---

## Phase 6 — Devnet Deployment

**Goal:** Deploy all four programs to Solana devnet, wire references, smoke-test on-chain.

**Deliverables:**
- `contracts/scripts/deploy.ts` — Anchor migration:
  1. Deploy mock USDC mint (devnet only).
  2. Deploy governance, vault, flight_pool, insurance programs.
  3. Initialise each: governance defaults; vault `initialize(usdc_mint)`;
     flight_pool `initialize(usdc_mint)`; insurance `initialize(...)` with all program
     references (governance, vault, flight_pool).
  4. `vault.set_controller(insurance_config_pda)`.
  5. `flight_pool.set_controller(insurance_config_pda)`.
  6. Set `authorized_oracle` and `authorized_keeper` to placeholder keys (rotated
     in Phase 7/8/9).
- Anchor.toml networks block configured for devnet with deployed program IDs.
- Program IDs replaced in source `declare_id!` macros and re-built; types re-synced.
- `contracts/scripts/devnet-smoke.ts` — runs end-to-end against deployed programs:
  whitelist a route, deposit, buy_insurance, oracle write, classify, settle, claim.
- `.env.example` documenting the keypair paths and RPC URL.

**Done when:**
- `solana program show <ID>` returns metadata for all four programs.
- `devnet-smoke.ts` completes without error against the deployed programs.
- IDL files in `frontend/src/idl/` reflect the deployed program IDs.

**Depends on:** Phase 5.

---

## Phase 7 — Oracle Cron (FlightDataFetcher)

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
  `insurance.set_authorized_oracle(...)`.

**Done when:**
- Unit tests pass.
- One-shot run on devnet writes data to a real FlightData account.

**Depends on:** Phase 6.

---

## Phase 8 — Classifier Cron (FlightClassifier)

**Goal:** Build cron #2 — calls `insurance.classify_flights()` periodically.

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

**Depends on:** Phase 7.

---

## Phase 9 — Settlement Cron (SettlementExecutor) + Cron Backend

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

**Depends on:** Phase 8.

---

## Phase 10 — Frontend Bootstrap

**Goal:** Connect a wallet, read on-chain state, render the app shell.

**Deliverables:**
- Next.js app with App Router, Tailwind, and `@solana/wallet-adapter-react`
  (or framework-kit's wallet-standard equivalent).
- Connection provider configured for devnet with the deployed program IDs.
- `src/idl/` populated by `pnpm sync-idl` (4 IDLs).
- `src/hooks/useGovernance.ts`, `useVault.ts`, `useFlightPool.ts`, `useInsurance.ts` —
  Anchor program instances scoped to the connected wallet.
- App shell with navigation: Traveler / Underwriter / Admin.
- Landing page showing protocol vitals: TMA, locked capital, free capital, share price,
  total policies sold, total payouts distributed (read from `VaultState` and
  `InsuranceConfig`).
- Toast / status notification component for tx status (Phantom-style).

**Tests:**
- Component tests for `WalletButton`, `ProtocolStats`.
- Manual smoke test: connect Phantom on devnet, see real values from deployed contracts.

**Done when:**
- `pnpm dev:frontend` renders the landing page with live devnet data.
- Wallet connect/disconnect works; readonly state shown without a connected wallet.

**Depends on:** Phase 6.

---

## Phase 11 — Frontend: Traveler Dashboard

**Goal:** Travelers can buy insurance, see their policies, and claim payouts.

**Deliverables:**
- Buy insurance form: flight_id, origin, destination, date inputs.
  - Pre-flight: read governance for resolved terms (preview premium / payoff /
    delay_hours), check route is whitelisted, check vault solvency, check lead time.
  - On submit: build + send `insurance.buy_insurance` tx (resolves all CPI accounts
    from PDAs), show toast.
- "My policies" view: `getProgramAccounts` + memcmp on BuyerRecord.buyer (against
  `flight_pool` program) for the connected wallet. Shows flight_id, date, policy status
  (Active / Settled / Claimed).
- Per-policy detail card: live FlightData status (from insurance program), settlement
  status (from flight_pool's FlightPool), claim button if eligible (status
  SettledDelayed/Cancelled, not yet claimed, before claim_expiry).
- Claim transaction handler — calls `flight_pool.claim` directly (not via insurance).

**Tests:**
- Component tests for the buy form (validation, button disabled states).
- Component tests for the my-policies list (renders empty state, populated state).
- Manual: full buy → claim flow on devnet against an oracle-driven settlement.

**Done when:**
- A new wallet can buy a policy on devnet via the UI.
- After settlement, the same wallet sees the policy and can click Claim to receive USDC.

**Depends on:** Phase 10, Phase 9 (so settlements actually happen on devnet).

---

## Phase 12 — Frontend: Underwriter Dashboard

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

**Depends on:** Phase 10.

---

## Phase 13 — Frontend: Admin Panel

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
- Insurance config tunables (owner-only): set_authorized_oracle, set_authorized_keeper.
- Flight pool config tunables (owner-only): withdraw_recovered (call against
  flight_pool_program).

**Tests:**
- Component tests for route form and tri-state field control.
- Manual: walk through every admin action on devnet.

**Done when:**
- Owner wallet can perform every admin action via the UI.
- Non-owner wallet sees the read-only view.

**Depends on:** Phase 10.

---

## Phase 14 — End-to-End Test

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
  4. Test script directly calls `set_estimated_arrival` then `set_landed` with a
     delay > threshold (bypassing AeroAPI for determinism).
  5. Test script directly calls `classify_flights` then `execute_settlements`.
  6. Traveler refreshes "My Policies", clicks Claim, receives USDC.
  7. Underwriter refreshes Vault Metrics, sees correct locked/TMA values.
- CI workflow: runs nightly against devnet; uploads screenshots/video on failure.

**Done when:**
- The full Playwright scenario passes locally.
- CI workflow runs green on a scheduled trigger.

**Depends on:** Phases 11, 12, 13.

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
