# backend/tests/conftest.py
import pytest
from fastapi.testclient import TestClient
from datetime import datetime
from copy import deepcopy

# Uygulamayı ve global state'i al
import backend.app as mod  # app.py 'backend' klasöründe

@pytest.fixture(autouse=True)
def _isolate_state():
    """
    Her testten önce global state'i temizle.
    """
    with mod.lock:
        mod.recent.clear()
        mod.officers.clear()
        mod.ewmas.clear()
    # varsayılan 1 görevli
    mod.officers["CP1"] = 1
    yield
    # test sonrası da temizle
    with mod.lock:
        mod.recent.clear()
        mod.officers.clear()
        mod.ewmas.clear()

@pytest.fixture()
def client():
    """
    TestClient + içine 1 adet örnek kayıt bas.
    """
    ts = datetime.utcnow().replace(second=0, microsecond=0).isoformat()
    cp = "CP1"
    n_t = 3
    x_t = float(n_t)
    lam = mod.ewmas[cp].update(x_t)          # EWMA başlat ve güncelle
    mu = mod.mu_for(cp)
    rho = lam / mu if mu > 0 else 999.0
    rec = {
        "ts_minute": ts,
        "checkpoint_id": cp,
        "n_t": n_t,
        "x_t": x_t,
        "lambda_hat": lam,
        "mu": mu,
        "rho": rho,
        "level": mod.calc_level(rho),
    }
    with mod.lock:
        mod.recent.append(rec)

    return TestClient(mod.app)
