# Architecture

## System Overview

Decentralised flight delay insurance on **Solana**. **Underwriters** deposit capital to back
claims; **travelers** pay a premium to receive a fixed payoff if their flight is delayed
beyond a configurable threshold (per-route `delay_hours`). All programs are written in
**Rust** using the **Anchor** framework and compiled to Solana BPF bytecode.

The system requires two off-chain cron jobs to keep ticking:

| Cron | Name | Frequency | Purpose |
|------|------|-----------|---------|
| #1 | **FlightDataFetcher** | Every 2 hours | Fetches flight data from AeroAPI, writes estimated/actual arrival times to FlightData accounts |
| #2 | **FlightProcessor** | Every 10 minutes | Classifies landed/cancelled flights AND executes money movement + processes underwriter withdrawal queue |

These run inside a modular **Executor Backend** that is fully swappable. The programs
enforce authorization via Anchor `Signer` checks against stored authorized addresses — they
don't know or care what backend is calling them. Swapping from a centralized cron to any
future keeper is a single owner transaction per program. No redeployment needed.

All payouts and withdrawals are **pull-based**: funds are credited on-chain and actors
claim them explicitly. Insurance is never sold unless the system has enough capital to
cover the payout — the protocol is **always solvent**.

The **insurance program never holds USDC in its own account** — it orchestrates everything
by calling instructions that change state and move funds through program-owned token accounts.

The frontend dApp uses **framework-kit** (`@solana/client` + `@solana/react-hooks`) with
wallet-standard connection, and Anchor IDL-generated TypeScript clients for each program.

---

## Program Architecture

The system is split into **3 Anchor programs** to minimize cross-program invocation (CPI)
overhead while maintaining clean separation of concerns:

| Program | Responsibility | Why separate |
|---------|---------------|--------------|
| `governance_program` | Route management, terms, admin whitelist | Independent admin concern, rarely called |
| `vault_program` | Capital management, share token, withdrawal queue | Underwriters interact directly, independent upgrade cycle |
| `insurance_program` | Controller + FlightPool + OracleAggregator + RecoveryPool | Tightly coupled — consolidation eliminates ~4 CPIs per transaction |

**CPI map** (only 2 cross-program boundaries):

```
insurance_program ──CPI──► vault_program      (lock/unlock capital, send payouts, record premium income)
insurance_program ──CPI──► governance_program  (read route terms, check whitelist)
insurance_program ──CPI──► SPL Token program   (transfer USDC)
vault_program     ──CPI──► SPL Token program   (transfer USDC, mint/burn shares)
```

All internal communication within `insurance_program` (Controller ↔ FlightPool ↔ OracleAggregator
↔ RecoveryPool logic) is plain Rust function calls — zero CPI overhead.

---

## Token Setup

**USDC:** Standard SPL Token (Token Program, not Token-2022). On devnet/localnet, a mock USDC
mint is deployed with 6 decimals to match production USDC. On mainnet, the real USDC mint
address (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) is configured.

**Vault shares (RVS):** A new SPL Token mint created by `vault_program` during initialization.
The vault PDA is the mint authority. Shares are minted on deposit and burned on redemption.

All token amounts are `u64` with 6 decimal places (1 USDC = 1,000,000 units).

---

## Programs

### governance_program

The route authority. Owns the canonical list of whitelisted flight routes and manages
premium, payoff, and delay threshold terms. The insurance program reads terms from this
program via CPI before every insurance purchase.

- A **route** is identified by `(flight_id, origin, destination)`.
- The program stores **global default terms** — `default_premium`, `default_payoff`, and
  `default_delay_hours` — that apply to any whitelisted route that does not have custom terms.
- When a route is **whitelisted**, custom `premium`, `payoff`, and `delay_hours` can
  optionally be assigned. If not assigned, the route falls back to global defaults.
- Routes can be **whitelisted** or **disabled**. Disabling blocks new purchases but does not
  affect already-active pools.
- **Terms can be updated** by the owner or an admin. Updates only apply to FlightPools
  created after the update; existing pools have their terms locked at creation.
- **Whitelisting a route does NOT create a FlightPool.** FlightPools are created lazily
  on first purchase (see insurance_program).

**Account types:**

```rust
/// Global configuration — one per program instance
/// PDA seeds: [b"governance_config"]
#[account]
pub struct GovernanceConfig {
    pub owner: Pubkey,
    pub default_premium: u64,       // in USDC units (6 decimals)
    pub default_payoff: u64,        // in USDC units (6 decimals)
    pub default_delay_hours: u32,
    pub route_count: u32,
    pub bump: u8,
}

/// Per-route terms and status
/// PDA seeds: [b"route", flight_id.as_bytes(), origin.as_bytes(), dest.as_bytes()]
#[account]
pub struct RouteAccount {
    pub flight_id: String,
    pub origin: String,
    pub destination: String,
    pub premium: Option<u64>,       // None → use default
    pub payoff: Option<u64>,        // None → use default
    pub delay_hours: Option<u32>,   // None → use default
    pub approved: bool,
    pub bump: u8,
}

/// Admin record
/// PDA seeds: [b"admin", admin_pubkey.as_ref()]
#[account]
pub struct AdminRecord {
    pub admin: Pubkey,
    pub is_active: bool,
    pub bump: u8,
}

/// Resolved terms returned to callers (not stored, computed on read)
pub struct ResolvedTerms {
    pub premium: u64,
    pub payoff: u64,
    pub delay_hours: u32,
}
```

**Instructions:**

```rust
// Initialization
fn initialize(ctx, default_premium, default_payoff, default_delay_hours) -> Result<()>;

// Global defaults
fn set_defaults(ctx, premium: u64, payoff: u64, delay_hours: u32) -> Result<()>;

// Route management — premium, payoff, delay_hours are optional overrides
fn whitelist_route(ctx, flight_id, origin, dest,
                   premium: Option<u64>, payoff: Option<u64>,
                   delay_hours: Option<u32>) -> Result<()>;
fn disable_route(ctx, flight_id, origin, dest) -> Result<()>;
fn update_route_terms(ctx, flight_id, origin, dest,
                      new_premium: Option<u64>, new_payoff: Option<u64>,
                      new_delay_hours: Option<u32>) -> Result<()>;

// Admin management
fn add_admin(ctx, admin: Pubkey) -> Result<()>;
fn remove_admin(ctx, admin: Pubkey) -> Result<()>;

// Read functions — resolve defaults before returning
fn get_route_terms(ctx, flight_id, origin, dest) -> Result<ResolvedTerms>;
fn is_route_whitelisted(ctx, flight_id, origin, dest) -> Result<bool>;
```

