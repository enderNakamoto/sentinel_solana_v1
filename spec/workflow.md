# Development Workflow

This document describes how we manage the build process for this project — how phases are planned, executed, resumed, and closed. Update this file as the workflow evolves.

---

## Overview

Development is broken into phases (see `spec/dev_steps.md`). Each phase has its own lifecycle: it is planned before work starts, worked through incrementally, and explicitly closed by the user after validation.

The agent uses these files to resume work seamlessly across sessions without losing context.

---

## Files

| File | Purpose |
|---|---|
| `spec/dev_steps.md` | Phased build plan — deliverables, gates, dependencies per phase. Source of truth for `/plan-phase`. |
| `spec/progress.md` | High-level dashboard — one row per phase, shows status at a glance |
| `spec/phases/phase-{NN}-{slug}.md` | Per-phase living document — subtask checklist, pre-work notes, context manifest, work log, decisions |
| `spec/architecture.md` | Full system architecture (4 Anchor programs, accounts, instructions, CPI graph, off-chain executor) |
| `spec/learn_solana.md` | Soroban-to-Solana concept guide (sanity check during migration; this is now a Solana project) |
| `spec/workflow.md` | This file — explains the workflow itself |
| `CLAUDE.md` | Project-level agent instructions (locked stack, hard rules) — auto-loaded every session |
| `~/.claude/projects/.../memory/MEMORY.md` | Agent's persistent memory — loaded at start of every session |

## Claude Commands & Skills Structure

```
.claude/
├── commands/                   ← user-invoked via /<name>
│   ├── prime.md                ← /prime           — load project context at session start
│   ├── plan-phase.md           ← /plan-phase N    — generate phase plan file with context manifest
│   ├── start-phase.md          ← /start-phase N   — auto-clear context, load manifest, begin work
│   ├── complete-phase.md       ← /complete-phase N — close a finished phase
│   └── commit.md               ← /commit          — draft, review, and execute a git commit
└── skills/                     ← read by /start-phase based on Context Manifest
    ├── solana-dev/             ← MANDATORY for every phase (locked stack defaults)
    │   ├── SKILL.md
    │   └── references/         ← progressive disclosure (kit, anchor, testing, surfpool, etc.)
    ├── aero-api/               ← FlightAware AeroAPI (cron phases 7–9)
    │   └── SKILL.md
    └── git/                    ← commit conventions
        └── SKILL.md
```

**Skills** are loaded by `/start-phase` based on each phase's Context Manifest. `solana-dev` is loaded **unconditionally** for every phase (always-on read in `/start-phase`, plus listed in every manifest by default).

**Commands** are explicitly invoked by the user with `/command-name`.

---

## Phase Lifecycle

```
not generated → planned → in_progress → paused → complete
                              ↑________________|
```

- **not generated** — phase row exists in `progress.md`; no phase file yet
- **planned** — phase file exists with Context Manifest and subtasks; user has reviewed and edited Pre-work Notes; work has not started
- **in_progress** — agent is actively working; subtasks being checked off; work log being written
- **paused** — session ended mid-phase; work log records where we stopped
- **complete** — user has validated and called `/complete-phase`; phase file is now read-only history

---

## Commands

### `/plan-phase N`

**When:** Before you're ready to start a phase.

**What it does:**
1. Generates `spec/phases/phase-{NN}-{slug}.md` pre-populated with the goal, all deliverables/subtasks from `spec/dev_steps.md`, and empty sections for you to fill in
2. Builds a **Context Manifest** — lists the exact skills (always including `solana-dev`), skill references, external docs (with URLs), and project files the agent will need when `/start-phase` runs
3. Shows you the manifest summary so you know what the agent will load

**What you do next:** Open the file. Read the subtasks. Fill in the **Pre-work Notes** section. Optionally edit the **Context Manifest** if you want the agent to consult additional (or fewer) resources. When you're satisfied, run `/start-phase N`.

---

### `/start-phase N`

**When:** You've reviewed the phase file and are ready for the agent to begin implementation.

