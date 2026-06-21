# AI Agent → On-Chain Governance: Architecture Report

A portable knowledge-transfer doc describing how Sentinel's pricing pipeline lets an off-chain AI agent write to an on-chain Anchor governance program safely. Written so another AI agent (or engineer) can replicate the pattern in a different domain.

The system has three moving parts that meet at one on-chain authority:

```
┌─────────────────────────┐    HTTP    ┌──────────────────────────┐
│ Pricing Agent           │  POST      │ Repricer Cron            │
│ FastAPI + XGBoost       │ ◄────────  │ (TypeScript, node)       │
│ /price  /healthz        │            │  ── getProgramAccounts   │
└─────────────────────────┘            │  ── decide action        │
                                       │  ── Codama ix builder    │
┌─────────────────────────┐  HTTPS     │  ── sign + send          │
│ xAI Grok                │ ◄────────  │                          │
│ /v1/responses           │            └────────────┬─────────────┘
│ web_search tool         │                         │ signed tx
│ json_schema output      │                         ▼
└─────────────────────────┘            ┌──────────────────────────┐
                                       │ governance_program       │
                                       │  whitelist_route         │
                                       │  update_route_terms      │
                                       │  disable_route           │
                                       └──────────────────────────┘
```

Everything below is the contract between those boxes.

---

## 1. The on-chain authority model — the part that matters most

Before anything else, the on-chain program decides **what an off-chain agent is even allowed to do**. Get this wrong and the rest is wasted.

In `contracts/programs/governance/src/lib.rs`:

- A single `GovernanceConfig` PDA stores `owner: Pubkey` plus protocol-wide defaults.
- All four write instructions (`whitelist_route`, `disable_route`, `update_route_terms`, admin mgmt) gate on `require_owner_or_active_admin(...)`.
- "Admin" is a separate `AdminRecord` PDA (`seeds = [b"admin", admin_pubkey]`) carrying an `is_active: bool`. Adds + removes flip the bool; the PDA address is bound by the pubkey, so removal is auditable and re-add is idempotent.
- The owner can act without an `AdminRecord`. Anchor optional accounts (`Option<Account<...>>`) use the **program ID as the "absent" sentinel** — the off-chain caller passes `GOVERNANCE_PROGRAM_ADDRESS` for the absent slot, and Anchor recognises it as `None`. Codama would otherwise auto-derive a real PDA and your tx fails.

**Why this matters for the agent.** The cron signs as the governance owner keypair. That keypair lives in a file referenced by `KEEPER_KEYPAIR` env. The agent itself is *unauthenticated* — same trust boundary as the cron — because compromising the cron host already gives you the keypair. The agent is therefore an internal service, not an internet-facing API. If you want a public agent, you need to add auth at the agent layer and treat its output as untrusted (the cron does that anyway via clamps).

**Isolation principle (worth replicating):** the keypair that signs route reprices (governance owner) is different from the keypair that pushes oracle data (`authorized_oracle`), which is different from the keypair that runs settlements (`authorized_keeper`). One key compromise cannot trigger payouts. Three crons, three keys, three separate program-level authority types.

### Code sample — owner-or-admin gate (Anchor, Rust)

```rust
// contracts/programs/governance/src/lib.rs
pub fn disable_route(
    ctx: Context<RouteMutate>,
    flight_id: String,
    origin: String,
    destination: String,
) -> Result<()> {
    let _ = (flight_id, origin, destination); // bound by `#[instruction(...)]`, used in seeds
    require_owner_or_active_admin(
        &ctx.accounts.config,
        &ctx.accounts.caller,
        &ctx.accounts.admin_record,
    )?;
    ctx.accounts.route.approved = false;
    Ok(())
}