**`get_route_terms()` resolves defaults** — returns a `ResolvedTerms` with concrete
values (never `None`). If the route has custom terms, those are used; otherwise the global
defaults are returned.

**Authorization:**

| Action | Who | Mechanism |
|--------|-----|-----------|
| `set_defaults` | Owner | `has_one = owner` on GovernanceConfig + `Signer` |
| `whitelist_route` | Owner or Admin | Check owner OR AdminRecord.is_active |
| `disable_route` | Owner or Admin | Check owner OR AdminRecord.is_active |
| `add_admin` / `remove_admin` | Owner only | `has_one = owner` on GovernanceConfig + `Signer` |

---

### vault_program

The capital backing layer. All underwriter USDC sits here. Implements a **custom vault**
with an SPL Token share mint — shares represent proportional ownership of the pool.

**Anti-manipulation design:**

- **Virtual share offset** (`10^3` = 1000 virtual shares). The share price formula adds
  virtual shares and virtual assets to prevent inflation attacks and rounding manipulation.
  Deposit rounds shares down, withdrawal rounds shares up — protecting vault solvency.
- **`total_managed_assets` is an internal counter** stored in the vault PDA, NOT the raw
  USDC token balance. Direct USDC transfers to the vault token account do not affect share
  price calculations.
- `locked_capital: u64` tracks USDC committed as collateral for active policies.
  `max_withdraw` and `max_redeem` are capped at `free_capital = total_managed_assets - locked_capital`.

**Two withdrawal paths:**

1. **Immediate (`redeem`)** — Burns shares and transfers USDC when `free_capital >= redemption`.
2. **Queued (`request_withdrawal`)** — FIFO queue for locked capital. Enqueues
   `(caller, shares, timestamp)`. After each settlement, the insurance program CPIs
   `process_withdrawal_queue()`, which credits fulfilled requests to `claimable_balance`.
   Underwriters call `collect()` to pull USDC.

**Account types:**

```rust
/// Vault global state
/// PDA seeds: [b"vault_state"]
#[account]
pub struct VaultState {
    pub owner: Pubkey,
    pub controller: Pubkey,             // insurance_program's config PDA (set once)
    pub usdc_mint: Pubkey,
    pub share_mint: Pubkey,             // RVS token mint
    pub vault_token_account: Pubkey,    // USDC held by the vault
    pub total_managed_assets: u64,
    pub locked_capital: u64,
    pub last_snapshot_time: i64,
    pub withdrawal_queue_count: u32,
    pub is_controller_set: bool,
    pub bump: u8,
}

/// FIFO withdrawal queue (stored in a dedicated account for realloc flexibility)
/// PDA seeds: [b"withdrawal_queue"]
#[account]
pub struct WithdrawalQueue {
    pub requests: Vec<WithdrawalRequest>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawalRequest {
    pub owner: Pubkey,
    pub shares: u64,
    pub timestamp: i64,
}

/// Per-underwriter claimable balance
/// PDA seeds: [b"claimable", underwriter_pubkey.as_ref()]
#[account]
pub struct ClaimableBalance {
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

/// Daily share price snapshot
/// PDA seeds: [b"snapshot", &day.to_le_bytes()]
#[account]
pub struct SnapshotRecord {
    pub day: u64,
    pub share_price: u64,       // scaled by 10^6 for precision
    pub bump: u8,
}
```

**Instructions:**

```rust
// Initialization
fn initialize(ctx, usdc_mint: Pubkey) -> Result<()>;
fn set_controller(ctx, controller: Pubkey) -> Result<()>;  // set once, panics on second call

// Underwriter operations
fn deposit(ctx, usdc_amount: u64) -> Result<()>;
fn redeem(ctx, shares: u64) -> Result<()>;                  // immediate, capped at free_capital
fn request_withdrawal(ctx, shares: u64) -> Result<()>;      // queued FIFO
fn cancel_withdrawal(ctx, queue_index: u32) -> Result<()>;
fn collect(ctx) -> Result<()>;                               // pull claimable balance

// Controller-only (CPI from insurance_program)
fn increase_locked(ctx, amount: u64) -> Result<()>;
fn decrease_locked(ctx, amount: u64) -> Result<()>;
fn send_payout(ctx, recipient: Pubkey, amount: u64) -> Result<()>;
fn record_premium_income(ctx, amount: u64) -> Result<()>;
fn process_withdrawal_queue(ctx) -> Result<()>;
fn snapshot(ctx) -> Result<()>;                              // no-op if already snapshotted today

// Read (view helpers — can also be read client-side from account data)
fn free_capital(vault: &VaultState) -> u64;
fn share_price(vault: &VaultState, share_supply: u64) -> u64;
```

**Share price formula (with virtual offset):**

```
VIRTUAL_SHARES = 1000
VIRTUAL_ASSETS = 1000

shares_for_deposit = (deposit_amount * (total_shares + VIRTUAL_SHARES))
                     / (total_managed_assets + VIRTUAL_ASSETS)
                     // rounded DOWN (depositor gets slightly fewer shares)

assets_for_redeem = (shares * (total_managed_assets + VIRTUAL_ASSETS))
                    / (total_shares + VIRTUAL_SHARES)
                    // rounded UP (vault retains slightly more assets)
```

**Authorization:**

| Action | Who | Mechanism |
|--------|-----|-----------|
| `deposit`, `redeem` | Any underwriter | Underwriter is `Signer` |
| `request_withdrawal`, `cancel_withdrawal`, `collect` | Any underwriter | `Signer` + ownership check |
| `increase_locked`, `decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot` | Controller only | `has_one = controller` on VaultState + PDA signer seeds |
| `set_controller` | Owner | `has_one = owner` + `is_controller_set == false` |

The insurance program signs CPIs to vault_program using its config PDA's signer seeds.

---

### insurance_program

The consolidated program containing Controller logic, FlightPool state, OracleAggregator
data, and RecoveryPool. These are logically separate concerns but share a single program
to eliminate CPI overhead on the hot paths (buy, classify, settle).

#### Config Account

```rust
/// Program-wide configuration
/// PDA seeds: [b"insurance_config"]
#[account]
pub struct InsuranceConfig {
    pub owner: Pubkey,
    pub authorized_oracle: Pubkey,      // FlightDataFetcher's keypair
    pub authorized_keeper: Pubkey,      // FlightProcessor's keypair
    pub governance_program: Pubkey,
    pub vault_program: Pubkey,
    pub vault_state: Pubkey,            // vault_program's VaultState PDA
    pub usdc_mint: Pubkey,
    pub solvency_ratio: u32,            // default 100 = fully collateralised
    pub min_lead_time: i64,             // seconds before departure (default 3600)
    pub claim_expiry_window: i64,       // seconds (default 60 days = 5_184_000)
    pub total_policies_sold: u64,
    pub total_premiums_collected: u64,
    pub total_payouts_distributed: u64,
    pub bump: u8,
}
```