**What it does:**
1. **Auto-clears context** — treats the moment as a fresh session, disregards all prior conversation
2. **Runs a lite prime** — reads `README.md`, `CLAUDE.md`, architecture overview (top), `workflow.md`, `progress.md`, recent git history
3. **Always-on Solana defaults** — reads `.claude/skills/solana-dev/SKILL.md` + `compatibility-matrix.md` + `common-errors.md` + `security.md` regardless of what the manifest says
4. Reads the phase file and its **Context Manifest**
5. **Loads the manifest on top:**
   - Reads full `architecture.md` + project files listed in the manifest
   - Loads skills + skill references listed in the manifest
   - WebFetches external docs listed in the manifest
6. Reads your Pre-work Notes and treats them as hard requirements
7. Marks the phase `in_progress` in `progress.md`
8. Begins working through subtasks in order
9. Checks off subtasks in real time and writes to the Work Log as it goes

**No need to run `/clear` or `/prime` first.** The command handles both automatically.

**The work log** is the key to resuming. The agent writes it continuously — what was done, what decisions were made, what files were changed, and where to resume if interrupted. Do not edit the Work Log manually.

---

### `/prime [modules...]`

**When:** Start of any session (or resuming a paused phase).

**Lite by default** — reads `README.md`, `CLAUDE.md`, architecture overview (top ~50 lines), `workflow.md`, `solana-dev` SKILL + baseline references, `progress.md`, and recent git history. Just enough to know where the project stands.

**Optional deep-dive modules** — pass one or more to go deeper:

| Module | What it reads |
|---|---|
| `contracts` | All Anchor program source in `contracts/programs/*/src/`, full architecture program sections, `Anchor.toml`, `Cargo.toml` files, LiteSVM test harness |
| `frontend` | `frontend/` source, `app/providers.tsx`, generated Codama clients, `package.json`, framework-kit references |
| `executor` | `executor/src/`, generated Codama clients, per-cron entry points, AeroAPI skill, executor architecture section |

```
/prime                              → lite only (10–15 lines)
/prime contracts                    → lite + Anchor programs deep-dive
/prime contracts frontend           → lite + two deep-dives
/prime contracts frontend executor  → lite + all three
```

You just say "keep going" after priming and work continues from the last completed subtask.

---

### `/complete-phase N`

**When:** You've reviewed the agent's work and are satisfied the phase is done.

**What it does:**
1. Marks the phase `complete` with a timestamp
2. Writes a Completion Summary to the phase file (what was built, key decisions, files)
3. Updates `spec/progress.md` — advances the current phase pointer
4. Updates `MEMORY.md` with stable learnings from this phase

**This is always triggered by you.** The agent never auto-completes a phase. You validate, then close it.

---

## Standard Session Flow

### Starting a new phase

```
1. /plan-phase N       → agent generates phase file + context manifest (solana-dev included by default)
2. You edit the file   → fill in Pre-work Notes, review/edit Context Manifest
3. /start-phase N      → auto-clears context, loads manifest + always-on solana-dev, begins work
4. Agent works         → checks off subtasks, writes work log
5. You review          → inspect output, run tests, give feedback
6. /complete-phase N   → phase closed, memory updated
```

### Resuming a paused phase

```
1. /prime              → agent reads CLAUDE.md + progress + phase file + work log + solana-dev baseline
2. "keep going"        → agent resumes from last completed subtask
3. Agent works         → continues checking subtasks, appends to work log
4. You review          → validate when done
5. /complete-phase N   → phase closed
```

### Session ends mid-phase

No action required. The Work Log records where we stopped. Next session just run `/prime`.

---

## Context Manifest

Each phase file includes a **Context Manifest** section that specifies exactly what the agent needs to load. This is generated by `/plan-phase` and can be edited by the user before `/start-phase`.

The manifest includes:
- **Skills** — which `.claude/skills/<name>/SKILL.md` files to read (always includes `solana-dev` and `git`; cron phases also include `aero-api`)
- **Skill References** — specific `.claude/skills/solana-dev/references/*.md` files to read alongside the skill
- **Docs to Fetch** — external URLs to WebFetch
- **Project Files to Read** — specific files/directories the agent must read before starting

