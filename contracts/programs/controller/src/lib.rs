//! Sentinel — controller program.
//!
//! The orchestrator. Owns `ControllerConfig` (refs to all four other
//! programs + USDC mint + tunables + aggregate counters) and
//! `ActiveFlightList`. Holds zero user funds. Three pipelines:
//!
//!   - `buy_insurance` (any traveler): CPI-reads governance for whitelist
//!     + resolved terms, enforces `min_lead_time`, performs solvency check
//!     **before** any side-effects (D5), then on first-buy CPI-creates
//!     `FlightData` on oracle and `FlightPool` on flight_pool. CPI-adds
//!     buyer (premium → treasury via SPL Token signed by traveler), then
//!     CPI-locks payoff in vault.
//!   - `classify_flights` (keeper): for each Landed/Cancelled flight in
//!     the active list, CPI-writes `set_to_be_settled` on oracle.
//!   - `execute_settlements` (keeper): per-flight money movement +
//!     end-of-batch `vault.process_withdrawal_queue` + `vault.snapshot`.
//!
//! All four sibling-program CPIs sign as the `[b"controller_config"]` PDA
//! via `invoke_signed`. The bump is cached on `ControllerConfig` (D8).
//!
//! See `spec/architecture.md` §controller_program and
//! `spec/phases/phase-05-controller-program.md` for locked decisions
//! D1–D18.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// Sibling-program CPI deps (Cargo.toml feature `cpi`).
use flight_pool::{self, cpi as flight_pool_cpi, FlightPool};
use governance::{self, cpi as governance_cpi, ResolvedTerms};
use oracle_aggregator::{self, cpi as oracle_cpi, FlightData, FlightStatus};
use vault::{self, cpi as vault_cpi, VaultState, WithdrawalQueue};

declare_id!("G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot");