#### FlightPool Accounts (was: separate FlightPool contracts)

Each pool is a PDA account initialized on first purchase for a `(flight_id, date)` pair.
Terms (premium, payoff, delay_hours) are locked at creation.

```rust
/// One per (flight_id, date)
/// PDA seeds: [b"pool", flight_id.as_bytes(), &date.to_le_bytes()]
#[account]
pub struct FlightPool {
    pub flight_id: String,          // max 10 chars
    pub date: u64,                  // unix epoch day
    pub premium: u64,               // locked at creation (USDC units)
    pub payoff: u64,                // locked at creation (USDC units)
    pub delay_hours: u32,           // locked at creation
    pub buyer_count: u32,
    pub status: SettlementStatus,
    pub claim_expiry: i64,          // unix timestamp, set on settlement
    pub pool_token_account: Pubkey, // USDC held by this pool
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}
```

```rust
/// One per buyer per pool — enables per-user querying via getProgramAccounts
/// PDA seeds: [b"buyer", pool_pda.as_ref(), buyer_pubkey.as_ref()]
#[account]
pub struct BuyerRecord {
    pub buyer: Pubkey,              // at offset 8 — filterable via memcmp
    pub pool: Pubkey,               // at offset 40 — filterable via memcmp
    pub has_policy: bool,
    pub claimed: bool,
    pub bump: u8,
}
```

**Per-user policy querying** (solves the Soroban "MyPolicies" bug):

```typescript
// Frontend: get all policies for a connected wallet — one RPC call
const buyerRecords = await connection.getProgramAccounts(INSURANCE_PROGRAM_ID, {
  filters: [
    { memcmp: { offset: 0, bytes: BUYER_RECORD_DISCRIMINATOR } },
    { memcmp: { offset: 8, bytes: walletAddress.toBase58() } },
  ],
});
```

#### FlightData Accounts (was: OracleAggregator contract)

On-chain registry of flight data and settlement pipeline status.

```rust
/// One per (flight_id, date)
/// PDA seeds: [b"flight", flight_id.as_bytes(), &date.to_le_bytes()]
#[account]
pub struct FlightData {
    pub flight_id: String,
    pub date: u64,
    pub status: FlightStatus,
    pub estimated_arrival_time: i64,    // 0 if not yet set, unix epoch seconds
    pub actual_arrival_time: i64,       // 0 if not yet set, unix epoch seconds
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum FlightStatus {
    NotInitiated,
    Active,
    Landed,
    Cancelled,
    ToBeSettledOnTime,
    ToBeSettledDelayed,
    ToBeSettledCancelled,
    Settled,
}
```

**State machine** (forward-only, never regresses):

```
NotInitiated → Active → Landed ──► ToBeSettledOnTime ──► Settled
                  │                 ToBeSettledDelayed ──► Settled
                  └──► Cancelled ► ToBeSettledCancelled ► Settled
```

| State | Meaning | Set by |
|-------|---------|--------|
| `NotInitiated` | Flight registered, no data yet | `create_pool` (on first purchase) |
| `Active` | Estimated arrival time stored | FlightDataFetcher (oracle cron) |
| `Landed` | Flight has landed, actual arrival stored | FlightDataFetcher (oracle cron) |
| `Cancelled` | Flight was cancelled | FlightDataFetcher (oracle cron) |
| `ToBeSettledOnTime` | Classified as on-time, awaiting money movement | FlightProcessor (keeper cron) |
| `ToBeSettledDelayed` | Classified as delayed, awaiting money movement | FlightProcessor (keeper cron) |
| `ToBeSettledCancelled` | Classified as cancelled, awaiting money movement | FlightProcessor (keeper cron) |
| `Settled` | Settlement complete, money moved | FlightProcessor (keeper cron) |

#### Active Flight List

```rust
/// Tracks all active (unsettled) flights for efficient iteration
/// PDA seeds: [b"active_flights"]
#[account]
pub struct ActiveFlightList {
    pub flights: Vec<FlightEntry>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FlightEntry {
    pub flight_id: String,
    pub date: u64,
}
```

#### RecoveryPool

```rust
/// Custody for expired, unclaimed traveler payouts
/// PDA seeds: [b"recovery"]
#[account]
pub struct RecoveryPool {
    pub owner: Pubkey,
    pub token_account: Pubkey,      // USDC held by recovery pool
    pub total_recovered: u64,
    pub bump: u8,
}
```

#### Instructions

**Initialization:**

```rust
fn initialize(ctx, config_params: InitializeParams) -> Result<()>;
fn set_authorized_oracle(ctx, new_oracle: Pubkey) -> Result<()>;
fn set_authorized_keeper(ctx, new_keeper: Pubkey) -> Result<()>;
```

**Pool management (Controller logic):**

```rust
/// Creates FlightPool + FlightData PDAs on first purchase, then records the purchase.
/// If pool already exists for (flight_id, date), records the purchase on existing pool.
///
/// Flow:
///   1. CPI → governance_program.is_route_whitelisted() — revert if not
///   2. CPI → governance_program.get_route_terms() — read resolved terms
///   3. Enforce min_lead_time — revert if departure too soon
///   4. If pool doesn't exist → init FlightPool PDA + FlightData PDA (NotInitiated)
///   5. Solvency check — revert if undercollateralised
///   6. CPI → SPL Token: transfer premium from traveler to pool token account
///   7. CPI → vault_program.increase_locked(payoff)
///   8. Init BuyerRecord PDA for this traveler
///   9. Update counters
fn buy_insurance(ctx, flight_id: String, origin: String, dest: String, date: u64) -> Result<()>;
```

**Oracle data (FlightDataFetcher cron):**

```rust
/// Sets estimated arrival time. NotInitiated → Active.
fn set_estimated_arrival(ctx, flight_id: String, date: u64,
                         estimated_arrival_time: i64) -> Result<()>;

/// Sets actual arrival time. Active → Landed.
fn set_landed(ctx, flight_id: String, date: u64,
              actual_arrival_time: i64) -> Result<()>;

/// Marks flight as cancelled. Active → Cancelled.
fn set_cancelled(ctx, flight_id: String, date: u64) -> Result<()>;
```

**Classification + Settlement (FlightProcessor cron — combined):**

