# Phase 16 — End-to-End Test (Browser)

Status: in_progress
Started: 2026-05-08
Completed: —

---

## Goal

Stand up a real browser-driven test suite that exercises the full Sentinel
stack — frontend + on-chain programs + off-chain cron — end-to-end on a
local Surfpool ledger, while keeping the same frontend bundle deployable
against live devnet for demo purposes. The deliverable proves that the
five Anchor programs, the three crons, and the four user-facing dashboards
work together without manual intervention, across the three flight outcomes
the protocol cares about (on-time, delayed, cancelled). A cluster-switch
flag (`NEXT_PUBLIC_CLUSTER=devnet|surfpool`) lets a single frontend
codebase swap RPC + authority configuration so demos run on devnet and
tests run on Surfpool with no code edits.

## Dependencies

- **Phases 1–6** (all five Anchor programs + LiteSVM integration tests) — the
  on-chain protocol the e2e suite exercises.
- **Phase 7** (devnet deployment) — gives the deployable contracts the
  cluster-switch flag wires the frontend to.
- **Phase 11** (executor crons + surfpool harness) — provides
  `runFetcherOnce`/`runClassifierOnce`/`runSettlerOnce` plus the
  parameterized AeroAPI mock used by the cron-driven scenarios.
- **Phase 12** (frontend bootstrap) — Wallet Standard via framework-kit,
  the entry point Synpress drives.