#[derive(Accounts)]
#[instruction(flight_id: String, origin: String, destination: String)]
pub struct RouteMutate<'info> {
    #[account(mut, seeds = [b"governance_config"], bump = config.bump)]
    pub config: Account<'info, GovernanceConfig>,

    #[account(
        mut,
        seeds = [b"route", flight_id.as_bytes(), origin.as_bytes(), destination.as_bytes()],
        bump = route.bump,
    )]
    pub route: Account<'info, RouteAccount>,

    pub caller: Signer<'info>,

    // `None` is signalled by passing the program ID as the address —
    // see "Code sample — passing the absent-admin sentinel" below.
    pub admin_record: Option<Account<'info, AdminRecord>>,
}
```

---

## 2. The off-chain → on-chain instruction surface

The agent can only touch **four** instructions, all bound by `(flight_id, origin, destination)` PDA seeds so the route's identity is immutable:

| Ix | When the cron calls it | Anchor account ctx | Codama builder |
|---|---|---|---|
| `whitelist_route` | First time we see a route, OR re-enabling a previously-disabled-by-this-cron route | `RouteWrite` (`init_if_needed`) | `getWhitelistRouteInstructionAsync` |
| `update_route_terms` | Premium drifted ≥ drift threshold from current on-chain value | `RouteMutate` | `getUpdateRouteTermsInstructionAsync` |
| `disable_route` | Grok flags a confirmed flight-stopping event | `RouteMutate` | `getDisableRouteInstructionAsync` |
| (no-op) | Within drift, or route already in the desired state | — | — |

`update_route_terms` uses a **tri-state enum** per field (`Keep` / `Set(v)` / `RevertToDefault`) so the agent can update one field without touching the others. The repricer always sends `premium: Set(...)`, `payoff: Keep`, `delay_hours: Keep`. This is the pattern to copy when you have many narrowly-targeted updates against a wide struct.

### Code sample — tri-state field update enum

```rust
// contracts/programs/governance/src/lib.rs
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum U64Update {
    Keep,
    Set(u64),
    RevertToDefault,
}

impl U64Update {
    pub fn apply(self, current: Option<u64>) -> Option<u64> {
        match self {
            Self::Keep             => current,
            Self::Set(v)           => Some(v),
            Self::RevertToDefault  => None,
        }
    }
}

pub fn update_route_terms(
    ctx: Context<RouteMutate>,
    flight_id: String,
    origin: String,
    destination: String,
    premium: U64Update,
    payoff: U64Update,
    delay_hours: U32Update,
) -> Result<()> {
    let _ = (flight_id, origin, destination);
    require_owner_or_active_admin(&ctx.accounts.config, &ctx.accounts.caller, &ctx.accounts.admin_record)?;
    let route = &mut ctx.accounts.route;
    route.premium     = premium.apply(route.premium);
    route.payoff      = payoff.apply(route.payoff);
    route.delay_hours = delay_hours.apply(route.delay_hours);
    Ok(())
}
```

In Codama-generated TypeScript this maps to a discriminated union — see the runner code sample in §7.

---

## 3. The agent: FastAPI + XGBoost (the "brain")

`agent/app/main.py` is ~180 lines. It is deliberately small.

**Contract with the world.** Two routes:

```
POST /price
  in:  { flight_id, carrier, origin, dest, dep_time_hhmm,
         distance_mi, month, day_of_month, day_of_week }
  out: { p_delay: float,
         premium_usdc: float,                  # human-readable
         premium_base_units: int,              # 1 USDC = 1_000_000
         model_version: str }

GET /healthz
  out: { status: "ok", model_version, loaded_at }
```

**Critical design choices to replicate:**

1. **Return both `*_usdc` and `*_base_units`.** The cron needs the integer base-unit form to feed directly into the on-chain `Set(u64)` enum without ever doing float→integer conversion at the trust boundary. The `usdc` field is just for the activity feed.
2. **Premium formula is in the agent, not the cron.** `premium_usdc = clamp(1 + 4 * p_delay, 1, 5)`. The cron applies the Grok multiplier on top and *re-clamps*. Keeping the clamp at both ends means the on-chain value is bounded even if either component goes haywire.
3. **Lifespan-managed model state.** FastAPI's `lifespan` async-context loads `model.joblib` + `encoder.joblib` once at startup and fails fast if missing. The `/healthz` endpoint reads from that same state — when health goes red, the cron can refuse to run instead of querying a half-loaded service.
4. **`AGENT_ARTIFACTS_DIR` env override**, not `MODEL_PATH`. Directory, not file. Lets you swap artifact bundles without renaming files.
5. **Pydantic 2 quirk:** `model_version` collides with Pydantic's reserved `model_` prefix. Opt out with `ConfigDict(protected_namespaces=())` on every response schema that uses it.
6. **OHE encoder is fit on training data only** with `handle_unknown="ignore"`. Serving-time unseen categories (new carriers, new airports) get silently zeroed instead of crashing. The trade-off is a tiny ROC AUC delta (~0.0008 in our case); document it.
7. **macOS deploy precondition:** `brew install libomp`. The xgboost wheel doesn't bundle OpenMP, and the failure mode is a runtime `OSError` at import. Put it in the README and CI.

**Known limits to surface in the README** (so a future operator doesn't trust the agent's output too far):
- Model target is a *proxy* for what the protocol actually settles on (we trained on `dep_delayed_15min`; the protocol pays out on `Delayed | Cancelled` at arrival). Plan to retrain when settlements accumulate.
- No probability calibration (Platt / isotonic). If predictions bunch in the middle, add it.
- No auth, single sync worker. Internal service only.

### Code sample — FastAPI lifespan + dual-unit response

```python
# agent/app/main.py
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import os, joblib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