```rust
/// Classifies AND settles flights in one pass. Called by the keeper cron.
///
/// Phase 1 — Classification:
///   For each flight in Landed or Cancelled status:
///     - Cancelled → ToBeSettledCancelled
///     - Landed → read FlightPool.delay_hours, compute delay
///       - delay >= delay_hours → ToBeSettledDelayed
///       - delay < delay_hours → ToBeSettledOnTime
///
/// Phase 2 — Settlement:
///   For each flight in ToBeSettled* status:
///     - ToBeSettledOnTime:
///         pool premiums → CPI vault.record_premium_income()
///         CPI vault.decrease_locked(payoff * buyer_count)
///     - ToBeSettledDelayed / ToBeSettledCancelled:
///         CPI vault.send_payout(pool, (payoff - premium) * buyer_count)
///         CPI vault.decrease_locked(payoff * buyer_count)
///     - Mark FlightData as Settled
///     - Remove from ActiveFlightList
///
/// Phase 3 — Housekeeping:
///   CPI vault.process_withdrawal_queue()
///   CPI vault.snapshot()
///
/// Processes up to MAX_FLIGHTS_PER_TX flights to stay within compute budget.
fn process_flights(ctx) -> Result<()>;
```

**Traveler claims:**

```rust
/// Traveler claims their payout after delayed/cancelled settlement.
fn claim(ctx, flight_id: String, date: u64) -> Result<()>;

/// Anyone can sweep expired unclaimed payouts to RecoveryPool.
fn sweep_expired(ctx, flight_id: String, date: u64) -> Result<()>;
```

**Recovery:**

```rust
/// Owner withdraws from RecoveryPool for manual resolution of late claims.
fn withdraw_recovery(ctx, amount: u64) -> Result<()>;
```

**Read helpers (also readable client-side from account data):**

```rust
fn get_flight_data(flight_data: &FlightData) -> FlightData;
fn get_pool_info(pool: &FlightPool) -> FlightPool;
```

#### Authorization

| Action | Who | Mechanism |
|--------|-----|-----------|
| `buy_insurance` | Any traveler | Traveler is `Signer`, token transfer authorized |
| `set_estimated_arrival`, `set_landed`, `set_cancelled` | Authorized oracle | `Signer` + `config.authorized_oracle` check |
| `process_flights` | Authorized keeper | `Signer` + `config.authorized_keeper` check |
| `claim` | Traveler with policy | `Signer` + BuyerRecord existence + `claimed == false` |
| `sweep_expired` | Anyone | `Signer` (caller pays tx fee) + expiry timestamp check |
| `set_authorized_oracle`, `set_authorized_keeper` | Owner | `has_one = owner` on InsuranceConfig |

---

## Off-Chain Executor Layer (Modular)

The protocol needs two off-chain cron jobs. Both are **backend-agnostic** — the programs
enforce authorization via Anchor `Signer` checks against stored authorized addresses.

### Cron Job Summary

| Cron | Name | Frequency | On-chain target | Authorization |
|------|------|-----------|-----------------|---------------|
| #1 | **FlightDataFetcher** | Every 2 hours | `insurance_program` (oracle instructions) | `authorized_oracle` |
| #2 | **FlightProcessor** | Every 10 minutes | `insurance_program.process_flights()` + vault CPIs | `authorized_keeper` |

### Cron #1 — FlightDataFetcher (Oracle, every 2 hours)

Fetches flight data from AeroAPI and writes it to FlightData accounts. This cron is the
only off-chain process that talks to external APIs.

```
FlightDataFetcher
    │
    ├─► reads ActiveFlightList account via Solana RPC
    │
    ├─► Step A: For flights in NotInitiated status:
    │       calls AeroAPI for estimated arrival time
    │       signs + submits tx:
    │         insurance_program.set_estimated_arrival(flight_id, date, eta)
    │       (NotInitiated → Active)
    │
    └─► Step B: For flights in Active status
        where estimated_arrival_time + 1 hour < now:
            calls AeroAPI for actual flight status
            │
            ├─ Landed → signs + submits tx:
            │    insurance_program.set_landed(flight_id, date, actual_arrival_time)
            │    (Active → Landed)
            │
            ├─ Cancelled → signs + submits tx:
            │    insurance_program.set_cancelled(flight_id, date)
            │    (Active → Cancelled)
            │
            └─ Still in flight / HTTP error → skip, retry next cycle
```

**Why 1 hour buffer?** The oracle only calls AeroAPI for flights that should have landed
at least 1 hour ago. This avoids unnecessary API calls for flights still in the air and
gives AeroAPI time to receive final landing data.

### Cron #2 — FlightProcessor (Keeper, every 10 minutes)

Combined classification + settlement. Reads oracle data, classifies outcomes, executes
money movement, and processes the withdrawal queue — all in one pass.

```
FlightProcessor → signs + submits tx:
    insurance_program.process_flights(keeper_address)
        │
        ├─► Phase 1: Classification
        │   for each flight with Landed or Cancelled status:
        │       │
        │       ├─ Cancelled → status = ToBeSettledCancelled
        │       │
        │       └─ Landed → read FlightPool.delay_hours
        │                   delay = actual_arrival - estimated_arrival
        │                   ├─ delay >= delay_hours → ToBeSettledDelayed
        │                   └─ delay <  delay_hours → ToBeSettledOnTime
        │
        ├─► Phase 2: Settlement
        │   for each flight with ToBeSettled* status:
        │       │
        │       ├─ ToBeSettledOnTime
        │       │       transfer premiums from pool → CPI vault.record_premium_income()
        │       │       CPI vault.decrease_locked(payoff * buyer_count)
        │       │       FlightData.status = Settled
        │       │
        │       ├─ ToBeSettledDelayed / ToBeSettledCancelled
        │       │       payout = (payoff - premium) * buyer_count
        │       │       CPI vault.send_payout(pool_token_account, payout)
        │       │       CPI vault.decrease_locked(payoff * buyer_count)
        │       │       set pool.claim_expiry = now + claim_expiry_window
        │       │       FlightData.status = Settled
        │       │       update total_payouts_distributed
        │       │
        │       └── remove from ActiveFlightList
        │
        ├─► Phase 3: Withdrawal queue
        │       CPI vault.process_withdrawal_queue()
        │
        └─► Phase 4: Snapshot
                CPI vault.snapshot()   (no-op if already snapshotted today)
```

**Why combined?** On Soroban, classification and settlement were separate crons because
they were separate cross-contract calls. On Solana, they're instructions in the same program
with zero CPI overhead between them. Combining reduces the number of transactions submitted,
simplifies the executor, and ensures classified flights are settled immediately.

