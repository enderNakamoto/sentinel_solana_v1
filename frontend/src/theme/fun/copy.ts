/**
 * Fun-mode copy variants.
 *
 * Pages and components import from this map and select via the active
 * theme. Future fun-mode copy revamps land here without touching pages.
 */

export const FUN_COPY = {
  hero: {
    eyebrow: 'AeroQuest · The Skies of Solana',
    title: ['A wager', 'on the', 'fickle', 'winds.'],
    lede:
      'Charter a coverage scroll for any flight — claim your gold the moment the gale carries it astray. Or fund the underwriter chest and earn the spread when skies stay clear.',
    primaryCta: 'Bind a flight',
    secondaryCta: 'Open the vault',
    tertiaryCta: 'Watch the sky map',
  },
  buy: {
    eyebrow: 'Bind a coverage scroll',
    title: 'Wager on the winds.',
    cta: (premium: string) => `Stamp the scroll · ${premium} USDC`,
    settlement: 'Auto · upon landing',
  },
  earn: {
    eyebrow: 'Underwriter chest',
    title: 'Underwrite the skies.',
    primaryCta: (amount: string) => `Add ${amount} USDC to the chest`,
  },
  portfolio: {
    eyebrow: 'Adventurer log',
    title: 'Your scrolls.',
    newCta: '+ Bind another',
  },
  trustStrip: ['◇ ACARS Oracle', '◈ FlightAware', '◇ Switchboard', '◆ Squads Multisig'],
} as const;

export const SERIOUS_COPY = {
  hero: {
    eyebrow: 'Parametric flight delay protocol · Solana',
    title: ['Insurance', 'and', 'alpha,', 'for every', 'delayed', 'flight.'],
    lede:
      'Pay a small premium to get an instant payout when your flight is late. Or deposit into the vault and underwrite the risk for yield. Settled on-chain by oracles, no claims.',
    primaryCta: 'Cover a flight →',
    secondaryCta: 'Earn 12.4% APY',
    tertiaryCta: 'Watch live markets',
  },
  buy: {
    eyebrow: 'Buy coverage',
    title: 'Cover a flight.',
    cta: (premium: string) => `Pay ${premium} USDC · Cover this flight`,
    settlement: 'Auto · on landing',
  },
  earn: {
    eyebrow: 'Earn',
    title: 'Underwrite delays. Earn premiums.',
    primaryCta: (amount: string) => `Deposit ${amount} USDC`,
  },
  portfolio: {
    eyebrow: 'Portfolio',
    title: 'Your coverage.',
    newCta: '+ New coverage',
  },
  trustStrip: ['◇ ACARS Oracle', '◈ FlightAware', '◇ Switchboard', '◆ Squads Multisig'],
} as const;

export type Copy = typeof SERIOUS_COPY;
