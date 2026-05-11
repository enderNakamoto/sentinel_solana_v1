# Phase 25 — Cron Executor on Render

Status: in_progress
Started: 2026-05-11
Completed: —

---

## Goal

Port the off-chain executor to a single **Render Web Service** that runs all
four crons (`FlightDataFetcher`, `FlightClassifier`, `SettlementExecutor`,
`RouteRepricer`) under `node-cron` in one Node process. Add an Express HTTP
surface (`/api/health`, `/api/logs`, `/api/trigger/:job`, `/api/config/:job`)
that the Vercel-hosted frontend proxies through, so both scheduled ticks and
manual UI-triggered ticks land in the **same in-memory ring-buffer log** and
render in the `/crons` activity feed. Replaces the current
`frontend/.cache-cron-runs.jsonl` JSONL store, which broke as soon as the
frontend moved to serverless (filesystem is ephemeral per Lambda invocation).

The deployment target is a single Render `type: web` service — not a
Background Worker, not Render Cron Jobs — because `node-cron` is in-process
and the trigger handler must share the log buffer with the scheduler. This
phase only delivers the localhost-validated codebase; the user pushes the
Render-deploy button manually once it's green.

## Dependencies

- **Phase 17** (Cron Control Panel) — provides the `/crons` UI that polls
  `/api/cron/runs` every 10s; that UI is the reader for the new buffer.
- **Phase 18** (FlightDataFetcher cron, centralised) — supplies
  `runFetcherOnce`, AeroAPI client, 4xx envelope decoder.
- **Phases 8–10** — supply `runClassifierOnce` and `runSettlerOnce`.
- **Phase 23** (Route Repricer cron) — supplies `runRepricerOnce` and the
  per-route `decisions[]` shape that `RunLogEntry` must preserve verbatim.
- **Phase 24** (Token-2022 / PUSD) — must be merged so the executor builds
  against the v2 PDAs; pre-Phase-24 binaries would mis-derive ATAs.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills

- `solana-dev` (mandatory)
- `git`
- `aero-api` (the cron the executor runs talks to AeroAPI)

### Skill References

- `solana-dev/references/compatibility-matrix.md`
- `solana-dev/references/common-errors.md`
- `solana-dev/references/security.md`
- `solana-dev/references/kit/overview.md`
- `solana-dev/references/kit/plugins.md`
- `solana-dev/references/programs/anchor.md`

### Docs to Fetch

- https://render.com/docs/blueprint-spec — `render.yaml` schema, env-var
  policy (`sync: false`), free-tier limits, healthcheck behavior
- https://expressjs.com/en/4x/api.html — route handlers, middleware,
  body-parser, error-handler patterns
- https://github.com/node-cron/node-cron — schedule expression reference

### Project Files to Read

- `spec/architecture.md` (full file, §Off-Chain Executor Layer in particular)
- `spec/dev_steps.md`
- `spec/workflow.md`
- `MEMORY.md`
- `executor/src/scripts/run-cron.ts` — current node-cron daemon + native
  `http` health server
- `executor/src/scripts/run-fetcher.ts`, `run-classifier.ts`, `run-settler.ts`
  — the existing one-shot CLIs (template for the new `run-repricer.ts`)
- `executor/src/core/flight_data_fetcher.ts`,
  `executor/src/core/flight_classifier.ts`,
  `executor/src/core/settlement_executor.ts`,
  `executor/src/core/route_repricer.ts` — the four `runFooOnce` core fns
- `executor/src/core/types.ts` — extend with `JobName`, `RunLogEntry`,
  `HealthStatus`
- `executor/Dockerfile` — reference for the build sequence (Codama
  gen-clients + esbuild bundle); the Render `startCommand` keeps it simpler
- `executor/package.json` — current scripts (`dev` script is stale, points
  at a non-existent `src/index.ts`)
- `frontend/src/lib/cron-runs.ts` — the soon-to-be-replaced JSONL impl
- `frontend/src/lib/cron-keypair.ts` — keypair loader that moves to the
  executor side entirely
- `frontend/app/api/cron/[id]/trigger/route.ts` — current in-lambda runner
  that becomes a proxy
- `frontend/app/api/cron/repricer/trigger/route.ts` — same
- `frontend/app/api/cron/runs/route.ts` — current JSONL reader that
  becomes a proxy