ARTIFACTS_DIR = Path(os.environ.get("AGENT_ARTIFACTS_DIR",
                                    str(Path(__file__).resolve().parent.parent / "artifacts")))
USDC_BASE_UNITS_PER_USDC = 1_000_000
_state: dict = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    for required in ("model.joblib", "encoder.joblib", "model_version.txt"):
        if not (ARTIFACTS_DIR / required).exists():
            raise RuntimeError(f"Missing artifact: {required}. Run `make train`.")
    _state["model"]         = joblib.load(ARTIFACTS_DIR / "model.joblib")
    _state["encoder"]       = joblib.load(ARTIFACTS_DIR / "encoder.joblib")
    _state["model_version"] = (ARTIFACTS_DIR / "model_version.txt").read_text().strip()
    _state["loaded_at"]     = datetime.now(timezone.utc).isoformat()
    yield
    _state.clear()

app = FastAPI(title="Sentinel Premium Pricing Agent", lifespan=lifespan)

class PriceRequest(BaseModel):
    flight_id: str
    carrier: str
    origin: str
    dest: str
    dep_time_hhmm: int = Field(..., ge=0, le=2359)
    distance_mi: int   = Field(..., ge=0)
    month: int         = Field(..., ge=1, le=12)
    day_of_month: int  = Field(..., ge=1, le=31)
    day_of_week: int   = Field(..., ge=1, le=7)

class PriceResponse(BaseModel):
    # `model_version` collides with Pydantic 2's reserved `model_` prefix.
    model_config = ConfigDict(protected_namespaces=())
    p_delay: float
    premium_usdc: float
    premium_base_units: int  # <-- the on-chain value, do not re-derive client-side
    model_version: str

def clamp_premium(p_delay: float) -> tuple[float, int]:
    raw = 1.0 + 4.0 * float(p_delay)
    premium_usdc = max(1.0, min(5.0, raw))
    return premium_usdc, round(premium_usdc * USDC_BASE_UNITS_PER_USDC)

@app.post("/price", response_model=PriceResponse)
def price(req: PriceRequest) -> PriceResponse:
    encoder, model = _state.get("encoder"), _state.get("model")
    if encoder is None or model is None:
        raise HTTPException(503, "Model artifacts not loaded.")
    df = to_notebook_format(req)                  # build the DataFrame shape the encoder expects
    p_delay = float(model.predict_proba(encoder.transform(df))[0, 1])
    premium_usdc, premium_base_units = clamp_premium(p_delay)
    return PriceResponse(
        p_delay=p_delay,
        premium_usdc=premium_usdc,
        premium_base_units=premium_base_units,
        model_version=str(_state["model_version"]),
    )
```

---

## 4. The geopolitical-risk layer: xAI Grok

`executor/src/core/grok_client.ts` is the most fragile part of the system. Its job is to be a *safe* fallback augmentation on top of the model — never the sole decision maker.

**Wire format (the part that changes most often):**

- Endpoint: `POST https://api.x.ai/v1/responses` (the legacy `search_parameters` field on `/v1/chat/completions` was retired May 2026 — don't use it).
- Model: `grok-4-fast-non-reasoning` (cheapest model that supports tool use).
- Tools: `[{ type: "web_search" }]` — built-in server-side tool, xAI handles invocation; the model returns a single grounded answer.
- Output: `text.format = { type: "json_schema", schema: {...}, strict: true }`. Strict schema = the model literally cannot return free-form text.

**The schema:**

```json
{
  "type": "object",
  "properties": {
    "action":     { "type": "string", "enum": ["ok", "raise", "disable"] },
    "multiplier": { "type": "number", "minimum": 1.0, "maximum": 3.0 },
    "reason":     { "type": "string", "maxLength": 200 }
  },
  "required": ["action", "multiplier", "reason"],
  "additionalProperties": false
}
```

**Three rules that keep the integration safe:**

