# Frontend Reference — Sentinel UI (Serious Mode Only)

A complete, copy-pasteable reference for rebuilding the Sentinel frontend in another project. The original codebase shipped a serious↔fun theme toggle; **fun mode has been stripped from this reference** — only the serious aesthetic (dark, navy/amber/cyan, mono-typographic, parametric-finance look) ships here.

The new project will swap in a different backend (different chain, different program IDs, different stablecoin, or even a non-blockchain backend). The UI is data-source agnostic — all chain calls funnel through `src/data/` and `src/lib/` adapter functions; replace the bodies and the screens keep working.

---

## 1. Quick start (for the receiving agent)

```bash
# 1. Copy this entire folder into your project as the frontend workspace.
cp -r reference/frontend  <new-project>/frontend
cd <new-project>/frontend

# 2. Install deps. pnpm is recommended (matches the lock semantics) but npm works.
pnpm install      # or: npm install

# 3. Configure backend.
cp .env.local.example .env.local   # see §6 — env vars
# Edit .env.local with your RPC URL / API base / stablecoin mint.

# 4. Dev.
pnpm dev          # Next.js on http://localhost:3000
```

If the build fails on a missing module from `@/clients/*`, that's a Solana-IDL-generated path the new backend won't have — see §7 for the swap plan.

---

## 2. Stack

| Layer | What it is | Notes for porting |
|---|---|---|
| Framework | **Next.js 15 App Router** (React 19, TS 5.6) | Server components by default; client components opt in with `'use client'`. Most pages here are client components because of wallet hooks. |
| Styling | **Tailwind 3.4** + a hand-rolled design system in `app/globals.css` | The CSS in `globals.css` is doing most of the lifting — Tailwind utilities are sprinkled but not load-bearing. **Read `globals.css` end-to-end before touching anything visual.** |
| Charts | **recharts 3.x** | Sparkline + snapshot history on /earn use this. |
| Wallet / chain | `@solana/kit` 6.x + `@solana/client` 1.x + `@solana/react-hooks` 1.x (framework-kit) | Wallet Standard via `autoDiscover()` — no `@solana/wallet-adapter-*`. If your new backend isn't Solana, replace `providers.tsx` and all of `src/lib/` and `src/data/onchain.ts`. |
| Codegen | Codama-generated typed clients under `src/clients/` | **Not included here** — these are auto-generated per-program from IDL. The receiving project regenerates against its own programs (or replaces `src/data/onchain.ts` with REST/GraphQL calls). |

### Top-level config files (in this folder)

| File | Purpose |
|---|---|
| `package.json` | Dependencies + scripts (`dev`, `build`, `start`, `typecheck`) |
| `next.config.ts` | Minimal — `reactStrictMode: true` |
| `tailwind.config.ts` | Scans `./src/**/*.{ts,tsx}` and `./app/**/*.{ts,tsx}`; empty `theme.extend` |
| `postcss.config.mjs` | Tailwind + autoprefixer |
| `tsconfig.json` | `paths: { "@/*": ["./src/*"], "@/clients/*", "@/idl/*", "@executor/*" }` — **adjust the last three if your new backend doesn't have a Codama clients dir or an executor workspace** |

---

## 3. Directory layout (what's in this reference folder)