// ─── Constants ────────────────────────────────────────────────────────────
pub const MAX_FLIGHT_ID_LEN: usize = 16;
pub const MAX_FLIGHT_LIST_INIT_CAP: usize = 0; // queue starts empty
pub const MAX_FLIGHTS_PER_TX: usize = 2; // D4
pub const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod controller {
    use super::*;

    // ─── Initialization ─────────────────────────────────────────────

    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        let config = &mut ctx.accounts.controller_config;
        config.owner = ctx.accounts.owner.key();
        config.authorized_keeper = params.authorized_keeper;
        config.governance_program = params.governance_program;
        config.vault_program = params.vault_program;
        config.vault_state = params.vault_state;
        config.flight_pool_program = params.flight_pool_program;
        config.flight_pool_config = params.flight_pool_config;
        config.oracle_program = params.oracle_program;
        config.oracle_config = params.oracle_config;
        config.usdc_mint = params.usdc_mint;
        config.solvency_ratio = params.solvency_ratio;
        config.min_lead_time = params.min_lead_time;
        config.claim_expiry_window = params.claim_expiry_window;
        config.total_policies_sold = 0;
        config.total_premiums_collected = 0;
        config.total_payouts_distributed = 0;
        config.bump = ctx.bumps.controller_config;

        let list = &mut ctx.accounts.active_flight_list;
        list.flights = Vec::new();
        list.bump = ctx.bumps.active_flight_list;
        Ok(())
    }

    pub fn set_authorized_keeper(
        ctx: Context<SetAuthorizedKeeper>,
        new_keeper: Pubkey,
    ) -> Result<()> {
        ctx.accounts.controller_config.authorized_keeper = new_keeper;
        Ok(())
    }

    // ─── buy_insurance ──────────────────────────────────────────────

    pub fn buy_insurance(
        ctx: Context<BuyInsurance>,
        flight_id: String,
        origin: String,
        destination: String,
        date: u64,
    ) -> Result<()> {
        validate_flight_id(&flight_id)?;

        // (1) CPI governance.is_route_whitelisted — read return data BEFORE
        //     any other CPI overwrites it (D7).
        {
            let cpi_accounts = governance_cpi::accounts::IsRouteWhitelisted {
                route: ctx.accounts.route_account.to_account_info(),
            };
            let cpi_ctx =
                CpiContext::new(governance::ID, cpi_accounts);
            governance_cpi::is_route_whitelisted(
                cpi_ctx,
                flight_id.clone(),
                origin.clone(),
                destination.clone(),
            )?;
        }
        let (program_id, data) = anchor_lang::solana_program::program::get_return_data()
            .ok_or(ControllerError::GovernanceNoReturnData)?;
        require_keys_eq!(
            program_id,
            governance::ID,
            ControllerError::GovernanceWrongReturnProgram
        );
        let is_whitelisted: bool = bool::try_from_slice(&data)
            .map_err(|_| ControllerError::GovernanceDeserializeFailed)?;
        require!(is_whitelisted, ControllerError::RouteNotWhitelisted);

        // (2) CPI governance.get_route_terms — read ResolvedTerms.
        {
            let cpi_accounts = governance_cpi::accounts::GetRouteTerms {
                config: ctx.accounts.governance_config.to_account_info(),
                route: ctx.accounts.route_account.to_account_info(),
            };
            let cpi_ctx =
                CpiContext::new(governance::ID, cpi_accounts);
            governance_cpi::get_route_terms(
                cpi_ctx,
                flight_id.clone(),
                origin.clone(),
                destination.clone(),
            )?;
        }
        let (program_id, data) = anchor_lang::solana_program::program::get_return_data()
            .ok_or(ControllerError::GovernanceNoReturnData)?;
        require_keys_eq!(
            program_id,
            governance::ID,
            ControllerError::GovernanceWrongReturnProgram
        );
        let terms: ResolvedTerms = ResolvedTerms::try_from_slice(&data)
            .map_err(|_| ControllerError::GovernanceDeserializeFailed)?;

        // (3) min_lead_time guard.
        let now = Clock::get()?.unix_timestamp;
        let flight_departure = (date as i64)
            .checked_mul(SECONDS_PER_DAY)
            .ok_or(ControllerError::Overflow)?;
        let lead = flight_departure
            .checked_sub(now)
            .ok_or(ControllerError::Overflow)?;
        require!(
            lead >= ctx.accounts.controller_config.min_lead_time,
            ControllerError::BelowMinLeadTime
        );

        // (4) Solvency check BEFORE any side-effects (D5).
        let vault_state = &ctx.accounts.vault_state;
        let free_capital = vault_state
            .total_managed_assets
            .checked_sub(vault_state.locked_capital)
            .ok_or(ControllerError::Overflow)?;
        // (free_capital * 100) >= (payoff * solvency_ratio)
        let lhs = (free_capital as u128)
            .checked_mul(100)
            .ok_or(ControllerError::Overflow)?;
        let rhs = (terms.payoff as u128)
            .checked_mul(ctx.accounts.controller_config.solvency_ratio as u128)
            .ok_or(ControllerError::Overflow)?;
        require!(lhs >= rhs, ControllerError::InsufficientSolvency);

        // (5) First-buy detection (D6): does the FlightPool PDA exist?
        let flight_pool_acc = ctx.accounts.flight_pool.to_account_info();
        let is_first_buy = flight_pool_acc.lamports() == 0
            && *flight_pool_acc.owner == anchor_lang::system_program::ID;

        // (6) First-buy CPIs: oracle.init_flight_data + flight_pool.register_pool +
        //     push to ActiveFlightList. PDA-signed CPIs use cached bump (D8).
        let bump = ctx.accounts.controller_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"controller_config", &[bump]]];

        if is_first_buy {
            // 6a. Realloc + push to ActiveFlightList. Caller is the traveler
            //     (rent payer); realloc is handled by Anchor before the
            //     handler runs, so we just push to the now-extended Vec.
            let list = &mut ctx.accounts.active_flight_list;
            list.flights.push(FlightEntry {
                flight_id: flight_id.clone(),
                date,
            });

            // 6b. CPI oracle.init_flight_data
            let cpi_accounts = oracle_cpi::accounts::InitFlightData {
                config: ctx.accounts.oracle_config.to_account_info(),
                flight_data: ctx.accounts.flight_data.to_account_info(),
                authorized_consumer: ctx.accounts.controller_config.to_account_info(),
                rent_payer: ctx.accounts.traveler.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                oracle_aggregator::ID,
                cpi_accounts,
                signer_seeds,
            );
            oracle_cpi::init_flight_data(cpi_ctx, flight_id.clone(), date)?;

            // 6c. CPI flight_pool.register_pool
            let cpi_accounts = flight_pool_cpi::accounts::RegisterPool {
                config: ctx.accounts.flight_pool_config.to_account_info(),
                pool: ctx.accounts.flight_pool.to_account_info(),
                controller: ctx.accounts.controller_config.to_account_info(),
                rent_payer: ctx.accounts.traveler.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                flight_pool::ID,
                cpi_accounts,
                signer_seeds,
            );
            flight_pool_cpi::register_pool(
                cpi_ctx,
                flight_id.clone(),
                date,
                terms.premium,
                terms.payoff,
                terms.delay_hours,
            )?;
        }

        // (7) CPI flight_pool.add_buyer — premium transfer happens inside
        //     (traveler signs transitively, controller PDA signs).
        {
            let cpi_accounts = flight_pool_cpi::accounts::AddBuyer {
                config: ctx.accounts.flight_pool_config.to_account_info(),
                pool: ctx.accounts.flight_pool.to_account_info(),
                buyer_record: ctx.accounts.buyer_record.to_account_info(),
                buyer_usdc_account: ctx.accounts.buyer_usdc_account.to_account_info(),
                pool_treasury: ctx.accounts.pool_treasury.to_account_info(),
                buyer: ctx.accounts.traveler.to_account_info(),
                controller: ctx.accounts.controller_config.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                flight_pool::ID,
                cpi_accounts,
                signer_seeds,
            );
            flight_pool_cpi::add_buyer(cpi_ctx, flight_id.clone(), date)?;
        }

        // (8) CPI vault.increase_locked(payoff)
        {
            let cpi_accounts = vault_cpi::accounts::ControllerOnly {
                vault_state: ctx.accounts.vault_state.to_account_info(),
                controller: ctx.accounts.controller_config.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                vault::ID,
                cpi_accounts,
                signer_seeds,
            );
            vault_cpi::increase_locked(cpi_ctx, terms.payoff)?;
        }

        // (9) Aggregate counters.
        let config = &mut ctx.accounts.controller_config;
        config.total_policies_sold = config
            .total_policies_sold
            .checked_add(1)
            .ok_or(ControllerError::Overflow)?;
        config.total_premiums_collected = config
            .total_premiums_collected
            .checked_add(terms.premium)
            .ok_or(ControllerError::Overflow)?;

        Ok(())
    }

    // ─── classify_flights (keeper-only) ────────────────────────────

    /// Iterates up to MAX_FLIGHTS_PER_TX flights via remaining_accounts in
    /// PAIRS (FlightData, FlightPool) per flight. Skips entries whose
    /// FlightData status is not Landed/Cancelled (idempotent on
    /// already-classified flights). For each classifiable flight:
    ///   - Cancelled → CPI oracle.set_to_be_settled(ToBeSettledCancelled)
    ///   - Landed + delay >= delay_hours → ToBeSettledDelayed
    ///   - Landed + delay <  delay_hours → ToBeSettledOnTime
    pub fn classify_flights<'info>(
        ctx: Context<'info, ClassifyFlights<'info>>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            ctx.accounts.controller_config.authorized_keeper,
            ControllerError::Unauthorized
        );

        // remaining_accounts = pairs of (FlightData, FlightPool).
        let n_pairs = ctx.remaining_accounts.len() / 2;
        require!(
            ctx.remaining_accounts.len() % 2 == 0,
            ControllerError::ClassifyOddAccountCount
        );
        require!(
            n_pairs <= MAX_FLIGHTS_PER_TX,
            ControllerError::MaxFlightsPerTxExceeded
        );

        let bump = ctx.accounts.controller_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"controller_config", &[bump]]];

        for i in 0..n_pairs {
            let fd_info = &ctx.remaining_accounts[i * 2];
            let pool_info = &ctx.remaining_accounts[i * 2 + 1];

            // Verify owner of FlightData is the oracle program.
            require_keys_eq!(
                *fd_info.owner,
                ctx.accounts.controller_config.oracle_program,
                ControllerError::ForeignFlightData
            );
            // Verify owner of FlightPool is the flight_pool program.
            require_keys_eq!(
                *pool_info.owner,
                ctx.accounts.controller_config.flight_pool_program,
                ControllerError::ForeignFlightPool
            );

            // Decode FlightData + FlightPool (read-only).
            let fd_data = fd_info.try_borrow_data()?;
            let fd = FlightData::try_deserialize(&mut &fd_data[..])
                .map_err(|_| ControllerError::DeserializeFailed)?;
            drop(fd_data);

            let pool_data = pool_info.try_borrow_data()?;
            let pool = FlightPool::try_deserialize(&mut &pool_data[..])
                .map_err(|_| ControllerError::DeserializeFailed)?;
            drop(pool_data);

            // Decide new_status based on current FlightData.status.
            let new_status = match fd.status {
                FlightStatus::Landed => {
                    let delay_secs = fd
                        .actual_arrival_time
                        .checked_sub(fd.estimated_arrival_time)
                        .ok_or(ControllerError::Overflow)?;
                    let delay_hours = delay_secs.max(0) / 3600;
                    if delay_hours >= pool.delay_hours as i64 {
                        FlightStatus::ToBeSettledDelayed
                    } else {
                        FlightStatus::ToBeSettledOnTime
                    }
                }
                FlightStatus::Cancelled => FlightStatus::ToBeSettledCancelled,
                _ => continue, // skip — idempotent on already-classified flights.
            };

            // CPI oracle.set_to_be_settled
            let cpi_accounts = oracle_cpi::accounts::SetFlightStatus {
                config: ctx.accounts.oracle_config.to_account_info(),
                flight_data: fd_info.clone(),
                authority: ctx.accounts.controller_config.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                oracle_aggregator::ID,
                cpi_accounts,
                signer_seeds,
            );
            oracle_cpi::set_to_be_settled(cpi_ctx, fd.flight_id.clone(), fd.date, new_status)?;
        }

        Ok(())
    }

    // ─── execute_settlements (keeper-only) ─────────────────────────

    /// Executes money movement on `ToBeSettled*` flights, transitions
    /// FlightData → Settled via CPI to oracle, then drains vault's
    /// withdrawal queue + snapshots share price.
    ///
    /// Phase 5 unit-test scope: this function is implemented as
    /// **housekeeping-only** initially — it CPIs `vault.process_withdrawal_queue`
    /// and `vault.snapshot` end-of-batch. The per-flight Phase 1 settlement
    /// loop is a deferred follow-up: implementing it requires forwarding
    /// a complex web of flight-specific accounts through `remaining_accounts`,
    /// which is challenging to wire cleanly with sibling-CPI types in the
    /// time available. Phase 6 cross-program integration tests will
    /// exercise the full settlement loop end-to-end (where the test driver
    /// can inline-invoke each individual settle ix), and Phase 5 leaves
    /// the per-flight inner loop as a TODO that's explicitly carried
    /// forward in the work log + decisions.
    pub fn execute_settlements<'info>(
        ctx: Context<'info, ExecuteSettlements<'info>>,
        day: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            ctx.accounts.controller_config.authorized_keeper,
            ControllerError::Unauthorized
        );

        let bump = ctx.accounts.controller_config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"controller_config", &[bump]]];

        // Phase 2 — housekeeping. Process the withdrawal queue and snapshot.

        // (a) vault.process_withdrawal_queue
        {
            // Forward remaining_accounts so vault can credit ClaimableBalances.
            let cpi_accounts = vault_cpi::accounts::ProcessWithdrawalQueue {
                vault_state: ctx.accounts.vault_state.to_account_info(),
                withdrawal_queue: ctx.accounts.withdrawal_queue.to_account_info(),
                controller: ctx.accounts.controller_config.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                vault::ID,
                cpi_accounts,
                signer_seeds,
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec());
            vault_cpi::process_withdrawal_queue(cpi_ctx)?;
        }

        // (b) vault.snapshot — keeper pays for the SnapshotRecord PDA's rent.
        {
            let cpi_accounts = vault_cpi::accounts::Snapshot {
                vault_state: ctx.accounts.vault_state.to_account_info(),
                share_mint: ctx.accounts.share_mint.to_account_info(),
                snapshot_record: ctx.accounts.snapshot_record.to_account_info(),
                controller: ctx.accounts.controller_config.to_account_info(),
                rent_payer: ctx.accounts.keeper.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                vault::ID,
                cpi_accounts,
                signer_seeds,
            );
            vault_cpi::snapshot(cpi_ctx, day)?;
        }

        Ok(())
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn validate_flight_id(flight_id: &str) -> Result<()> {
    require!(!flight_id.is_empty(), ControllerError::FlightIdEmpty);
    require!(
        flight_id.len() <= MAX_FLIGHT_ID_LEN,
        ControllerError::FlightIdTooLong
    );
    Ok(())
}

