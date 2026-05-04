# Solana/Anchor for Soroban Developers — Sentinel Protocol Migration Guide

This document maps every Soroban concept you already know to its Solana/Anchor equivalent.
It references the Sentinel flight delay insurance protocol throughout so every example
is grounded in real code you will write.

---

## 1. The Account Model: Solana vs Soroban

### Soroban: Code + State in One Contract

On Soroban, each contract is a self-contained unit. The GovernanceModule contract owns its
code AND its storage. You read and write state through `env.storage()`:

```rust
// Soroban — GovernanceModule stores a route inside itself
env.storage().persistent().set(
    &DataKey::Route(flight_id.clone(), origin.clone(), dest.clone()),
    &route_terms,
);
```

Deploy 6 contracts, get 6 independent state stores. Each contract is a microservice with
its own database baked in.

### Solana: Code Deployed Once, State Lives in Separate Accounts

On Solana, a **program** (the equivalent of a contract) is deployed once and contains only
executable code. All state lives in **accounts** — separate on-chain data blobs that the
program reads and writes. The program itself is stateless.

```rust
// Anchor — GovernanceModule's route is a separate account
#[account]
pub struct RouteAccount {
    pub flight_id: String,
    pub origin: String,
    pub destination: String,
    pub premium: Option<u64>,
    pub payoff: Option<u64>,
    pub delay_hours: Option<u32>,
    pub approved: bool,
    pub bump: u8,
}
```

This `RouteAccount` is its own on-chain account with its own address. The `governance_program`
reads and writes it, but does not "contain" it.

### The Web App Analogy

Think of it this way:

- **Soroban** = 6 separate microservices (GovernanceModule, RiskVault, FlightPool, Controller,
  OracleAggregator, RecoveryPool), each with its own embedded SQLite database. To talk to
  another service, you make an HTTP call (cross-contract call).

- **Solana** = 5 API servers (governance_program, vault_program, flight_pool_program,
  oracle_aggregator_program, controller_program), each backed by a shared PostgreSQL
  database (the Solana account space). The "tables" are PDA accounts. The servers do not
  contain data — they contain logic that operates on rows in the database.

### The Key Mental Shift

**The program is the smart contract. The PDA is just a database row.**

On Soroban, you deploy a new FlightPool contract for every flight. On Solana, you create a
new FlightPool PDA account under the `flight_pool_program`. Same data, same logic — but the
FlightPool is an account, not a deployed program.

| Soroban | Solana |
|---------|--------|
| Deploy GovernanceModule contract | Deploy `governance_program` once |
| `env.storage().set(&DataKey::Route(...), &terms)` | Create a `RouteAccount` PDA |
| Deploy a new FlightPool contract per flight | Create a `FlightPool` PDA per flight under `flight_pool_program` |
| 6 contract deployments | 5 program deployments + N PDA accounts |

---

## 2. PDAs (Program Derived Addresses)

### What They Are

A PDA is a deterministic address computed from a set of **seeds** and a **program ID**.
Given the same seeds and program, you always get the same address. PDAs replace Soroban's
`DataKey` enums as the way to locate and organize on-chain state.

On Soroban, you locate a route like this:

```rust
// Soroban — DataKey as storage key
let key = DataKey::Route(flight_id, origin, dest);
let terms: RouteTerms = env.storage().persistent().get(&key).unwrap();
```

On Solana, you derive a PDA address from seeds:

```rust
// Anchor — PDA seeds define the "key"
#[account(
    seeds = [b"route", flight_id.as_bytes(), origin.as_bytes(), dest.as_bytes()],
    bump = route.bump,
)]
pub route: Account<'info, RouteAccount>,
```

The PDA address is computed as `hash(seeds + program_id + bump)`. Anyone who knows the seeds
can recompute the address — no lookup table needed.

### Complete DataKey-to-PDA Mapping

Here is every Soroban `DataKey` from the architecture mapped to its Solana PDA equivalent:

| Soroban Contract | Soroban DataKey | Solana Program | PDA Seeds | Account Struct |
|-----------------|-----------------|----------------|-----------|----------------|
| GovernanceModule | `Owner` | governance_program | `[b"gov_config"]` | `GovConfig` |
| GovernanceModule | `Admin(Address)` | governance_program | `[b"admin", admin.key().as_ref()]` | `AdminRecord` |
| GovernanceModule | `DefaultPremium/Payoff/DelayHours` | governance_program | `[b"gov_config"]` | `GovConfig` (fields) |
| GovernanceModule | `Route(Symbol, Symbol, Symbol)` | governance_program | `[b"route", flight_id, origin, dest]` | `RouteAccount` |
| GovernanceModule | `RouteList` | governance_program | N/A — use `getProgramAccounts` filter | N/A |
| RiskVault | `Controller` | vault_program | `[b"vault_config"]` | `VaultConfig` |
| RiskVault | `TotalManagedAssets` | vault_program | `[b"vault_config"]` | `VaultConfig` (field) |
| RiskVault | `LockedCapital` | vault_program | `[b"vault_config"]` | `VaultConfig` (field) |
| RiskVault | `WithdrawalQueue` | vault_program | `[b"withdrawal", index.to_le_bytes()]` | `WithdrawalRequest` |
| RiskVault | `ClaimableBalance(Address)` | vault_program | `[b"claimable", owner.key().as_ref()]` | `ClaimableBalance` |
| RiskVault | `SnapshotPrice(u64)` | vault_program | `[b"snapshot", day.to_le_bytes()]` | `SnapshotRecord` |
| Controller | `Owner, Governance, RiskVault, Oracle...` | controller_program | `[b"controller_config"]` | `ControllerConfig` |
| Controller | `AuthorizedKeeper` | controller_program | `[b"controller_config"]` | `ControllerConfig` (field) |
| Controller | `ActiveFlightList` | controller_program | `[b"active_flights"]` | `ActiveFlightList` |
| FlightPool | `Controller, FlightId, Date, Premium...` | flight_pool_program | `[b"flight_pool", flight_id, date]` | `FlightPool` (fields) |
| FlightPool | `Buyer(Address)` | flight_pool_program | `[b"buyer", pool.key().as_ref(), buyer.key().as_ref()]` | `BuyerRecord` |
| FlightPool | `Claimed(Address)` | flight_pool_program | `[b"buyer", pool.key().as_ref(), buyer.key().as_ref()]` | `BuyerRecord` (claimed field) |
| OracleAggregator | `Owner, AuthorizedOracle...` | oracle_aggregator_program | `[b"oracle_config"]` | `OracleConfig` |
| OracleAggregator | `FlightData(Symbol, u64)` | oracle_aggregator_program | `[b"flight", flight_id, date]` | `FlightData` |
| RecoveryPool | `recovered_balance` counter | flight_pool_program | `[b"flight_pool_config"]` | `FlightPoolConfig` (field) |

Notice how Soroban's `RouteList` and `ActiveFlightList` disappear entirely. On Solana, you
query all accounts of a given type using `getProgramAccounts` with filters (see Section 7).
No more maintaining Vec lists in storage.

### The Bump Byte

PDA addresses are specifically chosen to NOT lie on the ed25519 curve — this means no
private key exists for them. The `bump` is a single byte (0-255) that the runtime appends
to the seeds to push the resulting address off the curve. Anchor finds the first valid bump
automatically on account creation and stores it in the account struct so you do not have to
recompute it on every access.

```rust
#[account]
pub struct FlightPoolAccount {
    pub flight_id: String,
    pub date: u64,
    pub premium: u64,
    pub payoff: u64,
    pub delay_hours: u32,
    pub status: SettlementStatus,
    pub buyer_count: u32,
    pub bump: u8,  // stored once at creation, reused on every access
}
```

### PDA as Signer: How the Vault Sends Tokens

This is the most powerful PDA feature and has no Soroban equivalent. On Soroban, your
RiskVault contract calls `usdc_client.transfer(vault_address, recipient, amount)` and
Soroban's auth framework authorizes it because the contract itself is the caller.

On Solana, the vault PDA has no private key — but the vault_program can sign on its behalf
using `invoke_signed`, passing the seeds + bump that derive the PDA. The SPL Token program
verifies that the seeds produce the PDA address, confirming authorization.

```rust
// Anchor — vault PDA signs a token transfer
let seeds = &[b"vault_authority", &[vault_config.bump]];
let signer_seeds = &[&seeds[..]];

let cpi_ctx = CpiContext::new_with_signer(
    ctx.accounts.token_program.to_account_info(),
    Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.recipient_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    },
    signer_seeds,
);
token::transfer(cpi_ctx, amount)?;
```

### Defining a PDA Account in Anchor

```rust
// Creating a new FlightPool PDA
#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct CreateFlightPool<'info> {
    #[account(
        init,
        payer = keeper,
        space = 8 + FlightPoolAccount::INIT_SPACE,
        seeds = [b"flight_pool", flight_id.as_bytes(), &date.to_le_bytes()],
        bump,
    )]
    pub flight_pool: Account<'info, FlightPoolAccount>,

    #[account(mut)]
    pub keeper: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

`init` allocates the account, `payer` pays the rent deposit, `space` sets the byte size,
`seeds` defines the PDA derivation, and `bump` tells Anchor to find and store the bump.

---

## 3. CPI (Cross-Program Invocation) and Why We Consolidated

### What CPI Is

CPI is Solana's equivalent of Soroban's cross-contract calls. When `controller_program`
needs to move tokens from the vault, it makes a CPI to `vault_program`. When it needs to
check route approval, it makes a CPI to `governance_program`.

### The Costs of CPI

CPI is significantly more expensive than Soroban's cross-contract calls:

- **~25,000 Compute Units overhead** per CPI, on top of the invoked instruction's own cost.
- **Account fan-out**: every account the callee needs must also be passed into the caller's
  transaction. If `controller_program` CPIs into `vault_program`, and vault needs 5 accounts,
  all 5 must appear in the original transaction's account list.
- **4-level depth limit**: A can call B can call C can call D — but no deeper.
- **Stack size**: each CPI level consumes stack. Deep chains risk stack overflow.

### Soroban vs Solana Cross-Contract Calls

On Soroban, cross-contract calls feel like local function calls:

```rust
// Soroban — Controller calls GovernanceModule
let gov_client = GovernanceModuleClient::new(&env, &governance_addr);
let terms = gov_client.get_route_terms(&flight_id, &origin, &dest);
// That is it. One line. The client is auto-generated from the contract trait.

