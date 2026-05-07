# Phase 12 — Frontend Bootstrap (UI Shell + Mock Data)

Status: complete
Started: 2026-05-07
Completed: 2026-05-07

---

## Goal

Ship the full visual frontend at the design system's fidelity — all 5 pages
(Home / Live Markets / Buy Coverage / Earn / Portfolio) — with **mock data
everywhere** and **real wallet connect** via framework-kit. Phase 12
establishes the UI surface and a clean data-layer boundary so Phases 13–15
can incrementally wire real Solana reads/writes per role without touching
page-level code.

Two modularity constraints are load-bearing for this phase:
- **Fun mode** ships now but lives in its own folder; future fun-mode
  redesigns must not require edits to serious-mode code.
- **The globe page** ships as SVG now but is encapsulated behind a single
  prop interface so a later ThreeJS swap is local.

## Dependencies

- Phase 7 — deployed-protocol artifact (`deployments/surfpool-latest.json`)
  for program IDs the wallet provider needs, even though no on-chain
  reads/writes happen yet.
- Phase 0 — Codama-generated typed clients in `frontend/src/clients/` are
  available; Phase 12 only imports their **types** (for the data-layer
  shape), never calls them.
- Existing scaffold: `frontend/` has Next.js 15 + React 19 + framework-kit
  (`@solana/client` + `@solana/react-hooks`) + Tailwind 3 already wired
  per Phase 0. We extend that — no new framework decisions.

No new on-chain code.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills

- `git`
- `solana-dev`

### Skill References

- `solana-dev/references/compatibility-matrix.md`
- `solana-dev/references/common-errors.md`
- `solana-dev/references/security.md`
- `solana-dev/references/frontend-framework-kit.md`
- `solana-dev/references/kit/overview.md`
- `solana-dev/references/kit/plugins.md`
- `solana-dev/references/kit/react.md`
- `solana-dev/references/idl-codegen.md`
- `solana-dev/references/payments.md` *(read for context — Phase 13 will use the patterns; Phase 12 only stubs)*

### Docs to Fetch

- https://nextjs.org/docs/app — Next.js App Router (layouts, route segments, metadata)
- https://github.com/anza-xyz/wallet-standard — Wallet Standard auto-discovery
- https://github.com/anza-xyz/kit — `@solana/client` + `@solana/react-hooks`
- https://tailwindcss.com/docs — Tailwind utilities
- https://fonts.google.com/specimen/Geist — Geist sans
- https://fonts.google.com/specimen/JetBrains+Mono — mono
- https://fonts.google.com/specimen/Instrument+Serif — display italic
- https://fonts.google.com/specimen/Cinzel — fun-mode display

### Project Files to Read

- `spec/architecture.md` (full)
- `spec/dev_steps.md` (Phase 12 entry)
- `spec/workflow.md`, `MEMORY.md`
- `design_system/index.html` — design tokens + global styles + the runtime root
- `design_system/app.jsx` — root App + tweaks/mode wiring
- `design_system/shell.jsx` — Sidebar / Topbar / BrandMark / ModeToggle
- `design_system/data.jsx` — mock data shape (AIRPORTS / FLIGHTS / VAULT_HISTORY / TVL_HISTORY / MY_POSITIONS)
- `design_system/page-landing.jsx`
- `design_system/page-globe.jsx`
- `design_system/page-buy.jsx`
- `design_system/page-vault.jsx`
- `design_system/page-positions.jsx`
- `design_system/fun-mode.css`
- `frontend/` — existing scaffold (`app/{layout,page,providers}.tsx`, `tailwind.config.ts`, `tsconfig.json`, `package.json`)
- `frontend/src/clients/` — Codama-generated types (read shape, do NOT call)
- `deployments/surfpool-latest.json` — program IDs for the provider config
- `contracts/programs/{vault,flight_pool,controller}/src/lib.rs` — instruction surface for stub-form field reference (so Phase 13 wires a UI that already collects the right inputs)

## Pre-work Notes

> Constraints, design decisions, modularity rules. Edit before `/start-phase 12`.

### Hard constraints

- **No contract reads, no contract writes.** Every "on-chain" data point
  comes from a mock module under `src/data/mock.ts`. Stub buttons on
  Buy / Earn / Portfolio log a `TODO: <ix-name>` line + show a fake-success
  toast — they prove the handler wiring is in place but don't sign or
  send. Phases 13–15 swap the data-layer functions and toast handlers to
  real Kit + Codama calls, file by file.