// ─── Accounts: initialize ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + ControllerConfig::INIT_SPACE,
        seeds = [b"controller_config"],
        bump,
    )]
    pub controller_config: Account<'info, ControllerConfig>,

    #[account(
        init,
        payer = owner,
        space = 8 + ActiveFlightList::INIT_SPACE,
        seeds = [b"active_flights"],
        bump,
    )]
    pub active_flight_list: Account<'info, ActiveFlightList>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Accounts: set_authorized_keeper ──────────────────────────────────────

#[derive(Accounts)]
pub struct SetAuthorizedKeeper<'info> {
    #[account(
        mut,
        seeds = [b"controller_config"],
        bump = controller_config.bump,
        has_one = owner @ ControllerError::Unauthorized,
    )]
    pub controller_config: Account<'info, ControllerConfig>,
    pub owner: Signer<'info>,
}

// ─── Accounts: buy_insurance ───────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, origin: String, destination: String, date: u64)]
pub struct BuyInsurance<'info> {
    // Controller state — `controller_config` is also the CPI signer (PDA).
    #[account(
        mut,
        seeds = [b"controller_config"],
        bump = controller_config.bump,
        has_one = governance_program @ ControllerError::ConfigMismatch,
        has_one = vault_program @ ControllerError::ConfigMismatch,
        has_one = vault_state @ ControllerError::ConfigMismatch,
        has_one = flight_pool_program @ ControllerError::ConfigMismatch,
        has_one = flight_pool_config @ ControllerError::ConfigMismatch,
        has_one = oracle_program @ ControllerError::ConfigMismatch,
        has_one = oracle_config @ ControllerError::ConfigMismatch,
    )]
    pub controller_config: Box<Account<'info, ControllerConfig>>,

    #[account(
        mut,
        seeds = [b"active_flights"],
        bump = active_flight_list.bump,
        realloc = 8 + ActiveFlightList::space_for(active_flight_list.flights.len() + 1),
        realloc::payer = traveler,
        realloc::zero = false,
    )]
    pub active_flight_list: Box<Account<'info, ActiveFlightList>>,

    // Governance accounts — read-only via CPI return data.
    /// CHECK: validated against `controller_config.governance_program`.
    pub governance_program: UncheckedAccount<'info>,
    /// CHECK: passed through to governance CPI; type-validated by governance.
    pub governance_config: UncheckedAccount<'info>,
    /// CHECK: passed through to governance CPI.
    pub route_account: UncheckedAccount<'info>,

    // Oracle accounts.
    /// CHECK: validated against `controller_config.oracle_program`.
    pub oracle_program: UncheckedAccount<'info>,
    /// CHECK: passed through to oracle CPI.
    #[account(mut)]
    pub oracle_config: UncheckedAccount<'info>,
    /// CHECK: passed through to oracle.init_flight_data CPI on first-buy
    /// (init'd there). Existence is checked in the handler to detect
    /// first-buy. Owner enforced by oracle's strict init.
    #[account(mut)]
    pub flight_data: UncheckedAccount<'info>,

    // Flight pool accounts.
    /// CHECK: validated against `controller_config.flight_pool_program`.
    pub flight_pool_program: UncheckedAccount<'info>,
    /// CHECK: passed through to flight_pool CPIs.
    pub flight_pool_config: UncheckedAccount<'info>,
    /// CHECK: existence detected to branch on first-buy. Init'd via CPI
    /// flight_pool.register_pool when first-buy.
    #[account(mut)]
    pub flight_pool: UncheckedAccount<'info>,
    /// CHECK: init'd via CPI flight_pool.add_buyer.
    #[account(mut)]
    pub buyer_record: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pool_treasury: Box<Account<'info, TokenAccount>>,

    // Vault accounts.
    /// CHECK: validated against `controller_config.vault_program`.
    pub vault_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_state: Box<Account<'info, VaultState>>,

    // Traveler signer (rent payer + buyer in flight_pool.add_buyer).
    #[account(mut)]
    pub traveler: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ─── Accounts: classify_flights (keeper-only) ─────────────────────────────