// Soroban — Controller calls RiskVault
let vault_client = RiskVaultClient::new(&env, &vault_addr);
vault_client.increase_locked(&controller_addr, &terms.payoff);

// Soroban — Controller calls OracleAggregator
let oracle_client = OracleAggregatorClient::new(&env, &oracle_addr);
oracle_client.set_to_be_settled(&controller_addr, &flight_id, &date, &status);
```

On Solana, CPIs are explicit, verbose, and require passing all accounts:

```rust
// Anchor — controller_program CPIs into vault_program
let cpi_program = ctx.accounts.vault_program.to_account_info();
let cpi_accounts = vault_program::cpi::accounts::IncreaseLocked {
    vault_config: ctx.accounts.vault_config.to_account_info(),
    authority: ctx.accounts.controller_config.to_account_info(),
};
let seeds = &[b"controller_config", &[ctx.accounts.controller_config.bump]];
let signer_seeds = &[&seeds[..]];
let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
vault_program::cpi::increase_locked(cpi_ctx, amount)?;
```

### Why We Mapped 6 Soroban Contracts to 5 Solana Programs

On Soroban, the Sentinel Protocol has 6 contracts: GovernanceModule, RiskVault, Controller,
FlightPool, OracleAggregator, RecoveryPool. The Controller makes cross-contract calls to
all of them freely because calls are cheap and seamless.

On Solana, each cross-program call costs ~25K CU overhead and requires passing every
account the callee needs — so we consolidated where it made sense and split where authority
isolation mattered.

The mapping:

| Soroban Contracts | Solana Program | Rationale |
|-------------------|----------------|-----------|
| GovernanceModule | `governance_program` | Standalone — only read by others |
| RiskVault | `vault_program` | Standalone — manages its own token accounts and share mint |
| FlightPool + RecoveryPool | `flight_pool_program` | Same custody surface (per-flight pool + recovery counter); merging eliminates the FlightPool↔RecoveryPool CPI. RecoveryPool collapsed to a `recovered_balance` field on `FlightPoolConfig`. |
| OracleAggregator | `oracle_aggregator_program` | Kept separate so the `authorized_oracle` keypair (compromise risk: it signs every 2h from an internet-exposed cron) cannot trigger payouts. Mirrors the Pyth/Switchboard pattern. Reads from controller are free (account passing); only state-transition writes use CPIs. |
| Controller | `controller_program` | Pure orchestration. CPIs into all 4 other programs to drive buy / classify / settle. Holds zero funds. |

### CPIs in the runtime hot path

These cross-program calls happen during normal protocol operation:

1. **`controller_program → governance_program`**: `is_route_whitelisted`, `get_route_terms`
   (read-only; could alternatively be done client-side by passing `RouteAccount` in)
2. **`controller_program → flight_pool_program`**: `register_pool`, `add_buyer`,
   `settle_on_time`, `settle_delayed`, `settle_cancelled` (consumer-gated)
3. **`controller_program → vault_program`**: `increase_locked`, `decrease_locked`,
   `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot`
4. **`controller_program → oracle_aggregator_program`**: `init_flight_data` (on first
   buy), `set_to_be_settled` (during classify), `set_settled` (during execute) — all
   consumer-gated, signed by the controller's `ControllerConfig` PDA
5. **`flight_pool_program → SPL Token program`**: premium in (from traveler), claim out
   (to traveler), settle on-time (to vault token account)
6. **`vault_program → flight_pool_program`**: `send_payout` target = `pool_treasury`
7. **`vault_program → SPL Token program`**: USDC transfers, RVS share mint/burn

**Settlement budget:** `controller_program.execute_settlements()` does ~4–5 CPIs per
flight (vault + flight_pool + oracle), so `MAX_FLIGHTS_PER_TX` is ~2. The keeper cron
fans out across multiple transactions when the queue is bigger.

### Reads are free — only writes are CPIs

The controller reads `FlightData` accounts during `classify_flights` and
`execute_settlements` by passing them in as `Account<'info, FlightData>` with an
`owner = oracle_aggregator_program` constraint. **No CPI is required for reads** —
that's the whole point of Solana's account model. CPIs from controller to oracle
only happen when the controller needs to **mutate** FlightData state (init,
to_be_settled, settled).

---

