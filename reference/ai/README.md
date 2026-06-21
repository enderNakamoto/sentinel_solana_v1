# AI Reference — Premium Pricing Agent

A complete, copy-pasteable reference for the **flight delay premium pricing agent**: a FastAPI service that wraps an XGBoost model trained on the BTS / Kaggle 2008 flight-delay dataset and returns a stablecoin premium clamped to `[$1, $5]` for any flight tuple.

Originally Phase 22 of the Sentinel Solana project. The model + service + data + tests are all included here so a receiving agent can stand it up in a new project from scratch.

---

## 1. Quick start (for the receiving agent)

```bash
# 1. Copy this whole folder into your project (any layout — the code uses an
#    AGENT_ROOT-relative artifact path with an env override).
cp -r reference/ai  <new-project>/agent
cd <new-project>/agent

# 2. macOS only — install OpenMP runtime (xgboost native lib needs it).
brew install libomp

# 3. Python 3.10+ (3.11 in Docker).
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

# 4. Train the model. The CSV is already in data/ — no download needed.
python -m training.train          # ~30s on modern laptop; writes 4 artifacts to ./artifacts/

# 5. Serve.
uvicorn app.main:app --host 0.0.0.0 --port 8000

# 6. Hit it.
curl -sS -X POST http://localhost:8000/price \
  -H "Content-Type: application/json" \
  -d '{"flight_id":"AA100","carrier":"AA","origin":"ATL","dest":"DFW",
       "dep_time_hhmm":1934,"distance_mi":732,"month":8,"day_of_month":21,"day_of_week":7}'
```

`Makefile.reference` is included — if you bring it to your repo root as `Makefile` you get `make install`, `make train`, `make serve`, `make test`, `make clean` for free. Adjust the `cd agent &&` prefix if your folder layout differs.

---

## 2. What's in this folder

```
reference/ai/
├── README.md                ← you are here (rebuild guide)
├── Makefile.reference       ← top-level make targets (copy to your repo root as `Makefile`)
├── Dockerfile               ← multi-stage Python 3.11-slim build, libgomp1, HEALTHCHECK
├── requirements.txt         ← pinned deps (fastapi, uvicorn, xgboost 2.1, scikit-learn, pandas, joblib, pytest, httpx)
├── app/
│   ├── __init__.py
│   └── main.py              ← FastAPI app (189 lines): GET /, POST /price, GET /healthz
├── training/
│   ├── __init__.py
│   ├── train.py             ← training script (141 lines): split, OHE, fit, persist artifacts
│   └── model_1.ipynb        ← source Kaggle notebook (kept for diffability; not used at runtime)
├── tests/
│   ├── __init__.py
│   └── test_price.py        ← 4 pytest cases via FastAPI TestClient
└── data/
    └── flight_delays_train.csv   ← 3.3 MB, 100,000 rows, Kaggle 2008 BTS delay data
```

After `python -m training.train` you'll also have:

```
artifacts/                   ← gitignore this
├── model.joblib             ← ~1.4 MB — fitted XGBClassifier
├── encoder.joblib           ← ~10 KB — fitted ColumnTransformer (OneHotEncoder + passthrough)
├── feature_names.json       ← ~13 KB — 650 post-OHE feature names (reference only)
└── model_version.txt        ← 21 bytes — UTC ISO 8601 timestamp of training
```

---

## 3. Premium formula (POC)

```python
premium_usdc       = clamp(1 + 4 * p_delay, 1, 5)
premium_base_units = round(premium_usdc * 1_000_000)   # 6-decimal stablecoin (USDC)
```

- `p_delay` comes from `model.predict_proba(X)[:, 1]` (probability of delay class).
- The clamp lives in the **agent**, not in any downstream cron. If the downstream applies a multiplier (e.g. a live-news adjustment), it should re-clamp after multiplying.
- Hackathon-grade pricing — proof-of-concept only, **not actuarially sound**.

If your stablecoin has different decimals (e.g. 9 for native SOL), change the `1_000_000` constant in `app/main.py`.

---

## 4. Model details (locked)

### Features (input columns to the encoder)

| Feature | Type | Encoding | Notes |
|---|---|---|---|
| `Month` | string `c-1`…`c-12` | one-hot | Stored in CSV as `c-N`, not int — keep this format |
| `DayofMonth` | string `c-1`…`c-31` | one-hot | Same `c-N` convention |
| `DayOfWeek` | string `c-1`…`c-7` | one-hot | Mon=1, Sun=7 |
| `UniqueCarrier` | string IATA code (e.g. `AA`) | one-hot | ~30 carriers in train set |
| `Origin` | string IATA airport (e.g. `ATL`) | one-hot | ~300 airports |
| `Dest` | string IATA airport (e.g. `DFW`) | one-hot | ~300 airports |
| `DepTime` | int HHMM (0–2359) | passthrough | Scheduled departure |
| `Distance` | int miles | passthrough | Route distance |

