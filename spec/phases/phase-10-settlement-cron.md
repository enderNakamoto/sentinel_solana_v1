# Phase 10 — Settlement Cron (SettlementExecutor) + Cron Backend

Status: complete
Started: 2026-05-05
Completed: 2026-05-05

---

## Goal

Build cron #3 — `SettlementExecutor` — which calls `controller.execute_settlements()` to move money on `ToBeSettled*` flights, drain the vault's withdrawal queue, and snapshot the daily share price. **And** wire all three crons (Phase 8 + 9 + 10) into a single deployable `node-cron` daemon with a `/health` HTTP endpoint and a Dockerfile.

This is the cron that actually moves USDC. After it runs:
- on-time flights: pool treasury → vault token account (premium income realized)
- delayed/cancelled flights: vault → pool treasury (payouts staged for traveler `claim()`)
- vault.locked_capital decreases by `payoff × buyer_count` per flight
- queued underwriter withdrawals get credited to their `ClaimableBalance` PDAs

## Dependencies

- Phase 8 (executor scaffold + fetcher cron)
- Phase 9 (classifier cron)
- Phase 7 (deployment artifact + keeper keypair)

## Design constraints

1. **No contract changes.** `controller.execute_settlements` already does the per-flight CPI chain + tail housekeeping (queue drain + snapshot).
2. **Respect MAX_FLIGHTS_PER_TX = 2.** Multi-tx fanout same as Phase 9.
3. **ClaimableBalance discovery via the WithdrawalQueue.** The cron decodes vault's `WithdrawalQueue` PDA, extracts each `WithdrawalRequest.claimable` pubkey in queue order, and appends them as the trailing remaining_accounts after the per-flight `(FlightData, FlightPool)` pairs. The on-chain handler uses the explicit `n_flights` arg as the boundary marker (Phase 6 D-Phase6-3).
4. **Signed by `authorized_keeper`** (same key as Phase 9).
5. **Tail housekeeping fires once per call.** `vault.process_withdrawal_queue` and `vault.snapshot` run unconditionally inside `execute_settlements`, so even an empty per-flight batch has bookkeeping value if there are queued withdrawals or it's a new day. (For the cron we still skip empty calls — no settle-able flights AND no queued withdrawals AND already-snapshotted = nothing to do.)

## Subtasks

### A. Settlement cron logic + tests
- [x] 1. `solana_client.ts` extended with `readWithdrawalQueueClaimables()` — hand-rolled Anchor account decoder that walks `WithdrawalQueue.requests[].claimable` in queue order and returns the pubkeys as Kit `Address[]`. Includes a small base58 encoder so we can avoid Codama imports here.
- [x] 2. `executor/src/core/settlement_executor.ts` exports pure `decideSettlementBatches(flights, maxPerTx)` — filters to all 3 `ToBeSettled` variants only, chunks into MAX_FLIGHTS_PER_TX-sized batches.
- [x] 3. `runSettlerOnce({solana, applyBatch, log?, runEmptyForHousekeeping?})` — main loop. Parallel status reads, single WithdrawalQueue read, per-batch try/catch. Optional `runEmptyForHousekeeping` flag fires a single `n_flights=0` tick when there are queued withdrawals but nothing to settle (defaults off — every-5-min cadence catches up quickly).
- [x] 4. `executor/tests/decide_settlement_batches.test.ts` — **12 unit tests** covering empty input, all-skip cases, **Landed/Cancelled excluded** (those are pre-classify), all 3 ToBeSettled variants accepted, mixed-status filter preserves order, chunking at boundary, custom maxPerTx.

