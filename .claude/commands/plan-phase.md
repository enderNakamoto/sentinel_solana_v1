---
description: Generate a detailed phase plan file for a given phase number
---

# Plan Phase

## Objective

Generate a pre-work plan file for a specific phase so the user can review and edit it before work begins. Includes a **Context Manifest** — the exact skills, docs, and files the agent will need when `/start-phase` runs. Do not start any implementation — this command only produces the plan document.

## Arguments

The user provides a phase number as the argument (e.g. `/plan-phase 4`).

## Process

### 1. Read context

- Read `spec/dev_steps.md` — extract all deliverables / subtasks for the requested phase number (this file is the source of truth)
- Read `spec/progress.md` — confirm the phase row status is `not generated` (or `planned` if regenerating)
- Read `spec/architecture.md` — understand what this phase's programs / off-chain components depend on
- Read `MEMORY.md` (auto-loaded) — pick up any decisions already locked in

### 2. Determine the phase file path

Phase file naming convention:
```
spec/phases/phase-{NN}-{slug}.md
```
where `{NN}` is zero-padded phase number and `{slug}` is a short kebab-case name.

Phase slugs (Solana build):

| # | Slug |
|---|---|
| 0  | `phase-00-project-bootstrap` |
| 1  | `phase-01-governance-program` |
| 2  | `phase-02-vault-program` |
| 3  | `phase-03-flight-pool-program` |
| 4  | `phase-04-oracle-aggregator-program` |
| 5  | `phase-05-controller-program` |
| 6  | `phase-06-cross-program-integration-tests` |
| 7  | `phase-07-devnet-deployment` |
| 8  | `phase-08-oracle-cron` |
| 9  | `phase-09-classifier-cron` |
| 10 | `phase-10-settlement-cron` |
| 11 | `phase-11-e2e-cron-validation` |
| 12 | `phase-12-frontend-bootstrap` |
| 13 | `phase-13-frontend-admin` |
| 14 | `phase-14-frontend-underwriter` |
| 15 | `phase-15-frontend-traveler` |
| 16 | `phase-16-e2e-test` |

### 3. Build the Context Manifest

Determine which skills, external docs, and project files the agent will need to load when `/start-phase` runs. The mapping below is the **default baseline for every Solana phase**, then add phase-specific extras.

#### Universal defaults (every phase, no exceptions)

- **Skills:** `git`, `solana-dev`
- **`solana-dev` references** (auto-load alongside the skill):
  - `references/compatibility-matrix.md`
  - `references/common-errors.md`
  - `references/security.md`
- **Project files:** `spec/architecture.md`, `spec/dev_steps.md`, `spec/workflow.md`, `MEMORY.md`

#### Phase → Context Mapping (additions on top of the defaults)

**Phase 0 — Project Bootstrap:**
- Skill references: `kit/overview.md`, `kit/plugins.md`, `frontend-framework-kit.md`, `programs/anchor.md`, `idl-codegen.md`, `testing.md`, `surfpool/overview.md`, `surfpool/cheatcodes.md`, `kit-web3-interop.md`, `anchor/migrating-v0.32-to-v1.md`
- Docs to fetch:
  - https://www.anchor-lang.com/ — Anchor v1 docs, workspace layout
  - https://solana.com/docs/intro/installation — Agave/Solana CLI install
  - https://github.com/anza-xyz/kit — `@solana/kit` README + plugins
  - https://github.com/codama-idl/codama — Codama codegen CLI
  - https://github.com/LiteSVM/litesvm — LiteSVM TS API
  - https://docs.surfpool.run/ — Surfpool CLI + cheatcodes
  - https://github.com/anza-xyz/wallet-standard — Wallet Standard (autoDiscover)
  - https://nextjs.org/docs/app — Next.js App Router
- Files: `spec/learn_solana.md`

