"""Tests for the Sentinel Premium Pricing Agent (Phase 22)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import ARTIFACTS_DIR, USDC_BASE_UNITS_PER_USDC, app


def _known_payload() -> dict:
    """A real route + date sampled from the Kaggle training set."""
    return {
        "flight_id": "AA100",
        "carrier": "AA",
        "origin": "ATL",
        "dest": "DFW",
        "dep_time_hhmm": 1934,
        "distance_mi": 732,
        "month": 8,
        "day_of_month": 21,
        "day_of_week": 7,
    }


def test_known_route_returns_clamped_value() -> None:
    """Known route returns premium_usdc in [1.0, 5.0] and p_delay in [0, 1]."""
    with TestClient(app) as client:
        response = client.post("/price", json=_known_payload())

    assert response.status_code == 200
    body = response.json()
    assert 1.0 <= body["premium_usdc"] <= 5.0
    assert 0.0 <= body["p_delay"] <= 1.0


def test_unknown_carrier_does_not_500() -> None:
    """Unknown carrier/origin/dest should produce a clamped response, not a 500.

    OneHotEncoder(handle_unknown="ignore") feeds an all-zero row into the
    OHE feature space; the model still predicts. Critical for serving
    routes the Kaggle 2008 dataset never saw.
    """
    payload = _known_payload()
    payload["carrier"] = "ZZ"  # not in the training set
    payload["origin"] = "QQQ"
    payload["dest"] = "RRR"

    with TestClient(app) as client:
        response = client.post("/price", json=payload)

    assert response.status_code == 200, f"got {response.status_code}: {response.text}"
    body = response.json()
    assert 1.0 <= body["premium_usdc"] <= 5.0


def test_healthz_reflects_loaded_model_version() -> None:
    """/healthz returns the same version string written to model_version.txt."""
    expected_version = (ARTIFACTS_DIR / "model_version.txt").read_text().strip()

    with TestClient(app) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["model_version"] == expected_version


def test_base_units_match_usdc_rounding() -> None:
    """premium_base_units == round(premium_usdc * 1_000_000)."""
    with TestClient(app) as client:
        response = client.post("/price", json=_known_payload())

    body = response.json()
    expected = round(body["premium_usdc"] * USDC_BASE_UNITS_PER_USDC)
    assert body["premium_base_units"] == expected
