# Sentinel Solana — Progress

High-level dashboard. One row per phase. Authoritative source for `/plan-phase`,
`/start-phase`, `/complete-phase`. See `spec/dev_steps.md` for full deliverables and
`spec/phases/` for per-phase plans + work logs.

Status values: `not generated` → `planned` → `in_progress` → `paused` → `complete`

## Phase Files

| #  | Name                                  | Status        | Phase File                                                |
|----|---------------------------------------|---------------|------------------------------------------------------------|
| 0  | Project Bootstrap                     | complete      | `spec/phases/phase-00-project-bootstrap.md` (completed 2026-05-04) |
| 1  | governance_program                    | complete      | `spec/phases/phase-01-governance-program.md` (completed 2026-05-04) |
| 2  | vault_program                         | complete      | `spec/phases/phase-02-vault-program.md` (completed 2026-05-04) |
| 3  | flight_pool_program                   | complete      | `spec/phases/phase-03-flight-pool-program.md` (completed 2026-05-04) |
| 4  | oracle_aggregator_program             | complete      | `spec/phases/phase-04-oracle-aggregator-program.md` (completed 2026-05-04) |
| 5  | controller_program                    | complete      | `spec/phases/phase-05-controller-program.md` (completed 2026-05-04) |
| 6  | Cross-Program Integration Tests       | complete      | `spec/phases/phase-06-cross-program-integration-tests.md` (completed 2026-05-04) |
| 7  | Devnet Deployment                     | complete      | `spec/phases/phase-07-devnet-deployment.md` (completed 2026-05-05) |
| 8  | Oracle Cron — FlightDataFetcher       | complete      | `spec/phases/phase-08-oracle-cron.md` (completed 2026-05-05) |
| 9  | Classifier Cron — FlightClassifier    | complete      | `spec/phases/phase-09-classifier-cron.md` (completed 2026-05-05) |
| 10 | Settlement Cron — SettlementExecutor  | complete      | `spec/phases/phase-10-settlement-cron.md` (completed 2026-05-05) |
| 11 | E2E Cron Validation (Surfpool)        | complete      | `spec/phases/phase-11-e2e-cron-validation.md` (completed 2026-05-06) |
| 12 | Frontend Bootstrap                    | complete      | `spec/phases/phase-12-frontend-bootstrap.md` (completed 2026-05-07) |
| 13 | Frontend — Admin Panel                | complete      | `spec/phases/phase-13-frontend-admin.md` (completed 2026-05-08) |
| 14 | Frontend — Underwriter Dashboard      | complete      | `spec/phases/phase-14-frontend-underwriter.md` (completed 2026-05-08) |
| 15 | Frontend — Traveler Dashboard         | complete      | `spec/phases/phase-15-frontend-traveler.md` (completed 2026-05-08) |
| 16 | End-to-End Test (Browser)             | in_progress   | `spec/phases/phase-16-e2e-test.md` (started 2026-05-08)     |
| 17 | Cron Control Panel (Classifier + Settler) | in_progress | `spec/phases/phase-17-cron-control-panel.md` (started 2026-05-08) |
| 18 | FlightDataFetcher (Centralised Oracle) | in_progress   | `spec/phases/phase-18-fetcher-oracle-centralized.md` (started 2026-05-08) |
| 19 | Acurast TEE Oracle                    | deferred      | — (scope locked: Acurast TEE for the FlightDataFetcher; execution deferred past hackathon) |
| 20 | Chrome Extension (Expedia Surface)    | deferred      | — (scope locked: MV3 + Phantom UX + reused Codama clients; out of hackathon scope) |
| 21 | Walletless + Sponsored Gas            | deferred      | — (scope locked: Privy embedded wallet + relay + D18 rent_payer schema; depends on Phase 20) |
| 22 | Premium Pricing Agent (FastAPI + XGBoost) | complete    | `spec/phases/phase-22-premium-pricing-agent.md` (completed 2026-05-10) |
| 23 | Route Repricer Cron (TS + Grok)       | in_progress   | `spec/phases/phase-23-route-repricer-cron.md` (started 2026-05-10) |

## Current Pointer

Active phase: **Phase 23 — Route Repricer Cron (TS + Grok)** (in_progress, started 2026-05-10)
Other in_progress: Phase 16 (E2E Test), Phase 17 (Cron Control Panel), Phase 18 (Fetcher Oracle Centralized) — all started 2026-05-08

Last updated: 2026-05-10
Last completed: Phase 22 — Premium Pricing Agent (FastAPI + XGBoost) (2026-05-10)