**Target**: `dep_delayed_15min` — `"Y"` (1) or `"N"` (0). Binary classification: departure delayed >15 min. Class balance ~19% delayed / ~81% not.

**Post-OHE feature count**: 650 columns.

**`handle_unknown="ignore"`** on the OHE — unseen carrier/origin/dest at inference produces an all-zero OHE row; the model predicts the train-set baseline (~0.19 → ~$1.76 premium). This is intentional (avoids 500s on every flight the dataset didn't see).

### Train / valid / test split

```python
TRAIN_SIZE = 0.7      # 70% train, 30% temp
TEST_VALID_REL = 0.5  # temp → 50/50 valid/test → 15% valid, 15% test
RANDOM_STATE = 42     # stratified by target
```

### XGBoost hyperparameters

```python
XGB_PARAMS = {
    "n_estimators": 200,
    "learning_rate": 0.1,
    "max_depth": 9,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "random_state": 42,
    "n_jobs": -1,
    "eval_metric": "logloss",
}
```

These are the Kaggle-winning settings from the source notebook. **Don't tune without a reason.** Validation ROC AUC lands around **0.7497** (within ±0.005 of the notebook's reported 0.7505).

### Why fit OHE on training only (vs. train+test concat as the notebook does)

The notebook concatenates train+test before fitting OHE — fine for the Kaggle leaderboard, but at serving time we won't have the test set. Fitting on training only adds ~0.0008 ROC AUC delta (negligible) and is the correct production posture. `handle_unknown="ignore"` covers unseen categories at inference.

---

## 5. Service contract

### `POST /price`

**Request** (Pydantic — `PriceRequest`):

```python
flight_id: str           # e.g. "AA100" — informational, not a model feature
carrier: str             # IATA carrier code, 1-3 chars
origin: str              # IATA airport
dest: str                # IATA airport
dep_time_hhmm: int       # 0–2359
distance_mi: int         # ≥ 0
month: int               # 1–12
day_of_month: int        # 1–31
day_of_week: int         # 1–7 (Mon=1)
```

**Response** (`PriceResponse`):

```python
p_delay: float           # 0..1 — from model.predict_proba()[:, 1]
premium_usdc: float      # 1.0 to 5.0 (clamped)
premium_base_units: int  # round(premium_usdc * 1_000_000)
model_version: str       # ISO 8601 UTC timestamp from model_version.txt
```

### `GET /healthz`

```json
{
  "status": "ok",
  "model_version": "2026-05-10T12:41:08Z",
  "loaded_at": "2026-05-10T12:43:26.015899+00:00"
}
```

503 if artifacts didn't load.

### `GET /`

One-line banner so a stray browser hit doesn't 404.

---

## 6. Inference pipeline (what `POST /price` actually does)

1. Accept `PriceRequest` (Pydantic validates types + bounds).
2. Convert `month` / `day_of_month` / `day_of_week` to `c-{n}` strings (matches training format).
3. Rename `carrier → UniqueCarrier`, `dep_time_hhmm → DepTime`, `distance_mi → Distance`.
4. Build a 1-row pandas DataFrame in training column order: `[CAT_FEATURES] + [NUM_FEATURES]`.
5. Pass through the loaded `ColumnTransformer` → 650-element feature vector.
6. `model.predict_proba(X)[0, 1]` → `p_delay`.
7. `clamp(1 + 4*p_delay, 1, 5)` → `premium_usdc`.
8. `round(premium_usdc * 1_000_000)` → `premium_base_units`.
9. Return `PriceResponse`.

---

## 7. Environment variables

| Name | Default | Purpose |
|---|---|---|
| `AGENT_ARTIFACTS_DIR` | `<agent_root>/artifacts` | Override artifact location (testing against frozen sets, mounted volumes) |
| `AGENT_PORT` | `8000` | Used by `make serve` — the app code doesn't read this; uvicorn does via the make target |

Pydantic uses `protected_namespaces=()` on `PriceResponse` and `HealthResponse` to allow the `model_version` field name without warning — keep this if you rename anything else.

---

## 8. The data file

`data/flight_delays_train.csv` — included in this reference folder, **3.3 MB, 100,000 rows + header**.

```
Month,DayofMonth,DayOfWeek,DepTime,UniqueCarrier,Origin,Dest,Distance,dep_delayed_15min
c-8,c-21,c-7,1934,AA,ATL,DFW,732,N
c-4,c-20,c-3,1548,US,PIT,MCO,834,N
c-9,c-2,c-5,1422,XE,RDU,CLE,416,N
...
```