- `frontend/app/api/cron/fetcher/config/route.ts`,
  `frontend/app/api/cron/repricer/config/route.ts` — also become proxies
  per D-Phase25-6
- `frontend/.env.local` — env-var template; the `EXECUTOR_BASE_URL` /
  `EXECUTOR_TRIGGER_SECRET` lines land here

## Pre-work Notes

> This section is for you to fill in before work begins.
> Add constraints, decisions already made, questions to resolve, patterns
> to follow, or anything the agent should know before touching code.

_(empty — fill in before `/start-phase 25`)_

---

## Subtasks

### Executor side

- [x] 1. **`executor/src/core/run_log.ts`** — new file. In-memory
      `Record<JobName, RunLogEntry[]>` with `MAX_ENTRIES = 10`,
      `push + shift` rotation, module-scope `startedAt`. Exports
      `logRun`, `getLogs`, `getHealth`. `JobName = 'fetcher' | 'classifier'
      | 'settler' | 'repricer'`.

- [x] 2. **Extend `executor/src/core/types.ts`** — add `JobName`,
      `RunLogEntry`, `HealthStatus` interfaces. `RunLogEntry` must keep
      the richness of today's `CronRunRecord`: multi `signatures: string[]`,
      `decisions[]` for repricer, `dryRun?`, `histogram?`,
      `newlyDisabledPdas?`, `summary`, `durationMs`, `ok`, `error?`,
      `logs`. **Do NOT collapse to a single `tx_hash`** — the activity
      feed renders multi-batch settler runs.

- [x] 3. **`executor/src/server.ts`** — new Express app. Add `express` +
      `@types/express` to `executor/package.json`. Routes:
  - `GET /api/health` → `{ uptime_seconds, started_at, last_run: { fetcher, classifier, settler, repricer } }` via `getHealth()`
  - `GET /api/logs[?cron=&limit=]` → calls `getLogs()`, optionally filters/trims
  - `POST /api/trigger/:job?mode=&scenario=&verdict=&dryRun=` → dispatches to the matching `runFooOnce` core fn, wraps in `try { logRun({ ok:true, ... }) } catch { logRun({ ok:false, error: ... }) }`, returns the entry
  - `GET /api/config/:job` → returns `{ liveAvailable, defaultMode, defaultScenario|defaultGrokVerdict, agentReachable }` so the `/crons` UI can render toggles **(D-Phase25-6)**
  - **Added:** `GET /api/active-flights` — read-only ActiveFlightList + per-flight status decoder, shared with the `/crons` UI's "next tick would touch these" panel.
  - Optional middleware: if `EXECUTOR_TRIGGER_SECRET` env is set, require `X-Trigger-Secret` header on `POST /api/trigger/*`. `GET` routes stay unauthenticated (read-only).

- [x] 4. **`executor/src/scripts/run-repricer.ts`** — new one-shot CLI
      mirroring `run-fetcher.ts` / `run-classifier.ts` / `run-settler.ts`.
      Loads the keeper/deployer keypair, builds the Solana client, calls
      `runRepricerOnce`, prints the result, exits. Drops the asymmetry
      where the repricer only ran from the frontend.

- [x] 5. **Modify `executor/src/scripts/run-cron.ts`** — replace the
      existing native `http` health server with the Express app from
      `server.ts`. Wrap each `node-cron` tick body in the same
      `try { logRun({ ok:true, ... }) } catch { logRun({ ok:false, error }) }`
      envelope as the trigger handler — scheduled + manual runs end up in
      the same buffer. **Consolidated:** the previous two-file split
      (`scripts/run-cron.ts` shim + `backends/cron/{index,health}.ts`) is
      now a single file at `scripts/run-cron.ts`. Empty `backends/` dir
      removed.