```
reference/frontend/
├── README.md                ← you are here
├── package.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── tsconfig.json
│
├── app/                     ← Next.js App Router pages
│   ├── layout.tsx           ← Root layout (fonts, providers, Chrome). REWRITTEN, fun fonts removed.
│   ├── Chrome.tsx           ← Sidebar+Topbar+BottomNav wrapper. Hides chrome on /presentation and /quant.
│   ├── providers.tsx        ← Wallet/RPC providers (Solana-specific — swap if porting off chain)
│   ├── globals.css          ← The design system (~500+ lines). Single source of truth for look-and-feel.
│   ├── page.tsx             ← Landing — hero + 4-stat strip + "How it works" + live markets peek
│   ├── markets/page.tsx     ← Full-screen globe with selectable flight markets
│   ├── buy/page.tsx         ← Buy parametric coverage on a specific flight
│   ├── earn/page.tsx        ← Vault deposit/redeem/withdraw + tier picker + snapshot chart
│   ├── portfolio/page.tsx   ← My active policies + claim history
│   ├── admin/page.tsx       ← Operator: governance config, route whitelist, admins
│   ├── crons/page.tsx       ← Operator: cron status dashboard (fetcher / classifier / settler / repricer)
│   ├── faucet/page.tsx      ← Operator: mint mock-stablecoin to a wallet
│   └── contracts/page.tsx   ← Operator: smart-contract surface explorer (read-only)
│
├── src/                     ← Everything `@/*` imports resolve to (tsconfig: `"@/*": ["src/*"]`)
│   ├── components/          ← Shared UI components
│   │   ├── BrandMark.tsx        ← The logo SVG
│   │   ├── Sidebar.tsx          ← Left nav. REWRITTEN, fun labels removed.
│   │   ├── Topbar.tsx           ← Breadcrumbs + ticker + wallet button. REWRITTEN, ModeToggle/gem-pill removed.
│   │   ├── BottomNav.tsx        ← Operator-panel strip pinned to bottom of every non-landing page
│   │   ├── WalletButton.tsx     ← Wallet Standard connect/disconnect + balance display
│   │   ├── Sparkline.tsx        ← Recharts area chart for stat strip
│   │   ├── RiskBar.tsx          ← Horizontal 0–1 risk gauge (green/amber/red)
│   │   ├── FlightRoute.tsx      ← "SFO → JFK" inline display
│   │   ├── Toast.tsx            ← Global toast provider + hook
│   │   ├── MonteCarloSimulator.tsx ← Delay-odds histogram used on /buy
│   │   ├── admin/Card.tsx       ← Section-card wrapper used across admin/buy/earn/portfolio/faucet
│   │   ├── admin/AddressBadge.tsx ← Truncated address + copy + explorer link
│   │   └── globe/SvgGlobe.tsx   ← Pure-SVG globe with drag-to-rotate, airport markers, route arcs
│   │
│   ├── theme/                   ← Theme tokens + provider
│   │   ├── ThemeProvider.tsx    ← REWRITTEN — no-op shim that hard-codes 'serious'
│   │   └── serious/             ← Color & font tokens (the entire design system)
│   │       └── tokens.css
│   │
│   ├── data/                    ← UI ↔ backend boundary (see §7)
│   │   ├── types.ts             ← All shared TS interfaces (MarketView, ProtocolStats, etc.)
│   │   ├── index.ts             ← Public async API the pages call
│   │   ├── mock.ts              ← Hardcoded mock data — keep for Phase-12-style first-light
│   │   └── onchain.ts           ← Solana on-chain readers (REPLACE for a different backend)
│   │
│   └── lib/                     ← Solana/wallet utilities (most need replacing for non-Solana backends)
│       ├── cluster.ts           ← `getClusterConfig() → { rpcUrl, websocketUrl }`
│       ├── rpc.ts               ← `useRpc()` hook
│       ├── pusd.ts              ← Stablecoin decimal formatting (6 decimals — same as USDC). Renamed PUSD here; rename to your token.
│       ├── ata.ts               ← Derive token accounts (Solana-specific)
│       ├── sendTx.ts            ← `useSendTx()` — prepare/simulate/send instruction set, fire toasts
│       ├── txEvents.ts          ← Tx-success event bus
│       ├── vault-math.ts        ← ERC-4626-style share math (`previewSharesFromDeposit`, `currentSharePrice`, …)
│       ├── compute-budget.ts    ← Solana compute-unit-limit instruction builder
│       ├── monteCarlo.ts        ← The MC distribution engine that powers MonteCarloSimulator
│       ├── executor-proxy.ts    ← Server-side proxy to executor (Solana-specific)
│       ├── useWalletSigner.ts   ← Wallet-signer hook
│       └── usePusdBalance.ts    ← Polling hook for stablecoin balance
│
└── public/
    └── presentation/        ← Pitch deck assets — DELETE if you don't need /presentation
        ├── slides.html
        └── acurast-cluster.jpg
```

---

## 4. The design system

`app/globals.css` is **the** styling file. It defines:

- Layout grids: `.app` (sidebar+main), `.page` (max-width container), `.row`, `.col`
- Surfaces: `.panel`, `.card`, `.sidebar`, `.topbar`
- Buttons: `.btn`, `.btn.primary`, `.btn.ghost`, `.btn.lg` (sizing modifier)
- Typography: `.display` (hero), `.section` (h2), `.h-eyebrow`, `.mono`, `.mono-tiny`, `.num`, `.muted`, `.lede`
- Stat tiles: `.stat-label`, `.stat-value`, `.stat-delta`
- Tables: `.t`, `thead`, `tbody`, `tr`, `td`
- Decorations: `.grain` (film grain), `.horizon` (hero divider), `.grid-bg` (faint grid backdrop), `.live-pill`
- Globe stage: `.globe-stage`, `.globe-overlay-l`, `.globe-overlay-r`
- Form inputs, dropdowns, modal backdrops
- Badges: `.badge.amber`, `.badge.cyan`
- Carrier label: `.carrier`

The color tokens live in **`theme/serious/tokens.css`**:

```css
:root {
  --bg: #07090e;       /* page bg (almost black, slight blue) */
  --bg-1: #0b0f17;     /* panel bg */
  --bg-2: #10151f;     /* nested panel bg */
  --bg-3: #161c28;     /* hover/active surface */
  --line: #1e2533;     /* subtle borders */
  --line-2: #2a3344;   /* stronger borders */
  --ink: #eef1f7;      /* primary text */
  --ink-2: #b6becd;    /* secondary text */
  --ink-3: #6b7385;    /* tertiary */
  --ink-4: #444c5d;    /* quaternary / dividers */
  --amber: #ffb547;    /* primary accent — premium / risk / underwriter */
  --amber-d: #d28a1f;
  --cyan: #5ee0d2;     /* secondary accent — payout / liquidity */
  --cyan-d: #2aa394;
  --red: #ff5d6c;      /* risk high / error */
  --green: #7ee787;    /* risk low / success */
  --violet: #a98bff;   /* tertiary / pitch CTA */
}
```

Fonts (loaded in `app/layout.tsx` via `next/font/google`):

- **Geist** → `--font-geist` — default sans, used on body
- **JetBrains Mono** → `--font-jetbrains-mono` — used in `.num`, `.mono`, tabular figures, addresses
- **Instrument Serif** → `--font-instrument-serif` — used in hero `<em>` accents (the italic flourishes on the display headlines)

Don't change these without updating both `layout.tsx` AND the CSS-variable references in `globals.css`.

---

## 5. Pages — what each one does

> The exact JSX is in the page files; this list is intent + dependencies so you can rewire them quickly to a new backend.

| Route | Purpose | Backend reads | Backend writes | Notes |
|---|---|---|---|---|
| `/` | Hero, 4-stat strip (TVL/APY/Open Markets/Payout Speed), how-it-works 2-col, 5-row "live markets peek", trust strip | `getProtocolStats()`, `getOpenMarkets()` | — | All data via `src/data/` — mock-friendly out of the box |
| `/markets` | Full-screen SVG globe + scrollable market list + selected-flight detail panel | `getOpenMarkets()`, `getAirports()` | — | Drag-to-rotate globe; click an arc to select |
| `/buy` | Pick a flight, see premium/payout, Monte Carlo delay-odds histogram, submit buy-insurance tx | route catalogue, vault state, user balance | `buy_insurance` instruction | The MC simulator is local-only; reads parameters from the selected market |
| `/earn` | Vault deposit / redeem / request-withdrawal / cancel / collect; tier picker (Conservative/Balanced/Aggressive); 30-day snapshot chart | vault state, user share balance, snapshot history | 5 vault instructions | Computes share-price client-side via `lib/vault-math.ts` |
| `/portfolio` | Active policies (tracking / pending claim) + history (settled / claimed / expired) | `getProgramAccounts` w/ memcmp on buyer field, joined with FlightPool + FlightData | `claim` instruction | Discovery pattern: discriminator @ offset 0 + wallet pubkey @ offset 8 |
| `/admin` | Operator: governance config read/write, route whitelist editor, admin record management | governance config + route accounts + admin records | many governance instructions | Auth-gated on the connected wallet matching `governance.owner` |
| `/crons` | Operator: cron status dashboard (Fetcher / Classifier / Settler / Repricer cards) | last-run log, decisions, errors | optional "simulate now" trigger | Logs may come from your executor service or a backend |
| `/faucet` | Operator: mint mock-stablecoin to any wallet (dev/testnet only) | — | calls `/api/faucet/mint` (server route, not included — implement yourself) | Hide / remove on mainnet |
| `/contracts` | Operator: collapsible explorer of every program PDA + read-only state | every program's config + state | — | Reference UI; not load-bearing |
| `/presentation` | Pitch deck (fullscreen iframe of `public/presentation/slides.html`) | — | — | Delete the route + the `public/presentation/` folder if you don't need a deck |
| `/quant` | Single fullscreen slide consumed by the deck | — | — | Same — delete if no deck |

`Chrome.tsx` hides the sidebar/topbar/bottomnav on `/presentation` and `/quant`. If you delete those routes, also trim `FULLSCREEN_ROUTES` in `Chrome.tsx`.

### Pages that still contain `useTheme()` calls

`app/page.tsx`, `app/buy/page.tsx`, `app/earn/page.tsx`, `app/portfolio/page.tsx` still call `useTheme()` and have `const isFun = mode === 'fun'` branches. The simplified `ThemeProvider` shim makes these dead-but-harmless (`isFun` is always `false`). You can either:

- **Leave them** — they compile, render the serious branch, and you can clean up later.
- **Strip them** — do a find/replace for `isFun ?` and `mode === 'fun'`, keep the second branch of each ternary, remove the import. Mechanical, ~30 minutes total.

---

## 6. Environment variables

Create `frontend/.env.local`:

```bash
# RPC for whatever chain you're targeting. For Solana devnet:
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com