## 4. Authorization: Signer vs require_auth

### Soroban: require_auth() + Address Comparison

On Soroban, authorization is a two-step pattern:

```rust
// Soroban — Controller.classify_flights()
fn classify_flights(env: Env, keeper: Address) {
    // Step 1: Verify the caller actually signed for this address
    keeper.require_auth();

    // Step 2: Verify this address is the authorized keeper
    let authorized: Address = env.storage().instance()
        .get(&CtrlKey::AuthorizedKeeper)
        .unwrap();
    assert!(keeper == authorized, "not authorized keeper");

    // ... proceed with classification
}
```

The `require_auth()` call verifies that the transaction includes a valid signature for the
`keeper` address. The stored comparison verifies that this particular address is allowed
to call this function.

### Solana: Signer Type + Constraint Macros

On Solana, authorization is enforced through the account validation struct:

```rust
// Anchor — process_flights instruction (combined classify + settle)
#[derive(Accounts)]
pub struct ProcessFlights<'info> {
    // Step 1: Signer<'info> ensures this account signed the transaction
    pub keeper: Signer<'info>,

    // Step 2: has_one = authorized_keeper checks that config.authorized_keeper == keeper.key()
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
        has_one = authorized_keeper @ SentinelError::UnauthorizedKeeper,
    )]
    pub config: Account<'info, ControllerConfig>,

    /// CHECK: Validated by has_one on config
    pub authorized_keeper: AccountInfo<'info>,
}
```

Wait — this looks like two separate accounts. That is because on Solana, the `has_one`
constraint works by comparing a field on the config account to one of the accounts passed
in the transaction. A cleaner pattern for our case:

```rust
#[derive(Accounts)]
pub struct ProcessFlights<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = config.bump,
        constraint = config.authorized_keeper == keeper.key()
            @ SentinelError::UnauthorizedKeeper,
    )]
    pub config: Account<'info, ControllerConfig>,

    pub keeper: Signer<'info>,
}
```

The `constraint` macro is the Anchor equivalent of Soroban's `assert!(keeper == authorized)`.
The `Signer<'info>` type is the equivalent of `require_auth()`.

### The Key Difference: Explicit Account Passing

On Soroban, the `classify_flights` function just takes `keeper: Address` as a parameter.
The contract reads `AuthorizedKeeper` from its own storage internally.

On Solana, you cannot "just read from storage." The `ControllerConfig` account that holds
`authorized_keeper` must be explicitly passed as an account in the transaction. Every piece
of state your instruction reads or writes must be declared in the accounts struct. You
cannot access any on-chain data that was not passed into the transaction.

This is why Solana transactions list 10+ accounts — you are declaring your entire data
dependency graph upfront.

---

## 5. Token Operations: SPL Token vs Soroban Token

### Soroban: Feels Like a Function Call

On Soroban, token operations are ergonomic. The Soroban token interface gives you a client
that feels like calling a normal function:

```rust
// Soroban — buying insurance in the Controller
let usdc_client = token::Client::new(&env, &usdc_address);

// Transfer premium from traveler to FlightPool
usdc_client.transfer(&traveler, &flight_pool_address, &premium_amount);

// Later, in FlightPool settlement — transfer premiums to vault
usdc_client.transfer(&pool_address, &vault_address, &total_premiums);
```

That is it. The token contract handles everything. The `transfer` function takes `from`,
`to`, and `amount`. The Soroban auth framework ensures the caller is authorized for `from`.

### Solana: CPI to SPL Token Program with Token Accounts

On Solana, tokens are managed by the **SPL Token Program** — a system-level program that
handles all fungible token logic. Every token interaction is a CPI.

The critical concept: **wallets do not hold tokens directly.** Each wallet has a separate
**Token Account** (also called Associated Token Account / ATA) for each token mint. The
token account is owned by the SPL Token Program and holds the balance.

```
Soroban:  Wallet Address -> has USDC balance (tracked by USDC contract)
Solana:   Wallet Address -> owns ATA Address -> has USDC balance (tracked by SPL Token)
```

Buying insurance requires these token accounts:

```rust
// Anchor — buy_insurance token transfer
#[derive(Accounts)]
pub struct BuyInsurance<'info> {
    #[account(mut)]
    pub traveler: Signer<'info>,

    // Traveler's USDC token account (source of premium)
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = traveler,
    )]
    pub traveler_token_account: Account<'info, TokenAccount>,

    // FlightPool's USDC token account (destination for premium)
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = flight_pool,
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    // ... other accounts
}
```

The actual transfer:

```rust
// Anchor — transfer premium from traveler to pool
let cpi_ctx = CpiContext::new(
    ctx.accounts.token_program.to_account_info(),
    Transfer {
        from: ctx.accounts.traveler_token_account.to_account_info(),
        to: ctx.accounts.pool_token_account.to_account_info(),
        authority: ctx.accounts.traveler.to_account_info(),
    },
);
token::transfer(cpi_ctx, premium_amount)?;
```

