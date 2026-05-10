"""Sentinel Premium Pricing Agent — FastAPI service (Phase 22).

Maps a flight tuple to a USDC premium clamped to [$1, $5] using an XGBoost
model trained on the Kaggle 2008 flight-delay dataset.

Premium formula (POC):
    premium_usdc = clamp(1 + 4 * p_delay, 1, 5)
    premium_base_units = round(premium_usdc * 1_000_000)  # USDC 6-decimals

The model's target is `dep_delayed_15min` — a proxy for Sentinel's actual
covered-event trigger (Delayed/Cancelled at arrival). See agent/README.md
"Known limitations" for the calibration follow-up.

Run:
    cd agent && python -m uvicorn app.main:app --port 8000
or:
    make serve
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

AGENT_ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS_DIR = Path(
    os.environ.get("AGENT_ARTIFACTS_DIR", str(AGENT_ROOT / "artifacts"))
)

CAT_FEATURES = ["Month", "DayofMonth", "DayOfWeek", "UniqueCarrier", "Origin", "Dest"]
NUM_FEATURES = ["DepTime", "Distance"]

USDC_BASE_UNITS_PER_USDC = 1_000_000  # USDC has 6 decimals on Solana

# Module-level state, populated in lifespan startup.
_state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load model artifacts at startup; fail fast if any are missing."""
    model_path = ARTIFACTS_DIR / "model.joblib"
    encoder_path = ARTIFACTS_DIR / "encoder.joblib"
    version_path = ARTIFACTS_DIR / "model_version.txt"

    for required in (model_path, encoder_path, version_path):
        if not required.exists():
            raise RuntimeError(
                f"Missing artifact: {required}. Run `make train` first. "
                "See agent/README.md for setup."
            )

    _state["model"] = joblib.load(model_path)
    _state["encoder"] = joblib.load(encoder_path)
    _state["model_version"] = version_path.read_text().strip()
    _state["loaded_at"] = datetime.now(timezone.utc).isoformat()
    yield
    _state.clear()


app = FastAPI(
    title="Sentinel Premium Pricing Agent",
    version="0.1.0",
    description=(
        "Maps a flight tuple to a USDC premium in [$1, $5] using XGBoost "
        "trained on the Kaggle 2008 flight-delay dataset. Phase 22 (POC)."
    ),
    lifespan=lifespan,
)


# ─── Schemas ──────────────────────────────────────────────────────────────


class PriceRequest(BaseModel):
    flight_id: str = Field(..., description="Informational only; not a model feature (e.g. 'AA100').")
    carrier: str = Field(..., description="IATA carrier code (e.g. 'AA').")
    origin: str = Field(..., description="IATA origin airport code (e.g. 'ATL').")
    dest: str = Field(..., description="IATA destination airport code (e.g. 'DFW').")
    dep_time_hhmm: int = Field(..., ge=0, le=2359, description="Scheduled departure time as HHMM int.")
    distance_mi: int = Field(..., ge=0, description="Route distance in miles.")
    month: int = Field(..., ge=1, le=12)
    day_of_month: int = Field(..., ge=1, le=31)
    day_of_week: int = Field(..., ge=1, le=7, description="Mon=1, Sun=7.")


class PriceResponse(BaseModel):
    # Pydantic 2 reserves the `model_` prefix; opt out so `model_version`
    # passes validation without a warning.
    model_config = ConfigDict(protected_namespaces=())

    p_delay: float
    premium_usdc: float
    premium_base_units: int
    model_version: str


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    model_version: str
    loaded_at: str


# ─── Helpers ──────────────────────────────────────────────────────────────


def to_notebook_format(req: PriceRequest) -> pd.DataFrame:
    """Translate a PriceRequest into the notebook's expected DataFrame format.

    The training notebook (`agent/training/model_1.ipynb`) represents
    Month/DayofMonth/DayOfWeek as `c-{n}` strings (e.g. `c-7`, `c-21`). The
    fitted ColumnTransformer expects the same encoding at serving time.
    """
    row = {
        "Month": f"c-{req.month}",
        "DayofMonth": f"c-{req.day_of_month}",
        "DayOfWeek": f"c-{req.day_of_week}",
        "UniqueCarrier": req.carrier,
        "Origin": req.origin,
        "Dest": req.dest,
        "DepTime": req.dep_time_hhmm,
        "Distance": req.distance_mi,
    }
    return pd.DataFrame([row], columns=CAT_FEATURES + NUM_FEATURES)


def clamp_premium(p_delay: float) -> tuple[float, int]:
    """Return (premium_usdc, premium_base_units) from a probability.

    POC formula: premium_usdc = clamp(1 + 4 * p_delay, 1, 5).
    USDC base units use 6 decimals on Solana (1 USDC = 1_000_000 base units).
    """
    raw = 1.0 + 4.0 * float(p_delay)
    premium_usdc = max(1.0, min(5.0, raw))
    premium_base_units = round(premium_usdc * USDC_BASE_UNITS_PER_USDC)
    return premium_usdc, premium_base_units


# ─── Routes ───────────────────────────────────────────────────────────────


@app.get("/")
def banner() -> dict[str, str]:
    return {
        "service": "sentinel-premium-pricing-agent",
        "phase": "22",
        "see": "POST /price, GET /healthz",
    }


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    if "model_version" not in _state:
        raise HTTPException(status_code=503, detail="Model artifacts not loaded.")
    return HealthResponse(
        status="ok",
        model_version=str(_state["model_version"]),
        loaded_at=str(_state["loaded_at"]),
    )


@app.post("/price", response_model=PriceResponse)
def price(req: PriceRequest) -> PriceResponse:
    encoder = _state.get("encoder")
    model = _state.get("model")
    if encoder is None or model is None:
        raise HTTPException(status_code=503, detail="Model artifacts not loaded.")

    df = to_notebook_format(req)
    X = encoder.transform(df)
    p_delay = float(model.predict_proba(X)[0, 1])
    premium_usdc, premium_base_units = clamp_premium(p_delay)

    return PriceResponse(
        p_delay=p_delay,
        premium_usdc=premium_usdc,
        premium_base_units=premium_base_units,
        model_version=str(_state["model_version"]),
    )