# Optional: WS endpoint if your provider exposes one separately
NEXT_PUBLIC_SOLANA_WS_URL=wss://api.devnet.solana.com

# Stablecoin mint (mock or real). Originally PUSD on Solana.
NEXT_PUBLIC_STABLE_MINT=<your-mint-address>

# Executor / agent API base (for Monte Carlo + repricer endpoints)
NEXT_PUBLIC_EXECUTOR_URL=http://localhost:8787
NEXT_PUBLIC_AGENT_URL=http://localhost:8000
```

For a non-Solana backend, replace the whole block with whatever your new backend needs (REST base URL, API key for client-safe ops, etc.) and update `src/lib/cluster.ts` + `src/lib/rpc.ts` to read those vars.

---

## 7. The backend swap

The whole UI talks to the backend through two layers:

1. **`src/data/index.ts`** — pure async functions the pages import. The function signatures are stable; only the bodies change per backend.
2. **`src/lib/`** — wallet/tx/balance hooks. These are Solana-specific. For a different backend, gut them and reimplement against your new transport.

### Step-by-step swap plan

1. **Keep `src/data/types.ts` unchanged.** The pages assume `MarketView`, `ProtocolStats`, `VaultState`, `MyPolicy`, etc. exist with these field names.
2. **Rewrite `src/data/onchain.ts`.** Every function in here calls `@solana/kit` RPC + Codama-generated decoders. Replace each with a call to your backend (REST, GraphQL, indexer). Keep the same return shape.
3. **Rewrite `src/data/index.ts`** if needed — most functions delegate to `onchain.ts` so just point them at the new module.
4. **Drop `src/lib/ata.ts`, `compute-budget.ts`, `executor-proxy.ts`** if you're not on Solana.
5. **Replace `src/lib/sendTx.ts`** with whatever your write path is. Keep the hook signature `useSendTx() → { send }` so pages don't change.
6. **Replace `src/components/WalletButton.tsx`** with your auth/wallet UI. Keep the visual shape: pill with truncated identity, balance number, dropdown with copy + disconnect.
7. **Replace `app/providers.tsx`** — wrap children in whatever your new client/SDK requires.
8. **Keep `src/lib/monteCarlo.ts` and `src/lib/vault-math.ts`** — these are pure math, no backend dependency. They power the MC simulator on /buy and the share-price math on /earn.

`src/data/mock.ts` is genuinely useful — keep it. It lets you bring up the UI before the backend is wired, and it's how the original project did Phase 12 ("everything renders" before any chain calls existed).

---

## 8. Wallet integration (current, Solana)

The receiving agent should know this is the **Wallet Standard** path via framework-kit, NOT `@solana/wallet-adapter-*`. If you keep Solana as the backend:

- `app/providers.tsx` wraps in `<SolanaProvider>` and creates a single `@solana/client` with `walletConnectors: autoDiscover()` so any installed Wallet-Standard wallet appears automatically.
- `useWalletSession()` (from `@solana/react-hooks`) — returns `{ account: { address }, … } | undefined` for the connected wallet.
- `useWalletConnection()` — returns `{ connectors, connect(id), disconnect, connecting, error }`.
- `useWallet()` — combined accessor.

**Don't import `@solana/wallet-adapter-react`** anywhere. The original project banned it as part of its locked stack.

---

## 9. Toasts

`<ToastProvider>` is wrapped at the layout root. Any component can call:

```tsx
import { useToast } from '@/components/Toast';