**Compute budget:** `process_flights` processes up to `MAX_FLIGHTS_PER_TX` flights (default 5).
If more flights are pending, the cron submits multiple transactions. Each flight's
classification + settlement uses ~100K-200K compute units depending on the path.

### Why two crons instead of three?

- **FlightDataFetcher** is fundamentally different — it talks to an external API (AeroAPI).
  It runs every 2 hours to respect API rate limits and the 1-hour landing buffer.
- **FlightProcessor** handles everything on-chain — classification and settlement are
  sequential steps that naturally belong together. Running every 10 minutes ensures
  classified flights are settled promptly.
- **Different failure modes.** A broken oracle doesn't halt settlement of already-classified
  flights (those are already ToBeSettled*). A broken processor doesn't prevent the oracle
  from writing data.
- **Independent key rotation.** The `authorized_oracle` and `authorized_keeper` are
  updatable independently.

### The Executor Interface

Every backend must implement two logical jobs:

```
FlightDataFetcher:
  1. Read ActiveFlightList via Solana RPC
  2. For NotInitiated flights:
       - Call AeroAPI for estimated arrival time
       - Build + sign Anchor instruction: set_estimated_arrival(...)
       - Submit via Solana RPC
  3. For Active flights where estimated_arrival + 1 hour < now:
       - Call AeroAPI for actual flight status
       - Landed → build + sign: set_landed(...)
       - Cancelled → build + sign: set_cancelled(...)
       - Still in flight / HTTP error → skip, retry next cycle

FlightProcessor:
  1. Build Anchor instruction: process_flights()
  2. Sign with executor's Solana keypair
  3. Submit via Solana RPC
```

All jobs use `@coral-xyz/anchor` TypeScript client to build instructions and
`@solana/kit` (or `@solana/web3.js`) to sign and submit transactions.

### Executor project structure

```
executor/
├── src/
│   ├── core/                      # Shared logic — reused by ALL backends
│   │   ├── flight_data_fetcher.ts # AeroAPI fetch + oracle instruction building
│   │   ├── flight_processor.ts    # Combined classify + settle instruction
│   │   ├── solana_client.ts       # Anchor client wrapper (build, sign, submit)
│   │   ├── aeroapi_client.ts      # AeroAPI HTTP client
│   │   └── types.ts               # FlightStatus, FlightData, etc.
│   │
│   ├── backends/
│   │   ├── cron/                  # Centralized cron (current default)
│   │   │   ├── index.ts           # node-cron scheduler entry point (2 schedules)
│   │   │   ├── config.ts          # Loads .env, RPC URLs, keypairs
│   │   │   └── health.ts          # /health endpoint for monitoring
│   │   │
│   │   └── future/                # Placeholder for future TEE backends
│   │
│   └── scripts/
│       ├── rotate_keys.ts         # Generate new keypair, call set_authorized_*
│       └── check_health.ts        # Verify jobs are running, balances are funded
│
├── .env.example
├── package.json
├── tsconfig.json
└── Dockerfile
```

The key insight: `core/` contains all the business logic. Each `backends/` entry is a thin
wrapper that provides scheduling and environment variable access. Adding a new backend
means writing a new entry point that imports from `core/` — typically under 20 lines.

### Backend migration

Migrating between executor backends is a **zero-downtime, no-redeployment operation**:

```
1. Deploy new executor backend
2. Read new executor's Solana public key(s)
3. Fund new executor account(s) with SOL (for transaction fees)
4. Start new executor jobs (both old and new running — only old is authorized)
5. Execute migration transactions:
     owner → insurance_program.set_authorized_oracle(new_oracle_address)
     owner → insurance_program.set_authorized_keeper(new_keeper_address)
6. Verify new executor's txs are succeeding on-chain
7. Shut down old executor backend
```

During the dual-running window, both backends submit transactions, but only the authorized
one succeeds. Unauthorized transactions fail signer checks — no side effects, no
double execution. Rollback = set addresses back to old backend.

---

## Data Flow

### Whitelisting a Route

```
Owner or Admin → governance_program.whitelist_route(flight_id, origin, dest,
                                                     premium?, payoff?, delay_hours?)
    └─► RouteAccount PDA created/updated
        if custom terms provided → stored in RouteAccount
        if not → will fall back to global defaults when queried
        NO FlightPool created yet — lazy creation on first purchase
```

### Buying Insurance (with lazy pool creation)

```
Traveler → insurance_program.buy_insurance(flight_id, origin, dest, date)
                │
                ├─► traveler is Signer (Anchor enforces)
                ├─► CPI → governance_program.is_route_whitelisted(...)
                │         revert if not whitelisted
                ├─► CPI → governance_program.get_route_terms(...)
                │         read resolved terms (premium, payoff, delay_hours)
                ├─► enforce min_lead_time
                │         revert if departure too soon
                │
                ├─► pool PDA exists for (flight_id, date)?
                │       ├─ YES → use existing pool
                │       └─ NO  → init FlightPool PDA with locked terms
                │                init pool token account (USDC, authority = pool PDA)
                │                init FlightData PDA (status = NotInitiated)
                │                add to ActiveFlightList
                │
                ├─► solvency check
                │       read vault free_capital via CPI or stored reference
                │       revert if undercollateralised
                ├─► CPI → SPL Token: transfer(traveler_ata, pool_token_account, premium)
                ├─► CPI → vault_program.increase_locked(payoff)
                ├─► init BuyerRecord PDA for this traveler
                └─► update counters (buyer_count, total_policies_sold, total_premiums_collected)
```

**Solana auth note:** The traveler signs the transaction. Anchor's `Signer` type verifies
this. The SPL Token `transfer` CPI requires the traveler's token account and the traveler
as the authority — both are validated by the token program. The traveler signs one
transaction that authorizes everything.

### Flight Data Collection (FlightDataFetcher, every 2 hours)

```
FlightDataFetcher (off-chain)
    │
    ├─► reads ActiveFlightList account via Solana RPC
    │
    ├─► for each flight in NotInitiated status:
    │       calls AeroAPI → gets estimated arrival time
    │       signs + submits tx:
    │       insurance_program.set_estimated_arrival(flight_id, date, eta)
    │           └─► NotInitiated → Active
    │
    └─► for each flight in Active status
        where estimated_arrival_time + 1 hour < now:
            calls AeroAPI → gets actual flight status
            │
            ├─ Landed → signs + submits tx:
            │    insurance_program.set_landed(flight_id, date, actual_arrival_time)
            │        └─► Active → Landed
            │
            ├─ Cancelled → signs + submits tx:
            │    insurance_program.set_cancelled(flight_id, date)
            │        └─► Active → Cancelled
            │
            └─ Still in flight / HTTP error → skip, retry next cycle
```

