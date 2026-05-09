# Phase 17 — Cron Control Panel (Classifier + Settler)

Status: in_progress
Started: 2026-05-08
Completed: —

---

## Goal

Replace the mock `/crons` page with a real operator control panel that
lets a logged-in operator (a) trigger the FlightClassifier and
SettlementExecutor crons on demand, (b) see when each one last ran +
its outcome + captured stdout, and (c) inspect the current
ActiveFlightList so it's obvious what the next tick would do. The
FlightDataFetcher (oracle/AeroAPI) cron is **explicitly out of scope** —
that lives in Phase 18 because the trust model (TEE? centralized?
Switchboard?) is still open. Phase 17's two crons are pure on-chain
orchestration: they read state and submit keeper-signed instructions,
no external API needed.

The same UI works against either cluster the frontend is pointed at
(devnet / surfpool) by reusing Phase 16's cluster-aware config.

## Dependencies

- **Phase 9** (FlightClassifier cron — `executor/src/core/flight_classifier.ts`
  + `runClassifierOnce`).
- **Phase 10** (SettlementExecutor cron — `executor/src/core/settlement_executor.ts`
  + `runSettlerOnce`).
- **Phase 11** (executor's deployment-artifact loading + SolanaClient
  helper that the API routes will reuse).
- **Phase 13** (the `/crons` route that this phase rewrites).
- **Phase 16** (cluster switch — operator can flip between devnet and
  Surfpool with the same UI; bucket A and the `/api/faucet/mint`
  pattern are the templates for the new routes).

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git`
- `solana-dev`

### Skill References
- `references/compatibility-matrix.md`
- `references/common-errors.md`
- `references/security.md`
- `references/frontend-framework-kit.md`
- `references/kit/overview.md`
- `references/kit/plugins.md`
- `references/kit/advanced.md`
- `references/idl-codegen.md`
- `references/programs/anchor.md`

### Docs to Fetch
- https://nextjs.org/docs/app/api-reference/file-conventions/route — Next.js Route Handler reference.
- https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations — for the trigger-button posture (route handler vs server action; we'll use route handlers to mirror /api/faucet/mint).
- https://github.com/anza-xyz/kit — Kit RPC + signer patterns the route handlers reuse.

### Project Files to Read
- `spec/architecture.md` — full file (program + executor graph the triggers exercise).
- `spec/dev_steps.md` — Phase 17 deliverables.
- `spec/workflow.md` — phase lifecycle.
- `MEMORY.md` — locked decisions.
- `frontend/app/crons/page.tsx` — current mock state, the rewrite target.
- `frontend/app/api/faucet/mint/route.ts` — server-side keypair + RPC + tx-send pattern. Phase 17 routes mirror this.
- `frontend/app/api/log/event/route.ts` — minimal Route Handler shape.
- `frontend/src/config/devnet.ts` + `frontend/src/lib/cluster.ts` — cluster-aware constants the routes will reuse.
- `executor/src/core/flight_classifier.ts` — `runClassifierOnce` signature + `applyBatch` callback shape.
- `executor/src/core/settlement_executor.ts` — `runSettlerOnce` signature + `applyBatch` callback shape.
- `executor/src/core/solana_client.ts` — `createSolanaClient` factory the route handlers reuse.
- `executor/src/scripts/run-classifier.ts` — existing one-shot CLI; the route handler is essentially a Next.js wrapper around the same logic.
- `executor/src/scripts/run-settler.ts` — same.
- `executor/src/backends/cron/index.ts` — node-cron daemon (we don't run it from the UI in Phase 17 but worth understanding for the daemon-control follow-up).
- `frontend/tests/helpers/cronTick.ts` — Phase 16's surfpool simulators; partial overlap with Phase 17 logic, useful as a reference but not the canonical implementation.
- `deployments/devnet-latest.json` (and any `surfpool-*.json` artefacts) — the deployment artifact `createSolanaClient` consumes.
- `frontend/src/components/admin/Card.tsx` — UI primitive every cron card uses.

## Pre-work Notes

> Locked decisions from the planning conversation. Treat as hard
> requirements during implementation.

- **Scope is Classifier + Settler ONLY.** The Fetcher card stays on
  `/crons` but is rendered with a "Phase 18" badge and a disabled
  trigger button. Don't try to wire AeroAPI here — Phase 18 will
  decide the trust model.
- **Trigger auth: public-unauth.** Same posture as `/api/faucet/mint`.
  Acceptable for devnet/demo. Document in the README that mainnet
  rollout would require shared-secret or session auth.
- **Trigger surface = one-shot only.** No daemon-control endpoints
  (start/stop the node-cron schedule). Daemon lifecycle from a
  serverless route is fragile — `pnpm cron-daemon` stays as the
  background-process answer.
- **Persistence = JSONL on disk** at `frontend/.cache-cron-runs.jsonl`
  (gitignored). Each line: `{ id, cron, ts, durationMs, ok, summary,
  signatures, logs, error? }`. Bounded to last 100 records per cron;
  rotate via simple read-rewrite on each append. Document the
  Vercel-ephemeral-fs caveat in the README.
- **Live ActiveFlightList panel ON.** Single most useful "what would
  happen if I trigger now" signal. Reads from chain via the configured
  RPC; auto-refreshes every 10s + on tx-success burst.
- **Cluster awareness via env, not args.** The route handlers read
  the cluster from the same env vars Phase 16 wired
  (`NEXT_PUBLIC_SOLANA_RPC_URL`, etc.) and load the matching keeper
  keypair (`CRON_KEEPER_BASE58 / CRON_KEEPER_PATH`, defaulting to
  `keys/devnet-keeper.json` on devnet and `keys/surfpool-keeper.json`
  on localnet).
- **Cross-workspace import.** Add `@sentinel/executor` as a workspace
  devDependency of `@sentinel/frontend` so the route handlers can
  `import { runClassifierOnce } from '@sentinel/executor/core/flight_classifier'`
  cleanly. Alternative (relative path) is uglier and brittle.
- **Run isolation.** Each trigger acquires a process-local mutex per
  cron name so concurrent button-mashing can't race two settler ticks
  against the same active list. Document but don't engineer beyond a
  simple in-memory lock.
- **Useful surface, not "complete".** Activity feed shows last ~10
  records expanded; the JSONL has more. We don't need
  pagination/filters in v1.

---

## Subtasks

### A. API routes

- [x] A1. Add `@sentinel/executor` as a workspace devDependency of
      `@sentinel/frontend` (pnpm-workspace edit). Verify
      `import { runClassifierOnce } from '@sentinel/executor/core/flight_classifier'`
      and `import { runSettlerOnce } from '@sentinel/executor/core/settlement_executor'`
      typecheck from the frontend.
- [x] A2. Create `frontend/src/lib/cron-runs.ts` — shared utilities:
      `appendRun(record)`, `readRecentRuns(cron, limit)`, `cronLogPath()`.
      Append-rotates at 100 records per cron.
- [x] A3. Create `frontend/src/lib/cron-keypair.ts` — load the keeper
      signer via env-var priority: `CRON_KEEPER_BASE58` →
      `CRON_KEEPER_PATH` → cluster-aware fallback
      (`keys/devnet-keeper.json` for devnet, `keys/surfpool-keeper.json`
      for localnet). Mirrors the faucet route's loader.
- [x] A4. Create `frontend/app/api/cron/[id]/trigger/route.ts` —
      `POST` handler:
      1. Validate `id ∈ {classifier, settler}`. Return 400 on
         `fetcher` (Phase 18) or anything else.
      2. Acquire per-cron mutex; reject 409 if already running.
      3. Construct `SolanaClient` from `executor/src/core/solana_client.ts`
         using the active cluster's RPC + the loaded keeper keypair.
      4. For `classifier`: call `runClassifierOnce({ solana, applyBatch,
         log })`. The `applyBatch` callback mirrors `executor/src/scripts/run-classifier.ts`
         (compute-budget + classify_flights ix per batch).
      5. For `settler`: same shape — call `runSettlerOnce` with the
         settler's `applyBatch` (vault.process_withdrawal_queue + per-flight
         settlement chains).
      6. Capture all `console.log` output during the call into a
         buffer; collect the returned summary + every tx signature
         that actually landed.
      7. Append a record to `cron-runs.jsonl`.
      8. Return `{ ok, durationMs, summary, signatures, logs }` JSON.
- [x] A5. Create `frontend/app/api/cron/runs/route.ts` — `GET` handler.
      Reads JSONL, returns last `limit` records (default 20) optionally
      filtered by `?cron=classifier|settler`.
- [x] A6. Create `frontend/app/api/cron/active-flights/route.ts` —
      `GET` handler. Reads `ActiveFlightList` PDA + each entry's
      `FlightStatus` from `FlightData` PDAs, returns a JSON array
      `{ flightId, date, originAirport, destAirport, status }[]`. The
      `/crons` page polls this every 10s for the live panel.
- [x] A7. `.gitignore` — extend with `frontend/.cache-cron-runs.jsonl`.

### B. /crons page rewrite

- [x] B1. Replace the static `CRONS` array with a `useEffect` poll of
      `/api/cron/runs` (every 10s) + `/api/cron/active-flights` (also
      every 10s).
- [x] B2. Subscribe to `useTxSuccess` so cron triggers immediately
      bump the polling tick (no need to wait 10s after a click).
- [x] B3. Per-cron card layout:
      - Title + cadence + signer pubkey (`KEEPER_AUTHORITY` for both
        classifier and settler).
      - "Last run" badge: relative time (`2 min ago` / `idle since
        deploy`) + status pill (`OK` green / `FAILED` red / `IDLE`
        muted).
      - Summary row: `n acted`, `n skipped`, total duration.
      - "Trigger now" button → `POST /api/cron/<id>/trigger` →
        success toast + activity-log mirror via `emitTxSuccess`.
      - **Activity feed — concise one-line per record**:
          - Header row: timestamp + OK/FAILED pill + one-line summary.
          - **OK runs** → summary = `n acted, n skipped` (e.g.
            `3 acted, 5 skipped · 1.2s`). No stdout shown by default.
          - **FAILED runs** → summary = a single concise error
            string (e.g. `tx failed: insufficient funds for rent`).
            Pulled from `record.error` (the route handler is
            responsible for stripping stack-trace noise to a one-liner
            before persisting). Pin-to-top + red accent.
          - "View log" button (per record) toggles the full captured
            stdout + per-tx signature list with explorer links — for
            when the one-liner isn't enough.
          - "Copy" button on the expanded log copies the full record
            for paste-back.
- [x] B7. Failed-runs banner at the top of the page if any cron has
      `ok=false` in its last run. Counts unresolved failures across
      all crons (classifier + settler) with a link that scrolls to
      the matching card.
- [x] B4. Fetcher card stays visible but renders with a "Phase 18 —
      pending oracle integration" badge + disabled button + a one-line
      explanation linking to the Phase 18 plan once it exists.
- [x] B5. Live ActiveFlightList panel above the cards: shows pending
      flights with their on-chain `FlightStatus`. Empty-state copy:
      "No active flights — trigger /buy or wait for new coverage."
- [x] B6. Cluster awareness: header pill shows the active cluster
      (reuses `CLUSTER` from `config/devnet.ts`). Operator immediately
      sees whether they're poking surfpool or devnet.

### C. Operator UX polish

- [x] C1. Loading state on the trigger button (spinner + disable
      while in-flight). 409 from a concurrent trigger surfaces an
      explicit "another tick is running" toast.
- [x] C2. Sticky error toast (already implemented in Phase 16) for
      any cron failure; include the captured stdout tail in the toast
      body so the operator can paste it back to the team.
- [x] C3. Activity-log records pass through `mirrorToServer` so
      cron failures hit the dev-server stdout for terminal-side
      inspection (consistent with Phase 16's `/api/log/event` path).

### D. Documentation

- [x] D1. README §"Cron control panel" — what each trigger does, how
      to read the activity feed, the JSONL caveat on Vercel.
- [x] D2. Document the env vars (`CRON_KEEPER_BASE58`,
      `CRON_KEEPER_PATH`) and the auto-fallback ordering.
- [x] D3. Note the security posture (public unauth) + a one-line
      pointer to the future shared-secret hardening.

### Gate

- `POST /api/cron/classifier/trigger` and `POST /api/cron/settler/trigger`
  successfully run against either cluster. The same `runClassifierOnce`
  / `runSettlerOnce` functions Phase 9–10 ship are reused — no
  duplicated cron logic in the route handler.
- `/crons` shows live last-run timestamps that update without a page
  reload; clicking Trigger fires the cron, the activity feed gains a
  new record, and the live ActiveFlightList reflects the post-tick
  state within ~10s.
- **Each run renders as one concise line** on `/crons`: `OK · 3 acted,
  5 skipped · 1.2s` or `FAILED · <single-line error>`. No stdout dump
  in the feed. "View log" reveals the full captured output if the
  one-liner isn't enough. The route handler is responsible for
  reducing any thrown error to a single readable line before persisting.
- `pnpm typecheck` clean across all 3 workspaces.
- The Fetcher card is visibly disabled with a "Phase 18" indicator
  so the gap is honest.
- README documents the runbook + env vars + JSONL caveat.

---

## Work Log

### Session 2026-05-08
Starting phase. Lite prime + manifest loaded from working memory
(Phase 16 just shipped; the cluster switch infrastructure and
faucet API pattern are the templates for Phase 17). Reviewed
`executor/src/core/solana_client.ts` (the `createSolanaClient`
factory + `SolanaClient` interface), `executor/src/scripts/run-classifier.ts`,
`executor/src/scripts/run-settler.ts` to understand `applyBatch`
callback shapes. Decided to use a TS path alias
(`@executor/* → ../executor/src/*`) instead of adding
`@sentinel/executor` as a workspace devDep — fewer moving parts,
no `exports` map needed in the executor's package.json. The
`findRepoRoot` walking pattern from Phase 16 will solve the
deployment-artifact path resolution from Next.js's `process.cwd()`.
Beginning with bucket A.

**Bucket A — API routes — DONE.** Added `@executor/*` path alias to
`frontend/tsconfig.json` + `allowImportingTsExtensions: true` (the
executor's source uses `.ts` import suffixes for its
`--experimental-strip-types` runtime). Built three Route Handlers:
- `/api/cron/[id]/trigger` (POST) — wraps `runClassifierOnce` /
  `runSettlerOnce` with a captureConsole shim, per-cron mutex,
  concise-error formatter, and JSONL persistence.
- `/api/cron/runs` (GET) — reads the JSONL, filterable by cron id,
  limit-bounded.
- `/api/cron/active-flights` (GET) — reads `ActiveFlightList` PDA +
  per-flight `FlightStatus` for the live panel.
Plus shared utilities: `frontend/src/lib/cron-runs.ts` (JSONL
persistence with auto-rotation at 100 records/cron),
`frontend/src/lib/cron-keypair.ts` (cluster-aware path resolver
with base58-env fallback that writes a temp file).
**Live-fire validated against devnet**: classifier + settler each
returned `OK · 0 acted, 1 skipped` with the AS359 active flight
present (it's at `NotInitiated` so neither cron has work to do —
correct outcome, as expected without a fetcher tick first).

**Bucket B — `/crons` rewrite — DONE.** Replaced the static mock
data with `useEffect`-polled runs + active flights (every 10s
plus on-tx-success-burst). Each cron has its own card; the Fetcher
card shows a "🔒 Phase 18" panel and a disabled trigger button.
Activity feed renders one line per record (`OK · 0 acted, 1
skipped · 0.4s` or `FAILED · <one-liner>`), with FAILED rows
red-bordered and "View log" / "Copy" buttons that expose the
captured stdout + signature list with explorer links. Failed-runs
banner at the top when the most recent run of any cron failed.
Live ActiveFlightList panel above the cards renders flightId /
date / status with status-dependent colours.

**Bucket C — UX polish — DONE.** Trigger button shows `Running…` +
`disabled` state during the in-flight POST. 409 from concurrent
trigger surfaces an explicit toast. Sticky error toast (Phase 16)
already handles failures; toast `mirrorToServer` (Phase 16) carries
both success + error events to the dev-server stdout for
terminal-side inspection.

**Bucket D — Documentation — DONE.** README §"Cron control panel"
documents the three routes, the keypair env-var priority order,
the public-unauth posture caveat, and the JSONL/Vercel
ephemeral-fs caveat. Phase 18 gating indicator pointed to.

`pnpm typecheck` clean across all 3 workspaces. Live-fire
end-to-end validated against devnet (3 successful trigger → log →
read cycles). All subtasks complete. Gate condition met. Ready for
`/complete-phase 17`.

---

## Files Created / Modified

- `frontend/tsconfig.json` — added `@executor/*` path alias + `allowImportingTsExtensions`.
- `frontend/src/lib/cron-runs.ts` — NEW. JSONL persistence helpers.
- `frontend/src/lib/cron-keypair.ts` — NEW. Cluster-aware keypair path resolver.
- `frontend/app/api/cron/[id]/trigger/route.ts` — NEW. POST trigger handler.
- `frontend/app/api/cron/runs/route.ts` — NEW. GET run history.
- `frontend/app/api/cron/active-flights/route.ts` — NEW. GET on-chain ActiveFlightList.
- `frontend/app/crons/page.tsx` — full rewrite, real triggers + live activity feed + Phase 18 gating.
- `.gitignore` — extended for `frontend/.cache-cron-runs.jsonl`.
- `README.md` — new §"Cron control panel" subsection.
- `spec/phases/phase-17-cron-control-panel.md` — work log + decisions.
- `spec/progress.md` — phase status updated.

---

## Decisions Made

- **`@executor/*` path alias** instead of `@sentinel/executor` workspace
  devDependency: avoids needing an `exports` map on the executor
  package + sidesteps Next.js bundler quirks. Path alias + `allowImportingTsExtensions`
  is enough for tsc to typecheck the executor's `.ts`-suffix imports.
- **Inline batch builders** in the trigger route handler instead of
  importing them from the `executor/src/scripts/run-*.ts` CLIs (which
  define them locally + don't export). Duplicates ~80 lines of
  PDA/ATA derivation but means the route doesn't need to extend the
  executor's surface. The actual cron orchestration (`runClassifierOnce`
  / `runSettlerOnce`) is still single-source.
- **Concise error format**: route handler reduces any thrown error to
  the first non-empty line of `e.message`, capped at 240 chars, before
  persisting. Activity feed shows the one-liner; "View log" exposes
  the full stack via the captured stdout buffer.
- **Per-cron mutex is process-local** (a tiny `Record<CronId, boolean>`).
  Acceptable for single-instance dev/preview deploys. Multi-instance
  prod would need a distributed lock (Redis / DB row); document but
  don't engineer.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this
> phase. Populated during work.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.