- **Phases 13–15** (admin / underwriter / traveler dashboards) — every UI
  surface the suite asserts against.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git`
- `solana-dev`
- `aero-api` (cron tests reuse the parameterized AeroAPI client; mock
  responses match the live client's contract)

### Skill References
- `references/compatibility-matrix.md`
- `references/common-errors.md`
- `references/security.md`
- `references/testing.md`
- `references/surfpool/overview.md`
- `references/surfpool/cheatcodes.md`
- `references/frontend-framework-kit.md`
- `references/kit/overview.md`
- `references/kit/plugins.md`
- `references/kit/advanced.md`
- `references/idl-codegen.md`
- `references/programs/anchor.md`

### Docs to Fetch
- https://playwright.dev/docs/intro — Playwright fundamentals (test runner,
  fixtures, projects, headless flags, video/screenshot on failure).
- https://docs.synpress.io/docs/setup-playwright — Synpress 4.x Playwright
  integration overview, including the Phantom (Solana) configuration.
- https://docs.synpress.io/docs/guides/playwright — Synpress fixture
  patterns, custom-fixture extension, and wallet-cache lifecycle.
- https://docs.synpress.io/docs/guides/cache — wallet-cache build flow,
  including `--phantom` and per-cache-dir invocations.
- https://docs.surfpool.run/ — Surfpool CLI, cheatcodes (time-travel,
  airdrop, account injection), `Surfpool.toml` schema.
- https://github.com/anza-xyz/wallet-standard — Wallet Standard surface
  Synpress drives via the real Phantom extension.
- https://nextjs.org/docs/app/api-reference/file-conventions/route —
  Next.js Route Handler reference (the `/api/faucet/mint` and
  `/api/log/event` routes the e2e tests exercise).

### Project Files to Read
- `spec/architecture.md` — full file (program graph + executor graph the
  e2e suite asserts against).
- `spec/dev_steps.md` — Phase 16 deliverables + gate.
- `spec/workflow.md` — phase lifecycle.
- `MEMORY.md` — locked decisions (program IDs, devnet deployment
  addresses, kit/framework-kit version pins, signer-identity rule).
- `frontend/app/` — every route the suite drives (`/admin`, `/buy`,
  `/earn`, `/portfolio`, `/faucet`, `/contracts`).
- `frontend/src/config/devnet.ts` — refactor target for the cluster
  switch.
- `frontend/src/lib/sendTx.ts`, `frontend/src/lib/txEvents.ts`,
  `frontend/src/lib/useWalletSigner.ts` — wallet/signer + tx-success-burst
  paths the e2e tests rely on (auto-refresh assertions).
- `frontend/src/clients/` — Codama-generated builders the test setup
  scripts reuse.
- `frontend/app/api/faucet/mint/route.ts` — public faucet the test
  traveler uses to fund itself with mock USDC.
- `executor/src/core/` — cron core (run-once helpers).
- `executor/src/scripts/` — existing run-fetcher / run-classifier /
  run-settler scripts.
- `executor/src/backends/cron/` — daemon mode (skipped by Phase 16; tests
  use direct calls).
- `executor/tests/` — parameterized AeroAPI mock, scenario harness
  patterns from Phase 11.
- `contracts/tests/integration/full-flow-deployed.test.ts` — Phase 6's
  in-process full-flow narrative; the browser e2e mirrors its three-flight
  shape.
- `scripts/deploy.ts` — re-init script the bootstrap flow re-runs against
  Surfpool.
- `scripts/seed-routes.ts` — route whitelist script the bootstrap flow
  re-runs against Surfpool.
- `scripts/bootstrap-test-actors.ts` (or its closest sibling — confirm at
  start) — generates oracle/keeper/underwriter/traveler keypairs + funds
  them.
- `Surfpool.toml` — local validator config (mock-USDC mint state seed,
  airdrop list).
- `Anchor.toml` — `[programs.localnet]` and `[programs.devnet]` mapping
  (must stay identical for the cluster switch invariant).
- `keys/` — keypair-on-disk inventory (deployer, mock-usdc-authority,
  surfpool-oracle, surfpool-keeper, mock-usdc).

## Pre-work Notes

> Locked decisions from the planning conversation. Treat as hard
> requirements during implementation.

- **Cluster switch is a single env var.** `NEXT_PUBLIC_CLUSTER=devnet|surfpool`,
  defaults to `devnet`. Branch only the four cluster-specific values:
  RPC URL, oracle authority, keeper authority, explorer URL. Everything else
  (program IDs, PDAs, mock USDC mint, mock-usdc-authority) is identical
  across clusters because we never rotate those keypairs (locked in
  `MEMORY.md` keypair-safety rule + Phase 1 D-Phase1 program-ID rotation
  note). The faucet API route (`/api/faucet/mint`) already reads
  `FAUCET_RPC_URL` and `FAUCET_*_BASE58 / *_PATH` env vars — no code change
  needed there, just the env-var docs.

- **Surfpool starts blank, bootstrap each session.** No fork-of-devnet.
  The bootstrap flow re-runs the existing scripts:
  `pnpm dev:surfpool` → wait until reachable → `scripts/deploy.ts` →
  `scripts/seed-routes.ts` → `scripts/bootstrap-test-actors.ts` (oracle/keeper
  authority init + airdrops). Fresh slate per test session is more
  deterministic than a forked snapshot that mutates over time.

- **Cron is invoked via direct calls, not daemons.** Tests import
  `runFetcherOnce / runClassifierOnce / runSettlerOnce` from `executor/`
  and trigger them inline at exact moments in the scenario (same pattern
  Phase 11 uses). The real `cron-daemon` is out of scope for Phase 16.

- **One browser wallet — the traveler.** Synpress 4.x `phantomFixtures`
  drives a single Phantom extension instance built from a test seed
  phrase. The underwriter side is bootstrapped **out of browser** via a
  keypair-signed deposit script (~20,000 USDC into the vault) before the
  Playwright test runs. Driving two real Phantom wallets in one browser
  context was considered but rejected (~2× test complexity, fragile
  multi-context handoffs).

- **Wallet automation = Synpress + real Phantom.** No mocked wallet. The
  Synpress wallet cache is built once via `npx synpress --phantom` and
  re-used across runs. Catches Wallet Standard handshake regressions a
  mock can't. Headless on CI; headed locally (Synpress default).

- **Faucet path in tests is the public API route.** The traveler
  Phantom wallet POSTs to `/api/faucet/mint` (no admin gate, no wallet
  signature required) to receive 10,000 mock USDC. Server-side the
  deployer pays fees and `mock-usdc-authority` signs the mint, both
  loaded from `keys/`.

- **Three flight scenarios drive the e2e narrative.** Per the user's
  ask, the suite asserts the on-time / delayed / cancelled outcomes
  specifically — not just delayed (which is what the original `dev_steps.md`
  spec called for). Each scenario shares setup but diverges at the cron
  stage (oracle reports different status → classifier flips state →
  settler executes appropriate CPI chain → frontend reflects).

- **/admin coverage is one happy-path test only.** Connect as deployer,
  whitelist a new route, verify on-chain via the `/contracts` read panel.
  Other admin write paths (set defaults, add admin, withdraw recovered)
  stay covered by Phase 6 LiteSVM tests.

- **CI is a smoke gate.** GitHub Actions workflow boots Surfpool +
  bootstrap + `next dev` + the cron run-once helpers + Playwright
  headless. Uploads screenshots / video on failure. Does not need to run
  on every PR — scheduled (nightly) is fine for a hackathon submission.
  Local-run is the primary path.

- **No state cleanup between Playwright `test()` blocks.** Surfpool is
  blank at suite start; tests run sequentially against a single ledger,
  asserting state transitions. Synpress wallet cache is shared across
  tests (Phantom shows one connected wallet for the whole run). Tests
  assert deltas, not absolutes (e.g. "balance increased by ≥ 9_900 USDC"
  not "balance == 10_000 USDC").

- **Test scope limit:** if a subtask balloons, prefer to ship the
  cluster-switch + page smokes + the three flight scenarios over
  exhaustive coverage. Phase 16 is the gate, not the ceiling.

---

## Subtasks

### A. Cluster switch flag

- [x] A1. Refactor `frontend/src/config/devnet.ts` to be cluster-aware.
      **Done:** discovered an existing `frontend/src/lib/cluster.ts` that
      already detects cluster from `NEXT_PUBLIC_SOLANA_RPC_URL`
      (`localnet` if the URL has 127.0.0.1, `devnet` otherwise). Reused
      that detection in `devnet.ts` instead of adding a parallel
      `NEXT_PUBLIC_CLUSTER` env var — fewer moving parts. Branched only
      `ORACLE_AUTHORITY`, `KEEPER_AUTHORITY`, and `explorerLink` per
      cluster (surfpool oracle/keeper from `keys/surfpool-*.pubkey`,
      explorer suppressed for localnet). Filename kept stable; existing
      imports unchanged.
- [x] A2. Added `CLUSTER` and `RPC_URL` exports for surfaces that need
      to display the active cluster (BottomNav now shows `{CLUSTER}`,
      `/crons` page footer reads `ORACLE_AUTHORITY` / `KEEPER_AUTHORITY`
      / `CLUSTER` instead of hardcoded devnet strings).
- [x] A3. Added `pnpm dev:frontend:surfpool` to root `package.json`. Sets
      `NEXT_PUBLIC_SOLANA_RPC_URL=http://127.0.0.1:8899` (which the
      existing cluster detection translates to `localnet`) + the matching
      `FAUCET_RPC_URL`. Deployer / mint-authority keypair paths fall
      through to the API route's defaults (`keys/devnet-deployer.json`
      and `keys/mock-usdc-authority.json` are shared across clusters).
