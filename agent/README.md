# Sentinel Premium Pricing Agent

Phase 22 service. A small FastAPI app that wraps an XGBoost model trained on
the Kaggle 2008 flight-delay dataset and returns a USDC premium clamped to
`[$1, $5]` for any flight tuple.

The only consumer is the **Phase 23 `RouteRepricer` cron**, which calls
`POST /price` once per whitelisted route and feeds the response into a
governance-program `update_route_terms` tx.

## Premium formula (POC)

```
premium_usdc       = clamp(1 + 4 * p_delay, 1, 5)
premium_base_units = round(premium_usdc * 1_000_000)   # USDC has 6 decimals
```

Hackathon-grade pricing — proof-of-concept only, **not actuarially sound**.

## Setup

| Step | Command | Notes |
|---|---|---|
| 1. Python 3.10+ | `python3 --version` | 3.11 in the Docker image; 3.10 works locally |
| 2. macOS only — install OpenMP runtime | `brew install libomp` | xgboost's native lib needs `libomp.dylib` |
| 3. Create venv | `python3 -m venv agent/.venv` | `.venv/` is gitignored |
| 4. Install deps | `agent/.venv/bin/pip install -r agent/requirements.txt` | or `make install` |
| 5. Drop the dataset | Save `flight_delays_train.csv` into `agent/data/` | `make download-data` prints the Kaggle URL |
| 6. Train the model | `make train` | ~30s on a modern laptop; produces 4 artifacts |
| 7. Run the service | `make serve` | uvicorn on port 8000 by default |
| 8. Run the tests | `make test` | 4 cases; ~1.5s |

## Make targets

| Target | What it does |
|---|---|
| `make install` | `pip install -r agent/requirements.txt` into the active interpreter |
| `make train` | Train + persist `model.joblib` / `encoder.joblib` / `feature_names.json` / `model_version.txt` |
| `make serve` | Start FastAPI on `$AGENT_PORT` (default `8000`) |
| `make test` | Run pytest |
| `make download-data` | Print Kaggle dataset URL + manual-download steps |
| `make clean` | Remove `agent/artifacts/` and Python caches |

## Endpoint contract

### `POST /price`

```bash
curl -sS -X POST http://localhost:8000/price \
  -H "Content-Type: application/json" \
  -d '{
    "flight_id": "AA100",
    "carrier": "AA",
    "origin": "ATL",
    "dest": "DFW",
    "dep_time_hhmm": 1934,
    "distance_mi": 732,
    "month": 8,
    "day_of_month": 21,
    "day_of_week": 7
  }'
```

Response:

```json
{
  "p_delay": 0.4970,
  "premium_usdc": 2.9879,
  "premium_base_units": 2987923,
  "model_version": "2026-05-10T12:41:08Z"
}
```

### `GET /healthz`

```bash
curl -sS http://localhost:8000/healthz
```

Response:

```json
{
  "status": "ok",
  "model_version": "2026-05-10T12:41:08Z",
  "loaded_at": "2026-05-10T12:43:26.015899+00:00"
}
```

### `GET /`

Returns a one-line banner so a stray browser hit doesn't 404. Not
machine-consumed.

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `AGENT_PORT` | `8000` | uvicorn listen port |
| `AGENT_ARTIFACTS_DIR` | `agent/artifacts/` | Override the location of `model.joblib` etc. — useful for tests against a frozen artifact set |

## Docker

```bash
make train                                    # training is a precondition
docker build -t sentinel-agent agent/         # builds with artifacts copied in
docker run -p 8000:8000 sentinel-agent
curl http://localhost:8000/healthz
```

The image is multi-stage on `python:3.11-slim`. `libgomp1` (OpenMP runtime)
is installed in both stages because xgboost's native lib loads it at import
time. The container has a `HEALTHCHECK` against `/healthz` so platforms
(Render / Railway) can mark the container ready.

## Known limitations

- **The model's target is a proxy.** The Kaggle 2008 dataset labels
  `dep_delayed_15min` (departure delay > 15 minutes). Sentinel's actual
  payout trigger is `Delayed`/`Cancelled` at arrival per per-route
  `delay_hours`. These correlate but are not the same probability — the
  agent prices a proxy. Calibration against Sentinel-trigger labels is a
  follow-up after enough on-chain settlements accumulate.
- **No probability calibration.** XGBoost output is not isotonic /
  Platt-calibrated; the linear `$1–$5` mapping intentionally amplifies the
  raw `p_delay` without correction. If demo predictions look bunched, file
  a follow-up — do not patch in calibration without an issue.
- **No auth on the endpoint.** POC runs unauthenticated. Mainnet hardening
  is a shared-secret header (`X-AGENT-TOKEN`); deferred.
- **Single sync FastAPI worker.** No `--workers N`, no async DB, no Redis.
  Hackathon scope.
- **Unknown categories quietly fall back to baseline.**
  `OneHotEncoder(handle_unknown="ignore")` feeds an all-zero row into the
  OHE feature space for any unseen `Origin` / `Dest` / `UniqueCarrier`.
  The model's prediction trends toward the train-set mean (~0.19), which
  clamps to ~$1.76. This is a feature, not a bug — the alternative is to
  500 on every flight Kaggle 2008 didn't see.

## Deploy

The agent is dyno-agnostic. Two viable shapes:

1. **Co-host with the frontend** on the same Render/Railway box, different
   port. Simplest for the hackathon. Phase 23 sees `AGENT_BASE_URL=http://localhost:8000`.
2. **Standalone Python service** on its own URL. Phase 23 sees
   `AGENT_BASE_URL=https://agent.sentinel.example`.

Phase 22 doesn't lock this in — pick whichever fits when wiring Phase 23.

## Reference

- Source notebook: `refrence_models/model_1.ipynb`
- Phase plan: `spec/phases/phase-22-premium-pricing-agent.md`
- Architecture: `spec/architecture.md` §Off-Chain Executor Layer
- Consumer: `spec/phases/phase-23-route-repricer-cron.md`