When the **vault PDA** needs to send a payout (no private key), use `invoke_signed`:

```rust
// Anchor — vault PDA sends payout to FlightPool
let seeds = &[b"vault_authority", &[vault_config.bump]];
let signer_seeds = &[&seeds[..]];
let cpi_ctx = CpiContext::new_with_signer(
    ctx.accounts.token_program.to_account_info(),
    Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.pool_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    },
    signer_seeds,
);
token::transfer(cpi_ctx, payout_amount)?;
```

### Amounts

- **Soroban**: uses `i128` for token amounts. USDC has 6 decimals (1 USDC = 1_000_000 stroops).
- **Solana**: SPL Token uses `u64` for token amounts. USDC also has 6 decimals (1 USDC = 1_000_000).
- The max `u64` is ~18.4 quintillion — more than enough. No practical difference for our
  protocol, but we lose the ability to represent negative balances (which we never needed).

### Mock USDC

On Soroban, you deploy the standard Soroban token contract with custom parameters for testing.
On Solana:

- **localnet/devnet**: Deploy your own SPL Token mint, set decimals to 6, mint freely for
  testing. Store the mint address in `ControllerConfig` and `VaultConfig`.
- **mainnet**: Use the real USDC mint address (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- The program code is identical — only the configured mint address changes.

---

## 6. Rent Exemption vs Soroban's TTL

### Soroban: TTL Management Is a Constant Tax

On Soroban, every piece of stored data has a **Time-To-Live (TTL)** measured in ledger
sequence numbers. If you do not extend the TTL, data gets **archived**. Archived data still
exists but cannot be accessed until restored (for a fee).

The Sentinel Soroban codebase has TTL management scattered everywhere:

```rust
// Soroban — FlightPool extends TTL on critical storage
env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
env.storage().persistent().extend_ttl(
    &PoolKey::Buyer(buyer.clone()),
    PERSISTENT_LIFETIME_THRESHOLD,
    PERSISTENT_BUMP_AMOUNT,
);
```

The settlement loop must extend TTL on FlightPool instance storage, buyer records, oracle
data, and the Controller's active flight list. Missing a TTL extension means data silently
disappears.

### Solana: Pay Once, Live Forever

On Solana, accounts pay a **rent deposit** at creation. If the deposit covers 2 years of
rent (based on account size in bytes), the account is **rent-exempt** and lives forever.
Anchor's `init` macro always makes accounts rent-exempt by default.

```rust
// Anchor — creating a rent-exempt FlightPool PDA
#[account(
    init,
    payer = keeper,
    space = 8 + FlightPoolAccount::INIT_SPACE,  // 8-byte discriminator + struct size
    seeds = [b"flight_pool", flight_id.as_bytes(), &date.to_le_bytes()],
    bump,
)]
pub flight_pool: Account<'info, FlightPoolAccount>,
// The rent deposit is automatically calculated from `space` and deducted from `payer`.
// The account now exists permanently until explicitly closed.
```

### What We Delete

Migrating to Solana means we can **remove all TTL management code**:

- No `extend_ttl()` calls anywhere
- No `INSTANCE_LIFETIME_THRESHOLD` / `INSTANCE_BUMP_AMOUNT` constants
- No TTL extension in the settlement loop
- No archival recovery logic
- No worry about data silently disappearing

### Account Closing: Reclaiming SOL

When a FlightPool is fully settled, all claims are paid or expired, and the pool is swept,
we can **close the account** to reclaim the rent deposit SOL:

```rust
// Anchor — close a fully settled FlightPool
#[derive(Accounts)]
pub struct CloseFlightPool<'info> {
    #[account(
        mut,
        close = authority,  // sends rent SOL back to authority
        seeds = [b"flight_pool", flight_pool.flight_id.as_bytes(), &flight_pool.date.to_le_bytes()],
        bump = flight_pool.bump,
        constraint = flight_pool.status == SettlementStatus::Swept
            @ SentinelError::PoolNotSwept,
    )]
    pub flight_pool: Account<'info, FlightPoolAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
}
```

On Soroban, the equivalent was letting the TTL expire so the contract gets archived. On
Solana, closing is explicit and gives you SOL back.

### Practical Impact

| Soroban | Solana |
|---------|--------|
| Must extend TTL on every storage access path | No TTL concept |
| Settlement loop extends TTL on pools, buyers, oracle data | Settlement loop just settles |
| Archived data needs restore transaction + fee | Accounts exist until explicitly closed |
| Forgetting extend_ttl = silent data loss | No equivalent failure mode |
| ~20 lines of TTL boilerplate per contract | Zero |

---

## 7. Querying: getProgramAccounts vs Contract Functions

### The MyPolicies Problem on Soroban

On Soroban, there is no efficient way to query "all FlightPools that contain policies for
wallet X." The storage is key-value inside each contract, and you cannot scan across
contracts. The Soroban version of Sentinel maintains a `Vec<(Symbol, u64)>` in Controller
storage (`ActiveFlightList`) and iterates it — but that does not help find a specific
buyer's policies without checking every pool.

The frontend had to either:
1. Maintain an off-chain index
2. Iterate all active pools and check `Buyer(address)` on each one (N contract reads)

Neither is great.

### Solana: getProgramAccounts with memcmp Filters

On Solana, every `BuyerRecord` is a separate account owned by `flight_pool_program`. The
Solana RPC has a `getProgramAccounts` endpoint that returns all accounts owned by a program,
with optional **memcmp filters** that match bytes at specific offsets in the account data.

Since every `BuyerRecord` contains the buyer's pubkey at a known byte offset, you can query
"all BuyerRecords where buyer == walletX" in a single RPC call.

```typescript
// TypeScript — find all policies for a specific wallet
import { connection } from "./connection";
import { PublicKey } from "@solana/web3.js";
import { FLIGHT_POOL_PROGRAM_ID } from "./constants";

const BUYER_RECORD_DISCRIMINATOR = Buffer.from(/* anchor discriminator for BuyerRecord */);
const BUYER_PUBKEY_OFFSET = 8; // 8-byte discriminator, then buyer pubkey starts

async function getPoliciesForWallet(walletPubkey: PublicKey) {
  const accounts = await connection.getProgramAccounts(FLIGHT_POOL_PROGRAM_ID, {
    filters: [
      {
        // Match the BuyerRecord account discriminator
        memcmp: {
          offset: 0,
          bytes: BUYER_RECORD_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
      {
        // Match the buyer's public key at the correct offset
        memcmp: {
          offset: BUYER_PUBKEY_OFFSET,
          bytes: walletPubkey.toBase58(),
        },
      },
    ],
  });

  return accounts.map((a) => {
    // Decode BuyerRecord from a.account.data using Anchor's coder
    return program.coder.accounts.decode("BuyerRecord", a.account.data);
  });
}
```

### Querying All Buyers for a Pool

The same pattern works in reverse — find all `BuyerRecord` accounts where the `pool` field
matches a specific FlightPool PDA:

```typescript
// TypeScript — find all buyers for a specific flight pool
const POOL_PUBKEY_OFFSET = 8 + 32; // discriminator + buyer pubkey, then pool pubkey

async function getBuyersForPool(poolPubkey: PublicKey) {
  const accounts = await connection.getProgramAccounts(FLIGHT_POOL_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: BUYER_RECORD_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
      {
        memcmp: {
          offset: POOL_PUBKEY_OFFSET,
          bytes: poolPubkey.toBase58(),
        },
      },
    ],
  });

  return accounts.map((a) =>
    program.coder.accounts.decode("BuyerRecord", a.account.data)
  );
}
```

### Why This Works

On Soroban, `Buyer(Address)` is a key inside the FlightPool contract's internal storage.
You cannot query it from outside without calling the contract. There is no cross-contract
storage scan.

On Solana, each `BuyerRecord` is a separate account in the global account space. The
`getProgramAccounts` RPC scans all accounts owned by `flight_pool_program` and applies byte-level
filters. This is possible because accounts are "database rows" — not entries hidden inside
a contract's private storage.

This means we can delete the `ActiveFlightList` Vec from the Soroban architecture. We do not
need to maintain lists — we query accounts directly.

---

## 8. Transaction Model

### Declare Everything Upfront

Solana transactions must declare **every account** they will read or write, before execution
begins. This is fundamentally different from Soroban, where a contract can read its own
storage without declaring it.

Each account in the transaction is marked as:
- **readonly** or **writable** (can the instruction modify it?)
- **signer** or **not signer** (did this account's keypair sign the transaction?)

This enables Solana's parallel execution — the runtime knows which transactions touch
which accounts and can run non-overlapping ones in parallel.

### Example: buy_insurance Transaction Accounts

A `buy_insurance` call on Solana must pass approximately these accounts:

```rust
#[derive(Accounts)]
pub struct BuyInsurance<'info> {
    // 1. Insurance program config PDA (read)
    #[account(seeds = [b"controller_config"], bump = config.bump)]
    pub config: Account<'info, ControllerConfig>,

    // 2. Flight pool PDA (write — update buyer_count)
    #[account(mut, seeds = [b"flight_pool", ...], bump = flight_pool.bump)]
    pub flight_pool: Account<'info, FlightPoolAccount>,

    // 3. Buyer record PDA (init — created on purchase)
    #[account(init, payer = traveler, space = 8 + BuyerRecord::INIT_SPACE, seeds = [b"buyer", ...], bump)]
    pub buyer_record: Account<'info, BuyerRecord>,

    // 4. Flight data PDA (read — check flight exists and is active)
    #[account(seeds = [b"flight_data", ...], bump = flight_data.bump)]
    pub flight_data: Account<'info, FlightDataAccount>,

    // 5. Route account from governance_program (read — verify route approved)
    pub route: Account<'info, RouteAccount>,

    // 6. Vault config (read — solvency check)
    pub vault_config: Account<'info, VaultConfig>,

    // 7. Traveler wallet (signer + writable for SOL rent)
    #[account(mut)]
    pub traveler: Signer<'info>,

    // 8. Traveler's USDC token account (writable — debit premium)
    #[account(mut)]
    pub traveler_token_account: Account<'info, TokenAccount>,

    // 9. Pool's USDC token account (writable — credit premium)
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,

    // 10. USDC mint (read)
    pub usdc_mint: Account<'info, Mint>,

    // 11. SPL Token program
    pub token_program: Program<'info, Token>,

    // 12. System program (needed for account creation)
    pub system_program: Program<'info, System>,
}
```

That is 12 accounts for a single insurance purchase. On Soroban, the `buy_insurance` function
on the Controller takes `traveler: Address, flight_id: Symbol, date: u64` — three parameters.
The contract reads everything else from its own storage and calls other contracts as needed.

### Limits

- **64 accounts** per transaction (including program IDs) — more than enough for Sentinel.
  Our most complex transaction (buy_insurance) uses ~12 accounts.
- **1232 bytes** transaction size limit — rarely hit with normal transactions.
- **200,000 Compute Units** default budget per transaction. Can request up to **1,400,000 CU**
  with a `SetComputeUnitLimit` instruction.

### Compute Budget and Batch Operations

The `process_flights` instruction (combined classify + settle) iterates over flight data
accounts. If processing many flights in one transaction, compute budget matters:

```typescript
// TypeScript — requesting more compute for batch settlement
import { ComputeBudgetProgram } from "@solana/web3.js";

const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: 1_000_000, // request 1M CU instead of default 200K
});

const tx = new Transaction()
  .add(modifyComputeUnits)
  .add(processFlightsInstruction);
```

For very large batches, the off-chain cron should split flights across multiple transactions
rather than trying to process everything in one. The 2-cron design (FlightDataFetcher +
combined FlightProcessor) naturally limits batch sizes since the FlightProcessor only
handles flights that changed status since the last run.

---

## 9. Upgradeability

### Solana: Upgrade Authority Keypair

Every Solana program has an **upgrade authority** — a keypair that can replace the program's
executable code. This is simpler than Soroban's model where each contract deployment is a
separate instance.

```bash
# Deploy initially
anchor deploy --program-name controller_program --provider.cluster devnet

# Upgrade with new code — all PDAs and accounts remain untouched
anchor upgrade target/deploy/controller_program.so \
  --program-id <PROGRAM_ID> \
  --provider.cluster devnet
```

Key point: **upgrading replaces code, not data.** All PDA accounts, their contents, and
their addresses remain exactly the same. This is analogous to deploying a new version of
your API server without touching the database.

### Authority Management

```bash
# Transfer upgrade authority to a multisig (Squads Protocol)
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_MULTISIG_ADDRESS>

# Make program immutable (irreversible — cannot upgrade ever again)
solana program set-upgrade-authority <PROGRAM_ID> --final
```

### Account Schema Changes

When you add fields to an account struct, existing accounts do not magically grow. You need
a migration strategy:

**Option A: Add fields at the end with realloc**

```rust
// New field added at the end of FlightPoolAccount
#[account]
pub struct FlightPoolAccount {
    pub flight_id: String,
    pub date: u64,
    pub premium: u64,
    pub payoff: u64,
    pub delay_hours: u32,
    pub status: SettlementStatus,
    pub buyer_count: u32,
    pub bump: u8,
    pub new_field: u64,  // added in v2
}

// Migration instruction to resize existing accounts
#[derive(Accounts)]
pub struct MigrateFlightPool<'info> {
    #[account(
        mut,
        realloc = 8 + FlightPoolAccount::INIT_SPACE,
        realloc::payer = authority,
        realloc::zero = false,
        seeds = [b"flight_pool", flight_pool.flight_id.as_bytes(), &flight_pool.date.to_le_bytes()],
        bump = flight_pool.bump,
    )]
    pub flight_pool: Account<'info, FlightPoolAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

**Option B: Version field + migration instruction**

Add a `version: u8` field to accounts. The program checks the version and runs migration
logic on first access, or a dedicated `migrate` instruction batch-updates old accounts.

### Our Plan for Sentinel

| Phase | Authority | Rationale |
|-------|-----------|-----------|
| Local dev / testing | Developer keypair | Fast iteration |
| Devnet / testnet | Developer keypair | Still iterating on design |
| Mainnet launch | Squads multisig (2-of-3) | No single point of compromise |
| Post-audit (optional) | Frozen with `--final` | Maximum trust — code cannot change |

---

## 10. Key Differences Summary Table

| Concept | Soroban | Solana/Anchor |
|---------|---------|---------------|
| **Contract / Program** | Each contract = code + state. Deploy per instance (e.g., one FlightPool contract per flight). | Program = code only, deployed once. State lives in separate PDA accounts. |
| **State Storage** | `env.storage().persistent().set(&DataKey::X, &val)` — key-value inside contract. | `#[account] struct X { ... }` — each piece of state is a separate on-chain account with its own address. |
| **Auth Model** | `caller.require_auth()` verifies signature. Compare to stored address. Contract reads its own state. | `Signer<'info>` type verifies signature. `has_one` / `constraint` macros compare to account fields. All accounts passed explicitly. |
| **Token Operations** | `token::Client::new(&env, &addr).transfer(&from, &to, &amt)` — one-liner. Auth handled by Soroban framework. | CPI to SPL Token program. Must pass: from token account, to token account, authority, mint, token_program. PDA authority uses `invoke_signed`. |
| **Cross-Contract Calls** | Auto-generated client: `ContractClient::new(&env, &addr).method(&args)`. Cheap, seamless, feels local. | CPI with ~25K CU overhead. Must pass all callee accounts. 4-level depth limit. Verbose setup. |
| **Deployment** | `env.deployer().with_current_contract(salt)` for deterministic deploys. Each instance is a new contract. New FlightPool = new contract deployment. | `anchor deploy` once per program. New FlightPool = `init` a new PDA account. No additional deployments needed. |
| **Querying** | Call contract functions (`get_route_terms`). No cross-contract storage scan. Lists maintained manually (`ActiveFlightList`). | `getProgramAccounts` with `memcmp` filters scans all accounts owned by a program. No manual list maintenance needed. |
| **Rent / TTL** | Accounts have TTL in ledger sequences. Must call `extend_ttl()` or data gets archived. Can restore for a fee. | Pay rent deposit once at creation (based on byte size). Account lives forever. Close account to reclaim SOL. |
| **Upgradeability** | Re-deploy contract WASM. Existing instances keep old code unless migrated individually. | Upgrade authority replaces program code. All accounts remain untouched. Can transfer authority to multisig or freeze forever. |
| **Error Handling** | `panic!()` or `assert!()` with string messages. Errors are string-based. | `#[error_code] enum SentinelError { #[msg("...")] UnauthorizedKeeper }`. Typed errors with codes. `require!()` macro for assertions. |
| **Testing** | `soroban-sdk` test harness. `Env::default()` gives you a mock ledger. Register contracts, call methods, assert state. | `anchor test` runs a local validator (or `bankrun` for faster in-process tests). Deploy programs, send transactions, assert account state. |
| **Frontend** | Scaffold Stellar auto-generates TypeScript bindings from contract traits. Call contract methods directly. | Anchor IDL generates TypeScript client. Must construct transactions with all accounts listed. Use `@coral-xyz/anchor` client library. |

---

### Quick Reference: Sentinel Architecture Mapping

```
SOROBAN (6 contracts)                    SOLANA (3 programs)
========================                 ========================

GovernanceModule (contract)    ──►       governance_program
  ├─ DataKey::Owner                        ├─ GovConfig PDA
  ├─ DataKey::Admin(addr)                  ├─ AdminRecord PDA (per admin)
  ├─ DataKey::DefaultPremium/Payoff/Delay  ├─ GovConfig PDA (fields)
  ├─ DataKey::Route(f, o, d)               ├─ RouteAccount PDA (per route)
  └─ DataKey::RouteList                    └─ (use getProgramAccounts)

RiskVault (contract)           ──►       vault_program
  ├─ VaultKey::Controller                  ├─ VaultConfig PDA
  ├─ VaultKey::TotalManagedAssets          ├─ VaultConfig PDA (field)
  ├─ VaultKey::LockedCapital               ├─ VaultConfig PDA (field)
  ├─ VaultKey::WithdrawalQueue             ├─ WithdrawalRequest PDA (per request)
  ├─ VaultKey::ClaimableBalance(addr)      ├─ ClaimableBalance PDA (per user)
  └─ VaultKey::SnapshotPrice(day)          └─ SnapshotRecord PDA (per day)

Controller (contract)          ──►   controller_program
                                       ├─ ControllerConfig PDA
                                       └─ ActiveFlightList PDA

FlightPool (contract, per flight) ──►   flight_pool_program
RecoveryPool (contract)           ──┘     ├─ FlightPoolConfig PDA (incl. recovered_balance)
  PoolKey::Buyer(addr)                    ├─ FlightPool PDA (per flight)
                                          ├─ BuyerRecord PDA (per buyer per pool)
                                          └─ pool_treasury (token account, PDA-owned)

OracleAggregator (contract)    ──►   oracle_aggregator_program
  OracleKey::FlightData(f, d)         ├─ OracleConfig PDA
                                      └─ FlightData PDA (per flight)
  PoolKey::Claimed(addr)

Off-chain crons:
  Soroban: 3 crons              ──►       Solana: 2 crons
    FlightDataFetcher                        FlightDataFetcher (same)
    FlightClassifier             ──┐
    SettlementExecutor           ──┴──►      FlightProcessor (combined)
```