**Phases 1–5 — Anchor programs (governance, vault, flight_pool, oracle_aggregator, controller):**
- Skill references: `programs/anchor.md`, `idl-codegen.md`, `testing.md`, `kit/overview.md`, `anchor/migrating-v0.32-to-v1.md`
- Docs to fetch:
  - https://www.anchor-lang.com/docs — Anchor v1 docs
  - https://www.anchor-lang.com/docs/references/account-constraints — `#[account]` constraint reference
  - https://spl.solana.com/token — SPL Token program reference
- Files: all preceding program source dirs (`contracts/programs/<name>/src/`), `contracts/tests/setup.ts`, the architecture section for this program (cite section in manifest)

**Phase 6 — Cross-Program Integration Tests:**
- Skill references: `testing.md`, `surfpool/overview.md`, `surfpool/cheatcodes.md`, `programs/anchor.md`, `kit/overview.md`
- Docs to fetch:
  - https://docs.surfpool.run/ — Surfpool integration patterns
- Files: ALL five program source dirs in `contracts/programs/`, `contracts/tests/`, `Surfpool.toml`

**Phase 7 — Devnet Deployment:**
- Skill references: `programs/anchor.md`, `kit/overview.md`, `kit/plugins.md`, `idl-codegen.md`
- Docs to fetch:
  - https://www.anchor-lang.com/docs/references/cli — `anchor deploy` reference
  - https://docs.solana.com/cli/deploy-a-program — Solana CLI deploy
  - https://faucet.solana.com — devnet faucet
- Files: `contracts/Anchor.toml`, `scripts/`, `keys/*.pubkey`, `.env.example`

**Phases 8–10 — Off-chain crons (oracle, classifier, settlement):**
- Skills: add `aero-api` (FlightAware AeroAPI reference)
- Skill references: `kit/overview.md`, `kit/plugins.md`, `kit/advanced.md`, `idl-codegen.md`, `kit-web3-interop.md`
- Docs to fetch:
  - https://github.com/anza-xyz/kit — Kit advanced patterns
  - (AeroAPI URLs come from the `aero-api` skill itself)
- Files: `executor/`, `executor/src/clients/` (Codama-generated), `spec/architecture.md` §Off-Chain Executor Layer