### Classification + Settlement (FlightProcessor, every 10 minutes)

```
FlightProcessor (off-chain) → signs + submits tx:
    insurance_program.process_flights(keeper_address)
        │
        ├─► keeper Signer check
        │
        ├─► Phase 1: Classification
        │   for each flight in Landed or Cancelled status:
        │       ├─ Cancelled
        │       │       FlightData.status = ToBeSettledCancelled
        │       └─ Landed
        │               read FlightPool.delay_hours
        │               read FlightData.estimated_arrival_time, actual_arrival_time
        │               delay = actual - estimated
        │               ├─ delay >= delay_hours → ToBeSettledDelayed
        │               └─ delay <  delay_hours → ToBeSettledOnTime
        │
        ├─► Phase 2: Settlement
        │   for each flight in ToBeSettled* status:
        │       ├─ ToBeSettledOnTime
        │       │       CPI → SPL Token: transfer pool premiums to vault token account
        │       │       CPI → vault.record_premium_income(premium * buyer_count)
        │       │       CPI → vault.decrease_locked(payoff * buyer_count)
        │       │       FlightData.status = Settled
        │       │       remove from ActiveFlightList
        │       │
        │       ├─ ToBeSettledDelayed / ToBeSettledCancelled
        │       │       payout = (payoff - premium) * buyer_count
        │       │       CPI → vault.send_payout(pool_token_account, payout)
        │       │       CPI → vault.decrease_locked(payoff * buyer_count)
        │       │       FlightPool.claim_expiry = now + claim_expiry_window
        │       │       FlightData.status = Settled
        │       │       remove from ActiveFlightList
        │       │       update total_payouts_distributed
        │       │
        │       (on-time pools can be closed after settlement to reclaim SOL rent)
        │
        ├─► CPI → vault.process_withdrawal_queue()
        └─► CPI → vault.snapshot()
```

### Payout Math (unchanged from Soroban)

```
premium = $10, payoff = $50, 2 buyers

On purchase:
  Pool token account holds: $10 * 2 = $20 (locked premiums)
  Vault locks:              $50 * 2 = $100 (collateral for max liability)

If delayed/cancelled:
  Vault sends: ($50 - $10) * 2 = $80 to pool token account
  Pool now holds: $20 + $80 = $100
  Each buyer claims: $50

If on time:
  Pool sends: $20 to vault token account (premium income / underwriter yield)
  Vault unlocks: $100 (collateral released)
```

### Traveler Claiming a Payout

```
Traveler → insurance_program.claim(flight_id, date)
    ├─► traveler is Signer
    ├─► load BuyerRecord PDA — panic if not found (no policy)
    ├─► panic if BuyerRecord.claimed == true
    ├─► load FlightPool PDA — panic if status != SettledDelayed or SettledCancelled
    ├─► panic if Clock::get()?.unix_timestamp > pool.claim_expiry
    ├─► BuyerRecord.claimed = true
    └─► CPI → SPL Token: transfer(pool_token_account, traveler_ata, payoff)
        (pool PDA signs via invoke_signed with pool seeds)
```

### Sweeping Expired Claims to RecoveryPool

```
Anyone → insurance_program.sweep_expired(flight_id, date)
    ├─► caller is Signer (pays tx fee)
    ├─► panic if Clock::get()?.unix_timestamp <= pool.claim_expiry
    ├─► calculate remaining USDC in pool token account
    └─► CPI → SPL Token: transfer(pool_token_account, recovery_token_account, remainder)
        (pool PDA signs via invoke_signed)
        └─► RecoveryPool.total_recovered += remainder
```

After sweep, the FlightPool PDA and its token account can be **closed** to reclaim the
SOL rent deposit. This is a natural cleanup — unlike Soroban's TTL-based archival, Solana
accounts are explicitly closed and the rent is returned.

### Underwriter Withdrawing Capital (FIFO)

```
── Immediate path ──────────────────────────────────────────────────────────

Underwriter → vault_program.redeem(shares)
    ├─► underwriter is Signer
    ├─► max_redeem check: panic if shares > free_capital equivalent
    ├─► CPI → SPL Token: burn shares from underwriter's share token account
    ├─► decrease total_managed_assets
    └─► CPI → SPL Token: transfer(vault_token_account, underwriter_usdc_ata, assets)

── Queued path (FIFO — used when free_capital < redemption) ────────────────

Underwriter → vault_program.request_withdrawal(shares)
    ├─► underwriter is Signer
    ├─► panic if shares == 0 or shares > balance
    ├─► request queued in WithdrawalQueue as (caller, shares, timestamp)
    └─► shares reserved (not yet burned)

                (queue drains during process_flights via CPI to process_withdrawal_queue)
                    ├─► walks FIFO list in order
                    ├─► for each request: if solvency allows, convert shares → USDC
                    └─► ClaimableBalance PDA: amount += redemption

Underwriter → vault_program.collect()
    ├─► underwriter is Signer
    ├─► amount = ClaimableBalance.amount
    ├─► panic if zero
    ├─► ClaimableBalance.amount = 0
    ├─► total_managed_assets -= amount
    └─► CPI → SPL Token: transfer(vault_token_account, underwriter_usdc_ata, amount)
```

---

## Solvency Invariant

**Never sell insurance unless we have money to cover it.** Before every insurance purchase:

```
vault.free_capital() >= (total_locked + new_payoff) * solvency_ratio / 100
```

- `free_capital()` = `total_managed_assets` − `locked_capital`
- `locked_capital` increases by `payoff` on each purchase; decreases by `payoff * buyer_count`
  on settlement
- `solvency_ratio` defaults to 100 — fully collateralised
- Underwriter withdrawals that would breach `locked_capital` are queued, not rejected
- Queue processor re-checks solvency at fulfillment time

---

## Program Relationships

```
         Owner / Admins
               │
               ▼
      governance_program ─── default terms + per-route overrides
               │  resolved terms (CPI read)
               ▼
      insurance_program
      (Controller + FlightPool + Oracle + Recovery)
          │         │
    ┌─────┘         └──────────────┐
    ▼                              ▼
vault_program              Off-chain Executor
(RVS shares + USDC)       ┌───────────────────┐
    │                      │ Cron #1: Fetcher  │ ← authorized_oracle
    │                      │ Cron #2: Processor│ ← authorized_keeper
    │                      └───────────────────┘
    │
    │          SPL Token Program
    │          (USDC transfers, RVS mint/burn)
    │
Underwriters ──deposit──► vault_program
                               └── collect() ◄── Underwriters (FIFO queue)

Travelers ──buy_insurance──► insurance_program
                                   └── claim() ◄── Travelers (after settlement)
                                   └── sweep_expired() ──► RecoveryPool
```