**Source**: Kaggle competition [flight-delays-fall-2018](https://www.kaggle.com/competitions/flight-delays-fall-2018/data), derived from US Bureau of Transportation Statistics (BTS) 2008 on-time data.

**Class balance**: ~81% `N` (not delayed), ~19% `Y` (delayed >15 min).

No preprocessing/cleaning is applied — `train.py` reads the raw CSV as-is. If you swap to a different dataset, the column names + value formats (`c-N` for month/day, `Y`/`N` for target) must match or you'll need to rewrite the encoder block in `train.py`.

---

## 9. Tests

`tests/test_price.py` — 4 pytest cases via FastAPI's `TestClient`:

1. `test_known_route_returns_clamped_value` — `AA ATL→DFW 8/21` returns `p_delay ∈ [0,1]`, `premium_usdc ∈ [1,5]`.
2. `test_unknown_carrier_does_not_500` — Unknown carrier/origin/dest (`ZZ`, `QQQ`, `RRR`) returns 200 with a clamped response (exercises `handle_unknown="ignore"`).
3. `test_healthz_reflects_loaded_model_version` — `/healthz` version string matches `model_version.txt`.
4. `test_base_units_match_usdc_rounding` — `premium_base_units == round(premium_usdc * 1_000_000)`.

Run: `pytest -v` from the agent root, or `make test`.

Precondition: artifacts must exist. If you haven't run `python -m training.train` yet, the tests fail at app-startup with "artifacts not found."

---

## 10. Docker

```bash
python -m training.train         # train first — artifacts get baked into the image
docker build -t agent .
docker run -p 8000:8000 agent
curl http://localhost:8000/healthz
```

Multi-stage build on `python:3.11-slim`. `libgomp1` (OpenMP runtime) installed in both stages because xgboost loads it at import time. HEALTHCHECK against `/healthz` every 30s.

If you'd rather train inside the container, add a `RUN python -m training.train` step before the COPY of artifacts — but then the data CSV must also be copied in (it's currently expected to live on the host).

---

## 11. Adapting to a new project

| You want to… | Do this |
|---|---|
| Use a different stablecoin with different decimals | Change `1_000_000` in `app/main.py` (`premium_base_units` calc). |
| Use a different premium scale (not `$1–$5`) | Change the clamp constants in `app/main.py`. |
| Retrain on your own flight-delay dataset | Match the schema in §4 OR rewrite `training/train.py`'s encoder block. The model + service code is dataset-shape-independent once the encoder is updated. |
| Add authentication | Add a FastAPI dependency that checks `X-AGENT-TOKEN` header against an env var. Originally deferred. |
| Scale to >1 RPS | Run uvicorn with `--workers N` behind a reverse proxy, or switch to gunicorn + uvicorn workers. The model + encoder are picklable so workers each load their own copy at startup. |
| Add probability calibration | Wrap `model` in `CalibratedClassifierCV` AFTER training. Don't add it without evidence the raw output is bunched. |
| Swap XGBoost for another model | Keep the joblib interface (`model.predict_proba(X)[:, 1]`) so `main.py` doesn't change. Update `XGB_PARAMS` → your hyperparameters. |
| Different consumer (not a cron) | The endpoint is a plain POST — anything that can `curl` it works. |

---

## 12. Known limitations (carried from original Phase 22)

- **Proxy target.** The model predicts `dep_delayed_15min` (departure delay >15 min). The original Sentinel payout trigger was arrival-delay-based — these correlate but aren't the same probability. If you're rebuilding for a different parametric trigger, retrain with the correct label as soon as you have ground-truth data.
- **No probability calibration.** Raw XGBoost output, linear $1–$5 mapping. If predictions bunch in demo, file an issue rather than patching calibration in blind.
- **No auth.** POC runs open. Add `X-AGENT-TOKEN` if exposing publicly.
- **Single sync worker.** Fine for the hackathon load profile; scale via workers/proxy for production.
- **Unknown categories degrade gracefully** to the baseline (~$1.76) rather than 500-ing. This is the intended behaviour for unseen carriers/airports.

---

## 13. Source code map

If you want to read just enough to understand the agent:

1. `data/flight_delays_train.csv` first 5 rows — what the input looks like.
2. `training/train.py` — 141 lines, end-to-end. Read top-to-bottom.
3. `app/main.py` — 189 lines. Read `_load_artifacts`, `to_notebook_format`, `clamp_premium`, then the route handlers.
4. `tests/test_price.py` — the contract.
5. `Dockerfile` last — only matters when deploying.

The original `model_1.ipynb` is kept for diff-against-source; you don't need it at runtime.