- [x] 6. **`render.yaml`** at repo root — per **D-Phase25-7**:
      ```yaml
      services:
        - type: web
          name: sentinel-executor
          runtime: node
          rootDir: .
          buildCommand: pnpm install --frozen-lockfile --filter @sentinel/executor
          startCommand: pnpm --filter @sentinel/executor exec tsx src/scripts/run-cron.ts
          healthCheckPath: /api/health
          envVars:
            - key: SOLANA_RPC_URL
              sync: false
            - key: CRON_KEEPER_BASE58
              sync: false
            - key: AEROAPI_KEY
              sync: false
            - key: XAI_API_KEY
              sync: false
            - key: AGENT_BASE_URL
              sync: false
            - key: AEROAPI_MOCK_SCENARIO
              value: on_time
            - key: GROK_MOCK_VERDICT
              value: ok
            - key: EXECUTOR_TRIGGER_SECRET
              sync: false
            - key: HEALTH_PORT
              value: "8080"
      ```

### Frontend swap

- [x] 7. **`frontend/src/lib/cron-runs.ts`** — **deleted** along with
      `cron-keypair.ts`. With every cron-related lambda now a proxy,
      neither file had any importers. Replaced by a new shared helper
      `frontend/src/lib/executor-proxy.ts` (~50 LOC) that all five proxy
      routes consume.

- [x] 8. **`frontend/app/api/cron/runs/route.ts`** — thin proxy. Forwards
      `?cron=&limit=` query params verbatim to `${EXECUTOR_BASE_URL}/api/logs`.

- [x] 9. **`frontend/app/api/cron/[id]/trigger/route.ts`** AND
      **`frontend/app/api/cron/repricer/trigger/route.ts`** — stripped.
      Lambda becomes `POST ${EXECUTOR_BASE_URL}/api/trigger/:job?<query>`
      with the `X-Trigger-Secret` header forwarded when the env is set.
      Per **D-Phase25-1**, query params pass through verbatim.
      **Also proxied:** `/api/cron/active-flights/route.ts` (read-only
      ActiveFlightList + per-flight status decoder moved to executor).

- [x] 10. **Env wiring** — `frontend/.env.local` rewritten to keep only
       `NEXT_PUBLIC_SOLANA_RPC_URL`, `FAUCET_RPC_URL`, the new
       `EXECUTOR_BASE_URL` / `EXECUTOR_TRIGGER_SECRET`, and the faucet
       keypair vars. `executor/.env.example` rewritten with the full
       executor-side list (CLUSTER, SOLANA_RPC_URL, CRON_KEEPER_BASE58,
       AEROAPI_*, XAI_API_KEY, AGENT_*, GROK_*, EXECUTOR_TRIGGER_SECRET,
       HEALTH_PORT, schedule overrides).