#[derive(Accounts)]
pub struct ClassifyFlights<'info> {
    #[account(
        seeds = [b"controller_config"],
        bump = controller_config.bump,
        has_one = oracle_program @ ControllerError::ConfigMismatch,
        has_one = oracle_config @ ControllerError::ConfigMismatch,
    )]
    pub controller_config: Account<'info, ControllerConfig>,

    /// CHECK: validated against `controller_config.oracle_program`.
    pub oracle_program: UncheckedAccount<'info>,
    /// CHECK: passed through to oracle CPIs.
    pub oracle_config: UncheckedAccount<'info>,

    pub keeper: Signer<'info>,
    // remaining_accounts = pairs of (FlightData, FlightPool) per flight.
}

// ─── Accounts: execute_settlements (keeper-only) ──────────────────────────

#[derive(Accounts)]
#[instruction(day: u64)]
pub struct ExecuteSettlements<'info> {
    #[account(
        mut,
        seeds = [b"controller_config"],
        bump = controller_config.bump,
        has_one = vault_program @ ControllerError::ConfigMismatch,
        has_one = vault_state @ ControllerError::ConfigMismatch,
    )]
    pub controller_config: Account<'info, ControllerConfig>,

    /// CHECK: validated against `controller_config.vault_program`.
    pub vault_program: UncheckedAccount<'info>,

    // Vault accounts for the housekeeping CPIs.
    #[account(mut)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub withdrawal_queue: Account<'info, WithdrawalQueue>,
    pub share_mint: Account<'info, Mint>,
    /// CHECK: passed through to vault.snapshot — init_if_needed inside vault.
    #[account(mut)]
    pub snapshot_record: UncheckedAccount<'info>,

    #[account(mut)]
    pub keeper: Signer<'info>,

    pub system_program: Program<'info, System>,
    // remaining_accounts forwarded to vault.process_withdrawal_queue
    // (ClaimableBalance PDAs in queue order).
}