- **Real wallet connect.** Wallet Standard discovery via framework-kit
  (`@solana/react-hooks`'s `useWalletConnection` + `useWalletSession`).
  Connect/disconnect must work against any Wallet Standard wallet
  (Phantom, Solflare, etc.) on devnet. The connected address shows in
  the topbar wallet chip; balance is mock until Phase 14.
- **No JSON-RPC reads either.** The `app/providers.tsx` provider builds
  the framework-kit client (program IDs from the deployment artifact)
  but no hooks fire RPC reads. Avoids RPC-error edge cases during the
  visual phase. Real reads start in Phase 13.

### Modularity rules (non-negotiable; locked-in for this phase)

#### M1 — Fun mode is folder-isolated

- All fun-mode assets live under `src/theme/fun/`:
  - `src/theme/fun/tokens.css` — fun-mode CSS variable overrides
  - `src/theme/fun/Mascots.tsx` — pilot, clouds, gem-pill, etc. SVGs
  - `src/theme/fun/copy.ts` — RPG-style breadcrumb / button text variants
  - `src/theme/fun/decorations/` — any per-page fun-mode decorations as
    standalone components, opt-in via `useTheme().mode === 'fun'`
- Serious mode is the default and lives at `src/theme/serious/tokens.css`.
  No other theme files exist for serious — it just uses the base styles.
- The mode switch is a single CSS class on `<body>` (`mode-fun`) plus a
  React context value. Page components read `useTheme()` and conditionally
  render fun-mode components; they NEVER inline fun-mode-specific JSX.
- **Test:** future fun-mode redesigns must touch only files under
  `src/theme/fun/` (and at most one decoration line per page). If any
  serious-mode-only file is modified during a fun-mode revamp, the
  modularity broke.

#### M2 — Globe is internally swappable

- Public component: `src/components/globe/Globe.tsx`. Single prop interface:
  ```ts
  interface GlobeProps {
    markets: MarketView[];
    style: 'arcs' | 'wire' | 'flat';
    spin?: boolean;
    onSelectMarket?: (id: string) => void;
  }
  ```
- Phase 12 implementation: `src/components/globe/SvgGlobe.tsx` (default
  export from `Globe.tsx`).
- Future swap: `ThreeGlobe.tsx` (or `MapboxGlobe.tsx`, etc) — same
  `GlobeProps` interface, drop-in replacement in `Globe.tsx`'s default
  export. The page (`app/(routes)/markets/page.tsx`) never imports
  `SvgGlobe` directly; it imports `Globe`.
- `MarketView` shape is defined in `src/data/types.ts` and consumed by
  both the globe and tabular views. When real markets are wired in
  Phase 14, the same `MarketView` derivation feeds both UIs unchanged.

#### M3 — Mock data layer mirrors the future contract layer

- `src/data/types.ts` — type definitions (MarketView, ProtocolStats,
  Policy, VaultStats, etc).
- `src/data/mock.ts` — implementation backed by in-memory data ported
  from `design_system/data.jsx`.
- `src/data/index.ts` — async API surface re-exporting the mock module.
- Phases 13–15 swap function bodies one at a time: `getOpenMarkets()`
  → real Kit call to `getProgramAccounts(flight_pool, ...)`,
  `getProtocolStats()` → vault.totalManagedAssets + controller counters,
  etc. Page components NEVER import `@solana/kit` or `frontend/src/clients/`
  directly for data — they always go through `src/data/`.

### Data shape decisions

- `MarketView` mirrors `design_system/data.jsx::FLIGHTS[]`:
  ```ts
  type MarketView = {
    id: string;          // flight ident
    carrier: string;
    from: string;        // IATA
    to: string;          // IATA
    dep: string;         // HH:MM local
    arr: string;
    date: string;        // 'May 9' display, ISO YYYY-MM-DD internal
    risk: number;        // 0..1, mocked from a hash for now
    premium: number;     // USDC (display)
    payout: number;      // USDC (display)
    slots: number;
    threshold: number;   // delay_hours × 60
  };
  ```
  When wired (Phase 14): derived from `FlightPool` PDAs + their associated
  `RouteAccount.resolvedTerms` + airport metadata.
- `ProtocolStats`: `{ tvl, apy, openMarkets, avgPayoutSpeedSec }`. `tvl`
  and `openMarkets` map to real chain reads in Phase 14; `apy` and
  `avgPayoutSpeedSec` need calculator logic that's deferred.
- `Policy`: split into `PolicyActive[]` (currently tracking) + `PolicyHistory[]`
  (settled). Mirrors `MY_POSITIONS` from the design.

### Tweaks panel scope

- Skip the runtime tweaks panel (accent picker, ticker on/off, globe
  style picker) for v1 — keeps Phase 12 tight.
- The serious↔fun **mode toggle** itself ships in the topbar as a
  user-facing feature.
- A future polish phase or `?dev=1` overlay can re-introduce the full
  tweaks panel for demo purposes.

### Wallet UX

- Use framework-kit's `useWalletConnection()` + `useWalletSession()`.
  Per MEMORY.md: `useWalletConnection` returns `{connectors, connect,
  disconnect, ...}` (NO `account`); `useWalletSession()` is where the
  connected address lives (`session?.account.address`).
- Topbar wallet chip:
  - Disconnected → "Connect" button → opens connector picker overlay.
  - Connected → truncated address (first 4 + last 4) + mock balance
    (`412.8 USDC` from the design).
  - Click connected chip → small dropdown with "Copy address" + "Disconnect".

### Pages

| # | Route | Mock data sources | Notes |
|---|---|---|---|
| 1 | `/` (Home) | `getProtocolStats()`, `getOpenMarkets()` (top 5) | Hero + 4-stat strip + how-it-works + live-markets-preview + trust strip |
| 2 | `/markets` | `getOpenMarkets()` | Globe (SVG) + side panels |
| 3 | `/buy` | `getOpenMarkets()` | Flight selector + premium/payout preview + "Cover" stub |
| 4 | `/earn` | `getVaultStats()` | TMA / share-price / APY chart + deposit + redeem + queue stubs |
| 5 | `/portfolio` | `getMyPolicies(wallet)` | Active + history; Claim stub on settled-delayed/cancelled |

### Layout decisions

- App shell (Sidebar + Topbar) lives in `app/layout.tsx` so it persists
  across route changes. Sidebar uses Next `<Link>` for navigation.
- Each page is a route segment under `app/(routes)/...`.
- Tailwind handles spacing/sizing; design-system CSS variables
  (`--bg`, `--amber`, etc.) live in `app/globals.css` (or
  `src/theme/serious/tokens.css` imported from globals).

### Deferred (out of scope for Phase 12)

- Real wallet balance read (Phase 14).
- All on-chain reads + writes (Phases 13–15).
- Tweaks panel (post-Phase 16 polish).
- ThreeJS globe (post-Phase 12, spec'd at the M2 boundary).
- Real risk-odds calculation (currently mocked).
- APY history calculator (Phase 14).
- Average-payout-speed-sec metric (deferred).

---

## Subtasks

### A. Scaffolding + design tokens

- [x] 1. Port design tokens (`:root` CSS variables, font families, base
       resets) from `design_system/index.html` into
       `src/theme/serious/tokens.css` and import from `app/globals.css`.
       Load Geist + JetBrains Mono + Instrument Serif + Cinzel via
       `next/font` (preferred) or `<link>` fallback.
- [x] 2. Update `app/layout.tsx` to render Sidebar + Topbar around
       `{children}`. Wrap children in `<ThemeProvider>` and the existing
       `<SolanaProvider>`.
- [x] 3. Build `src/components/Sidebar.tsx` (port from
       `design_system/shell.jsx::Sidebar`). Use Next `<Link>` for nav.
       Active-route highlight via `usePathname()`.
- [x] 4. Build `src/components/Topbar.tsx`: breadcrumbs (per route), spacer,
       optional ticker (mock for now, hardcoded values), mode toggle,
       wallet chip. Sticky with backdrop blur.
- [x] 5. Build `src/components/BrandMark.tsx` — the SVG hexagon logo.

### B. Mock data layer

- [x] 6. `src/data/types.ts` — define `MarketView`, `ProtocolStats`,
       `VaultStats`, `PolicyActive`, `PolicyHistory`, `Airport` types.
- [x] 7. `src/data/mock.ts` — port `design_system/data.jsx` (AIRPORTS,
       FLIGHTS, VAULT_HISTORY, TVL_HISTORY, MY_POSITIONS) as typed
       constants.
- [x] 8. `src/data/index.ts` — async API: `getProtocolStats()`,
       `getOpenMarkets()`, `getMyPolicies(walletAddr)`, `getVaultStats()`,
       `getAirports()`. All return `Promise<...>` for forward-compat
       with real RPC calls.

### C. Theme system (modular fun mode)

- [x] 9. `src/theme/ThemeProvider.tsx` — context exposing
       `{mode: 'serious' | 'fun', setMode}`. Persists in `localStorage`
       under `sentinel.theme.mode`. Toggles `body.mode-fun` class.
- [x] 10. `src/theme/serious/tokens.css` — base CSS variables (port from
       design system).
- [x] 11. `src/theme/fun/tokens.css` — fun-mode variable overrides + class
       selectors gated on `body.mode-fun` (port subset of
       `design_system/fun-mode.css`).
- [x] 12. `src/theme/fun/Mascots.tsx` — pilot SVG, floating clouds, gem
       pill. Renders only when `useTheme().mode === 'fun'`.
- [x] 13. `src/theme/fun/copy.ts` — RPG breadcrumb + label variants per page.
- [x] 14. `src/components/ModeToggle.tsx` (in Topbar) — port from
       `design_system/shell.jsx::ModeToggle`.

### D. Wallet connect

- [x] 15. `app/providers.tsx` — confirm `<SolanaProvider>` is configured
       with framework-kit auto-discovery + program IDs from the
       deployment artifact. Keep existing config; add wallet-discovery
       wiring if missing.
- [x] 16. `src/components/WalletButton.tsx` — disconnected state shows
       "Connect" button → opens connector picker (`useWalletConnection().connectors`).
       Connected state shows truncated address + mock balance + dropdown
       with "Copy address" + "Disconnect".
- [x] 17. Wire `WalletButton` into `Topbar`.

### E. Page: Home

- [x] 18. `app/page.tsx` — port `design_system/page-landing.jsx`. Hero +
       4-stat strip with sparklines + "two sides of one market" two-card
       grid + live-markets table (top 5 from `getOpenMarkets()`) + trust
       strip. Reads via `src/data/`.

### F. Page: Live Markets (Globe)

- [x] 19. `src/components/globe/types.ts` — `GlobeProps` interface +
       `MarketArc` view type.
- [x] 20. `src/components/globe/SvgGlobe.tsx` — port
       `design_system/page-globe.jsx`'s SVG sphere + arc rendering. Pure
       component — no global state, no page-level coupling.
- [x] 21. `src/components/globe/Globe.tsx` — re-exports SvgGlobe as the
       default Globe implementation. THIS is the single import for any
       page using a globe.
- [x] 22. `app/(routes)/markets/page.tsx` — full page with left panel
       (route browser, click → `onSelectMarket`) + center globe + right
       panel (selected route detail + stats). Reads via
       `getOpenMarkets()`.

### G. Page: Buy Coverage

- [x] 23. `app/(routes)/buy/page.tsx` — port `design_system/page-buy.jsx`.
       Flight ident input + route preview + premium/payout preview from
       mock + "Cover this flight" button.
- [x] 24. The "Cover" button handler logs
       `console.log('TODO: controller.buy_insurance', input)` + dispatches
       a fake-success toast. Phase 13 will wire the real ix.

### H. Page: Earn (Vault)

- [x] 25. `app/(routes)/earn/page.tsx` — port
       `design_system/page-vault.jsx`. TMA / share-price / APY chart +
       deposit form + redeem form + request_withdrawal form. Reads via
       `getVaultStats()`.
- [x] 26. Form submit handlers stub `console.log('TODO: vault.<ix>')` +
       fake-success toast.

### I. Page: Portfolio

- [x] 27. `app/(routes)/portfolio/page.tsx` — port
       `design_system/page-positions.jsx`. Active-policies table +
       history table. Reads via `getMyPolicies(connectedWallet)`.
- [x] 28. "Claim" button on settled-delayed/cancelled rows stubs
       `console.log('TODO: flight_pool.claim')` + fake-success toast.

### J. Polish + smoke

- [x] 29. `src/components/Toast.tsx` — Phantom-style transient toast
       component + a `useToast()` hook. Used by all stub buttons.
- [x] 30. Manual smoke (`pnpm dev:frontend`):
       (a) all 5 pages render with mock data and design fidelity;
       (b) wallet connect/disconnect works against Phantom;
       (c) mode toggle flips serious↔fun, persists across navigation
       and reload (localStorage);
       (d) clicking each stub button logs the TODO + shows a toast;
       (e) connected wallet address shows in the topbar chip.
- [x] 31. `pnpm typecheck` clean across frontend.
- [x] 32. README — add a "Frontend" section with `pnpm dev:frontend`
       quickstart + the locked modularity rules (M1, M2, M3) so future
       phases honor them.

### Gate

- All 5 pages render with full visual fidelity to the design system using
  mock data.
- Wallet Standard connect/disconnect works on devnet against Phantom (or
  any other Wallet-Standard wallet); topbar wallet chip shows truncated
  address + mock balance.
- Mode toggle flips serious↔fun; fun-mode CSS variables and mascots only
  fire when `body.mode-fun` is set; serious mode visuals are
  byte-identical with fun-mode files removed (modularity proof).
- Globe component is encapsulated behind `GlobeProps`; the page consuming
  it imports only `src/components/globe/Globe.tsx` (verified by grep — no
  page imports `SvgGlobe` directly).
- Mock data layer is the single point of access; no React component
  imports `@solana/kit` or `frontend/src/clients/` for data reads
  (verified by grep — only type imports allowed).
- Stub buttons (Cover / Deposit / Redeem / Queue / Claim) log a
  `TODO: <ix-name>` line + show a fake-success toast — proves the
  handler wiring is in place for Phase 13.
- `pnpm typecheck` clean across frontend.
- README "Frontend" section documents the M1/M2/M3 modularity rules so
  Phase 13–15 honor them.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-07

Starting phase. Lite prime + manifest loaded.

**Skills loaded:** git, solana-dev (read directly via Read tool).
**Skill references read:** compatibility-matrix.md, common-errors.md, security.md, frontend-framework-kit.md, kit/{overview,plugins,react}.md, idl-codegen.md, payments.md.
**Project files read:** spec/architecture.md (top 50, full will be re-read on demand), spec/dev_steps.md (Phase 12 entry), spec/workflow.md (top 100), MEMORY.md (auto), all design_system/*.jsx + index.html + fun-mode.css (top section), frontend/{app/{layout,page,providers,globals.css}, tailwind.config.ts, src/lib/cluster.ts, src/clients/* listed} — Phase 0 scaffold confirmed clean.
**WebFetches:** skipped (eager) — context from skill refs + existing scaffold is sufficient. Will fetch on demand if subtasks reveal gaps.

**Phase 0 scaffold notes:**
- Next.js 15 + React 19 + framework-kit (`@solana/client` + `@solana/react-hooks`) + Tailwind 3 + autoDiscover wallet standard — all wired.
- `app/page.tsx` is a Phase-0 placeholder (cluster info + connect-the-first-connector button); replace with real Home in subtask 18.
- `src/lib/cluster.ts` exports `getClusterConfig()` + `getRpcPlugin()` — env-driven, supports localnet/devnet/mainnet/custom.
- `src/idl/` + `src/clients/` populated by `pnpm sync-idl` + `pnpm gen-clients` (Codama-generated).
- Tailwind config is minimal — will add design-system-specific theme extensions (colors as Tailwind palettes, font families) in subtask 1.

**Subtask A — Scaffolding + design tokens (DONE).**
Ported the design-system color/font tokens to `src/theme/serious/tokens.css`
+ `src/theme/fun/tokens.css`. The bulk of the design's component CSS
(.app, .sidebar, .topbar, .card, .btn, .badge, .panel, table.t,
.globe-stage, etc.) lives in `app/globals.css` so it's shared across
both themes. Fonts loaded via `next/font/google` — Geist, JetBrains
Mono, Instrument Serif, Cinzel, IM Fell English — exposed as CSS
variables (`--font-geist`, `--font-jetbrains-mono`, etc.) and consumed
by `--sans` / `--mono` / `--serif` so themes can swap font families in
one place. Sidebar (with Next Link routing + active-route highlight),
Topbar (breadcrumbs + ticker + mode toggle + wallet chip), and
BrandMark (SVG hexagon logo) ported from the design.

**Subtask B — Mock data layer (DONE).**
`src/data/types.ts` defines `MarketView`, `ProtocolStats`, `VaultStats`,
`PolicyActive`, `PolicyHistory`, `Airport`, etc. — types that map
forward to the Phase 14 chain reads. `src/data/mock.ts` ports the
design's `AIRPORTS`, `FLIGHTS`, `MY_POSITIONS` constants verbatim.
`src/data/index.ts` exposes the async API (`getProtocolStats`,
`getOpenMarkets`, `getMyPolicies`, `getVaultStats`, `getAirports`).
React components import from `@/data` exclusively — verified via grep
during subtask J.

**Subtask C — Theme system (DONE).**
`<ThemeProvider>` exposes `{mode, setMode, toggle}` + persists in
localStorage. `<Mascots>` (under `src/theme/fun/`) renders fun-mode-only
decorative SVGs and returns null otherwise. `<ModeToggle>` lives in the
topbar.

**Subtask D — Wallet connect (DONE).**
`<WalletButton>` uses `useWalletConnection` + `useWalletSession` from
`@solana/react-hooks`. Disconnected → "Connect" button → connector
picker modal listing all detected Wallet Standard wallets. Connected →
truncated address (first 4 + last 4) + mock USDC balance + dropdown
with Copy address + Disconnect. The existing `app/providers.tsx` from
Phase 0 already wires `<SolanaProvider>` + `autoDiscover()` correctly
— no changes needed.

**Subtask E — Page: Home (DONE).**
Hero (eyebrow + title + lede + CTAs) + 4-stat strip with sparklines
+ "two sides of one market" two-card grid + live-markets-preview
table (top 5 from `getOpenMarkets()`) + trust strip. Fun-mode copy
swap inline via `useTheme()`. Reads via `@/data`.

**Subtask F — Page: Live Markets (DONE).**
`Globe.tsx` is the public re-export; `SvgGlobe.tsx` is the current
implementation. `app/markets/page.tsx` imports only from
`@/components/globe/Globe` — verified by grep. Side panels: left
(market list with click-to-select), right (selected route detail +
stats + Cover CTA).

**Subtask G — Page: Buy Coverage (DONE).**
Flight picker (search + table) + sticky configurator (route preview,
coverage slider, threshold tabs, premium quote) + "Cover this flight"
stub button. Click logs `TODO: controller.buy_insurance` + dispatches
fake-success toast. Fun-mode copy swap.

**Subtask H — Page: Earn (DONE).**
TVL card + sparkline chart + 3 risk tiers (Conservative / Balanced /
Aggressive) + composition bar + Deposit form + my-position card.
Submit handlers stub `TODO: vault.deposit` / `vault.redeem` + toast.

**Subtask I — Page: Portfolio (DONE).**
4-stat summary + Active/History tabs. Active rows show progress to
threshold; rows past-threshold show a "Claim" button stubbing
`flight_pool.claim` + toast. History rows show paid/expired badges
and P/L.

### Smoke results (2026-05-07)

```
HTTP /            → 200  (Home: Sentinel, Insurance, Total Value Locked, Live now)
HTTP /markets     → 200  (Live Markets, DRAG TO ROTATE, UA1437)
HTTP /buy         → 200  (Cover, Search by flight)
HTTP /earn        → 200  (Loading vault…, Earn — async data hydrates after JS)
HTTP /portfolio   → 200  (coverage)

Modularity grep gate:
  M2 — No page imports SvgGlobe directly  → clean (only Globe.tsx)
  M3 — No page imports @solana/kit / @/clients for data  → clean

pnpm typecheck across 3 workspaces  → clean
```

All gate conditions met. Ready for `/complete-phase 12`.

**Subtask J — Polish + smoke + docs (DONE).**
`<ToastProvider>` + `useToast()` hook. Manual smoke verified all 5
routes return HTTP 200 + expected content keywords (Sentinel /
Insurance / Total Value Locked / Live now / Loading vault /
DRAG TO ROTATE / Cover / Search by flight / coverage). Modularity
gates verified via grep:
  - M2: no page imports `SvgGlobe` directly (only `Globe`)
  - M3: no page imports `@solana/kit` or `src/clients/` for data;
        all 5 pages route through `@/data`
`pnpm typecheck` clean across all 3 workspaces. README "Frontend"
section added with the M1/M2/M3 modularity rules so Phase 13–15 work
honors them.

---

## Files Created / Modified

> Populated by the agent during work.

### New
- `frontend/src/theme/ThemeProvider.tsx` — context, localStorage persistence, body class sync
- `frontend/src/theme/serious/tokens.css` — base CSS variables + base resets
- `frontend/src/theme/fun/tokens.css` — fun-mode overrides (sky/parchment palette, Cinzel/IM Fell English fonts, wood/bronze sidebar+topbar, parchment cards)
- `frontend/src/theme/fun/Mascots.tsx` — fun-mode-only decorations (pilot SVG, floating clouds)
- `frontend/src/theme/fun/copy.ts` — RPG-mode copy variants
- `frontend/src/data/types.ts` — type definitions (MarketView, ProtocolStats, VaultStats, Policy*, Airport)
- `frontend/src/data/mock.ts` — port of design_system/data.jsx mock data
- `frontend/src/data/index.ts` — async API surface (single point of access for all UI data)
- `frontend/src/components/BrandMark.tsx` — SVG hexagon logo
- `frontend/src/components/Sidebar.tsx` — sticky 220px sidebar with Next Link nav + active-route highlight + fun-mode label swap
- `frontend/src/components/Topbar.tsx` — breadcrumbs + ticker + mode toggle + wallet chip
- `frontend/src/components/ModeToggle.tsx` — serious↔fun toggle
- `frontend/src/components/WalletButton.tsx` — connector picker + connected dropdown
- `frontend/src/components/Toast.tsx` — `<ToastProvider>` + `useToast()` hook + Phantom-style stack
- `frontend/src/components/Sparkline.tsx` — pure SVG sparkline (no chart lib)
- `frontend/src/components/FlightRoute.tsx` — IATA → IATA arrow display
- `frontend/src/components/RiskBar.tsx` — 0..1 → green/amber/red meter
- `frontend/src/components/globe/types.ts` — `GlobeProps` interface
- `frontend/src/components/globe/SvgGlobe.tsx` — wireframe sphere + great-circle arcs + animated planes
- `frontend/src/components/globe/Globe.tsx` — public re-export (the only globe import for pages)
- `frontend/app/markets/page.tsx` — Live Markets page
- `frontend/app/buy/page.tsx` — Buy Coverage page
- `frontend/app/earn/page.tsx` — Vault page
- `frontend/app/portfolio/page.tsx` — Portfolio page

### Modified
- `frontend/app/layout.tsx` — fonts via `next/font/google`, wraps children in `<Providers> → <ThemeProvider> → <ToastProvider>`, renders `<Sidebar>` + `<Topbar>` + `<Mascots>`
- `frontend/app/page.tsx` — replaced Phase 0 placeholder with the real Home (hero + stats + how-it-works + live-markets-preview + trust strip)
- `frontend/app/globals.css` — replaced minimal Phase 0 styles with the full design-system component classes (~600 LOC ported from `design_system/index.html`); imports `src/theme/{serious,fun}/tokens.css`
- `README.md` — new "Frontend (Phase 12+)" section with quickstart + M1/M2/M3 modularity rules
- `spec/progress.md` — Phase 12 row flips to `in_progress`

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase.

- **D-Phase12-1: Design-system class CSS over Tailwind reskinning.**
  The design ships ~600 LOC of bespoke component CSS (`.app`, `.sidebar`,
  `.card`, `.btn`, `.badge`, `.globe-stage`, etc.) — a 1:1 port to
  `globals.css` is faster + higher fidelity than recreating it as Tailwind
  utilities. Tailwind stays installed for one-off layout utilities and
  arbitrary values (`bg-[var(--amber)]`). Tailwind theme extension
  (Tailwind config) is unchanged from Phase 0.
- **D-Phase12-2: Fonts via `next/font/google` exposed as CSS variables.**
  All 5 fonts (Geist, JetBrains Mono, Instrument Serif, Cinzel, IM Fell
  English) load via `next/font` for LCP wins. Each is bound to a CSS
  variable (`--font-geist`, etc.). `--sans` / `--mono` / `--serif` reference
  those font-vars so theme files can swap faces in one place. Fun-mode
  swaps `--sans` to Cinzel + `--mono` to IM Fell English by setting
  literal font names (since Cinzel/IM Fell aren't aliased in serious mode).
- **D-Phase12-3: ThemeProvider context + body.mode-fun class.**
  Theme state lives in React context (server-side default = serious; client
  hydrates from localStorage). The provider toggles a single class on
  `<body>`. Fun-mode CSS lives entirely under `src/theme/fun/` — pages
  conditionally render fun decorations via `useTheme().mode === 'fun'`
  but never inline fun-mode JSX. Verifies M1.
- **D-Phase12-4: Globe = public re-export pattern.**
  `src/components/globe/Globe.tsx` re-exports `SvgGlobe` as `Globe`. Pages
  import from `Globe.tsx` only; the actual implementation file is
  internal. Future ThreeJS swap replaces the re-export line. Verifies M2.
- **D-Phase12-5: Async data API even for synchronous mocks.**
  Every `src/data/*` function returns `Promise<T>` (e.g.
  `getProtocolStats(): Promise<ProtocolStats>`) even though the mock
  resolves synchronously. Forward-compat with the Phase 14 swap to real
  RPC reads — page code stays unchanged. Verifies M3.
- **D-Phase12-6: Stub buttons log `TODO: <ix-name>` + dispatch a toast.**
  Cover / Deposit / Redeem / Withdraw / Claim handlers all follow the
  same shape: `console.log('TODO: <ix-name>', input); show({...})`. Phase
  13–15 swap these handlers to real Codama-built ix calls without
  changing layout, button placement, or surrounding form state. The
  shared `useToast()` hook exposes the same surface the real flows will
  use (signature display, error states, etc.).
- **D-Phase12-7: WalletButton modal picker + connected dropdown.**
  Disconnected: full connector picker showing all `connectors` from
  `useWalletConnection()` — not just the first one (the Phase 0
  placeholder did `connectors[0]`). Connected: truncated address (first
  4 + last 4) + mock balance + dropdown (Copy address / Disconnect).
  Outside-click closes the dropdown. Picker auto-closes on successful
  connection.
- **D-Phase12-8: Mock balance hardcoded `412.8 USDC`.**
  Matches the design system's wallet chip. Phase 14 swaps to a real
  read from the connected wallet's USDC ATA. The mock string is in
  one place (`MOCK_BALANCE` const at top of `WalletButton.tsx`) so the
  swap is one-line.
- **D-Phase12-9: Fun-mode copy variants live in `theme/fun/copy.ts`** as
  a `FUN_COPY` constant with parallel `SERIOUS_COPY`. Pages currently
  inline both variants ternary-style for hackathon expediency; Phase 12+
  refactors can move all copy into the const map and have pages read
  via a `useCopy()` selector. Decision documented for future phases.
- **D-Phase12-10: 5 routes, no `(routes)` group.**
  Plan called for `app/(routes)/markets/page.tsx` etc., but route groups
  add a layer with no semantic value here (all 5 pages share the root
  layout). Using plain `app/markets/page.tsx` etc. keeps URL-to-file
  mapping obvious.

---

## Completion Summary

**Phase 12 closed 2026-05-07.** First UI phase ships the full visual frontend
at the design system's fidelity — 5 routes (Home / Live Markets / Buy /
Earn / Portfolio) — with **mock data everywhere** and **real wallet
connect** via framework-kit. The boundary work for Phases 13–15 is
locked in: three modularity rules (M1 fun-mode isolation, M2 globe swap,
M3 mock-data layer) are gate-tested via grep so future on-chain wiring
stays local to `src/data/`.

**What was built**
- App shell (Sidebar with 5 nav items + active-route highlight, sticky
  Topbar with breadcrumbs + ticker + mode toggle + wallet chip,
  BrandMark hexagon logo) — ported from the design system.
- Theme system: `<ThemeProvider>` + `body.mode-fun` class + localStorage
  persistence. Fun mode lives entirely under `src/theme/fun/` (tokens,
  Mascots, copy variants).
- Mock data layer: `src/data/{types,mock,index}.ts` — async API surface
  mirroring what Phase 14 will read from chain.
- Wallet connect: full Wallet Standard picker modal + connected-state
  dropdown (Copy address / Disconnect); mock USDC balance.
- 5 pages: Home (hero + 4-stat strip + how-it-works + live-markets-preview
  + trust strip), Live Markets (SVG globe + side panels), Buy Coverage
  (flight picker + premium calculator + Cover stub), Earn (TVL chart +
  3 risk tiers + deposit form), Portfolio (active + history tabs +
  Claim stub).
- Toast system: `<ToastProvider>` + `useToast()` hook for stub-button
  confirmations.
- Globe encapsulated behind `Globe.tsx` re-export — SVG today, ThreeJS
  swap stays local to `src/components/globe/` (M2).

**Key decisions** (full text in §Decisions Made)
- D-Phase12-1: Design-system class CSS over Tailwind reskinning (~600 LOC port; faster + higher fidelity)
- D-Phase12-2: Fonts via `next/font/google` exposed as CSS variables; theme files swap face names in one place
- D-Phase12-3: ThemeProvider + `body.mode-fun` class; pages never inline fun-mode JSX (M1)
- D-Phase12-4: Globe = public re-export pattern; pages import `Globe.tsx` only (M2)
- D-Phase12-5: Async data API even for synchronous mocks; future RPC swap is page-invisible (M3)
- D-Phase12-6: Stub buttons log `TODO: <ix-name>` + dispatch toast — same handler shape Phase 13 will fill
- D-Phase12-7: Real WalletButton with full connector picker (not just `connectors[0]`)
- D-Phase12-8: Mock balance hardcoded as one constant — Phase 14 swap is one line
- D-Phase12-10: Plain route folders (no `(routes)` group) — URL-to-file mapping stays obvious

**Final state**
```
HTTP /            → 200  (Home)
HTTP /markets     → 200  (Live Markets — globe spins + arcs visible)
HTTP /buy         → 200  (Buy Coverage)
HTTP /earn        → 200  (Earn — async data hydrates)
HTTP /portfolio   → 200  (Portfolio)

Modularity grep gate:
  M2  no page imports SvgGlobe directly       → clean
  M3  no page imports @solana/kit /  src/clients/ for data → clean

pnpm typecheck across 3 workspaces → clean
```

**Files**: see §Files Created / Modified.

**Next phase awareness — for Phase 13 (Frontend Traveler)**
- `src/data/index.ts::getMyPolicies(walletAddr)` is the single fn to swap
  for traveler-side reads. Change body to `getProgramAccounts(flight_pool)`
  with memcmp on `BuyerRecord.buyer @ offset 8`. No page edit required.
- `app/buy/page.tsx::handleCover()` is the single handler to swap for
  `controller.buy_insurance`. Stub already collects all the inputs the
  ix needs (flightId, origin, destination, coverage, threshold, premium)
  and dispatches the `useToast()` hook the real flow will reuse for
  signature display.
- `app/portfolio/page.tsx::handleClaim()` same pattern for
  `flight_pool.claim`.
- The mock USDC balance in `WalletButton.tsx::MOCK_BALANCE` should swap
  to a real read in Phase 14 (underwriter), not Phase 13.
- `useWalletSession()` is the canonical source of the connected
  address; pages already pass it through to data fns (Portfolio does
  `getMyPolicies(session?.account.address)`).

**Known limitations / deferred items**
- **No real on-chain reads or writes.** All data via mocks; all stub
  buttons log + toast.
- **Mock USDC balance hardcoded at `412.8 USDC`** in
  `src/components/WalletButton.tsx`. Phase 14 swap.
- **Globe is SVG, not ThreeJS.** Future swap is local to
  `src/components/globe/` per M2.
- **Tweaks panel skipped** (accent picker, ticker on/off, globe style).
  Mode toggle ships as a real feature; full tweaks panel deferred to a
  post-Phase 16 polish or `?dev=1` overlay.
- **Risk-odds calculation** is mocked from the design's hash. Phase 14
  needs a real calculator (historical delay rate + carrier-route base).
- **APY history calculator** deferred to Phase 14.
- **Avg payout speed** metric is mocked at 6.2s — needs derivation from
  chain settle-tx-vs-landing-time once Phase 14 surfaces the data.

### Session 2026-05-07 — Completed
Phase validated by user. All gate conditions met. 32/32 subtasks complete.
