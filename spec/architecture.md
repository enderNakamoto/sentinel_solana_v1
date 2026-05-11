# Architecture

## System Overview

Decentralised flight delay insurance on **Solana**. **Underwriters** deposit capital to back
claims; **travelers** pay a premium to receive a fixed payoff if their flight is delayed
beyond a configurable threshold (per-route `delay_hours`). All programs are written in
**Rust** using the **Anchor** framework and compiled to Solana BPF bytecode.

The system requires four off-chain cron jobs to keep ticking:

| Cron | Name | Frequency | Purpose |
|------|------|-----------|---------|
| #1 | **FlightDataFetcher** | Every 2 hours | Fetches flight data from AeroAPI, writes estimated/actual arrival times to `FlightData` accounts on `oracle_aggregator_program`. Signed by `authorized_oracle`. |
| #2 | **FlightClassifier** | Every 1 hour | Calls `controller_program.classify_flights()` — reads FlightData + FlightPool, decides `ToBeSettled*`, writes via CPI to oracle. No money movement. Signed by `authorized_keeper`. |
| #3 | **SettlementExecutor** | Every 5 minutes | Calls `controller_program.execute_settlements()` — executes money movement, transitions FlightData to `Settled` via CPI to oracle, drains withdrawal queue, snapshots share price. Signed by `authorized_keeper`. |
| #4 | **RouteRepricer** *(Phase 23)* | On-demand (daily target) | For each whitelisted `RouteAccount`: fetches a baseline premium from the Phase 22 agent (XGBoost on Kaggle 2008 flight delays), asks Grok (xAI Live Search) for a geopolitical risk verdict, then applies `update_route_terms` / `disable_route` / idempotent `whitelist_route` re-enable. Signed by `GovernanceConfig.owner`. Centralised POC. |

These run inside a modular **Executor Backend** that is fully swappable. The programs
enforce authorization via Anchor `Signer` checks against stored authorized addresses — they
don't know or care what backend is calling them. Swapping from a centralized cron to any
future keeper is a single owner transaction per program. No redeployment needed.

All payouts and withdrawals are **pull-based**: funds are credited on-chain and actors
claim them explicitly. Insurance is never sold unless the system has enough capital to
cover the payout — the protocol is **always solvent**.

The flight pool program owns a single **pool treasury** token account that holds all
in-flight premiums and pending payouts across every flight. Per-flight liability is tracked
on `FlightPool` PDAs (premium × buyer_count, payoff × buyer_count, claimed count) — no
per-flight token accounts. The treasury also holds expired-claim funds, accounted via a
`recovered_balance` counter on the flight pool config. The controller program orchestrates
but does not custody flight funds. The oracle aggregator program holds flight data only —
no funds ever touch it.

The frontend dApp uses **framework-kit** (`@solana/client` + `@solana/react-hooks`) with
wallet-standard connection, and Anchor IDL-generated TypeScript clients for each program.

---

## Program Architecture

The system is split into **5 Anchor programs**, each with a single domain responsibility:

| Program | Responsibility | Why separate |
|---------|---------------|--------------|
| `governance_program` | Route management, terms, admin whitelist | Independent admin concern, rarely called |
| `vault_program` | Capital management, share token, withdrawal queue | Underwriters interact directly, independent upgrade cycle |
| `flight_pool_program` | Per-flight pool registry, buyer records, shared pool treasury, claim, sweep, recovery accounting | Owns user-facing flight funds; isolated audit surface; iterates independently of controller logic |
| `oracle_aggregator_program` | FlightData accounts; oracle-authority writes (estimated arrival, landed, cancelled) | Authority isolation — oracle keypair compromise cannot trigger payouts; mirrors Pyth/Switchboard pattern; swappable feed |
| `controller_program` | Orchestration: buy, classify, settle. Holds `ControllerConfig` + `ActiveFlightList` | Pure orchestration — never custodies funds; clean settlement state machine; reads oracle by passing FlightData accounts; writes oracle via CPI for state transitions |

**CPI map:**

```
controller_program ──CPI──► governance_program        (read route terms, check whitelist)
controller_program ──CPI──► flight_pool_program       (register pool, add buyer, settle_*)
controller_program ──CPI──► vault_program             (lock/unlock, payouts, premium income, queue, snapshot)
controller_program ──CPI──► oracle_aggregator_program (init_flight_data, set_to_be_settled, set_settled)
flight_pool_program ──CPI──► SPL Token                (premium in, claim out)
vault_program       ──CPI──► flight_pool_program      (send_payout target = pool treasury)
vault_program       ──CPI──► SPL Token                (USDC transfers, mint/burn RVS shares)
```

**Read access (no CPI required):** `controller_program` reads `FlightData` accounts during `classify_flights` and `execute_settlements` by passing them in as `Account<'info, FlightData>` with an `owner = oracle_aggregator_program` constraint. CPIs to oracle are only needed for state transitions written by the controller.

`flight_pool_program` exposes controller-gated instructions (`register_pool`, `add_buyer`,
`settle_on_time`, `settle_delayed`, `settle_cancelled`) that only `controller_program`'s
config PDA can sign for, using the same `set_controller` pattern as the vault.

`oracle_aggregator_program` exposes consumer-gated instructions (`init_flight_data`,
`set_to_be_settled`, `set_settled`) that only `controller_program`'s config PDA can sign for,
via a one-time `set_authorized_consumer` wiring step.

---

## Token Setup