- [x] A4. README §"Frontend cluster switch (devnet ↔ Surfpool)" added,
      including the differs-vs-stays table and the three-tab Surfpool
      runbook (dev:surfpool / bootstrap / dev:frontend:surfpool).
- [ ] A5. Smoke-check: with `pnpm dev:frontend:surfpool` running against a
      live `pnpm dev:surfpool`, every read panel on `/contracts` returns
      data for the bootstrapped state. **Deferred** — needs §C bootstrap
      script to land first, since blank Surfpool has no PDAs to read.

### B. Test infrastructure (Synpress + Playwright)

- [ ] B1. Add dev deps in the `frontend/` workspace: `@playwright/test`,
      `@synthetixio/synpress`. Run `npx playwright install chromium` in
      the workspace.
- [ ] B2. Create `frontend/tests/wallet-setup/basic.setup.ts` with the
      test seed phrase + password (gitignored, shared via
      `tests/.env.example` template).
- [ ] B3. Build the Phantom wallet cache via `npx synpress --phantom`.
      Document the cache location and how to rebuild it.
- [ ] B4. Create `frontend/playwright.config.ts`: chromium-only project,
      `webServer` boot of `pnpm dev:frontend:surfpool`, retain trace +
      screenshot + video on failure.
- [ ] B5. Add `pnpm test:e2e` (and `:headed`) scripts in
      `frontend/package.json`.