### B. Settler runner
- [x] 5. `executor/src/scripts/run-settler.ts` — env-driven (CLUSTER + KEEPER_KEYPAIR). Builds the `execute_settlements` ix with the heavy 17-field accounts struct (controller config + active list + 3 sibling programs + 3 sibling configs + vault state + vault token + queue + share mint + snapshot + pool treasury + treasury auth + keeper + token program). Day index derived from `getBlockTime(getSlot)`; falls back to wall clock if surfpool returns null. `remaining_accounts` = `[(FlightData WRITABLE, FlightPool WRITABLE) × n_flights, ClaimableBalance WRITABLE × m]`.

### C. node-cron backend (the daemon)
- [x] 6. `executor/src/backends/cron/index.ts` — node-cron entry. **Two SolanaClients** (oracle + keeper signers; same RPC backend), one shared AeroApiClient, one health server. Schedules use defaults from `architecture.md` but env-overridable. Optional `RUN_AT_BOOT=1` fires all 3 schedules once on startup for testing.
- [x] 7. `executor/src/backends/cron/health.ts` — minimal `node:http` server on `HEALTH_PORT` (default 8080). `/health` returns 200 with `{ok: bool, schedules: {<name>: {lastRunUnix, lastResult}}}`. `ok = false` if any schedule's last run failed; null lastRunUnix means cold-start (orchestrator should give 2h grace).
- [x] 8. Each tick wraps `runFetcherOnce` / `runClassifierOnce` / `runSettlerOnce` in try/catch + records the outcome via `recordTick(state, name, result)` regardless of pass/fail.

### D. Containerization
- [x] 9. `executor/Dockerfile` — multi-stage. Stage 1: Node 22 alpine + pnpm install + Codama gen-clients + esbuild bundle of `run-cron.ts`. Stage 2: minimal `node:22-alpine` with the bundle + `node_modules`. `EXPOSE 8080`, `HEALTHCHECK` curls `/health`, `CMD ["node", "cron.mjs"]`.

### E. Docs
- [x] 10. README "Running the crons (Phase 8–10)" section: per-cron one-shot table, daemon mode (`pnpm cron-daemon` or Docker), schedule override env vars, health-check usage.

### Gate

- All settlement-batching unit tests pass.
- Total executor test suite: 50+ tests across all 3 cron phases.
- `pnpm typecheck` clean.
- Bundle invocations of all 3 runners + the daemon entry point error cleanly with `missing env var` messages (proving the bundles load).
- Dockerfile builds (operator-driven; not in CI).

---

## Work Log

### Session 2026-05-05

Final autonomous-run phase. Settlement is the heaviest cron — moves money — but the per-flight CPI chain is on-chain. Cron just orchestrates.

**Outcomes:**
- 1 new core module (`settlement_executor.ts`) + 1 runner (`run-settler.ts`) + 1 node-cron backend (`backends/cron/index.ts` + `health.ts`) + 1 thin shim (`run-cron.ts`) + 1 Dockerfile + 1 test file (12 tests).
- 58/58 unit tests passing across the executor (15 aeroapi + 19 fetcher + 12 classifier + 12 settler).
- Typecheck clean across the full executor workspace.
- All 4 bundles validate cleanly: run-fetcher / run-classifier / run-settler / run-cron — each errors with `missing env var` proving the bundle loads + the `isMain` regex matches.
- README updated with per-cron one-shot table + daemon mode + Docker run example + schedule override env vars.

**One bug caught + fixed:** the cron daemon's `isMain` regex initially only matched `index|cron` — it didn't match `run-cron` (the thin shim that lets `scripts/run.sh` find it). Updated the regex to also match `run-cron.{ts,mjs,js}`.

## Decisions Made

