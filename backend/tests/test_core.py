# backend/tests/test_core.py
import math
import backend.app as mod

def test_ewma_basic():
    e = mod.EWMA(alpha=0.5)
    assert e.update(0.0) == 0.0
    assert e.update(10.0) == 5.0
    assert round(e.update(10.0), 2) == 7.5

def test_calc_level_thresholds():
    # GREEN < 0.7, YELLOW < 0.9, aksi RED (app.py'deki sabitlere göre)
    assert mod.calc_level(0.50) == "GREEN"
    assert mod.calc_level(0.80) == "YELLOW"
    assert mod.calc_level(1.10) == "RED"

def test_mu_for_scales_with_officers():
    mod.officers["CPX"] = 3
    mu = mod.mu_for("CPX")
    assert math.isclose(mu, 3 * mod.MU_PER_OFFICER, rel_tol=1e-6)