- [x] 11. **README** — added the [Render deploy (Phase 25)](../README.md#render-deploy-phase-25)
       section with the env-var checklist, the localhost test sequence,
       a `node -e` recipe for keypair→base58 conversion, and the
       single-instance / restart-wipes-logs caveats. Updated the cron
       count from 3 → 4 in the "Running the crons" intro.

- [x] 12. **Config endpoint proxies (D-Phase25-6)** —
       `frontend/app/api/cron/fetcher/config/route.ts` and
       `frontend/app/api/cron/repricer/config/route.ts` proxy to
       `${EXECUTOR_BASE_URL}/api/config/:job`. Vercel no longer needs
       `AEROAPI_KEY` / `XAI_API_KEY` / `AGENT_BASE_URL` — the executor
       reports its own capabilities via `GET /api/config/:job`.

### Gate

Localhost end-to-end works:

1. Executor daemon running locally on `:8080` with all four crons hot (node-cron schedules registered, `/api/health` returns OK with all four jobs in `last_run`).
2. Frontend on `:3000` pointing at `EXECUTOR_BASE_URL=http://localhost:8080`.
3. Manual trigger from `/crons` for each of the four crons lands in the executor's in-memory buffer.
4. `/crons` activity feed renders those runs from the executor's buffer within one 10s poll (no JSONL reads, no Vercel filesystem dependency).
5. `pnpm typecheck` clean across all 3 TS workspaces.
6. `pnpm --filter @sentinel/executor test` passes (existing 114 executor unit tests still green after the `run-cron.ts` refactor).

After that gate is green, the user deploys to Render manually (push render.yaml, set the env vars in the Render dashboard, point Vercel's `EXECUTOR_BASE_URL` at the Render URL, redeploy Vercel).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-11

Starting phase. Lite prime complete. Context manifest loaded.

Skills loaded: solana-dev (SKILL.md + compatibility-matrix + common-errors + security), git.
Project files read: phase file, executor/src/scripts/{run-cron, run-fetcher, run-classifier, run-settler}.ts, executor/src/backends/cron/{index, health}.ts, executor/src/core/{types, flight_data_fetcher, flight_classifier, settlement_executor, route_repricer, solana_client}.ts, executor/package.json, frontend/src/lib/{cron-runs, cron-keypair}.ts, frontend/app/api/cron/{[id]/trigger, repricer/trigger, runs, fetcher/config, repricer/config}/route.ts, progress.md, CLAUDE.md, architecture.md (top).

Implementation order: types extension → run_log → server.ts → run-repricer → refactor cron daemon → render.yaml → frontend swap (config proxies, runs proxy, cron-runs lib, trigger proxies) → env wiring → README.

All 12 subtasks complete. Notable shape changes vs. the original plan:

- **Two-file split removed.** `executor/src/scripts/run-cron.ts` was a one-line shim that imported the real daemon from `backends/cron/index.ts`. Consolidated: the daemon is now self-contained in `run-cron.ts`. Empty `executor/src/backends/` directory removed.
- **Frontend lib files deleted, not gutted.** With the trigger routes becoming proxies, `frontend/src/lib/cron-runs.ts` and `frontend/src/lib/cron-keypair.ts` had no remaining importers. Per CLAUDE.md "no backwards-compat hacks", deleted both. New `frontend/src/lib/executor-proxy.ts` (~50 LOC) shared by all five proxy routes.
- **Active-flights route also became a proxy.** `frontend/app/api/cron/active-flights/route.ts` was the last frontend lambda importing `@executor/core/*`. Added `GET /api/active-flights` to the executor server (read-only ActiveFlightList + status decoder), turned the Vercel route into a one-liner proxy. Frontend now has ZERO `@executor/*` imports — sanity-grep confirmed.
- **Repricer schedule added.** New cron expression `0 0 * * *` (daily 00:00 UTC). Existing daemon was scheduling 3 crons; now 4.
- **Single signer simplification.** The old daemon loaded two SolanaClients (oracleSolana + keeperSolana from separate keypairs). The new design uses one keypair for all four crons — production sets `CRON_KEEPER_BASE58` to the deployer (post-rotate-keeper + rotate-oracle).

**Gate status:**
- ✓ `pnpm -r typecheck` — clean across contracts, executor, frontend.
- ✓ `pnpm --filter @sentinel/executor test` — 114/114 unit tests pass (no regressions from the daemon refactor).
- ⏳ Live localhost smoke (executor :8080 + frontend :3000 + `/crons` UI activity feed) — user to validate.

**Two locked decisions added on top of the original 5 (see Decisions Made):**
- D-Phase25-6: `/api/cron/{fetcher,repricer}/config` proxies to the executor's `/api/config/:job` so Vercel doesn't need AEROAPI_KEY / XAI_API_KEY / AGENT_BASE_URL just to render UI toggles.
- D-Phase25-7: Render uses `tsx` directly. `rootDir: .`, `buildCommand: pnpm install --frozen-lockfile --filter @sentinel/executor...`, `startCommand: pnpm --filter @sentinel/executor exec tsx src/scripts/run-cron.ts`.

Ready for `/complete-phase 25` after user validates the localhost flow and (optionally) the Render deploy.

---

## Files Created / Modified

**Executor (Render side)**
- `executor/src/core/run_log.ts` — NEW. In-memory ring buffer + getHealth.
- `executor/src/core/types.ts` — extended with `JobName`, `RunLogEntry`, `HealthStatus`, `RepricerDecisionRecord`, `JobConfigStatus`.
- `executor/src/server.ts` — NEW. Express app: `/api/health`, `/api/logs`, `/api/config/:job`, `/api/trigger/:job`, `/api/active-flights`. Exports `buildServer(deps)` + `runJobTick(job, ctx)` (shared by triggers + scheduler).
- `executor/src/scripts/run-cron.ts` — REWRITTEN. Consolidates the old `backends/cron/index.ts` + `health.ts`. Mounts the Express server, schedules all four crons (fetcher 2h, classifier 1h, settler 5min, repricer daily), wraps each tick in `runJobTick`.
- `executor/src/scripts/run-repricer.ts` — NEW. One-shot CLI mirroring run-fetcher/classifier/settler. Exports `routeActionToIxs` + agent/grok client builders shared with the server.
- `executor/src/backends/cron/{index.ts,health.ts}` — DELETED. Folded into the consolidated `run-cron.ts`.
- `executor/package.json` — added `express`, `@types/express`, `tsx` deps. `dev` script now points at `tsx src/scripts/run-cron.ts`.
- `executor/.env.example` — REWRITTEN. Full executor-side env list.

**Render config**
- `render.yaml` — NEW at repo root. Single Web Service `sentinel-executor`, `rootDir: .`, pnpm install --filter, tsx start, /api/health healthcheck, secrets `sync: false`.

**Frontend (Vercel side)**
- `frontend/src/lib/executor-proxy.ts` — NEW. Shared `executorBaseUrl()` + `triggerHeaders()` + `proxyJson()` helper used by all five proxy routes.
- `frontend/src/lib/cron-runs.ts` — DELETED.
- `frontend/src/lib/cron-keypair.ts` — DELETED.
- `frontend/app/api/cron/runs/route.ts` — REWRITTEN as proxy.
- `frontend/app/api/cron/[id]/trigger/route.ts` — REWRITTEN as proxy.
- `frontend/app/api/cron/repricer/trigger/route.ts` — REWRITTEN as proxy.
- `frontend/app/api/cron/fetcher/config/route.ts` — REWRITTEN as proxy.
- `frontend/app/api/cron/repricer/config/route.ts` — REWRITTEN as proxy.
- `frontend/app/api/cron/active-flights/route.ts` — REWRITTEN as proxy.
- `frontend/app/crons/page.tsx` — comment update (mirror reference moved to `executor/src/core/types.ts → RunLogEntry`).
- `frontend/.env.local` — pruned cron/AeroAPI/Grok/agent vars; added `EXECUTOR_BASE_URL` + `EXECUTOR_TRIGGER_SECRET`.

**Root**
- `package.json` — added `run-repricer` script. Removed duplicate `dev:executor` key.
- `README.md` — added "Render deploy (Phase 25)" section; updated cron count 3 → 4 in "Running the crons".
- `spec/progress.md` — Phase 25 status → in_progress.

---

## Decisions Made

**D-Phase25-1.** Query params pass through verbatim from Vercel → Render.
Defaults (`AEROAPI_MOCK_SCENARIO`, `GROK_MOCK_VERDICT`) read from env on
the executor side, not the frontend. Reason: env-derived defaults live
next to the code that runs them; one source of truth.

**D-Phase25-2.** Single Render Web Service (not Background Worker +
separate web). node-cron is in-process; trigger routes share the
`run_log` buffer with the schedule. Splitting them would give each its
own buffer.

**D-Phase25-3.** In-memory ring buffer at N=10 per job. Restart wipes
history — accepted for the demo. Audit/forensic history lives on chain
via signature history; the off-chain log is operational-dashboard only.

**D-Phase25-4.** Reuse the existing `executor/` directory (don't create
`executor/centralized_cron/` as in the reference design). The current
executor already has the core fns, Codama clients, and tests — only the
HTTP server and the log buffer are net-new.

**D-Phase25-5.** Repricer gets its own `run-repricer.ts` one-shot script
for symmetry with the other three crons. Removes the only path where a
cron's core fn was reachable from the frontend lambda but not from a
local CLI.

**D-Phase25-6.** `/api/cron/{fetcher,repricer}/config` endpoints become
thin proxies to a new executor `GET /api/config/:job`. Single source of
truth for "is live mode available". Without this the frontend would
need `AEROAPI_KEY` / `XAI_API_KEY` / `AGENT_BASE_URL` duplicated on
Vercel just to gate the toggles correctly.

**D-Phase25-7.** Render runs the cron daemon via `tsx` directly — no
esbuild bundle step. `rootDir: .` (repo root) with
`buildCommand: pnpm install --frozen-lockfile --filter @sentinel/executor`
and `startCommand: pnpm --filter @sentinel/executor exec tsx src/scripts/run-cron.ts`.
Keeps pnpm workspace resolution working (executor depends on
`executor/src/clients/*` which is now committed) and avoids duplicating
the Dockerfile's esbuild + 2-stage build for a Node-only runtime.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.