- **D-Phase10-1: ClaimableBalance discovery via WithdrawalQueue decode.** The cron decodes vault's WithdrawalQueue PDA bytes directly (hand-rolled, Codama-free) and walks `requests[].claimable` to extract the pubkeys in queue order. Pass them as the trailing remaining_accounts of `execute_settlements`; on-chain `n_flights` arg marks the boundary per Phase 6 D-Phase6-3.
- **D-Phase10-2: Two SolanaClients in the daemon.** The fetcher signs as `authorized_oracle`; the classifier + settler sign as `authorized_keeper`. The daemon constructs both via `createSolanaClient({keypairPath: ORACLE_KEYPAIR})` and `createSolanaClient({keypairPath: KEEPER_KEYPAIR})`. They share the RPC URL but hold distinct signers — authority isolation per Phase 4 D2.
- **D-Phase10-3: Per-tick try/catch + always-record outcome.** Every cron tick records `lastRunUnix` + `lastResult: 'ok' | 'failed'` regardless of throw. The `/health` endpoint reports `ok: false` only if any schedule's *last* run failed. A cold-start state (`lastRunUnix: null`) is treated as not-yet-failing — orchestrators should give the slowest schedule (fetcher, 2h) a `start_period` grace.
- **D-Phase10-4: Optional `runEmptyForHousekeeping`.** The settler can fire a `n_flights=0` ix when there are no settle-able flights but the withdrawal queue is non-empty — runs the tail housekeeping (queue drain + snapshot) without per-flight work. Defaults OFF because the every-5-min cadence catches up within 1-2 ticks of any settlement event anyway. Operators can flip it on for staging environments where flights are sparse.
- **D-Phase10-5: Day-index from `getBlockTime(getSlot)`.** The settler computes today's day index for `SnapshotRecord` PDA derivation by querying the chain's clock, falling back to `Date.now()` if surfpool returns null. Reasoning: surfpool's clock can drift from wall clock when `block_production_mode = "clock"` advances slots independently. Trust the chain's view.
- **D-Phase10-6: `RUN_AT_BOOT=1` env flag.** When set, the daemon fires each schedule once on startup before yielding to the cron tick. Useful for fresh deployments (no need to wait 2h for the first fetcher run) and for staging tests. Off by default in production.
- **D-Phase10-7: Multi-stage Dockerfile, full node_modules in runtime.** Stage 1 installs + bundles + cleans up. Stage 2 is `node:22-alpine` with the bundle + the full `node_modules` tree. We could trim further (esbuild can `--bundle` everything), but `--packages=external` is needed to avoid bundling native modules (`@solana/spl-token`'s native deps). ~80MB final image is acceptable for a cron daemon. Future optimization: bundle without `--packages=external` and audit for native modules.
- **D-Phase10-8: `run-cron.ts` thin shim re-export.** Lets the shared `scripts/run.sh` resolve the daemon by name (matches the `executor/src/scripts/<name>.ts` path) without complicating the resolver. Single-line file: `import './../backends/cron/index.ts';`.

## Files Created / Modified

### New
- `executor/src/core/settlement_executor.ts` (~155 LOC)
- `executor/src/scripts/run-settler.ts` (~210 LOC)
- `executor/src/scripts/run-cron.ts` (10 LOC shim)
- `executor/src/backends/cron/index.ts` (~210 LOC)
- `executor/src/backends/cron/health.ts` (~80 LOC)
- `executor/Dockerfile` (~70 LOC)
- `executor/tests/decide_settlement_batches.test.ts` (~115 LOC)
- `spec/phases/phase-10-settlement-cron.md`

### Modified
- `executor/src/core/solana_client.ts` — added `readWithdrawalQueueClaimables` + base58 encoder
- `package.json` — added `cron-daemon` script
- `README.md` — added "Running the crons" section
- `spec/progress.md` — Phase 10 status flips on commit

## Completion Summary

**Phase 10 closed 2026-05-05.** SettlementExecutor cron ships as a pure batching function + runner + node-cron daemon binding all three crons. 58/58 unit tests pass; typecheck clean across the full executor. The daemon ships a `/health` HTTP endpoint surfaces stuck schedules to Docker/Kubernetes orchestrators. Multi-stage Dockerfile builds the bundle + ships a minimal Node 22 alpine image. **All three crons (Phases 8/9/10) now run together under one process; ready for `/complete-phase 10`.**