const { show } = useToast();
show({ kind: 'success', title: 'Position opened', body: 'Tx <sig>' });
```

`kind` is `'info' | 'success' | 'warning' | 'error'`. Auto-dismisses unless `sticky: true`. The `sendTx` hook fires these on tx outcomes — replace if you replace `sendTx`.

---

## 10. Things to delete on day one if you don't need them

- `app/presentation/`, `app/quant/`, `public/presentation/` — the pitch deck
- `app/faucet/page.tsx` — only useful if you ship a test-stablecoin faucet
- `theme/` and the no-op `useTheme()` calls — once you've removed all `mode === 'fun'` references
- `lib/compute-budget.ts`, `lib/ata.ts`, `lib/executor-proxy.ts` — if not on Solana
- `data/onchain.ts` — if not on Solana (replace with a `rest.ts` or `graphql.ts`)

---

## 11. What was deliberately left out of this reference

- **`src/clients/*`** — Codama-generated typed program clients. Regenerate from your IDLs (or skip if non-Solana).
- **`src/idl/*`** — Anchor IDL JSON. Same as above.
- **`src/config/devnet.ts`** — program-IDs constants for the original project. Recreate with your own addresses.
- **`scripts/`** — original repo had IDL sync + client gen scripts. Reimplement only if you're regenerating typed clients.
- **`src/theme/fun/`** — the entire fun-mode theme (Cinzel/IM Fell English fonts, parchment palette, mascot SVGs, painted-sky overlays). Gone by design.

---

## 12. Sanity checks after the port

1. `pnpm dev` starts on :3000 with no console errors.
2. Sidebar shows: Home / Live Markets / Buy Coverage / Earn / Portfolio.
3. Topbar shows: breadcrumb + ticker + wallet button (no mode toggle, no gem pill).
4. `/` renders hero + 4-stat strip + how-it-works + live-markets-peek + trust strip.
5. `/markets` renders the globe and lets you drag-rotate it.
6. `/buy` renders the route picker + Monte Carlo histogram.
7. `/earn` renders the tier picker + deposit/redeem form + snapshot chart.
8. `/portfolio` shows an empty-state when no wallet is connected, then policies after connecting.
9. Operator pages (`/admin`, `/crons`, `/faucet`, `/contracts`) render — they can be gated/hidden on prod.

If something looks visually off — wrong spacing, wrong border, wrong font — it's almost always in `app/globals.css`. That file is the source of truth for the look.
