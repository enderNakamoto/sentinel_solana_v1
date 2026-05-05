//! Sentinel — controller program (Phase 0 no-op skeleton).
//!
//! Phase 5 will implement:
//!   - ControllerConfig (refs to governance, vault, flight_pool, oracle, etc.)
//!   - ActiveFlightList
//!   - buy_insurance: CPIs governance.is_route_whitelisted /
//!     get_route_terms, oracle.init_flight_data, flight_pool.register_pool /
//!     add_buyer, vault.increase_locked
//!   - keeper-gated classify_flights: reads FlightData (passed in,
//!     owner-checked), CPIs oracle.set_to_be_settled
//!   - keeper-gated execute_settlements: CPIs vault, flight_pool, oracle.set_settled

use anchor_lang::prelude::*;

declare_id!("G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot");

#[program]
pub mod controller {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.bump = ctx.bumps.state;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ControllerConfig::INIT_SPACE,
        seeds = [b"controller_config"],
        bump,
    )]
    pub state: Account<'info, ControllerConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct ControllerConfig {
    pub bump: u8,
}
