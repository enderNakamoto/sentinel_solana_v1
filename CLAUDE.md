# Sentinel Solana — Agent Instructions

Decentralised flight delay insurance on Solana. This file is loaded automatically into every session — keep it short and durable.

## Locked stack — non-negotiable

| Layer | Tool |
|---|---|
| On-chain programs | **Anchor** (v1.x latest stable) |
| Client SDK (frontend + executor) | **`@solana/kit`** + `@solana-program/*` plugins |
| Frontend UI / wallet | **framework-kit** — `@solana/client` + `@solana/react-hooks` (Wallet Standard via `autoDiscover()`) |
| Legacy interop | `@solana/web3-compat` — boundary modules only |
| Typed program clients | **Codama** (generated from Anchor IDL) |
| Unit tests | **LiteSVM** (TypeScript, in-process) |
| Integration tests | **Surfpool** (local Surfnet) |
| Package manager | **pnpm workspaces** |

**Do not introduce:** `@solana/wallet-adapter-*`, raw `@solana/web3.js` outside boundary modules, `solana-test-validator` for unit tests, alternative codegen tools (declarative-codegen, etc.) without explicit approval.

## Project shape

- 5 Anchor programs: `governance`, `vault`, `flight_pool`, `oracle_aggregator`, `controller` (per `spec/architecture.md` §Program Architecture — do not consolidate). Oracle authority lives on `oracle_aggregator_program`; keeper authority lives on `controller_program`.
- 3 off-chain crons: `FlightDataFetcher` (2h), `FlightClassifier` (1h), `SettlementExecutor` (5min)
- **Stablecoin is Palm USD (PUSD)** — Token-2022 mint at `CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s` (mainnet) with MetadataPointer + TokenMetadata extensions, no fees / no transfer hooks. On dev/test clusters a mock PUSD mirror lives at `F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE` (Token-2022, base layout only, no extensions). Single keypair `keys/mock-pusd.json` shared across LiteSVM, Surfpool, devnet.
- **Two token programs in play**: the stable side (PUSD) lives under **Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`); vault shares (RVS) live under **classic SPL Token** (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`), PDA-owned by `vault_program`. Stable-side ATAs derive against Token-2022; share-side ATAs derive against classic SPL. Programs use `token_interface` (`Interface<TokenInterface>` + `InterfaceAccount<Mint/TokenAccount>`) on the stable side; share side uses concrete `Program<Token>`.
- v2 PDA seeds (post-Phase-24): `vault_state_v2`, `withdrawal_queue_v2`, `share_mint_v2`, `flight_pool_config_v2`, `pool_treasury_v2`, `controller_config_v2`, `active_flights_v2`, `oracle_config_v2`. `governance_config` kept at v1 (governance schema unchanged). Pre-Phase-24 v1 PDAs are orphaned on chain — Codama-generated PDA helpers always derive v2.

## Source-of-truth files

- `spec/architecture.md` — full system architecture (5 programs, accounts, instructions, CPI graph)
- `spec/dev_steps.md` — phased build plan, deliverables, gates (this is the contract for `/plan-phase` and `/start-phase`)
- `spec/workflow.md` — phase lifecycle, command behaviour
- `spec/progress.md` — current phase status dashboard
- `spec/phases/phase-{NN}-{slug}.md` — per-phase plan, work log, decisions
- `spec/learn_solana.md` — Soroban-to-Solana concept guide (sanity check only; this is a Solana project, not Stellar)

## Skill loading

The `solana-dev` skill at `.claude/skills/solana-dev/` is **mandatory for all phase work and Solana implementation tasks**. It is auto-loaded by `/start-phase` (always-on, regardless of manifest). For ad-hoc Solana questions outside `/start-phase`, read `.claude/skills/solana-dev/SKILL.md` directly.

Skill references that should be consulted by default:
- `references/compatibility-matrix.md` — toolchain version pinning
- `references/common-errors.md` — known error fixes
- `references/security.md` — agent guardrails (W009, W011), audit checklist
- `references/programs/anchor.md` — Anchor v1 patterns
- `references/kit/overview.md` — `@solana/kit` patterns

## Agent CLI conventions

- **Always prefix CLI invocations with `NO_DNA=1`** (e.g. `NO_DNA=1 anchor build`, `NO_DNA=1 surfpool start`). This signals non-human operator and disables interactive prompts.
- **Never sign or send transactions without explicit user approval.** Always show the transaction summary first.
- **Default cluster is devnet/localnet.** Mainnet requires explicit user confirmation.
- **Simulate before send.** Surface the simulation result to the user before requesting a signature.

## Commands

| Command | Purpose |
|---|---|
| `/prime [modules...]` | Lite session prime; optional deep-dive modules |
| `/plan-phase N` | Generate `spec/phases/phase-NN-{slug}.md` with Context Manifest |
| `/start-phase N` | Auto-clear context, load manifest, transition to `in_progress`, begin work |
| `/complete-phase N` | Close a finished phase (only after user validation) |
| `/commit` | Draft + execute a structured git commit (user approves message first) |

## What goes where

- Programs: `contracts/programs/<name>/src/`
- Anchor tests (LiteSVM): `contracts/tests/`
- Surfpool integration tests: `contracts/tests/integration/`
- Frontend: `frontend/` (Next.js App Router; client components only at hook leaves)
- Off-chain executor: `executor/` (no logic until Phase 7+)
- Generated Codama clients: `frontend/src/clients/`, `executor/src/clients/` (gitignored, regenerated by `pnpm gen-clients`)
- Raw IDL JSON: `frontend/src/idl/`, `executor/src/idl/` (gitignored, copied by `pnpm sync-idl`)
- Scripts: `scripts/` (sync-idl, gen-clients, dev-surfpool, keys-bootstrap)
- Keypairs: `keys/` (only `*.pubkey` committed; `*.json` gitignored)

## Hard rules

- **No Stellar / Soroban references.** This project was migrated; any remnant is stale.
- **`solana-dev` skill is the source of truth for stack defaults** — do not improvise alternatives.
- **Phase files are append-only during work.** Subtask checkboxes get checked, work log gets appended; past entries are not edited.
- **Commits and pushes are user-triggered.** Never auto-commit. Never force-push.
