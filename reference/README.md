# Reference

Self-contained reference bundle. Two sub-folders, each independently copy-pasteable into a new project.

| Folder | What it is | Start here |
|---|---|---|
| **`frontend/`** | The Sentinel UI (Next.js 15 + React 19 + Tailwind + framework-kit). **Serious theme only** — the original fun-mode aesthetic is stripped. Same pages, same components, same look. | [`frontend/README.md`](./frontend/README.md) |
| **`ai/`** | The premium pricing agent. FastAPI + XGBoost model trained on BTS / Kaggle 2008 flight-delay data. POST a flight tuple, get a clamped stablecoin premium back. **Includes the raw 3.3 MB CSV** so retraining works from scratch. | [`ai/README.md`](./ai/README.md) |

Each README is rebuild-focused: a Quick Start at the top, then file inventory, contracts, and porting notes.

## How to hand this off

Tell the receiving agent:

> "Copy `reference/frontend/` into your project as the frontend workspace and follow its README. Copy `reference/ai/` into your project as the pricing agent (typically at `agent/`) and follow its README. They are independent — you can do one without the other."

Both folders are fully self-contained: no symlinks, no relative paths leaking out, no dependencies on the parent repo.

## What's NOT in here

- The Solana on-chain programs (Anchor) — those are project-specific to Sentinel and have no analog in a new project.
- The cron executor service (`executor/`) — the original glue between cron jobs and the chain; reimplement against your new backend.
- Codama-generated typed program clients — regenerate from your own IDLs (or skip if non-Solana).
- The pitch deck (`pitch/`, `spec/`) — narrative, not code.