### External Doc Sources (Solana)

| Domain | What | Phases |
|---|---|---|
| `anchor-lang.com` | Anchor v1 docs, account constraints, CLI reference | 0–6, 14 |
| `solana.com/docs` | Solana CLI install, deploy, network config | 0, 6 |
| `github.com/anza-xyz/kit` | `@solana/kit` README, plugin catalog | 0, 7–14 |
| `github.com/codama-idl/codama` | Codama IDL → typed client codegen | 0, 7–14 |
| `github.com/LiteSVM/litesvm` | LiteSVM TypeScript API | 0–4 |
| `docs.surfpool.run` | Surfpool CLI, `Surfpool.toml`, cheatcodes | 0, 5, 14 |
| `nextjs.org/docs/app` | Next.js App Router | 0, 10–13 |
| `github.com/anza-xyz/wallet-standard` | Wallet Standard discovery (`autoDiscover`) | 0, 10 |
| `playwright.dev` | Browser e2e tests | 14 |
| FlightAware AeroAPI (via `aero-api` skill) | Flight status API reference | 7–9 |

---

## Per-Phase File Structure

```markdown
# Phase {N} — {Name}

Status: planned | in_progress | paused | complete
Started: {date or —}
Completed: {date or —}

## Goal
One paragraph: what this phase builds and why it matters.

## Dependencies
What must exist before this phase starts.

## Context Manifest              ← Generated by /plan-phase, editable by user
### Skills                       ← always includes solana-dev + git
### Skill References             ← specific solana-dev/references/*.md files
### Docs to Fetch
### Project Files to Read

## Pre-work Notes                ← YOU FILL THIS IN before /start-phase
Constraints, decisions already made, questions, patterns to follow.

## Subtasks                      ← Agent checks these off during work
- [x] 1. Done subtask
- [ ] 2. Pending subtask
...

### Gate
The condition that must be met for this phase to be complete.

## Work Log                      ← Agent writes this during work, do not edit
### Session {date}
...

## Files Created / Modified      ← Agent maintains this
## Decisions Made                ← Agent maintains this
## Completion Summary            ← Written by /complete-phase
```

---

## Rules

- **You fill in Pre-work Notes. The agent fills in everything else** in the phase file during work.
- **`solana-dev` is mandatory in every phase.** `/plan-phase` always includes it; `/start-phase` always loads it. Never omit.
- **The agent never auto-completes a phase.** You validate, then call `/complete-phase`.
- **The Work Log is append-only.** The agent adds to it; neither you nor the agent edits past entries.
- **Completed phase files are read-only history.** After `/complete-phase`, nothing in the file changes.
- **MEMORY.md captures stable facts only.** Not session details, not in-progress state — only things that will still be true in future sessions.
- **Context Manifest is the source of truth** for what `/start-phase` loads (in addition to the always-on `solana-dev` baseline). Edit it to control what the agent sees.
- **No Stellar / Soroban references.** This is a Solana project; any remnant is stale.

---

## Git Workflow

### Commit format

```
type[, type, ...]: short imperative description (≤50 chars)

- bullet: what changed and why
- bullet: one per logical group
```

### Types

| Type | When |
|---|---|
| `feat` | New program, instruction, hook, or feature |
| `fix` | Bug fix |
| `refactor` | Restructure without behaviour change |
| `test` | Tests added or updated (LiteSVM, Surfpool, Playwright) |
| `docs` | Spec files, architecture docs, phase files, CLAUDE.md |
| `workflow` | Commands, skills, progress tracking |
| `chore` | Config, deps, tooling, IDL/client codegen scripts |
| `deploy` | Deployment scripts, devnet/mainnet config |

### When to commit

- After completing a logical unit of work (a program, a test suite, a phase)
- After any workflow/tooling changes (commands, skills, progress files)
- Before pushing to GitHub — run `/commit` to generate and review the message

### `/commit` flow

```
/commit         → agent reads all changes, drafts message, shows you for approval
                  you say "yes" / edit it / "cancel"
                  agent commits only after explicit approval
```

**The agent never auto-commits.** You always see and approve the message first.
