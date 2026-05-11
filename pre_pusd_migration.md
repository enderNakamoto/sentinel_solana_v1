# Rollback: Pre-PUSD Migration

This document describes how to revert the protocol to its pre-Phase-24 state
(classic SPL mock USDC, no Token-2022, v1 PDA seeds). It is a **paper
runbook** — none of the steps have been executed since the migration landed
on 2026-05-11. Use it as a recovery procedure if the Token-2022 / PUSD
migration introduces a regression in production that cannot be patched
forward.

## Recovery anchors

The repo was tagged at the pre-Phase-24 head so we can always get back to a
known-good source tree:

| Anchor | What it points at |
|---|---|
| Git tag `pre-pusd-migration` | The last commit before any Phase 24 work (`a4d513e`, "docs: add Tests section at end of README"). |
| Feature branch `phase-24-token2022-pusd` | All Phase 24 commits. The branch was never merged to `main` — `main` still tracks pre-Phase-24 state. |
| `keys/mock-usdc.json` + `keys/mock-usdc-authority.json` | Retained on disk (gitignored). Mint authority for the legacy classic-SPL mint at `epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K`. |
| `keys/mock-usdc.pubkey` + `keys/mock-usdc-authority.pubkey` | Committed. Public addresses of the above. |
| `keys/devnet-deployer.json` | Unchanged across the migration — same upgrade authority signed both v1 and v2 devnet deployments. |

The v1 on-chain state is **not** preserved automatically:

- The v1 PDA accounts (`vault_state`, `flight_pool_config`, `controller_config`, etc., without the `_v2` suffix) still exist on devnet but are **orphaned**. The Phase 24 binaries don't reference them.
- The classic-SPL mock USDC mint (`epYcqu...`) still exists on devnet. Its supply, holders, and any pre-migration ATA balances are intact.
- The **v1 program binaries are gone** — `solana program deploy` upgraded them in place. There is no committed `.so` archive for the pre-Phase-24 binaries. Rebuilding from the `pre-pusd-migration` tag is the only path.

## Rollback procedure (paper-only — not executed since 2026-05-11)

The exact ordering matters: rebuild before redeploying, redeploy before re-pointing the frontend, re-point the frontend before unwiring crons.

### 1. Confirm the rollback is actually wanted

Before doing anything destructive: capture the current state.

```bash
# Snapshot the current deployment artifact and the v2 PDA addresses
cp deployments/devnet-latest.json deployments/devnet-pre-rollback-$(date +%s).json

# Snapshot the post-migration source state
git log --oneline -1                          # current HEAD
git stash --include-untracked || true         # park anything in flight

# Record the v2 deployer balance + program-data accounts so we can compare after
solana balance FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy --url devnet
```

### 2. Revert the code

```bash
# Move main aside; switch to a fresh recovery branch off the pre-migration tag
git checkout main
git checkout -b pre-pusd-rollback pre-pusd-migration

# Verify the tree is at the expected commit
git log --oneline -1
# expected: a4d513e docs: add Tests section at end of README
```

At this point the working tree mirrors the protocol as it was on 2026-05-08 — classic SPL mock USDC, v1 PDAs, no Token-2022 wiring.

### 3. Rebuild + redeploy the v1 binaries

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Rebuild all 5 programs from the pre-migration source
NO_DNA=1 anchor build

# Sync IDLs + regenerate Codama clients
NO_DNA=1 pnpm sync-idl
NO_DNA=1 pnpm gen-clients

# Confirm LiteSVM still passes against the rolled-back source
NO_DNA=1 pnpm --filter @sentinel/contracts test
# expected: 88/88 passing (same count as post-migration — surface unchanged)

# Redeploy to devnet (in place — program IDs are stable)
NO_DNA=1 bash scripts/run.sh deploy \
  --cluster devnet \
  --owner FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy \
  --deployer keys/devnet-deployer.json
```

The deploy script reads `keys/mock-usdc.pubkey` (still classic-SPL on the rolled-back source) and finds the existing v1 PDAs already initialized — it will skip every `initialize` ix because `accountExists` returns true for each v1 PDA. The wire phase (`vault.set_controller`, `flight_pool.set_controller`, `oracle.set_authorized_consumer`) is also a no-op because the v1 PDAs are already wired to the v1 controller PDA `mCKrLhjbapVxbD4AGK99jPg1s3neXfpezQLMZFfNPTR`.

**Expected verify output:** all 13 checks pass against the v1 PDA state. The new deployment artifact will list the v1 PDAs (`FpUBQ...`, `89YRV...`, `mCKrL...`, etc.) — the same addresses that lived in `deployments/devnet-1778222416.json` from the May 8 deploy.

### 4. Re-point the frontend + executor

Both consume `deployments/devnet-latest.json`. Once the v1 redeploy above writes a fresh artifact, no manual edits are needed — `frontend/src/config/devnet.ts` and the cron loader both pick up the v1 PDAs automatically.

Two manual sanity checks:

```bash
# Confirm the artifact references the v1 PDAs + classic-SPL mint
grep -E "stableMint|vaultState|controllerConfig" deployments/devnet-latest.json
# expected: stableMint = epYcquLhSz... (classic SPL),
#           vaultState = FpUBQSCehF... (v1)
#           controllerConfig = mCKrLhjbap... (v1)

