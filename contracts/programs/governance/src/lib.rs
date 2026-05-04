//! Sentinel — governance program (Phase 0 no-op skeleton).
//!
//! Phase 1 will implement:
//!   - GovernanceConfig + RouteAccount + AdminRecord PDAs
//!   - whitelist_route / disable_route / update_route_terms / get_route_terms
//!   - add_admin / remove_admin
//!
//! This file is a wiring placeholder so the workspace builds end-to-end
//! and the IDL → Codama → Kit-client pipeline can be exercised.

use anchor_lang::prelude::*;

declare_id!("Ex7rbjNscqZqsqL9b24etRAKrNegDr8Ez7ftMVietUPE");

#[program]
pub mod governance {
    use super::*;

    /// No-op initializer for Phase 0 wiring. Replaced in Phase 1.
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
        space = 8 + GovernanceState::INIT_SPACE,
        seeds = [b"governance_state"],
        bump,
    )]
    pub state: Account<'info, GovernanceState>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct GovernanceState {
    pub bump: u8,
}
