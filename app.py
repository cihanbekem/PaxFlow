# backend/app.py
import os, threading, time
from collections import defaultdict, deque
from datetime import datetime
from typing import Deque, Dict, List

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import math
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles


TR_LEVEL = {"GREEN": "YEŞİL", "YELLOW": "SARI", "RED": "KIRMIZI"}
EMOJI = {"GREEN": "🟢", "YELLOW": "🟡", "RED": "🔴"}

def _dedupe_by_minute(records):
    """Aynı dakika+checkpoint için en son kaydı bırak."""
    uniq = {}
    for r in records:
        key = (r["ts_minute"], r["checkpoint_id"])
        uniq[key] = r
    return sorted(uniq.values(), key=lambda r: (r["checkpoint_id"], r["ts_minute"]))

def _summarize(rec):
    """Tek bir kaydı insan diliyle açıkla + öneri üret."""
    cp = rec["checkpoint_id"]
    ts = rec["ts_minute"].replace("T", " ")[:16]  # 2025-08-14 14:15
    n_t = rec.get("n_t", 0)
    lam = float(rec.get("lambda_hat", 0.0))
    mu  = float(rec.get("mu", 0.0))
    rho = float(rec.get("rho", 0.0))
    level = rec.get("level", "GREEN")

    # Kaç görevli var / kaç olmalı?
    current_officers = officers[cp]
    # Hedefi “yeşile” çekmek için gereken min görevli sayısı (rho < GREEN eşiği)
    needed_for_green = math.ceil(lam / (GREEN * MU_PER_OFFICER)) if MU_PER_OFFICER > 0 else current_officers
    addl = max(0, needed_for_green - current_officers)

    headline = f"{ts} – {cp} – {EMOJI[level]} {TR_LEVEL[level]}"
    detail = (f"Son dakikada {n_t} kişi geçti. "
              f"Tahmini hız ≈ {lam:.1f} kişi/dk. "
              f"Kapasite ≈ {mu:.2f} kişi/dk (görevli: {current_officers}). "
              f"Yoğunluk ≈ {rho:.2f}×.")

    if level == "RED":
        advice = f"Öneri: En az {needed_for_green} görevliye çıkarın (≈ +{addl})."
    elif level == "YELLOW":
        advice = "Öneri: Artış sürerse +1 görevli eklemeye hazır olun."
    else:
        advice = "Öneri: Akış normal; izlemeye devam."

    return {
        "checkpoint_id": cp,
        "time": ts,
        "level": TR_LEVEL[level],
        "emoji": EMOJI[level],
        "rho": round(rho, 2),
        "headline": headline,
        "detail": detail,
        "advice": advice,
    }


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.getenv("CSV_PATH", os.path.join(BASE_DIR, "flight_data.csv"))
BUCKET = "1T"          # 1 dakika
ALPHA = 0.25           # EWMA
MU_PER_OFFICER = 0.50  # kişi/dk (örnek)
GREEN, YELLOW = 0.7, 0.9

app = FastAPI(title="EWMA Boarding Load")
UI_DIR = os.path.join(BASE_DIR, "ui")
app.mount("/ui", StaticFiles(directory=UI_DIR, html=True), name="ui")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# --- Basit durum (state) ---
class EWMA:
    def __init__(self, alpha: float): self.a, self.v = alpha, None
    def update(self, x: float) -> float:
        self.v = x if self.v is None else self.a * x + (1 - self.a) * self.v
        return self.v

ewmas: Dict[str, EWMA] = defaultdict(lambda: EWMA(ALPHA))
officers: Dict[str, int] = defaultdict(lambda: 1)  # cp -> görevli sayısı
recent: Deque[dict] = deque(maxlen=600)            # ~10 saat / 1 dk
lock = threading.Lock()

def calc_level(rho: float) -> str:
    if rho < GREEN: return "GREEN"
    if rho < YELLOW: return "YELLOW"
    return "RED"

def mu_for(cp: str) -> float:
    return max(0.01, officers[cp] * MU_PER_OFFICER)