- [ ] B6. Create test fixture helpers in `frontend/tests/helpers/`:
      - `connectWallet.ts` — drives the Phantom connector picker.
      - `waitForBurst.ts` — waits for the `useTxSuccess` 3-shot burst
        propagation window (max ~5s) and re-asserts.
      - `mintFromFaucet.ts` — POSTs to `/api/faucet/mint` for the
        traveler's wallet address.

### C. Bootstrap (out-of-browser side)

- [ ] C1. Create `scripts/e2e/bootstrap-surfpool.ts` (or extend the
      existing bootstrap path) that, in order:
      1. `surfpool start` health-check (assumes the user already ran
         `pnpm dev:surfpool` in another tab).
      2. Re-runs `scripts/deploy.ts --cluster surfpool`.
      3. Calls each program's init ix (governance, vault, oracle, flight
         pool, controller).
      4. Funds oracle + keeper + underwriter + traveler keypairs with SOL
         via Surfpool airdrop cheatcode.
      5. Bootstraps the underwriter side: keypair-signed `vault.deposit`
         of 20,000 USDC into the vault.
      6. Whitelists the routes the e2e scenarios need (3 flights — one
         per scenario).
- [ ] C2. Create `scripts/e2e/cron-tick.ts` — exposes
      `runFetcher / runClassifier / runSettler` against a passed-in
      AeroAPI-mock fixture so test files import + invoke directly.
- [ ] C3. Add `pnpm test:e2e:bootstrap` script that runs the bootstrap
      sequence (idempotent — safe to re-run).

### D. Page smoke tests (one per dashboard)

- [ ] D1. `frontend/tests/e2e/00-faucet.spec.ts` — connect wallet, mint
      10k mock USDC via faucet, assert navbar pill bumps via the
      `useTxSuccess` burst (no manual reload).
- [ ] D2. `frontend/tests/e2e/01-earn-deposit.spec.ts` — `/earn`
      Deposit 1,000 USDC, Phantom-approve, assert vault TVL increases +
      RVS shares show in user position card.
- [ ] D3. `frontend/tests/e2e/02-earn-redeem.spec.ts` — redeem partial
      shares, assert USDC returned + RVS decreases.
- [ ] D4. `frontend/tests/e2e/03-earn-queue-cancel.spec.ts` — request
      withdrawal that exceeds free capital, cancel it, assert position
      restored.
- [ ] D5. `frontend/tests/e2e/04-buy-coverage.spec.ts` — `/buy` connect,
      pick a route, cover, Phantom-approve, assert tx succeeds + the
      policy shows up in `/portfolio` Active.
- [ ] D6. `frontend/tests/e2e/05-portfolio-active.spec.ts` — assert the
      policy card shows the right premium / payout / threshold values
      vs the on-chain `BuyerRecord`.
- [ ] D7. `frontend/tests/e2e/06-admin-whitelist.spec.ts` — connect as
      deployer (Phantom imports the deployer key into a second account in
      the cache), call `/admin` Add Route form, verify the new route
      appears in `/buy`'s catalog.

### E. Three-scenario E2E (cron + frontend + contract)