---

## Access Control

| Guard | Program | Instruction(s) | Mechanism |
|-------|---------|-----------------|-----------|
| Owner-only | governance_program | `set_defaults`, `add_admin`, `remove_admin` | `has_one = owner` + `Signer` |
| Owner or Admin | governance_program | `whitelist_route`, `disable_route`, `update_route_terms` | Owner check OR AdminRecord lookup + `Signer` |
| Owner-only | insurance_program | `set_authorized_oracle`, `set_authorized_keeper`, config updates | `has_one = owner` + `Signer` |
| Authorized oracle | insurance_program | `set_estimated_arrival`, `set_landed`, `set_cancelled` | `Signer` + `config.authorized_oracle` check |
| Authorized keeper | insurance_program | `process_flights` | `Signer` + `config.authorized_keeper` check |
| Controller PDA | vault_program | `increase_locked`, `decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot` | `has_one = controller` + PDA signer seeds |
| Owner-only | vault_program | `set_controller` (once) | `has_one = owner` + `is_controller_set == false` |
| Owner-only | RecoveryPool | `withdraw_recovery` | `has_one = owner` + `Signer` |
| Traveler | insurance_program | `buy_insurance` | `Signer` (traveler signs tx) |
| Traveler with policy | insurance_program | `claim` | `Signer` + BuyerRecord exists + not claimed |
| Anyone | insurance_program | `sweep_expired` | `Signer` (for tx fee) + expiry check |

**`authorized_keeper`:** The executor backend's Solana keypair is registered in
InsuranceConfig. Anchor verifies the executor signed the transaction. No unauthorized
address can trigger processing. The address is **owner-updatable** for zero-downtime migration.

**`authorized_oracle`** is owner-updatable for backend migration without redeployment.

**`controller` on VaultState** is set once via `set_controller()`. Subsequent calls panic.
This is the insurance program's config PDA, which signs vault CPIs with its seeds.

**Insurance program never holds user funds.** USDC flows traveler → pool token account
via SPL Token transfer authorized by the traveler's signature.

---

## Security

### Reentrancy

Solana's runtime prevents a program from being re-entered during its own execution within
a single transaction. CPI calls to other programs are allowed but the calling program's
accounts are locked during the CPI. This eliminates most reentrancy vectors.
Defense-in-depth: all state mutations are performed before external CPIs.

### Share Price Manipulation (vault_program)

The virtual share offset (`10^3`) combined with `total_managed_assets` being an internal
counter (not raw balance) provides two layers of defense against inflation attacks:
1. Direct USDC transfers to the vault token account do not affect share price calculations.
2. The virtual offset ensures the denominator is always large enough that rounding cannot
   steal depositor shares.

### Oracle Trust Model

1. Only `authorized_oracle` can write flight data to FlightData accounts.
2. Status is forward-only — cannot regress through the state machine.
3. Data updates for unregistered flights are rejected (FlightData PDA must exist).
4. Read functions return `NotInitiated` status as safe fallback for missing entries.
5. Oracle is decoupled from settlement — can only write data, not trigger payouts or
   classify outcomes.

**Trust assumption depends on executor backend.** With a centralized cron, trust the
server operator. The architecture is designed so that the trust model **improves over time**
without touching the programs — only the authorized address changes.

### Account Validation (Solana-specific)

Anchor provides automatic account validation:
- **Owner checks**: `Account<'info, T>` automatically verifies the account is owned by the
  correct program. Prevents fake account injection.
- **Discriminator checks**: Each account type has an 8-byte discriminator. Anchor verifies
  it on deserialization. Prevents type confusion attacks.
- **PDA validation**: `seeds` + `bump` constraints verify the account address is correctly
  derived. Prevents PDA substitution.
- **Signer checks**: `Signer<'info>` enforces the account signed the transaction.

### Missing Signer / Owner Checks

All authority-gated instructions use Anchor's type system (`Signer`, `has_one`, `constraint`)
rather than manual runtime checks. This makes missing-check vulnerabilities a compile-time
error rather than a runtime bug.

### Arbitrary CPI Prevention

All CPI targets use typed `Program<'info, T>` accounts (e.g., `Program<'info, Token>`),
which verify the program ID at runtime. No instruction accepts an arbitrary program address
as a parameter.

### Front-Running / MEV

Solana has active MEV via Jito. A mempool watcher could theoretically front-run
`buy_insurance`, but this is a legitimate purchase — it doesn't extract value from the
protocol. The solvency check and fixed premium prevent sandwich attacks.

### Known Limitations

- **Oracle manipulation** — single authorized executor; trust model depends on backend.
  Multi-oracle aggregation is a future enhancement.
- **Correlated event risk** — simultaneous delays across many flights are protected only
  by `solvency_ratio`. At 100% the vault covers all; underwriters bear correlated risk.
- **No per-underwriter capital attribution** — `locked_capital` is pool-level.
- **Classification + settlement lag** — up to 10 minutes between oracle data write and
  settlement (FlightProcessor runs every 10 minutes).
- **Executor availability** — depends on backend choice and its uptime guarantees.
- **Account limits** — `process_flights` handles at most `MAX_FLIGHTS_PER_TX` flights
  per transaction due to compute budget and account limits. The cron submits multiple
  transactions for large batches.
- **ActiveFlightList size** — stored as a Vec in one account. If the protocol scales to
  thousands of simultaneous flights, this should migrate to an indexer-based pattern.
- **WithdrawalQueue size** — stored as a Vec. If the queue grows very large, consider
  per-request PDA accounts instead.

---

## User Flows

### Traveler

**Buy insurance:**
1. Frontend calls `governance_program` view: check route is whitelisted.
2. Frontend reads vault free_capital: check solvency.
3. Wallet signs transaction calling `insurance_program.buy_insurance(flight_id, origin, dest, date)`.
   Anchor handles USDC transfer authorization within the same signature.

**Claim payout (if delayed or cancelled):**
After settlement, call `insurance_program.claim(flight_id, date)`. Must claim before expiry.

**If on time:** No action needed. Premium becomes underwriter yield.

**View my policies:**
Frontend calls `getProgramAccounts` with memcmp filter on BuyerRecord's `buyer` field.
One RPC call returns all policies for the connected wallet.