def build_counts() -> pd.DataFrame:
    # 1) Dosya kontrolü
    if not os.path.exists(CSV_PATH) or os.path.getsize(CSV_PATH) == 0:
        return pd.DataFrame(columns=["ts", "checkpoint_id", "n_t"])

    df = pd.read_csv(CSV_PATH)

    if df.empty:
        return pd.DataFrame(columns=["ts", "checkpoint_id", "n_t"])

    # 2) Sütunları normalize et
    # Zaman damgası: CSV'de 'CheckDate' var; onu kullan
    if "CheckDate" in df.columns:
        df = df.rename(columns={"CheckDate": "ts"})
    elif "ts" in df.columns:
        pass
    else:
        # Başka bir isim varsa buraya ekleyebilirsin
        raise ValueError(f"Zaman damgası sütunu bulunamadı. Mevcut sütunlar: {list(df.columns)}")

    # Checkpoint yoksa tek hat varsay: CP1
    if "checkpoint_id" not in df.columns:
        df["checkpoint_id"] = "CP1"

    # 3) Zamanı dönüştür
    df["ts"] = pd.to_datetime(df["ts"], errors="coerce")
    df = df.dropna(subset=["ts"])

    # 4) Dakikalık sayım (bucket = 1 dakika)
    grp = (
        df.set_index("ts")
          .groupby("checkpoint_id")
          .resample(BUCKET).size()
          .rename("n_t")
          .reset_index()
    )

    # 5) Eksik dakikaları 0 ile doldur (her checkpoint için)
    frames = []
    for cp, g in grp.groupby("checkpoint_id"):
        g = g.set_index("ts").asfreq(BUCKET)
        g["n_t"] = g["n_t"].fillna(0).astype(int)
        g["checkpoint_id"] = cp
        frames.append(g.reset_index())

    if not frames:
        return pd.DataFrame(columns=["ts", "checkpoint_id", "n_t"])

    res = pd.concat(frames).sort_values(["checkpoint_id", "ts"])
    return res


def updater_loop():
    last_size = -1
    while True:
        try:
            size = os.path.getsize(CSV_PATH) if os.path.exists(CSV_PATH) else -1
            if size != last_size:
                res = build_counts()
                if not res.empty:
                    last = res.iloc[-1]
                    ts = last["ts"]
                    cp = str(last["checkpoint_id"])
                    n_t = int(last["n_t"])
                    x_t = n_t / 1.0  # kişi/dk
                    lam = ewmas[cp].update(x_t)
                    mu = mu_for(cp)
                    rho = lam / mu if mu > 0 else 999.0
                    rec = {
                        "ts_minute": ts.isoformat(),
                        "checkpoint_id": cp,
                        "n_t": n_t,
                        "x_t": x_t,
                        "lambda_hat": round(lam, 4),
                        "mu": round(mu, 4),
                        "rho": round(rho, 4),
                        "level": calc_level(rho)
                    }
                    with lock:
                        recent.append(rec)
                last_size = size
        except Exception:
            pass
        time.sleep(1.0)

# arka planda CSV’yi izleyen thread
threading.Thread(target=updater_loop, daemon=True).start()

@app.get("/health")
def health():
    return {"ok": True, "csv": os.path.abspath(CSV_PATH)}

@app.get("/api/summary")
def summary(minutes: int = 15):
    with lock:
        data = list(recent)
    # aynı dakika + checkpoint için en güncel kaydı al
    data = _dedupe_by_minute(data)[-minutes:]
    human = [_summarize(r) for r in data]
    return JSONResponse(human)


@app.get("/api/latest")
def latest(minutes: int = 60):
    with lock:
        data = list(recent)
    data = _dedupe_by_minute(data)
    out = data[-minutes:]
    return JSONResponse(out)


@app.post("/api/capacity")
def set_capacity(payload: dict):
    cp = str(payload.get("checkpoint_id", "CP1"))
    n = int(payload.get("officers", 1))
    officers[cp] = max(1, n)
    # mu güncellenir, sonraki döngüde rho/level güncel gelir
    return {"ok": True, "checkpoint_id": cp, "officers": officers[cp], "mu_per_officer": MU_PER_OFFICER}