- [ ] E1. `frontend/tests/e2e/10-flight-on-time.spec.ts` — full flow:
      buy coverage → tick fetcher (oracle reports landed-on-time) → tick
      classifier (`SettledOnTime`) → tick settler → assert in
      `/portfolio` History the policy is "Expired", no payout, traveler
      USDC balance unchanged from pre-buy minus the premium.
- [ ] E2. `frontend/tests/e2e/11-flight-delayed.spec.ts` — full flow:
      buy → tick fetcher (delay > threshold) → classifier
      (`ToBeSettledDelayed`) → settler runs the per-flight CPI chain →
      `/portfolio` shows policy claimable → click Claim → Phantom-approve
      → traveler USDC balance increases by the payout.
- [ ] E3. `frontend/tests/e2e/12-flight-cancelled.spec.ts` — full flow:
      buy → tick fetcher (status=Cancelled before ETA) → classifier
      (`ToBeSettledCancelled`) → settler → claim → balance increases by
      payout.
- [ ] E4. Each scenario uses a dedicated whitelisted route (so they run
      sequentially without cross-contamination on the same Surfpool
      ledger).

### F. CI

- [ ] F1. Add `.github/workflows/e2e.yml`: macOS or ubuntu runner,
      installs node + pnpm + Solana CLI + Surfpool, boots
      `pnpm dev:surfpool` + bootstrap + `pnpm test:e2e` headless.
- [ ] F2. Trigger: workflow_dispatch + scheduled (nightly). Not on every
      PR (too slow).
- [ ] F3. Upload Playwright HTML report + traces + videos as workflow
      artifacts on failure.

### Gate

- All Playwright tests in §D and §E pass locally on a fresh Surfpool
  ledger (`pnpm dev:surfpool` → `pnpm test:e2e:bootstrap` → `pnpm test:e2e`).
- Cluster switch verified: `NEXT_PUBLIC_CLUSTER=devnet pnpm dev:frontend`
  reads from devnet's deployed PDAs unchanged from Phase 15;
  `NEXT_PUBLIC_CLUSTER=surfpool pnpm dev:frontend:surfpool` reads from
  the local Surfpool ledger.
- CI workflow runs green on a manual `workflow_dispatch` trigger.
- The three flight outcomes (on-time / delayed / cancelled) are
  observable end-to-end through the UI without page reloads — every
  state transition is picked up via the `useTxSuccess` burst.

---

## Work Log

### Session 2026-05-08
Starting phase. Lite prime complete. Manifest loaded: solana-dev skill +
references (compatibility-matrix, common-errors, security, testing,
surfpool/overview, surfpool/cheatcodes, frontend-framework-kit, kit/*),
git, aero-api. Project context already in working memory from the
preceding planning conversation (Phase 15 just shipped, frontend bundle
on devnet, 50 routes seeded, faucet API live, tx-success burst wired).
Beginning with bucket A — cluster switch — since it's the smallest
foundational change and unblocks everything else.

**Bucket A — cluster switch — DONE (modulo A5 smoke deferred to §C).**
Discovered `frontend/src/lib/cluster.ts` already auto-detects cluster
from the `NEXT_PUBLIC_SOLANA_RPC_URL` env var. Reused that detection in
`config/devnet.ts` rather than adding a second `NEXT_PUBLIC_CLUSTER` env
flag — single source of truth. Cluster-aware branches added for
oracle/keeper authorities and `explorerLink`; everything else
(program IDs, PDAs, mock USDC mint, mock-usdc-authority) stays
identical across clusters per the keypair-stability rule.
`pnpm dev:frontend:surfpool` script added; BottomNav + `/crons`
footer now display the active cluster name. README §"Frontend cluster
switch (devnet ↔ Surfpool)" documents the env vars + runbook.
`pnpm typecheck` clean. A5 (read-panel smoke against bootstrapped
Surfpool) deferred — blank Surfpool has no state until §C lands.

---

## Files Created / Modified

> Populated by the agent during work.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this
> phase. Populated during work.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.