# Typecheck across all 3 workspaces
pnpm -r typecheck
```

### 5. Re-create the rolled-back keys directory state

`keys/mock-pusd.{json,pubkey,-authority.json,-authority.pubkey}` still exist on disk from the v2 era but the rolled-back source doesn't reference them. They can stay (harmless) or be removed:

```bash
# Optional cleanup — only if you want a fully pristine v1 state
rm keys/mock-pusd.json keys/mock-pusd.pubkey keys/mock-pusd-authority.json keys/mock-pusd-authority.pubkey
```

The Token-2022 mock PUSD mint (`F5KjXX...`) on devnet itself stays as-is. There is no way to "uncreate" an SPL mint. It just becomes inert — no protocol references it.

### 6. Verify the rollback landed

Three smoke tests against the rolled-back devnet state:

```bash
# 1. End-to-end LiteSVM (same as during dev)
NO_DNA=1 pnpm --filter @sentinel/contracts test
# expected: 88/88 passing

# 2. Verify the live devnet state matches the v1 source
NO_DNA=1 bash scripts/run.sh deploy \
  --cluster devnet \
  --owner FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy \
  --deployer keys/devnet-deployer.json \
  --skip-deploy --skip-init
# expected: verify phase shows all 13 checks passing against v1 PDAs

# 3. Fund a wallet via the rolled-back script
pnpm fund-usdc --cluster devnet --recipient <test-wallet-pubkey> --amount 100
# expected: 100 mock USDC (classic SPL) minted to <test-wallet-pubkey>
```

### 7. Force-push the rolled-back state (if rolling back `main`)

If the rollback is permanent and the v2 work is being abandoned, archive the v2 history and reset `main`:

```bash
# Archive the v2 work — never lose it, just take it off the main line
git checkout phase-24-token2022-pusd
git tag phase-24-token2022-pusd-archive
git push origin phase-24-token2022-pusd-archive

# Reset main to the pre-migration tag
git checkout main
git reset --hard pre-pusd-migration

# DESTRUCTIVE — only do this with stakeholder buy-in
git push origin main --force-with-lease
```

If the rollback is a temporary measure (revert prod while we debug, then re-apply the migration), skip this step entirely. Leave `main` untouched and operate from the `pre-pusd-rollback` branch only.

## Known gotchas

1. **The Solana program-data accounts grow unbounded.** Each `solana program deploy` allocates a new on-chain buffer for the new binary and then closes the previous one. A rollback re-deploys all 5 programs, eating another ~2 SOL of deployer balance. Budget ~3 SOL margin.

2. **`set_authorized_consumer` is one-shot on the v1 oracle_config PDA.** It is already set to the v1 controller PDA (`mCKrLhjbap...`) from the May 8 deploy. The rollback step 3 above leaves that wire intact — the v1 binary expects v1 consumer, and that's what's there. No action needed.

3. **Existing v2 PUSD balances are stranded.** Any wallets that deposited PUSD into the v2 vault (`vault_state_v2 = CZ7Cnntu7uSWmzKNudfd6v8UHJqjELiCJuBX1pn43ecc`) cannot redeem against the rolled-back v1 vault. Decision: enumerate post-migration depositors before pulling the trigger, refund them off-chain, then roll back. The list of depositors is recoverable via `getProgramAccounts` filtered on the `share_mint_v2` mint authority.

4. **The Phase 11 Surfpool cron e2e suite (`pnpm test:e2e:crons`) is on the post-migration source.** After rolling back, the suite at the `pre-pusd-migration` tag was the older variant (`mintUsdcTo`, not `mintPusdTo`, classic-SPL ATAs throughout). It still works — just with different identifiers.

5. **No frontend e2e on either side.** The Synpress + Playwright suite at `frontend/tests/` was deleted in commit `be8e19b` (Phase 24, Group G dropped). The pre-migration tag still has those files — `git checkout pre-pusd-migration` brings them back. They were never reliable; treat them as historical artifacts only.

## Decision criteria — when to roll back

Rolling back loses the Token-2022 stable side and any value already deposited under v2. It is the right call only when:

- A protocol-level bug is found in the v2 binary that **cannot be patched forward** by another in-place upgrade. (Anchor v1's CPI surface is the most common place this would happen.)
- The bug has **economic consequences** — funds at risk, not a UI glitch.
- The fix-forward path takes longer than the operational cost of running on v1 while we fix.

If the bug is patch-forward-able, deploy a new v2 binary instead. PDA seeds don't need to bump again unless the account schema changes.

## Last verified

This runbook was written 2026-05-11 alongside the Phase 24 migration. It has **not** been executed end-to-end — the steps above are derived from inverting the migration commits (`5a8d6de`, `f1e6c4e`, `60df20b`, `459b79a`, `be8e19b`). Running through it in a Surfpool sandbox before relying on it for a real rollback is recommended.
