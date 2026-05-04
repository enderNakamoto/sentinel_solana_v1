---
description: Prime agent with codebase understanding
---

# Prime: Load Project Context

## Objective

Build project understanding at the level requested. **Lite by default** — just enough to know where the project stands. Optionally deep-dive into specific areas.

## Arguments

```
/prime                                    → lite only
/prime contracts                          → lite + Anchor programs deep-dive
/prime frontend                           → lite + Next.js / framework-kit deep-dive
/prime executor                           → lite + off-chain cron deep-dive
/prime contracts frontend                 → lite + two deep-dives
/prime contracts frontend executor        → lite + all three
```

Zero or more modules can be passed. Order doesn't matter.

---

## Part 1 — Lite Prime (always runs)

### 1a. Read core docs (in parallel)

- Read `README.md` if it exists — project overview, structure, tech stack
- Read `CLAUDE.md` — locked stack, project shape, hard rules (auto-loaded into context)
- Read `spec/architecture.md` — **only the first ~50 lines** (System Overview + program table). Do NOT read the full file unless a deep-dive module needs it.
- Read `spec/workflow.md` — phase lifecycle and command behaviour

### 1a.bis. Read solana-dev skill baseline (always)

- Read `.claude/skills/solana-dev/SKILL.md` — locked stack defaults (Anchor v1, `@solana/kit`, framework-kit, LiteSVM, Surfpool, Codama, NO_DNA=1)
- Read `.claude/skills/solana-dev/references/compatibility-matrix.md`
- Read `.claude/skills/solana-dev/references/common-errors.md`

These are non-negotiable for every session. Deeper references load only if a module is invoked or `/start-phase` runs.

### 1b. Read progress and current state (in parallel)

- Read `spec/progress.md` — identify current phase and its status
- If a phase is `in_progress` or `paused`, read its phase file from `spec/phases/` — subtask checklist, Context Manifest, Work Log — to understand where work stopped
- `git log --oneline -15` — last 15 commits
- `git status` — any uncommitted work

### 1c. Extract from git

- Which phases have completion commits — treat as ground truth
- What the most recent commit was
- Cross-check against `progress.md`: if git shows phase N complete but `progress.md` disagrees, trust git and note the discrepancy

### 1d. Output lite summary

```
## Project: Sentinel Protocol — Solana
- Decentralised flight delay insurance on Solana (Anchor + framework-kit + executor crons)
- Current phase: {N} — {name} ({status})
- Last commit: {hash} {message}
- Uncommitted changes: {yes/no}
- Next action: {suggestion}

Stack: Anchor v1 · @solana/kit · framework-kit · Codama · LiteSVM · Surfpool
Workflow: /plan-phase N · /start-phase N · /complete-phase N · /commit
```

Keep it short — 10–15 lines max. This is the whole output if no modules are passed.

---

## Part 2 — Deep-Dive Modules (only if requested)

Run requested modules in parallel. Each module appends its section to the lite summary.

### Module: `contracts`

**What it reads:**
- `spec/architecture.md` — full Programs section (account types, instructions, CPI graph, authorization)
- All `.rs` source files in `contracts/programs/*/src/`
- `contracts/Anchor.toml` — program ID overrides, cluster config
- `contracts/Cargo.toml` (workspace) and each program's `Cargo.toml`
- `contracts/tests/setup.ts` — LiteSVM harness
- Existing test files in `contracts/tests/`
- `.claude/skills/solana-dev/references/programs/anchor.md` and `.claude/skills/solana-dev/references/testing.md`

**What it reports:**
- Each of the five programs (`governance`, `vault`, `flight_pool`, `oracle_aggregator`, `controller`): purpose, key instructions, key accounts/PDAs
- CPI graph (controller → governance/vault/flight_pool/oracle_aggregator; vault → flight_pool; flight_pool/vault → SPL Token; controller reads FlightData from oracle without CPI)
- Which programs exist vs. still to be built
- Test coverage observations (LiteSVM unit + Surfpool integration)
- Any deviation from `architecture.md`

### Module: `frontend`

**What it reads:**
- `frontend/` directory structure
- `frontend/package.json` — dependencies (must be framework-kit + `@solana/kit`, NOT `@solana/wallet-adapter-*`)
- `frontend/src/app/providers.tsx` and `app/layout.tsx` — `SolanaProvider` wiring
- Key source files: `app/page.tsx`, route definitions, hooks
- `frontend/src/clients/` — Codama-generated typed Kit clients (gitignored, may not be present)
- `frontend/src/idl/` — raw IDL JSON (gitignored)
- `.env.example` for cluster/RPC config
- `.claude/skills/solana-dev/references/frontend-framework-kit.md`

**What it reports:**
- Framework and key deps (Next.js App Router, framework-kit, Tailwind, Codama)
- Which Codama clients are generated and importable
- Current state of UI (scaffolded? landing page? dashboards built? connected to programs?)
- Wallet connection flow (`autoDiscover`, hooks used)
- Cluster default + env wiring
- Any leakage of legacy `@solana/web3.js` types outside boundary modules

### Module: `executor`

**What it reads:**
- `executor/` directory structure
- `executor/package.json`, `executor/tsconfig.json`
- `executor/src/index.ts` and `executor/src/lib/client.ts` — Kit client construction
- `executor/src/clients/` — Codama-generated typed Kit clients
- `executor/src/idl/` — raw IDL JSON
- Per-cron source dirs (Phase 7+): `executor/src/crons/oracle/`, `executor/src/crons/classifier/`, `executor/src/crons/settlement/`
- `.env.example` for AeroAPI key, executor keypair path, RPC URL
- `spec/architecture.md` §Off-Chain Executor Layer
- `.claude/skills/aero-api/SKILL.md` (FlightAware API reference)

**What it reports:**
- Cron architecture: shared Kit client + per-cron entry points
- Cron #1 — FlightDataFetcher (every 2h): how it calls AeroAPI, signs as `authorized_oracle`, writes via `oracle_aggregator_program` (`set_estimated_arrival`/`set_landed`/`set_cancelled`)
- Cron #2 — FlightClassifier (every 1h): how it walks `ActiveFlightList` and calls `controller_program.classify_flights()` (which CPIs to oracle to write `set_to_be_settled`)
- Cron #3 — SettlementExecutor (every 5min): how it calls `controller_program.execute_settlements()` (which CPIs to vault, flight_pool, and oracle)
- Which pieces exist vs. still to be built
- Authority/keypair boundaries (`authorized_oracle` vs `authorized_keeper`)

---

## Output Format

Always lead with the lite summary. If modules were requested, append each module's section with a clear header:

```
## Project: Sentinel Protocol — Solana
{lite summary}

## Contracts Deep-Dive
{only if /prime contracts}

## Frontend Deep-Dive
{only if /prime frontend}

## Executor Deep-Dive
{only if /prime executor}
```

**Make it scannable — bullet points, short lines, no walls of text.**
