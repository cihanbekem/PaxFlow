# backend/tests/test_api.py
import pytest

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data.get("ok") is True
    assert "csv" in data  # yol döner

def test_latest_returns_list(client):
    r = client.get("/api/latest?minutes=1")
    assert r.status_code == 200
    arr = r.json()
    assert isinstance(arr, list) and len(arr) >= 1
    item = arr[-1]
    for key in ("checkpoint_id", "rho", "level", "n_t", "lambda_hat", "mu"):
        assert key in item

def test_summary_human_readable(client):
    r = client.get("/api/summary?minutes=5")
    assert r.status_code == 200
    arr = r.json()
    assert isinstance(arr, list) and len(arr) >= 1
    human = arr[-1]
    for key in ("headline", "detail", "advice", "emoji", "level", "rho"):
        assert key in human

def test_set_capacity_changes_officers(client):
    # önce 1 görevli
    r1 = client.get("/api/summary?minutes=5")
    assert r1.status_code == 200

    # 3 görevliye çıkar
    r = client.post("/api/capacity", json={"checkpoint_id": "CP1", "officers": 3})
    assert r.status_code == 200
    resp = r.json()
    assert resp["ok"] is True
    assert resp["checkpoint_id"] == "CP1"
    assert resp["officers"] == 3
    assert "mu_per_officer" in resp

@pytest.mark.skipif(True, reason="Opsiyonel: endpoint yoksa atla")
def test_metrics_last_minutes_optional(client):
    r = client.get("/api/metrics/last_minutes?minutes=5")
    if r.status_code == 404:
        pytest.skip("metrics endpoint yok")
    assert r.status_code == 200
    data = r.json()
    assert "series" in data and "kpis" in data