### Underwriter

**Deposit:** Sign transaction calling `vault_program.deposit(usdc_amount)`.
Shares (RVS tokens) minted proportional to `total_managed_assets / total_supply`.

**Withdraw (immediate):** `vault_program.redeem(shares)` — executes when `free_capital >= redemption`.

**Withdraw (queued FIFO):** `vault_program.request_withdrawal(shares)` — enqueues when
capital is locked. Queue drains FIFO after each settlement cycle. Call `vault_program.collect()`
to pull USDC.

**Cancel queued request:** `vault_program.cancel_withdrawal(queue_index)`.

### Function Reference

| Action | Who | Function |
|--------|-----|----------|
| Set global defaults | Owner | `governance.set_defaults(premium, payoff, delay_hours)` |
| Whitelist route | Owner / Admin | `governance.whitelist_route(...)` |
| Deposit capital | Underwriter | `vault.deposit(usdc_amount)` |
| Withdraw immediately | Underwriter | `vault.redeem(shares)` |
| Withdraw (queued) | Underwriter | `vault.request_withdrawal(shares)` |
| Collect credited USDC | Underwriter | `vault.collect()` |
| Cancel queued withdrawal | Underwriter | `vault.cancel_withdrawal(index)` |
| Buy insurance | Traveler | `insurance.buy_insurance(flight_id, origin, dest, date)` |
| Claim payout | Traveler | `insurance.claim(flight_id, date)` |
| Sweep expired claims | Anyone | `insurance.sweep_expired(flight_id, date)` |
| Update keeper address | Owner | `insurance.set_authorized_keeper(new_keeper)` |
| Update oracle address | Owner | `insurance.set_authorized_oracle(new_oracle)` |

---

## dApp Frontend — Framework-Kit

The frontend is built using **framework-kit** (`@solana/client` + `@solana/react-hooks`)
with wallet-standard connection and Anchor IDL-generated TypeScript clients.

### Project Structure

```
sentinel_solana/
├── programs/                      # Anchor programs (Rust)
│   ├── governance/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   ├── vault/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── insurance/
│       ├── Cargo.toml
│       └── src/lib.rs
├── app/                           # Frontend (React + Next.js or Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── TravelerDashboard.tsx
│   │   │   ├── UnderwriterDashboard.tsx
│   │   │   ├── AdminPanel.tsx
│   │   │   ├── RouteManager.tsx
│   │   │   ├── PoolStatus.tsx
│   │   │   └── VaultMetrics.tsx
│   │   ├── hooks/
│   │   │   ├── useInsurance.ts
│   │   │   ├── useVault.ts
│   │   │   └── useGovernance.ts
│   │   ├── idl/                   # Anchor-generated IDL files
│   │   │   ├── governance.json
│   │   │   ├── vault.json
│   │   │   └── insurance.json
│   │   └── App.tsx
│   └── package.json
├── tests/                         # Anchor integration tests (TypeScript)
│   ├── governance.test.ts
│   ├── vault.test.ts
│   ├── insurance.test.ts
│   └── e2e.test.ts
├── executor/                      # Off-chain executor (modular backend)
│   ├── src/
│   │   ├── core/
│   │   │   ├── flight_data_fetcher.ts
│   │   │   ├── flight_processor.ts
│   │   │   ├── solana_client.ts
│   │   │   ├── aeroapi_client.ts
│   │   │   └── types.ts
│   │   ├── backends/
│   │   │   └── cron/
│   │   │       ├── index.ts
│   │   │       ├── config.ts
│   │   │       └── health.ts
│   │   └── scripts/
│   │       ├── rotate_keys.ts
│   │       └── check_health.ts
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── migrations/                    # Anchor deploy/migration scripts
│   └── deploy.ts
├── spec/                          # Architecture and planning docs
├── Anchor.toml                    # Anchor workspace config
├── Cargo.toml                     # Rust workspace root
└── README.md
```

### Anchor IDL Clients

Anchor generates typed TypeScript clients from the program IDL:

```typescript
import { Program } from '@coral-xyz/anchor';
import { Insurance } from '../idl/insurance';

// Buy insurance — wallet signs one transaction
const tx = await program.methods
  .buyInsurance(flightId, origin, dest, new BN(date))
  .accounts({
    pool: poolPda,
    buyerRecord: buyerPda,
    flightData: flightDataPda,
    traveler: wallet.publicKey,
    travelerTokenAccount: travelerAta,
    poolTokenAccount: poolTokenAta,
    insuranceConfig: configPda,
    vaultState: vaultStatePda,
    vaultProgram: VAULT_PROGRAM_ID,
    governanceConfig: govConfigPda,
    routeAccount: routePda,
    governanceProgram: GOVERNANCE_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

### Per-User Policy Querying

```typescript
// Get all policies for the connected wallet — solves the "MyPolicies" bug from Soroban
const buyerRecords = await connection.getProgramAccounts(INSURANCE_PROGRAM_ID, {
  filters: [
    { memcmp: { offset: 0, bytes: bs58.encode(BUYER_RECORD_DISCRIMINATOR) } },
    { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
  ],
});

// Decode each record
const policies = buyerRecords.map(({ account }) =>
  program.coder.accounts.decode('BuyerRecord', account.data)
);
```

---

## Mock USDC (Testing)

For devnet and localnet testing, a mock USDC mint is deployed:

```bash
# Create mock USDC with 6 decimals (matches real USDC)
spl-token create-token --decimals 6

# Create token accounts and mint test tokens
spl-token create-account <MOCK_MINT>
spl-token mint <MOCK_MINT> 1000000000   # 1000 USDC
```

In Anchor tests (LiteSVM), mock USDC is created programmatically during test setup.
The program is agnostic — it accepts any SPL Token mint as USDC via the `usdc_mint` config.
On mainnet, configure the real USDC mint address.

---

## Upgradeability

All three programs are deployed as **upgradeable** during development:

```bash
# Deploy with upgrade authority (default)
anchor deploy

# Later: upgrade program code (accounts untouched)
anchor upgrade target/deploy/insurance.so --program-id <PROGRAM_ID>

# Transfer authority to multisig before mainnet
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <MULTISIG>

# Optional: make immutable after audit (irreversible)
solana program set-upgrade-authority <PROGRAM_ID> --final
```

**Account schema changes** during upgrades:
- Add new fields at the end of account structs + use `realloc` to extend existing accounts
- Store a `version: u8` field if breaking changes are needed
- Write a one-time migration instruction to convert old → new layout

**Plan:** Upgradeable during dev/testnet → transfer to Squads multisig for mainnet → optional freeze after security audit.