**Stable side — Palm USD (PUSD), Token-2022.** As of Phase 24, the unit of account is **Palm
USD (PUSD)** on the **Token-2022** program (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
Mainnet mint: `CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s` (MetadataPointer + TokenMetadata
extensions only — no transfer fee, no transfer hook, no permanent delegate, no freeze). On
devnet / Surfpool / LiteSVM the protocol uses a **mock PUSD** mirror at
`F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE` — same Token-2022 program, base mint layout
only, no extensions. All five programs handle the stable mint through Anchor's
`token_interface` module (`Interface<TokenInterface>` + `InterfaceAccount<Mint>` /
`InterfaceAccount<TokenAccount>`) and call `transfer_checked` for SPL transfers so the same
binary works against classic SPL or Token-2022 mints.

**Vault shares (RVS) — classic SPL Token.** A new SPL Token mint (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
created by `vault_program` during initialization at the PDA `[b"share_mint_v2"]`. The vault
state PDA (`[b"vault_state_v2"]`) is the mint authority. Shares are minted on deposit and
burned on redemption. Share-side transfers use the concrete `Program<Token>` (not the
interface) and standard `token::transfer` / `mint_to` / `burn`.

**Why two token programs.** The stable side needs Token-2022 to interoperate with PUSD's
real mainnet mint. The share side stays on classic SPL because (a) RVS is a Sentinel-native
mint with no metadata or extension requirements, and (b) keeping it on classic SPL avoids
forcing the vault PDA to act as a Token-2022 authority across the protocol's most
performance-sensitive path (deposit / redeem / mint / burn). Anchor account constraints
must pass `associated_token::token_program = token_program` explicitly when an ATA is
derived against Token-2022 — otherwise Anchor defaults to classic SPL and the constraint
fails at runtime.

**Pre-Phase-24 baseline.** Before Phase 24 the protocol used a classic-SPL mock USDC mint
(`epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K`). That mint still exists on devnet but is
no longer referenced by the deployed binaries; rollback to it requires reverting to
the `pre-pusd-migration` git tag — see `pre_pusd_migration.md` at the repo root.

All token amounts are `u64` with 6 decimal places (1 PUSD = 1,000,000 units).

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
  on first purchase (see controller_program).

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
    pub controller: Pubkey,             // controller_program's ControllerConfig PDA (set once)
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

// Controller-only (CPI from controller_program)
fn increase_locked(ctx, amount: u64) -> Result<()>;
fn decrease_locked(ctx, amount: u64) -> Result<()>;
fn send_payout(ctx, amount: u64) -> Result<()>;              // recipient = flight_pool's pool_treasury
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

### flight_pool_program

The flight pool registry. Owns per-flight money state, the shared pool treasury, buyer
records, claim/sweep paths, and recovery accounting. The insurance program drives every
write-path mutation (register, add_buyer, settle_*) via CPI; travelers and owner call the
program directly for `claim`, `sweep_expired`, and `withdraw_recovered`.

A single program-owned **pool treasury** token account holds all USDC for all in-flight
flights — premiums in, payouts out, expired-claim funds retained. Per-flight money state
is tracked entirely in `FlightPool` PDA fields; no per-flight token accounts.

#### Config Account

```rust
/// Flight pool program configuration
/// PDA seeds: [b"flight_pool_config"]
#[account]
pub struct FlightPoolConfig {
    pub owner: Pubkey,
    pub controller: Pubkey,             // controller_program's ControllerConfig PDA (set once)
    pub usdc_mint: Pubkey,
    pub pool_treasury: Pubkey,          // shared USDC token account for all flights
    pub recovered_balance: u64,         // expired-claim USDC owed to owner
    pub is_controller_set: bool,
    pub bump: u8,
}
```

The pool treasury authority is a PDA derived from `[b"pool_treasury"]` within
`flight_pool_program`. The program signs treasury outflows via `invoke_signed` with that
seed.

#### FlightPool Accounts

Each pool is a PDA account initialized on first purchase for a `(flight_id, date)` pair.
Terms (premium, payoff, delay_hours) are locked at creation.

```rust
/// One per (flight_id, date) — money state only; USDC lives in the shared pool treasury.
/// PDA seeds: [b"pool", flight_id.as_bytes(), &date.to_le_bytes()]
#[account]
pub struct FlightPool {
    pub flight_id: String,          // max 10 chars
    pub date: u64,                  // unix epoch day
    pub premium: u64,               // locked at creation (USDC units)
    pub payoff: u64,                // locked at creation (USDC units)
    pub delay_hours: u32,           // locked at creation
    pub buyer_count: u32,
    pub claimed_count: u32,         // travelers who have collected payout
    pub status: SettlementStatus,
    pub claim_expiry: i64,          // unix timestamp, set on settlement
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
const buyerRecords = await connection.getProgramAccounts(FLIGHT_POOL_PROGRAM_ID, {
  filters: [
    { memcmp: { offset: 0, bytes: BUYER_RECORD_DISCRIMINATOR } },
    { memcmp: { offset: 8, bytes: walletAddress.toBase58() } },
  ],
});
```

#### Instructions

**Initialization:**

```rust
fn initialize(ctx, usdc_mint: Pubkey) -> Result<()>;
fn set_controller(ctx, controller: Pubkey) -> Result<()>;  // set once, panics on second call
```

**Controller-only (CPI from controller_program):**

```rust
/// Creates a new FlightPool PDA with locked terms. Called by controller_program on the
/// first buy_insurance for a (flight_id, date) pair. Reverts if pool already exists.
fn register_pool(ctx, flight_id: String, date: u64,
                 premium: u64, payoff: u64, delay_hours: u32) -> Result<()>;

/// Records a buyer on an existing FlightPool, creates BuyerRecord PDA, transfers
/// premium from traveler ATA → pool treasury (traveler signature passes through CPI).
fn add_buyer(ctx, flight_id: String, date: u64) -> Result<()>;

/// Marks pool SettledOnTime and forwards (premium * buyer_count) to vault token account
/// (caller passes vault token account; transfer signed by pool_treasury PDA).
fn settle_on_time(ctx, flight_id: String, date: u64) -> Result<()>;

/// Marks pool SettledDelayed; sets claim_expiry. No transfer here — vault.send_payout
/// (called separately by controller_program in the same tx) tops up the treasury.
fn settle_delayed(ctx, flight_id: String, date: u64, claim_expiry: i64) -> Result<()>;

/// Marks pool SettledCancelled; sets claim_expiry. Same payout path as delayed.
fn settle_cancelled(ctx, flight_id: String, date: u64, claim_expiry: i64) -> Result<()>;
```

**Traveler / public:**

```rust
/// Traveler claims their payout after delayed/cancelled settlement.
/// Verifies BuyerRecord, status, expiry. Increments claimed_count. Transfers payoff
/// from pool_treasury → traveler ATA (signed by pool_treasury PDA seeds).
fn claim(ctx, flight_id: String, date: u64) -> Result<()>;

/// Anyone can sweep expired unclaimed payouts. Increments recovered_balance counter;
/// no token transfer (funds stay in pool treasury). Idempotent.
fn sweep_expired(ctx, flight_id: String, date: u64) -> Result<()>;
```

**Owner:**

```rust
/// Owner withdraws expired-claim funds from the pool treasury.
/// Decrements config.recovered_balance; CPI transfers from treasury → owner ATA.
fn withdraw_recovered(ctx, amount: u64) -> Result<()>;
```

#### Authorization

| Action | Who | Mechanism |
|--------|-----|-----------|
| `set_controller` | Owner | `has_one = owner` + `is_controller_set == false` |
| `register_pool`, `add_buyer`, `settle_on_time`, `settle_delayed`, `settle_cancelled` | Controller (controller_program's ControllerConfig PDA) | `has_one = controller` on FlightPoolConfig + PDA signer seeds |
| `claim` | Traveler with policy | `Signer` + BuyerRecord existence + `claimed == false` + status & expiry checks |
| `sweep_expired` | Anyone | `Signer` (for tx fee) + expiry check |
| `withdraw_recovered` | Owner | `has_one = owner` |

The insurance program signs CPIs to flight_pool_program using its own config PDA's signer
seeds — same pattern as the vault.

---

### oracle_aggregator_program

The flight data feed. Owns `FlightData` accounts and is the only program the
`authorized_oracle` keypair can sign for. Holds zero funds. Reads are free (controller
passes FlightData accounts in as readonly); writes are split between the oracle keypair
(raw flight statuses) and the controller's PDA (settlement-pipeline transitions).

#### Config Account

```rust
/// PDA seeds: [b"oracle_config"]
#[account]
pub struct OracleConfig {
    pub owner: Pubkey,
    pub authorized_oracle: Pubkey,      // FlightDataFetcher's keypair
    pub authorized_consumer: Pubkey,    // controller_program's ControllerConfig PDA (set once)
    pub is_consumer_set: bool,
    pub bump: u8,
}
```

#### FlightData Accounts

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
| `NotInitiated` | FlightData created, no oracle data yet | `init_flight_data` (CPI from controller on first buy) |
| `Active` | Estimated arrival time stored | `set_estimated_arrival` — FlightDataFetcher (oracle key) |
| `Landed` | Flight has landed, actual arrival stored | `set_landed` — FlightDataFetcher (oracle key) |
| `Cancelled` | Flight was cancelled | `set_cancelled` — FlightDataFetcher (oracle key) |
| `ToBeSettledOnTime` | Classified as on-time, awaiting money movement | `set_to_be_settled` — controller PDA (CPI from `classify_flights`) |
| `ToBeSettledDelayed` | Classified as delayed, awaiting money movement | `set_to_be_settled` — controller PDA (CPI from `classify_flights`) |
| `ToBeSettledCancelled` | Classified as cancelled, awaiting money movement | `set_to_be_settled` — controller PDA (CPI from `classify_flights`) |
| `Settled` | Settlement complete, money moved | `set_settled` — controller PDA (CPI from `execute_settlements`) |

#### Instructions

**Initialization (owner-only):**

```rust
fn initialize(ctx, authorized_oracle: Pubkey) -> Result<()>;
fn set_authorized_oracle(ctx, new_oracle: Pubkey) -> Result<()>;
/// One-time wiring: stores controller's ControllerConfig PDA as the consumer.
/// Reverts if already set. Mirrors flight_pool's set_controller pattern.
fn set_authorized_consumer(ctx, consumer: Pubkey) -> Result<()>;
```

**Consumer (CPI from controller, signed by ControllerConfig PDA):**

```rust
/// Creates FlightData PDA in NotInitiated. Called by controller on first buy.
fn init_flight_data(ctx, flight_id: String, date: u64) -> Result<()>;

/// Landed/Cancelled → ToBeSettled*. Called by controller's classify_flights.
fn set_to_be_settled(ctx, flight_id: String, date: u64,
                     new_status: FlightStatus) -> Result<()>;

/// ToBeSettled* → Settled. Called by controller's execute_settlements.
fn set_settled(ctx, flight_id: String, date: u64) -> Result<()>;
```

**Oracle (FlightDataFetcher cron, signed by `authorized_oracle`):**

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

#### Authorization

| Action | Who | Mechanism |
|--------|-----|-----------|
| `set_estimated_arrival`, `set_landed`, `set_cancelled` | Authorized oracle | `Signer` + `config.authorized_oracle` check |
| `init_flight_data`, `set_to_be_settled`, `set_settled` | Authorized consumer (controller PDA) | `has_one = authorized_consumer` on `OracleConfig` + `invoke_signed` from controller |
| `set_authorized_oracle`, `set_authorized_consumer` | Owner | `has_one = owner` on `OracleConfig` |

The controller signs CPIs to `oracle_aggregator_program` using its own `ControllerConfig`
PDA's signer seeds.

---

### controller_program

The orchestrator. Owns `ControllerConfig`, `ActiveFlightList`, and the buy / classify /
settle pipeline. Holds zero user funds — every money movement is delegated to
`flight_pool_program` (treasury) or `vault_program` (capital). FlightData lives on
`oracle_aggregator_program`; the controller reads it (account passing, owner check) and
writes settlement-pipeline state via CPI.

#### Config Account

```rust
/// PDA seeds: [b"controller_config"]
#[account]
pub struct ControllerConfig {
    pub owner: Pubkey,
    pub authorized_keeper: Pubkey,      // FlightClassifier + SettlementExecutor's keypair
    pub governance_program: Pubkey,
    pub vault_program: Pubkey,
    pub vault_state: Pubkey,            // vault_program's VaultState PDA
    pub flight_pool_program: Pubkey,
    pub flight_pool_config: Pubkey,     // flight_pool_program's FlightPoolConfig PDA
    pub oracle_program: Pubkey,         // oracle_aggregator_program ID
    pub oracle_config: Pubkey,          // oracle_aggregator_program's OracleConfig PDA
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

Note: `authorized_oracle` is **not** stored here — it lives on `oracle_aggregator_program`'s
`OracleConfig`. The controller has no oracle authority.

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

#### Instructions

**Initialization:**

```rust
fn initialize(ctx, config_params: InitializeParams) -> Result<()>;
fn set_authorized_keeper(ctx, new_keeper: Pubkey) -> Result<()>;
```

**Buy insurance (orchestration):**

```rust
/// Orchestrates a policy purchase. Holds no funds — premium goes through
/// flight_pool_program; collateral is locked in vault_program; FlightData is created
/// on oracle_aggregator_program.
///
/// Flow:
///   1. CPI → governance_program.is_route_whitelisted() — revert if not
///   2. CPI → governance_program.get_route_terms() — read resolved terms
///   3. Enforce min_lead_time — revert if departure too soon
///   4. If FlightPool doesn't exist (first buy for this flight_id, date):
///        - CPI → oracle_aggregator.init_flight_data(flight_id, date)
///            (creates FlightData PDA in NotInitiated; signed by ControllerConfig PDA)
///        - Add to ActiveFlightList
///        - CPI → flight_pool.register_pool(flight_id, date, premium, payoff, delay_hours)
///   5. Solvency check — revert if undercollateralised
///   6. CPI → flight_pool.add_buyer(flight_id, date)
///        (flight_pool internally transfers premium from traveler ATA → pool treasury,
///         creates BuyerRecord PDA — traveler's signature passes through transitively)
///   7. CPI → vault_program.increase_locked(payoff)
///   8. Update aggregate counters on ControllerConfig
fn buy_insurance(ctx, flight_id: String, origin: String, dest: String, date: u64) -> Result<()>;
```

**Classification (FlightClassifier cron, ~1h):**

```rust
/// Reads FlightData (account-passed, owner = oracle_aggregator_program) and FlightPool
/// (for delay_hours), decides ToBeSettled* status, writes via CPI to oracle.
///
/// For each flight in Landed or Cancelled status:
///   - Cancelled → set_to_be_settled(ToBeSettledCancelled)
///   - Landed → read FlightPool.delay_hours, compute delay
///     - delay >= delay_hours → set_to_be_settled(ToBeSettledDelayed)
///     - delay <  delay_hours → set_to_be_settled(ToBeSettledOnTime)
///
/// Processes up to MAX_FLIGHTS_PER_TX flights. One CPI to oracle per classified flight.
fn classify_flights(ctx) -> Result<()>;
```

**Settlement (SettlementExecutor cron, ~5min):**

```rust
/// Executes money movement on ToBeSettled* flights, transitions FlightData to Settled
/// via CPI to oracle, then drains the underwriter withdrawal queue and snapshots share
/// price.
///
/// Phase 1 — Settlement:
///   For each flight in ToBeSettled* status (FlightData passed in, owner-checked):
///     - ToBeSettledOnTime:
///         CPI flight_pool.settle_on_time(flight_id, date)
///             (transfers premium * buyer_count from pool_treasury → vault token account)
///         CPI vault.record_premium_income(premium * buyer_count)
///         CPI vault.decrease_locked(payoff * buyer_count)
///     - ToBeSettledDelayed / ToBeSettledCancelled:
///         CPI vault.send_payout((payoff - premium) * buyer_count)
///             (vault transfers to flight_pool's pool_treasury)
///         CPI vault.decrease_locked(payoff * buyer_count)
///         CPI flight_pool.settle_delayed_or_cancelled(flight_id, date, claim_expiry)
///     - CPI oracle_aggregator.set_settled(flight_id, date)
///     - Remove from ActiveFlightList
///
/// Phase 2 — Housekeeping:
///   CPI vault.process_withdrawal_queue()
///   CPI vault.snapshot()
///
/// Compute budget: ~4-5 CPIs per flight (vault + flight_pool + oracle); MAX_FLIGHTS_PER_TX
/// is ~2. Larger batches fan out across multiple transactions.
fn execute_settlements(ctx) -> Result<()>;
```

#### Authorization

| Action | Who | Mechanism |
|--------|-----|-----------|
| `buy_insurance` | Any traveler | Traveler is `Signer`; signature passes transitively through CPI to flight_pool for premium transfer |
| `classify_flights`, `execute_settlements` | Authorized keeper | `Signer` + `config.authorized_keeper` check |
| `set_authorized_keeper` | Owner | `has_one = owner` on `ControllerConfig` |

CPIs to `oracle_aggregator_program`, `flight_pool_program`, and `vault_program` are signed
with `ControllerConfig` PDA seeds.

---

## Off-Chain Executor Layer (Modular)

The protocol needs four off-chain cron jobs. All are **backend-agnostic** — the
programs enforce authorization via Anchor `Signer` checks against stored
authorized addresses (`authorized_oracle`, `authorized_keeper`,
`GovernanceConfig.owner`).

### Cron Job Summary

| Cron | Name | Frequency | On-chain target | Authorization |
|------|------|-----------|-----------------|---------------|
| #1 | **FlightDataFetcher** | Every 2 hours | `oracle_aggregator_program` (`set_estimated_arrival`, `set_landed`, `set_cancelled`) | `authorized_oracle` |
| #2 | **FlightClassifier** | Every 1 hour | `controller_program.classify_flights()` (CPIs to oracle to write `set_to_be_settled`) | `authorized_keeper` |
| #3 | **SettlementExecutor** | Every 5 minutes | `controller_program.execute_settlements()` (CPIs to vault, flight_pool, oracle) | `authorized_keeper` |
| #4 | **RouteRepricer** *(Phase 23)* | On-demand (daily target) | `governance_program` (`update_route_terms`, `disable_route`, idempotent `whitelist_route`) | `GovernanceConfig.owner` |

**Cron #4 trust assumption:** the RouteRepricer is a centralised POC. It depends
on two off-chain services it talks to before signing:
- The **Phase 22 premium-pricing agent** (`agent/`, FastAPI + XGBoost) for a
  baseline premium per route.
- **xAI Grok** (Live Search news mode + structured JSON outputs) for a
  geopolitical risk verdict (`ok` / `raise:<mult>` / `disable`).

The cron never throws on either dependency — agent failures skip the route,
Grok failures fall back to the safe-default verdict (`ok`, multiplier 1.0).
Re-enabling a previously-disabled route is gated to routes that THIS cron
disabled (tracked in the JSONL log) so the cron cannot unilaterally
override a manual `/admin` operator decision.

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
    │         oracle_aggregator_program.set_estimated_arrival(flight_id, date, eta)
    │       (NotInitiated → Active)
    │
    └─► Step B: For flights in Active status
        where estimated_arrival_time + 1 hour < now:
            calls AeroAPI for actual flight status
            │
            ├─ Landed → signs + submits tx:
            │    oracle_aggregator_program.set_landed(flight_id, date, actual_arrival_time)
            │    (Active → Landed)
            │
            ├─ Cancelled → signs + submits tx:
            │    oracle_aggregator_program.set_cancelled(flight_id, date)
            │    (Active → Cancelled)
            │
            └─ Still in flight / HTTP error → skip, retry next cycle
```

**Why 1 hour buffer?** The oracle only calls AeroAPI for flights that should have landed
at least 1 hour ago. This avoids unnecessary API calls for flights still in the air and
gives AeroAPI time to receive final landing data.

### Cron #2 — FlightClassifier (Keeper, every 1 hour)

Reads oracle data and transitions Landed/Cancelled flights into `ToBeSettled*`. No money
movement, no vault CPIs — purely state transitions on FlightData.

```
FlightClassifier → signs + submits tx:
    controller_program.classify_flights()
        │
        ├─► keeper Signer check
        │
        └─► for each flight with Landed or Cancelled status:
                ├─ Cancelled → FlightData.status = ToBeSettledCancelled
                │
                └─ Landed → read FlightPool.delay_hours
                            delay = actual_arrival - estimated_arrival
                            ├─ delay >= delay_hours → ToBeSettledDelayed
                            └─ delay <  delay_hours → ToBeSettledOnTime
```

Cheap per flight (no CPIs), so `MAX_FLIGHTS_PER_TX` can be high.

### Cron #3 — SettlementExecutor (Keeper, every 5 minutes)

Executes money movement on `ToBeSettled*` flights, drains the underwriter withdrawal queue,
and snapshots share price. Higher cadence than the classifier so payouts and underwriter
exits are prompt.

```
SettlementExecutor → signs + submits tx:
    controller_program.execute_settlements()
        │
        ├─► keeper Signer check
        │
        ├─► Phase 1: Settlement
        │   for each flight with ToBeSettled* status:
        │       │
        │       ├─ ToBeSettledOnTime
        │       │       CPI SPL Token: transfer (premium * buyer_count)
        │       │           pool_treasury → vault token account
        │       │       CPI vault.record_premium_income(premium * buyer_count)
        │       │       CPI vault.decrease_locked(payoff * buyer_count)
        │       │       FlightData.status = Settled
        │       │
        │       ├─ ToBeSettledDelayed / ToBeSettledCancelled
        │       │       payout = (payoff - premium) * buyer_count
        │       │       CPI vault.send_payout(pool_treasury, payout)
        │       │       CPI vault.decrease_locked(payoff * buyer_count)
        │       │       set FlightPool.claim_expiry = now + claim_expiry_window
        │       │       FlightData.status = Settled
        │       │       update total_payouts_distributed
        │       │
        │       └── remove from ActiveFlightList
        │
        ├─► Phase 2: Withdrawal queue
        │       CPI vault.process_withdrawal_queue()
        │
        └─► Phase 3: Snapshot
                CPI vault.snapshot()   (no-op if already snapshotted today)
```

**Compute budget:** `execute_settlements` processes up to `MAX_FLIGHTS_PER_TX` flights
(default 5) — money-moving paths cost ~100K-200K CU per flight. If more flights are
pending, the cron submits multiple transactions.

### Why split classify and execute?

- **Classification only reads on-chain state**; settlement moves money. Separating them
  bounds the compute budget per call and lets oracle data stabilize between runs.
- **Different failure modes.** A broken classifier doesn't halt settlement of
  already-classified flights. A broken settler doesn't prevent classification.
- **Different cadences.** Classification only matters once per flight as soon as oracle
  data lands; running it every 5 minutes is wasteful. Settlement should be prompt; running
  it hourly delays payouts.
- **FlightDataFetcher** is fundamentally different again — it talks to an external API
  (AeroAPI) and runs every 2 hours to respect rate limits and the 1-hour landing buffer.
- **Independent key rotation.** `authorized_oracle` and `authorized_keeper` are updatable
  independently. Both keeper crons share `authorized_keeper`.

### The Executor Interface

Every backend must implement three logical jobs:

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

FlightClassifier:
  1. Build Anchor instruction: classify_flights()
  2. Sign with keeper keypair
  3. Submit via Solana RPC

SettlementExecutor:
  1. Build Anchor instruction: execute_settlements()
  2. Sign with keeper keypair
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
│   │   ├── flight_classifier.ts   # classify_flights instruction builder
│   │   ├── settlement_executor.ts # execute_settlements instruction builder
│   │   ├── solana_client.ts       # Anchor client wrapper (build, sign, submit)
│   │   ├── aeroapi_client.ts      # AeroAPI HTTP client
│   │   └── types.ts               # FlightStatus, FlightData, etc.
│   │
│   ├── backends/
│   │   ├── cron/                  # Centralized cron (current default)
│   │   │   ├── index.ts           # node-cron scheduler entry point (3 schedules)
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
     owner → oracle_aggregator_program.set_authorized_oracle(new_oracle_address)
     owner → controller_program.set_authorized_keeper(new_keeper_address)
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
Traveler → controller_program.buy_insurance(flight_id, origin, dest, date)
                │
                ├─► traveler is Signer (Anchor enforces; passes through CPIs transitively)
                ├─► CPI → governance_program.is_route_whitelisted(...)
                │         revert if not whitelisted
                ├─► CPI → governance_program.get_route_terms(...)
                │         read resolved terms (premium, payoff, delay_hours)
                ├─► enforce min_lead_time
                │         revert if departure too soon
                │
                ├─► FlightPool PDA exists for (flight_id, date)?
                │       ├─ YES → skip register
                │       └─ NO  → init FlightData PDA (NotInitiated) + ActiveFlightList entry
                │                CPI → flight_pool_program.register_pool(
                │                          flight_id, date, premium, payoff, delay_hours)
                │
                ├─► solvency check
                │       read vault free_capital via CPI or stored reference
                │       revert if undercollateralised
                │
                ├─► CPI → flight_pool_program.add_buyer(flight_id, date)
                │           internally:
                │             - init BuyerRecord PDA
                │             - increment FlightPool.buyer_count
                │             - CPI → SPL Token: transfer(
                │                       traveler_ata → pool_treasury, premium)
                │               (traveler signature passes through transitively)
                │
                ├─► CPI → vault_program.increase_locked(payoff)
                └─► update insurance counters (total_policies_sold, total_premiums_collected)
```

**Solana auth note:** The traveler signs the top-level transaction. Their signature is
visible to all transitively-called programs (flight_pool, SPL Token), so the premium
transfer authorized by the traveler completes inside the nested CPI without an extra
transaction.

### Flight Data Collection (FlightDataFetcher, every 2 hours)

```
FlightDataFetcher (off-chain)
    │
    ├─► reads ActiveFlightList account via Solana RPC
    │
    ├─► for each flight in NotInitiated status:
    │       calls AeroAPI → gets estimated arrival time
    │       signs + submits tx:
    │       oracle_aggregator_program.set_estimated_arrival(flight_id, date, eta)
    │           └─► NotInitiated → Active
    │
    └─► for each flight in Active status
        where estimated_arrival_time + 1 hour < now:
            calls AeroAPI → gets actual flight status
            │
            ├─ Landed → signs + submits tx:
            │    oracle_aggregator_program.set_landed(flight_id, date, actual_arrival_time)
            │        └─► Active → Landed
            │
            ├─ Cancelled → signs + submits tx:
            │    oracle_aggregator_program.set_cancelled(flight_id, date)
            │        └─► Active → Cancelled
            │
            └─ Still in flight / HTTP error → skip, retry next cycle
```

### Classification (FlightClassifier, every 1 hour)

```
FlightClassifier (off-chain) → signs + submits tx:
    controller_program.classify_flights()
        │
        ├─► keeper Signer check
        │
        └─► for each flight in Landed or Cancelled status:
                ├─ Cancelled
                │       FlightData.status = ToBeSettledCancelled
                └─ Landed
                        read FlightPool.delay_hours
                        read FlightData.estimated_arrival_time, actual_arrival_time
                        delay = actual - estimated
                        ├─ delay >= delay_hours → ToBeSettledDelayed
                        └─ delay <  delay_hours → ToBeSettledOnTime
```

### Settlement (SettlementExecutor, every 5 minutes)

```
SettlementExecutor (off-chain) → signs + submits tx:
    controller_program.execute_settlements()
        │
        ├─► keeper Signer check
        │
        ├─► Phase 1: Settlement
        │   for each flight in ToBeSettled* status:
        │       ├─ ToBeSettledOnTime
        │       │       CPI → flight_pool.settle_on_time(flight_id, date)
        │       │           internally: marks SettledOnTime, transfers
        │       │             (premium * buyer_count) pool_treasury → vault token account
        │       │       CPI → vault.record_premium_income(premium * buyer_count)
        │       │       CPI → vault.decrease_locked(payoff * buyer_count)
        │       │       FlightData.status = Settled
        │       │       remove from ActiveFlightList
        │       │
        │       ├─ ToBeSettledDelayed / ToBeSettledCancelled
        │       │       payout = (payoff - premium) * buyer_count
        │       │       CPI → vault.send_payout(payout)
        │       │           recipient = flight_pool's pool_treasury
        │       │       CPI → vault.decrease_locked(payoff * buyer_count)
        │       │       CPI → flight_pool.settle_delayed(flight_id, date, claim_expiry)
        │       │           or flight_pool.settle_cancelled(...)
        │       │       FlightData.status = Settled
        │       │       remove from ActiveFlightList
        │       │       update total_payouts_distributed
        │
        ├─► CPI → vault.process_withdrawal_queue()
        └─► CPI → vault.snapshot()
```

### Payout Math (unchanged from Soroban)

```
premium = $10, payoff = $50, 2 buyers

On purchase:
  Pool treasury receives: $10 * 2 = $20 (premiums in)
  FlightPool tracks:      premium=$10, payoff=$50, buyer_count=2
  Vault locks:            $50 * 2 = $100 (collateral for max liability)

If delayed/cancelled:
  Vault sends: ($50 - $10) * 2 = $80 to pool treasury
  Treasury now earmarks (for this flight): $20 + $80 = $100 = payoff * buyer_count
  Each buyer claim: pool treasury → traveler, $50 (signed by treasury PDA)

If on time:
  Pool treasury sends: $20 to vault token account (premium income / underwriter yield)
  Vault unlocks: $100 (collateral released)
```

Per-flight treasury earmarks are accounting only — derived from `FlightPool` fields.
The treasury holds USDC for many flights at once.

### Traveler Claiming a Payout

```
Traveler → flight_pool_program.claim(flight_id, date)
    ├─► traveler is Signer
    ├─► load BuyerRecord PDA — panic if not found (no policy)
    ├─► panic if BuyerRecord.claimed == true
    ├─► load FlightPool PDA — panic if status != SettledDelayed or SettledCancelled
    ├─► panic if Clock::get()?.unix_timestamp > pool.claim_expiry
    ├─► BuyerRecord.claimed = true
    ├─► FlightPool.claimed_count += 1
    └─► CPI → SPL Token: transfer(pool_treasury, traveler_ata, payoff)
        (treasury PDA signs via invoke_signed with [b"pool_treasury"])
```

The traveler calls `flight_pool_program` directly — no controller_program round-trip,
since the pool program owns the treasury and the pool/buyer state.

### Sweeping Expired Claims (treasury accounting only)

```
Anyone → flight_pool_program.sweep_expired(flight_id, date)
    ├─► caller is Signer (pays tx fee)
    ├─► panic if Clock::get()?.unix_timestamp <= pool.claim_expiry
    ├─► unclaimed = (pool.buyer_count - pool.claimed_count) * pool.payoff
    ├─► FlightPoolConfig.recovered_balance += unclaimed
    └─► pool.claimed_count = pool.buyer_count   (idempotent guard)
```

No token transfer happens — funds stay in the pool treasury, just reclassified from
"owed to travelers" to "owed to owner" via `recovered_balance`. The owner withdraws via
`flight_pool_program.withdraw_recovered`. After sweep, the (now small) `FlightPool` PDA
can be closed to reclaim its SOL rent deposit.

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

                (queue drains during execute_settlements via CPI to process_withdrawal_queue)
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
      controller_program (orchestration, no funds custody)
          │       │       │       │
    ┌─────┘       │       │       └─────────────────────┐
    ▼             ▼       ▼                             ▼
vault_program   flight_pool_program   oracle_aggregator_program     Off-chain Executor
(RVS shares     (FlightPool,           (FlightData,                 ┌────────────────────────┐
 + USDC)         BuyerRecord,           OracleConfig — no funds)    │ Cron #1: Fetcher       │ ← authorized_oracle
    │            pool_treasury,            ▲                        │ Cron #2: Classifier    │ ← authorized_keeper
    │            recovery)                 │ writes (oracle key)    │ Cron #3: SettlementExec│ ← authorized_keeper
    │               │                      └────────────────────────┘
    │               │
    └──── send_payout ─►
              (vault → flight_pool's pool_treasury on delayed/cancelled settle)

           SPL Token Program
           (USDC transfers, RVS mint/burn)

Underwriters ──deposit──► vault_program
                               └── collect() ◄── Underwriters (FIFO queue)

Travelers ──buy_insurance──► controller_program
                                   ├─CPI→ governance.is_route_whitelisted / get_route_terms
                                   ├─CPI→ oracle_aggregator.init_flight_data (first buy only)
                                   ├─CPI→ flight_pool.register_pool (first buy only)
                                   ├─CPI→ flight_pool.add_buyer (premium → treasury)
                                   └─CPI→ vault.increase_locked

Travelers ──claim()──► flight_pool_program (treasury → traveler)
Anyone   ──sweep_expired()──► flight_pool_program (recovered_balance counter ↑)
Owner    ──withdraw_recovered()──► flight_pool_program (treasury → owner)
```

---

## Access Control

| Guard | Program | Instruction(s) | Mechanism |
|-------|---------|-----------------|-----------|
| Owner-only | governance_program | `set_defaults`, `add_admin`, `remove_admin` | `has_one = owner` + `Signer` |
| Owner or Admin | governance_program | `whitelist_route`, `disable_route`, `update_route_terms` | Owner check OR AdminRecord lookup + `Signer` |
| Owner-only | controller_program | `set_authorized_keeper`, config updates | `has_one = owner` + `Signer` |
| Authorized keeper | controller_program | `classify_flights`, `execute_settlements` | `Signer` + `config.authorized_keeper` check |
| Traveler | controller_program | `buy_insurance` | `Signer` (traveler signs top-level tx) |
| Controller PDA | controller_program → oracle_aggregator_program | `init_flight_data`, `set_to_be_settled`, `set_settled` | `has_one = authorized_consumer` + PDA signer seeds (CPI) |
| Owner-only | oracle_aggregator_program | `set_authorized_oracle`, `set_authorized_consumer` (once) | `has_one = owner` + `Signer` |
| Authorized oracle | oracle_aggregator_program | `set_estimated_arrival`, `set_landed`, `set_cancelled` | `Signer` + `config.authorized_oracle` check |
| Controller PDA | vault_program | `increase_locked`, `decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot` | `has_one = controller` + PDA signer seeds |
| Owner-only | vault_program | `set_controller` (once) | `has_one = owner` + `is_controller_set == false` |
| Controller PDA | flight_pool_program | `register_pool`, `add_buyer`, `settle_on_time`, `settle_delayed`, `settle_cancelled` | `has_one = controller` + PDA signer seeds |
| Owner-only | flight_pool_program | `set_controller` (once), `withdraw_recovered` | `has_one = owner` + `Signer` |
| Traveler with policy | flight_pool_program | `claim` | `Signer` + BuyerRecord exists + not claimed + status & expiry checks |
| Anyone | flight_pool_program | `sweep_expired` | `Signer` (for tx fee) + expiry check |

**`authorized_keeper`:** Lives on `ControllerConfig`. The executor backend's Solana keypair
signs `classify_flights` and `execute_settlements`. **Owner-updatable** for zero-downtime
migration.

**`authorized_oracle`:** Lives on `OracleConfig` (separate program). The fetcher backend's
Solana keypair signs `set_estimated_arrival`, `set_landed`, `set_cancelled`. Owner-updatable.
Compromise of this key cannot trigger payouts because oracle has no fund-moving authority.

**`authorized_consumer` on OracleConfig** is set once via `set_authorized_consumer()`.
Subsequent calls panic. The consumer is the controller program's `ControllerConfig` PDA,
which signs CPIs to oracle (`init_flight_data`, `set_to_be_settled`, `set_settled`) with
its own seeds.

**`controller` on VaultState and FlightPoolConfig** is set once via `set_controller()`.
Subsequent calls panic. In both cases the controller is the controller program's
`ControllerConfig` PDA, which signs vault and flight_pool CPIs with its own seeds.

**Controller and oracle programs hold zero user funds.** The flight_pool program is the
sole custodian of in-flight USDC via its `pool_treasury`. Inflows go to treasury via SPL
Token transfers authorized by traveler signatures (transitively, through CPI). Outflows
(claims, on-time settlement to vault, owner recovery withdrawals) are signed by the
treasury PDA via `invoke_signed`.

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
- **Classification + settlement lag** — up to ~1 hour between oracle data write and
  classification (FlightClassifier runs hourly), then up to ~5 minutes between
  classification and settlement (SettlementExecutor runs every 5 minutes).
- **Executor availability** — depends on backend choice and its uptime guarantees.
- **Account limits** — `classify_flights` and `execute_settlements` each handle at most
  `MAX_FLIGHTS_PER_TX` flights per transaction due to compute budget and account limits.
  The crons submit multiple transactions for large batches. With the flight_pool program
  separated, `execute_settlements` makes ~3-4 CPIs per flight (flight_pool + vault); the
  practical batch size is ~3 flights/tx.
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
3. Wallet signs transaction calling `controller_program.buy_insurance(flight_id, origin, dest, date)`.
   Anchor handles USDC transfer authorization within the same signature.

**Claim payout (if delayed or cancelled):**
After settlement, call `controller_program.claim(flight_id, date)`. Must claim before expiry.

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
| Claim payout | Traveler | `flight_pool.claim(flight_id, date)` |
| Sweep expired claims | Anyone | `flight_pool.sweep_expired(flight_id, date)` |
| Classify flights | Keeper | `insurance.classify_flights()` |
| Execute settlements | Keeper | `insurance.execute_settlements()` |
| Withdraw recovered funds | Owner | `flight_pool.withdraw_recovered(amount)` |
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
│   ├── flight_pool/
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
│   │   │   ├── useFlightPool.ts
│   │   │   └── useGovernance.ts
│   │   ├── idl/                   # Anchor-generated IDL files
│   │   │   ├── governance.json
│   │   │   ├── vault.json
│   │   │   ├── flight_pool.json
│   │   │   └── insurance.json
│   │   └── App.tsx
│   └── package.json
├── tests/                         # Anchor integration tests (TypeScript)
│   ├── governance.test.ts
│   ├── vault.test.ts
│   ├── flight_pool.test.ts
│   ├── insurance.test.ts
│   └── e2e.test.ts
├── executor/                      # Off-chain executor (modular backend)
│   ├── src/
│   │   ├── core/
│   │   │   ├── flight_data_fetcher.ts
│   │   │   ├── flight_classifier.ts
│   │   │   ├── settlement_executor.ts
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
// controller_program orchestrates CPIs into flight_pool and vault.
const tx = await insuranceProgram.methods
  .buyInsurance(flightId, origin, dest, new BN(date))
  .accounts({
    insuranceConfig: configPda,
    flightData: flightDataPda,
    activeFlightList: activeFlightListPda,
    traveler: wallet.publicKey,
    travelerTokenAccount: travelerAta,
    // governance refs
    governanceProgram: GOVERNANCE_PROGRAM_ID,
    governanceConfig: govConfigPda,
    routeAccount: routePda,
    // flight pool refs (passed through to CPI)
    flightPoolProgram: FLIGHT_POOL_PROGRAM_ID,
    flightPoolConfig: flightPoolConfigPda,
    pool: poolPda,
    buyerRecord: buyerPda,
    poolTreasury: poolTreasuryAta,
    // vault refs
    vaultProgram: VAULT_PROGRAM_ID,
    vaultState: vaultStatePda,
    // common
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

// Claim — call flight_pool_program directly
const claimTx = await flightPoolProgram.methods
  .claim(flightId, new BN(date))
  .accounts({
    pool: poolPda,
    buyerRecord: buyerPda,
    traveler: wallet.publicKey,
    travelerTokenAccount: travelerAta,
    poolTreasury: poolTreasuryAta,
    flightPoolConfig: flightPoolConfigPda,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

### Per-User Policy Querying

```typescript
// Get all policies for the connected wallet — solves the "MyPolicies" bug from Soroban
const buyerRecords = await connection.getProgramAccounts(FLIGHT_POOL_PROGRAM_ID, {
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