1. **The client never throws.** Every error path — network, non-200, invalid JSON, schema violation, timeout — falls back to `GROK_SAFE_DEFAULT = { action: "ok", multiplier: 1.0, reason: "grok unavailable; baseline only" }`. The cron's per-route loop must keep going.
2. **The client re-validates everything Grok returns.** `coerceVerdict()` re-clamps `multiplier` to `[1.0, 3.0]`, re-validates `action`, truncates `reason` to 200 chars. The strict json_schema is belt; this is suspenders.
3. **System prompt explicitly classifies the three actions** so the model has the same rubric every call: `disable` = confirmed airspace closure / fleet grounding / war zone, `raise` 1.1–3.0 = severe weather forecast / partial strikes / regional unrest, `ok` = no credible disruption. Without this rubric the model leans too hard on `raise`.

**Mock layer is mandatory.** `GROK_MOCK=1` + `GROK_MOCK_VERDICT={ok|raise:1.5|disable}` lets you build the entire cron and test all four decision branches without network or API key. Same posture for the agent (`AGENT_MOCK=1` + `AGENT_MOCK_PREMIUM_USDC`). The route-handler UI flips mock/live per request — invaluable for hackathon demos.

**Timeout = 45s.** Web search + reasoning is slow. Don't try to make it fast; just budget for it.

### Code sample — xAI /v1/responses request with web_search + json_schema

```ts
// executor/src/core/grok_client.ts
function buildRequest(route: RouteSummary): unknown {
  const systemPrompt =
    'You are a precise flight-insurance risk analyst. Use the web_search tool to ' +
    'ground every answer on real news. Always return strict JSON matching the schema. ' +
    'Use action "disable" only for confirmed flight-stopping events (announced ' +
    'airspace closure, fleet grounding, war zone). Use "raise" with multiplier 1.1–3.0 ' +
    'for elevated but still-operational risk. Use "ok" with multiplier 1.0 when no ' +
    'credible disruption is reported.';

  return {
    model: 'grok-4-fast-non-reasoning',
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content:
        `Within the next 30 days, is there credible news of airspace closure, military ` +
        `action, embargo, or major disruption affecting flights from ${route.origin} ` +
        `to ${route.destination} operated by ${route.carrier} (e.g. ${route.flightId})?` },
    ],
    tools: [{ type: 'web_search' }],   // built-in server-side tool
    tool_choice: 'auto',
    text: {
      format: {
        type: 'json_schema',
        name: 'geopolitical_risk_verdict',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            action:     { type: 'string', enum: ['ok', 'raise', 'disable'] },
            multiplier: { type: 'number', minimum: 1.0, maximum: 3.0 },
            reason:     { type: 'string', maxLength: 200 },
          },
          required: ['action', 'multiplier', 'reason'],
          additionalProperties: false,
        },
      },
    },
  };
}
```

### Code sample — never-throws client + safe default + re-validation

```ts
// executor/src/core/grok_client.ts
export const GROK_SAFE_DEFAULT: GrokVerdict = {
  action: 'ok', multiplier: 1.0, reason: 'grok unavailable; baseline only',
};

return {
  async assess(route) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(buildRequest(route)),
      });
      if (!res.ok) return { ...GROK_SAFE_DEFAULT, reason: `grok ${res.status}: ${GROK_SAFE_DEFAULT.reason}` };
      const body = await res.json();
      const text = extractOutputText(body);  // walks output[].content[] for the first output_text
      if (!text) return GROK_SAFE_DEFAULT;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return GROK_SAFE_DEFAULT; }
      return coerceVerdict(parsed);          // belt-and-suspenders re-validate
    } catch {
      return GROK_SAFE_DEFAULT;               // network/timeout/anything — never throws
    }
  },
};

// Re-validate everything the model returned, even with strict json_schema.
export function coerceVerdict(raw: unknown): GrokVerdict {
  if (!raw || typeof raw !== 'object') return GROK_SAFE_DEFAULT;
  const r = raw as Record<string, unknown>;
  const actionRaw = String(r.action ?? '').toLowerCase();
  if (actionRaw !== 'ok' && actionRaw !== 'raise' && actionRaw !== 'disable') return GROK_SAFE_DEFAULT;
  const action = actionRaw as GrokAction;
  const multRaw = Number(r.multiplier ?? 1.0);
  const multiplier = action === 'raise'
    ? Math.max(1.0, Math.min(3.0, Number.isFinite(multRaw) ? multRaw : 1.0))
    : 1.0;
  const reason = String(r.reason ?? '').slice(0, 200);
  return { action, multiplier, reason: reason || GROK_SAFE_DEFAULT.reason };
}
```

---

## 5. The decision module: pure, testable, no I/O

`executor/src/core/decide_route_actions.ts` is the only place where "should we touch this route" logic lives. It takes:

```ts
decideRouteAction(
  route: RouteState,                // current on-chain snapshot
  baselinePremiumBaseUnits: bigint, // from agent
  verdict: GrokVerdict,             // from grok
  recentDisablesByRepricer: ReadonlySet<string>, // JSONL-tracked
): RouteAction
```

…and returns one of `noop | update_premium | disable | reenable_with_terms`. **No fetch, no signer, no clock.** This is the part you write tests against.

**Drift threshold pattern.** `update_premium` only fires when `|target - current| ≥ 10¢` (`100_000` base units). Without this you spam the chain with no-op-ish updates every cron tick. With it, the chain accurately reflects "the price the model + Grok currently believe in" within a tolerance band.

**Asymmetric re-enable.** A `disable` only flips back to `whitelist_route` if **this cron** disabled it (tracked in a JSONL log on the cron host). If a human operator disabled the route via the admin panel, the cron leaves it alone and emits `noop reason="route disabled (not by this cron); grok says ok — leaving alone"`. This is the cheap version of an operator-override flag without needing on-chain state.

**The closed action enum + serializer split.** `RouteAction` carries `bigint` premiums (correct for on-chain math). The JSONL log needs JSON-safe strings. `serializeAction()` is the only converter and lives next to the orchestrator, not the decision module. Replicate this split: pure decision module returns canonical types; the side-effecty caller adapts to serialization.

### Code sample — pure decision branches

```ts
// executor/src/core/decide_route_actions.ts
export const PUSD_BASE_UNITS_PER_PUSD = 1_000_000n;
export const MIN_PREMIUM_BASE_UNITS   = 1n * PUSD_BASE_UNITS_PER_PUSD;
export const MAX_PREMIUM_BASE_UNITS   = 5n * PUSD_BASE_UNITS_PER_PUSD;
export const DRIFT_THRESHOLD_BASE_UNITS = 100_000n;  // 10¢

export function clampPremiumBaseUnits(baseline: bigint, multiplier: number): bigint {
  const adjusted = Math.round(Number(baseline) * multiplier);
  let result = BigInt(adjusted);
  if (result < MIN_PREMIUM_BASE_UNITS) result = MIN_PREMIUM_BASE_UNITS;
  if (result > MAX_PREMIUM_BASE_UNITS) result = MAX_PREMIUM_BASE_UNITS;
  return result;
}

export function decideRouteAction(
  route: RouteState,
  baselinePremiumBaseUnits: bigint,
  verdict: GrokVerdict,
  recentDisablesByRepricer: ReadonlySet<string>,
): RouteAction {
  const target = clampPremiumBaseUnits(baselinePremiumBaseUnits, verdict.multiplier);

  // 1. Grok says disable.
  if (verdict.action === 'disable') {
    if (!route.approved) return { kind: 'noop', routePda: route.pda, reason: `already disabled (${verdict.reason})` };
    return { kind: 'disable', routePda: route.pda, flightId: route.flightId, origin: route.origin, destination: route.destination, reason: verdict.reason };
  }

  // 2. Route currently disabled — only re-enable if THIS cron disabled it.
  if (!route.approved) {
    if (verdict.action === 'ok' && recentDisablesByRepricer.has(route.pda)) {
      return { kind: 'reenable_with_terms', routePda: route.pda, flightId: route.flightId, origin: route.origin, destination: route.destination, newPremiumBaseUnits: target, reason: `grok ok — re-enabling after prior cron disable (${verdict.reason})` };
    }
    return { kind: 'noop', routePda: route.pda, reason: 'route disabled (not by this cron); leaving alone' };
  }

  // 3. Drift check — avoid spamming the chain with sub-threshold updates.
  const current = route.currentPremiumBaseUnits;
  if (current !== null) {
    const delta = target > current ? target - current : current - target;
    if (delta < DRIFT_THRESHOLD_BASE_UNITS) {
      return { kind: 'noop', routePda: route.pda, reason: `within drift (Δ=${delta} < ${DRIFT_THRESHOLD_BASE_UNITS})` };
    }
  }

  return { kind: 'update_premium', routePda: route.pda, flightId: route.flightId, origin: route.origin, destination: route.destination, newPremiumBaseUnits: target, reason: verdict.action === 'raise' ? `grok raise×${verdict.multiplier.toFixed(2)}: ${verdict.reason}` : `agent baseline (${verdict.reason})` };
}
```

---

## 6. The orchestrator: `runRepricerOnce()`

`executor/src/core/route_repricer.ts` is the cron body. ~450 lines, no surprises if you follow the numbered comments.