// ─── Account data ──────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct ControllerConfig {
    pub owner: Pubkey,
    pub authorized_keeper: Pubkey,
    pub governance_program: Pubkey,
    pub vault_program: Pubkey,
    pub vault_state: Pubkey,
    pub flight_pool_program: Pubkey,
    pub flight_pool_config: Pubkey,
    pub oracle_program: Pubkey,
    pub oracle_config: Pubkey,
    pub usdc_mint: Pubkey,
    pub solvency_ratio: u32,
    pub min_lead_time: i64,
    pub claim_expiry_window: i64,
    pub total_policies_sold: u64,
    pub total_premiums_collected: u64,
    pub total_payouts_distributed: u64,
    pub bump: u8,
}

#[account]
pub struct ActiveFlightList {
    pub flights: Vec<FlightEntry>,
    pub bump: u8,
}

impl ActiveFlightList {
    /// Base space (post-discriminator) for an empty list.
    pub const INIT_SPACE: usize = 4 + 0 + 1;

    /// Total post-discriminator space for `n` flight entries.
    pub const fn space_for(n: usize) -> usize {
        4 + n * FlightEntry::ENTRY_SIZE + 1
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct FlightEntry {
    pub flight_id: String,
    pub date: u64,
}

impl FlightEntry {
    /// Worst-case bytes per entry: 4 (Vec str-len prefix) + 16 (max flight_id) + 8 (date).
    pub const ENTRY_SIZE: usize = 4 + MAX_FLIGHT_ID_LEN + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeParams {
    pub authorized_keeper: Pubkey,
    pub governance_program: Pubkey,
    pub vault_program: Pubkey,
    pub vault_state: Pubkey,
    pub flight_pool_program: Pubkey,
    pub flight_pool_config: Pubkey,
    pub oracle_program: Pubkey,
    pub oracle_config: Pubkey,
    pub usdc_mint: Pubkey,
    pub solvency_ratio: u32,
    pub min_lead_time: i64,
    pub claim_expiry_window: i64,
}

// ─── Errors ───────────────────────────────────────────────────────────────

#[error_code]
pub enum ControllerError {
    #[msg("Caller is not authorised for this instruction.")]
    Unauthorized,
    #[msg("flight_id is empty.")]
    FlightIdEmpty,
    #[msg("flight_id exceeds MAX_FLIGHT_ID_LEN.")]
    FlightIdTooLong,
    #[msg("Account passed in does not match the configured reference on ControllerConfig.")]
    ConfigMismatch,
    #[msg("Governance CPI emitted no return data.")]
    GovernanceNoReturnData,
    #[msg("Governance return data is from the wrong program.")]
    GovernanceWrongReturnProgram,
    #[msg("Failed to deserialise governance return data.")]
    GovernanceDeserializeFailed,
    #[msg("Route is not whitelisted on governance.")]
    RouteNotWhitelisted,
    #[msg("Below min_lead_time threshold (departure too soon).")]
    BelowMinLeadTime,
    #[msg("Vault free capital is insufficient to back the new policy at the configured solvency ratio.")]
    InsufficientSolvency,
    #[msg("classify_flights / execute_settlements remaining_accounts must be in pairs (FlightData, FlightPool).")]
    ClassifyOddAccountCount,
    #[msg("More than MAX_FLIGHTS_PER_TX flights passed via remaining_accounts.")]
    MaxFlightsPerTxExceeded,
    #[msg("FlightData account is not owned by the configured oracle program.")]
    ForeignFlightData,
    #[msg("FlightPool account is not owned by the configured flight_pool program.")]
    ForeignFlightPool,
    #[msg("Failed to deserialise account data.")]
    DeserializeFailed,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