**Phase 11 — E2E Cron Validation (Surfpool, no frontend):**
- Skills: add `aero-api` (mock client matches the real client's contract)
- Skill references: `testing.md`, `surfpool/overview.md`, `surfpool/cheatcodes.md`, `kit/overview.md`, `kit/advanced.md`, `idl-codegen.md`
- Docs to fetch:
  - https://docs.surfpool.run/ — Surfpool integration / time-travel cheatcodes
  - https://github.com/anza-xyz/kit — Kit advanced patterns
- Files: `executor/src/core/`, `executor/src/scripts/`, `executor/src/backends/cron/`, `executor/tests/`, `contracts/tests/integration/full-flow-deployed.test.ts`, `scripts/deploy.ts`, `spec/architecture.md` §Off-Chain Executor Layer

**Phase 12 — Frontend Bootstrap:**
- Skill references: `frontend-framework-kit.md`, `kit/overview.md`, `kit/plugins.md`, `idl-codegen.md`
- Docs to fetch:
  - https://nextjs.org/docs/app — Next.js App Router
  - https://github.com/anza-xyz/wallet-standard — Wallet Standard
  - https://github.com/anza-xyz/kit — `@solana/client` + `@solana/react-hooks`
- Files: `frontend/`, `frontend/src/clients/` (Codama-generated)

**Phases 13–15 — Frontend dashboards (traveler, underwriter, admin):**
- Skill references: `frontend-framework-kit.md`, `kit/overview.md`, `kit/plugins.md`, `idl-codegen.md`, `payments.md`
- Docs to fetch:
  - https://nextjs.org/docs/app — Next.js App Router
  - https://tailwindcss.com/docs — Tailwind reference
- Files: `frontend/src/`, `frontend/src/clients/`, all five program source dirs (for instruction reference)

**Phase 16 — End-to-End Test (Browser):**
- Skill references: `testing.md`, `surfpool/overview.md`, `surfpool/cheatcodes.md`, `frontend-framework-kit.md`
- Docs to fetch:
  - https://playwright.dev/docs/intro — Playwright (browser e2e)
  - https://docs.surfpool.run/ — Surfpool integration
- Files: all five program source dirs, `executor/`, `frontend/`, `Surfpool.toml`

### 4. Ask the user clarifying questions

Before writing the file, review the subtasks and architecture context for this phase. Identify anything that is ambiguous, has multiple valid design choices, or depends on decisions not already recorded in `architecture.md`, `dev_steps.md`, or `MEMORY.md`. Ask the user these questions directly — wait for answers before proceeding to write the file.

Examples of things worth asking about:
- Design choices that affect the program interface (account names, instruction parameters, error enum style)
- Whether to use Anchor account constraints or manual checks for a particular invariant
- PDA seed schemes, signer hierarchy, or upgrade authority decisions
- Edge cases where `architecture.md` is silent
- Constraints the user may want to enforce (rent, compute budget, account sizing, CPI surface)

Do not ask about things already clearly specified in `architecture.md`, `dev_steps.md`, or `MEMORY.md`. Keep questions concise — one to three questions is typical. If nothing is genuinely ambiguous, skip this step and proceed directly to writing the file.

### 5. Generate the phase file

Write the file at the path from step 2 with the following structure:

```markdown
# Phase {N} — {Name}

Status: planned
Started: —
Completed: —

---

## Goal

{One paragraph describing what this phase builds and why it matters to the system.}

## Dependencies

{List programs / components that must exist before this phase can begin. Reference which prior phase produces each dependency. Phase 0 has no dependencies.}

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
{Always include `git` and `solana-dev`. Add `aero-api` for cron phases (7–9).}

### Skill References
{List of `solana-dev/references/*.md` paths to read alongside the skill — universal defaults plus phase-specific entries from §3.}

### Docs to Fetch
{List of URLs the agent will WebFetch at start, with one-line descriptions.}

### Project Files to Read
{List of specific files/directories the agent must read before starting work — universal defaults plus phase-specific entries.}

## Pre-work Notes

> This section is for you to fill in before work begins.
> Add constraints, decisions already made, questions to resolve, patterns to follow, or anything the agent should know before touching code.

---

## Subtasks

{All numbered subtasks from dev_steps.md for this phase, as unchecked boxes. Group under sub-headings if the phase has many.}

- [ ] 1. ...
- [ ] 2. ...
...

### Gate

{The gate / "Done when" condition from dev_steps.md — what must be true before this phase is considered complete.}

---

## Work Log

> Populated by the agent during work. Do not edit manually.

---

## Files Created / Modified

> Populated by the agent during work.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.
```

### 6. Update progress.md

In the Phase Files table, change the phase row's Status column from `not generated` to `planned`. Update the Phase File path column with the slug filename.

### 7. Tell the user what to do next

Output a short message:
- Confirm the file was created at its path
- Show the **Context Manifest** summary — list the skills (always including `solana-dev`), skill references, docs, and key files that will be loaded
- Tell the user to open the file, read the subtasks, fill in the Pre-work Notes, and optionally edit the Context Manifest
- Tell them to run `/start-phase {N}` when they are ready — it will automatically clear context and begin work

## Hard rules

- **`solana-dev` is mandatory in every phase's manifest.** Never omit it. Never replace it. The agent's Solana defaults (framework-kit, `@solana/kit`, Anchor, LiteSVM, Surfpool, NO_DNA=1) live in this skill — without it the agent will drift.
- **No Stellar/Soroban references.** This is a Solana project. If you find any in `spec/` or commands during planning, flag them to the user.
- **Use `spec/dev_steps.md` as the source of truth.** Not `development_list.md`, not anything else.