**Account discovery via `getProgramAccounts` + memcmp on Anchor's 8-byte discriminator.**

```ts
rpc.getProgramAccounts(governanceProgramId, {
  encoding: 'base64',
  filters: [{
    memcmp: {
      offset: 0n,
      bytes: ROUTE_ACCOUNT_DISCRIMINATOR_B58 as Base58EncodedBytes,
      encoding: 'base58',
    },
  }],
})
```

The discriminator is the first 8 bytes of `sha256("account:RouteAccount")` — Codama generates a `ROUTE_ACCOUNT_DISCRIMINATOR` const but we lift it as a literal here to keep the orchestrator Codama-import-free (Codama's chain has directory-import quirks that break unit tests).

For the `Base58EncodedBytes` cast — Kit's RPC types union the `withContext`/no-`withContext` shapes. When you omit `withContext` you get the unwrapped array form. Cast accordingly; trust the runtime shape.

**Manual Borsh decode of `RouteAccount`.** Strings are `u32 length + bytes`. Options are `u8 tag + (value if tag==1)`. The handwritten decoder is intentional — if you import the Codama struct decoder, you import the whole client chain, and unit tests start needing the IDL build pipeline to be green. Keep the orchestrator decode-free of the Codama generated client; only the **applyAction translator** imports Codama (Section 7).

**Pre-flight `healthz` check on the agent in live mode.** If the agent is down, the cron exits with a 503-tagged error before doing any work. Same pattern for any external dependency you can probe.

**Per-route try/catch.** Agent failure → skip + warn. Decode failure → skip + warn. Grok never fails (Section 4). `applyAction` failure → log + continue to next route. The cron must always emit a histogram.

**Returns:**

```ts
{
  decisions: RouteDecisionRecord[],    // full per-route trace for JSONL log
  signatures: string[],                // tx sigs sent this run
  histogram: { noop, update, disable, reenable },
  newlyDisabledPdas: string[],         // append to disabledByRepricer JSONL
}
```

### Code sample — `getProgramAccounts` + memcmp discriminator scan

```ts
// executor/src/core/route_repricer.ts

// First 8 bytes of sha256("account:RouteAccount") — Anchor's discriminator.
const ROUTE_ACCOUNT_DISCRIMINATOR = new Uint8Array([135, 89, 73, 184, 33, 21, 243, 86]);
const ROUTE_ACCOUNT_DISCRIMINATOR_B58 = base58FromBytes(ROUTE_ACCOUNT_DISCRIMINATOR);

const accountsResp = (await opts.rpc.getProgramAccounts(opts.governanceProgramId, {
  encoding: 'base64',
  filters: [{
    memcmp: {
      offset: 0n,
      bytes: ROUTE_ACCOUNT_DISCRIMINATOR_B58 as unknown as Base58EncodedBytes,
      encoding: 'base58',
    },
  }],
}).send()) as unknown as ReadonlyArray<{
  pubkey: Address;
  account: { data: readonly [string, 'base64']; owner: Address; lamports: bigint; executable: boolean };
}>;

for (const entry of accountsResp) {
  const dataB64 = Array.isArray(entry.account.data) ? entry.account.data[0] : (entry.account.data as unknown as string);
  const decoded = decodeRouteAccount(Buffer.from(dataB64, 'base64'));
  // …per-route loop
}
```

### Code sample — handwritten Borsh decoder (keeps core Codama-import-free)

```ts
// executor/src/core/route_repricer.ts
function readOptionU64(buf: Buffer, off: number): { value: bigint | null; bytesRead: number } {
  const tag = buf.readUInt8(off);
  if (tag === 0) return { value: null, bytesRead: 1 };
  return { value: buf.readBigUInt64LE(off + 1), bytesRead: 9 };
}

export function decodeRouteAccount(buf: Buffer): DecodedRouteAccount {
  let off = 8;  // skip discriminator
  // Borsh String: u32 length-prefix + utf-8 bytes
  const flightLen = buf.readUInt32LE(off); off += 4;
  const flightId  = buf.slice(off, off + flightLen).toString('utf-8'); off += flightLen;
  const originLen = buf.readUInt32LE(off); off += 4;
  const origin    = buf.slice(off, off + originLen).toString('utf-8'); off += originLen;
  const destLen   = buf.readUInt32LE(off); off += 4;
  const destination = buf.slice(off, off + destLen).toString('utf-8'); off += destLen;
  const premium     = readOptionU64(buf, off); off += premium.bytesRead;
  const payoff      = readOptionU64(buf, off); off += payoff.bytesRead;
  const delayHours  = readOptionU32(buf, off); off += delayHours.bytesRead;
  const approved    = buf.readUInt8(off) !== 0;
  return { flightId, origin, destination, premium: premium.value, payoff: payoff.value, delayHours: delayHours.value, approved };
}
```

---

## 7. Action → instruction translator: where Codama re-enters

`executor/src/scripts/run-repricer.ts → routeActionToIxs()` is the only place that imports Codama-generated instruction builders. The split — orchestrator decode-free, runner Codama-aware — is the load-bearing pattern.

```ts
routeActionToIxs(action: RouteAction, caller: TransactionSigner): Promise<Instruction[]>
  - action.kind === 'update_premium'      → getUpdateRouteTermsInstructionAsync({...})
  - action.kind === 'disable'             → getDisableRouteInstructionAsync({...})
  - action.kind === 'reenable_with_terms' → getWhitelistRouteInstructionAsync({...})
  - action.kind === 'noop'                → []
```

Three replicable details:

1. **Pass `GOVERNANCE_PROGRAM_ADDRESS` as the `adminRecord`** for owner-signed calls. Codama would otherwise derive a real PDA for the `Option<Account<AdminRecord>>` and the tx would fail.
2. **Codama's async builders auto-derive every PDA from seeds** (route PDA from `[b"route", flight_id, origin, destination]`). You only pass the human inputs — `flightId`, `origin`, `destination`, `caller`. This is dramatically less error-prone than handwiring `getAddressFromPublicKey + findProgramAddressSync` everywhere.
3. **The tri-state Set/Keep enum** appears in TS as `{ __kind: 'Set', fields: [bigint] }` / `{ __kind: 'Keep' }`. Codama maps Anchor enums to a discriminated-union shape; replicate this shape exactly when constructing.

**`applyAction` callback split.** The orchestrator takes `applyAction: (action) => Promise<string>` as an injected callback, not the signer directly. This means:
- Unit tests pass a fake `applyAction` that returns a synthetic sig.
- The Express server, the one-shot CLI, and (hypothetically) a Lambda handler all reuse the same orchestrator, passing different `applyAction`s.
- `dryRun=true` simply skips invoking the callback — no special path inside the orchestrator.

### Code sample — passing the absent-admin sentinel + tri-state enum

```ts
// executor/src/scripts/run-repricer.ts
import {
  GOVERNANCE_PROGRAM_ADDRESS,
  getDisableRouteInstructionAsync,
  getUpdateRouteTermsInstructionAsync,
  getWhitelistRouteInstructionAsync,
} from '../clients/governance/src/generated/index.ts';

export async function routeActionToIxs(
  action: RouteAction,
  caller: TransactionSigner,
): Promise<Instruction[]> {
  // Owner-signed calls pass the program ID as the "absent" admin_record
  // sentinel. Codama would otherwise auto-derive a real AdminRecord PDA
  // and the tx would fail with a constraint violation.
  const ABSENT_ADMIN: Address = GOVERNANCE_PROGRAM_ADDRESS as unknown as Address;

  switch (action.kind) {
    case 'noop': return [];

    case 'update_premium': {
      const ix = await getUpdateRouteTermsInstructionAsync({
        caller,
        adminRecord: ABSENT_ADMIN,
        flightId:    action.flightId,
        origin:      action.origin,
        destination: action.destination,
        // Codama maps Anchor enums to a discriminated union — exact shape required.
        premium:     { __kind: 'Set',  fields: [action.newPremiumBaseUnits] },
        payoff:      { __kind: 'Keep' },
        delayHours:  { __kind: 'Keep' },
      });
      return [ix as unknown as Instruction];
    }

    case 'disable': {
      const ix = await getDisableRouteInstructionAsync({
        caller, adminRecord: ABSENT_ADMIN,
        flightId: action.flightId, origin: action.origin, destination: action.destination,
      });
      return [ix as unknown as Instruction];
    }

    case 'reenable_with_terms': {
      const ix = await getWhitelistRouteInstructionAsync({
        caller, adminRecord: ABSENT_ADMIN,
        flightId: action.flightId, origin: action.origin, destination: action.destination,
        premium: action.newPremiumBaseUnits, payoff: null, delayHours: null,
      });
      return [ix as unknown as Instruction];
    }
  }
  return [];
}
```

### Code sample — orchestrator wiring with `applyAction` callback

```ts
// executor/src/scripts/run-repricer.ts (main)
const result = await runRepricerOnce({
  rpc:                  solana.rpc,
  agent,                                                     // built from env
  grok,                                                      // built from env
  governanceProgramId:  kitAddress(solana.deployment.programs.governance),
  recentDisablesByRepricer: new Set(),                       // or readDisabledByRepricer() in server.ts
  dryRun,
  applyAction: async (action) => {
    const ixs = await routeActionToIxs(action, solana.signer);
    if (ixs.length === 0) return '';
    return solana.sendIxs(ixs);
  },
});
```

---

## 8. Replication checklist for a similar project

If you're building "AI agent that writes to an Anchor program," here's the minimal skeleton, in order:

1. **Lock authority isolation first.** Decide which off-chain key signs which on-chain ix. Owner vs. domain-specific authority (oracle, keeper, repricer-owner). Never let one key sign everything.
2. **Write the on-chain program with `Option<Account<...>>` admin slots** + the program-ID-as-absent-sentinel convention. Use `init_if_needed` only where the PDA seeds bind the caller's identity AND mutable state is bounded (bool, Option, counter).
3. **Build the agent as a FastAPI service** with a single domain endpoint + `/healthz`. Return *both* the human-readable value and the on-chain base-unit integer. Clamp inside the agent. Lifespan-load model state once.
4. **Wrap the LLM** (Grok / Claude / GPT) in a strict-json-schema response format. Add a constant `SAFE_DEFAULT` that the client returns on every failure path. Re-validate everything the model returns. Provide a mock client driven by env vars.
5. **Write a pure decision module** that takes the on-chain snapshot + agent output + LLM verdict + a "previously acted on" set, and returns a closed-set `Action` enum. Drift-threshold to avoid spam. Asymmetric re-enable to respect operator overrides.
6. **Discover accounts via `getProgramAccounts + memcmp`** on the 8-byte discriminator. Handwrite the Borsh decoder for the account you care about; keep the orchestrator import-free of generated clients.
7. **Translate `Action → Instruction[]` in a separate file** that owns all Codama imports. Inject it into the orchestrator as an `applyAction` callback so dry-run, unit-test, and prod-send all share one code path.
8. **Triple-mode the cron from day one**: real, mock-agent, mock-LLM, dryRun. The Express trigger UI flips mode per request; the one-shot CLI reads env. You will need every mode during the hackathon demo.
9. **JSONL the decisions** with `bigint`s stringified. This is your audit log + your "previously disabled by this cron" memory.
10. **Two HTTP timeouts to set explicitly**: agent 5s, LLM 30–45s. Default `fetch` has no timeout; abort controllers + `setTimeout` are mandatory.

---

## 9. Files to mirror (paths from this repo)

| Purpose | File |
|---|---|
| On-chain program with owner/admin auth | `contracts/programs/governance/src/lib.rs` |
| FastAPI ML agent | `agent/app/main.py` |
| Training script (model + encoder + version artifacts) | `agent/training/train.py` |
| Agent HTTP client (live + mock) | `executor/src/core/agent_client.ts` |
| LLM client (live + mock, json_schema, safe-default) | `executor/src/core/grok_client.ts` |
| Pure decision module | `executor/src/core/decide_route_actions.ts` |
| Cron orchestrator | `executor/src/core/route_repricer.ts` |
| Action → ix translator + CLI runner | `executor/src/scripts/run-repricer.ts` |
| HTTP trigger (Express) | `executor/src/server.ts` (`tickRepricer`) |

The orchestrator + decision module are intentionally Codama-import-free; the runner is the only file that touches generated clients. Replicate that boundary.

---

## 10. What I would change if starting over

- **Add probability calibration to the agent.** The XGBoost output is uncalibrated and predictions bunch around 0.2–0.3. A Platt or isotonic calibrator on a holdout set would make the multiplier meaningful.
- **Cache route discovery.** `getProgramAccounts` against a public RPC is a heavy call; with 100+ routes the cron pays for it every tick. A 1-minute in-process cache or a websocket subscription would be a big win.
- **Move the "previously disabled by this cron" set on-chain.** Today it's a JSONL file on the cron host. If you re-deploy the cron, you lose the memory and accidentally re-enable everything. A small `DisabledByCron` PDA per route would fix it — at the cost of one more ix per disable.
- **Auth the agent.** Even though the trust boundary is internal, a single shared secret in a header would let you put the agent behind a reverse proxy and detect drift. The cost is one env var.
- **Type the on-chain decoder with a runtime check on the discriminator.** Right now we trust the memcmp filter; a paranoid check after `Buffer.from(data, 'base64')` catches RPC-side bugs.
