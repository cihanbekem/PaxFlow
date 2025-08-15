# backend/app.py
import os, threading, time
from collections import defaultdict, deque
from datetime import datetime
from typing import Deque, Dict, List

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
import math
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi import HTTPException
from datetime import timedelta
from collections import deque



TR_LEVEL = {"GREEN": "YEŞİL", "YELLOW": "SARI", "RED": "KIRMIZI"}
EMOJI = {"GREEN": "🟢", "YELLOW": "🟡", "RED": "🔴"}

# --- CSV preview helpers ---

def _find_ts_col(cols):
    # CSV'deki muhtemel zaman damgası sütun adları
    cands = ["CheckDate", "ts", "timestamp", "datetime", "created_at", "flightdate", "date"]
    low = {c.lower(): c for c in cols}
    for k in cands:
        if k.lower() in low:
            return low[k.lower()]
    return None

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


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.getenv("CSV_PATH", os.path.join(BASE_DIR, "data", "flight_data.csv"))
BUCKET = "1min"          # 1 dakika
ALPHA = 0.25           # EWMA
MU_PER_OFFICER = 3.0  # kişi/dk (örnek)
GREEN, YELLOW = 0.7, 0.9

app = FastAPI(title="EWMA Boarding Load")
UI_DIR = os.path.join(BASE_DIR, "ui")
app.mount("/ui", StaticFiles(directory=UI_DIR, html=True), name="ui")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/")
def root():
    """Ana sayfa - UI'ya yönlendir"""
    return RedirectResponse(url="/ui/")

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

@app.get("/api/csv/latest")
def csv_latest(limit: int = 50):
    """
    CSV'nin son N satırını gönderir (en yeni en üstte).
    """
    try:
        # Basit CSV okuma
        df = pd.read_csv(CSV_PATH)
        
        if df.empty:
            return {"columns": list(df.columns), "rows": []}

        # son N satır
        tail = df.tail(int(limit)).copy().reset_index(drop=True)
        
        # basit satır id'si
        tail["__rowid"] = tail.index.astype(int)
        
        # NaN değerleri temizle ve tüm kolonları string yap
        for col in tail.columns:
            if col != "__rowid":
                # NaN değerleri boş string yap
                tail[col] = tail[col].fillna("")
                # String'e çevir
                tail[col] = tail[col].astype(str)

        rows = tail.to_dict(orient="records")[::-1]  # en yeni en üste
        return {"columns": list(tail.columns), "rows": rows}
        
    except Exception as e:
        # Hata durumunda basit bir hata mesajı döndür
        import traceback
        return {"columns": [], "rows": [], "error": str(e), "traceback": traceback.format_exc()}

@app.get("/health")
def health():
    return {"ok": True, "csv": os.path.abspath(CSV_PATH)}

@app.get("/test")
def test():
    return {"message": "Server is working"}

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

from datetime import timedelta

@app.get("/api/metrics/last_minutes")
def metrics_last_minutes(minutes: int = 60):
    """
    CSV'den okumaya dayanarak son N dakikanın tamamını (0'lar dahil)
    dakika dakika döndürür. UI üst KPI'lar ve bar chart bu veriyi kullanabilir.
    """
    path = os.path.abspath(CSV_PATH)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        # Boş seri üret
        end = pd.Timestamp.now().floor("min")
        idx = pd.date_range(end=end, periods=minutes, freq="1min")
        series = [{"ts": t.isoformat(), "count": 0} for t in idx]
        return {
            "series": series,
            "kpis": {"total": 0, "avg_per_min": 0.0, "peak_count": 0, "peak_ts": None, "cp_count": 0},
        }

    # CSV'yi toleranslı oku (eşzamanlı yazımda sorun çıkmasın)
    df = pd.read_csv(path)
    if df.empty:
        end = pd.Timestamp.now().floor("min")
        idx = pd.date_range(end=end, periods=minutes, freq="1min")
        series = [{"ts": t.isoformat(), "count": 0} for t in idx]
        return {
            "series": series,
            "kpis": {"total": 0, "avg_per_min": 0.0, "peak_count": 0, "peak_ts": None, "cp_count": 0},
        }

    # Zaman sütunu
    ts_col = _find_ts_col(df.columns)
    if ts_col is None:
        raise HTTPException(status_code=400, detail=f"Zaman sütunu bulunamadı. Mevcut: {list(df.columns)}")

    # Normalize et
    if "checkpoint_id" not in df.columns:
        df["checkpoint_id"] = "CP1"
    df[ts_col] = pd.to_datetime(df[ts_col], errors="coerce")
    df = df.dropna(subset=[ts_col])

    # Hedef zaman aralığı: son N tam dakika
    end = pd.Timestamp.now().floor("min")
    start = end - pd.Timedelta(minutes=minutes-1)
    # Dakikalık sayım
    grp = (
        df.set_index(ts_col)
          .groupby("checkpoint_id")
          .resample("1min").size()
          .rename("n_t")
          .reset_index()
    )
    # Her CP için eksik dakikaları 0 ile doldur, sonra aralığa kırp
    frames = []
    for cp, g in grp.groupby("checkpoint_id"):
        g = g.set_index(ts_col).asfreq("1min")
        g["n_t"] = g["n_t"].fillna(0).astype(int)
        g["checkpoint_id"] = cp
        g = g.loc[start:end].reset_index()
        frames.append(g)
    if frames:
        res = pd.concat(frames, ignore_index=True)
    else:
        res = pd.DataFrame(columns=[ts_col, "checkpoint_id", "n_t"])

    # Toplam (tüm CP'ler) dakika dakika
    total_per_min = (
        res.groupby(ts_col)["n_t"].sum()
          .reindex(pd.date_range(start=start, end=end, freq="1min"), fill_value=0)
    )
    series = [{"ts": t.isoformat(), "count": int(c)} for t, c in total_per_min.items()]

    # KPI'lar
    total = int(total_per_min.sum())
    avg = float(total_per_min.mean()) if len(total_per_min) else 0.0
    peak_count = int(total_per_min.max()) if len(total_per_min) else 0
    peak_ts = (
        total_per_min.idxmax().isoformat() if len(total_per_min) and peak_count > 0 else None
    )
    cp_count = res["checkpoint_id"].nunique() if not res.empty else 0

    return {"series": series,
            "kpis": {"total": total, "avg_per_min": round(avg, 2),
                     "peak_count": peak_count, "peak_ts": peak_ts, "cp_count": int(cp_count)}}

@app.get("/api/destinations")
def get_destination_stats():
    """En çok gidilen destinasyonları döndür"""
    try:
        if not os.path.exists(CSV_PATH) or os.path.getsize(CSV_PATH) == 0:
            return {"destinations": []}
        
        df = pd.read_csv(CSV_PATH)
        if df.empty or "DestinationAirport" not in df.columns:
            return {"destinations": []}
        
        # Destinasyon sayılarını hesapla
        dest_counts = df["DestinationAirport"].value_counts()
        
        # Top 10 destinasyonu al
        top_destinations = dest_counts.head(10)
        
        # Toplam sayıyı hesapla
        total_flights = len(df)
        
        # Yüzde hesapla ve formatla
        destinations = []
        for dest, count in top_destinations.items():
            percentage = (count / total_flights) * 100
            destinations.append({
                "destination": str(dest),
                "count": int(count),
                "percentage": round(percentage, 1)
            })
        
        return {"destinations": destinations, "total_flights": total_flights}
        
    except Exception as e:
        return {"destinations": [], "error": str(e)}

@app.get("/api/color-durations")
def get_color_durations():
    """Son 60 dakikadaki renk sürelerini döndür"""
    try:
        with lock:
            data = list(recent)
        
        if not data:
            return {"colors": {"GREEN": 0, "YELLOW": 0, "RED": 0}, "total_minutes": 0}
        
        # Son 60 dakikayı al
        data = _dedupe_by_minute(data)[-60:]
        
        # Renk sayılarını hesapla
        color_counts = {"GREEN": 0, "YELLOW": 0, "RED": 0}
        for record in data:
            level = record.get("level", "GREEN")
            color_counts[level] += 1
        
        total_minutes = len(data)
        
        return {"colors": color_counts, "total_minutes": total_minutes}
        
    except Exception as e:
        return {"colors": {"GREEN": 0, "YELLOW": 0, "RED": 0}, "total_minutes": 0, "error": str(e)}

@app.get("/api/warning-durations")
def get_warning_durations():
    """RED durumunun üst üste kaç dakika sürdüğünü döndür"""
    try:
        with lock:
            data = list(recent)
        
        if not data:
            return {"durations": [], "max_red_streak": 0}
        
        # Son 60 dakikayı al
        data = _dedupe_by_minute(data)[-60:]
        
        # Her CP için RED streak'lerini hesapla
        cp_red_streaks = {}
        current_streaks = {}
        
        for record in data:
            cp = record.get("checkpoint_id", "CP1")
            level = record.get("level", "GREEN")
            
            if level == "RED":
                # RED streak'i artır
                current_streaks[cp] = current_streaks.get(cp, 0) + 1
            else:
                # RED streak'i bitir ve kaydet
                if cp in current_streaks and current_streaks[cp] > 0:
                    if cp not in cp_red_streaks:
                        cp_red_streaks[cp] = []
                    cp_red_streaks[cp].append(current_streaks[cp])
                current_streaks[cp] = 0
        
        # Aktif streak'leri de ekle
        for cp, streak in current_streaks.items():
            if streak > 0:
                if cp not in cp_red_streaks:
                    cp_red_streaks[cp] = []
                cp_red_streaks[cp].append(streak)
        
        # Sonuçları formatla
        durations = []
        max_red_streak = 0
        
        for cp, streaks in cp_red_streaks.items():
            if streaks:
                max_streak = max(streaks)
                max_red_streak = max(max_red_streak, max_streak)
                durations.append({
                    "checkpoint": cp,
                    "max_streak": max_streak,
                    "current_streak": current_streaks.get(cp, 0),
                    "total_red_minutes": sum(streaks)
                })
        
        # CP'ye göre sırala
        durations.sort(key=lambda x: x["checkpoint"])
        
        return {
            "durations": durations,
            "max_red_streak": max_red_streak
        }
        
    except Exception as e:
        return {"durations": [], "max_red_streak": 0, "error": str(e)}

@app.get("/api/current-rho")
def get_current_rho():
    """CP1'in ρ değerini döndür (CP kartındaki ile aynı)"""
    try:
        with lock:
            data = list(recent)
        
        if not data:
            return {"rho": 0.0, "lambda_hat": 0.0, "mu": 0.0}
        
        # CP1'in en son kaydını bul
        cp1_data = [r for r in data if r.get("checkpoint_id") == "CP1"]
        
        if not cp1_data:
            return {"rho": 0.0, "lambda_hat": 0.0, "mu": 0.0}
        
        # En son CP1 kaydını al
        latest_cp1 = cp1_data[-1]
        
        rho = latest_cp1.get("rho", 0.0)
        lambda_hat = latest_cp1.get("lambda_hat", 0.0)
        mu = latest_cp1.get("mu", 0.0)
        
        return {
            "rho": round(rho, 3),
            "lambda_hat": round(lambda_hat, 3),
            "mu": round(mu, 3)
        }
        
    except Exception as e:
        return {"rho": 0.0, "lambda_hat": 0.0, "mu": 0.0, "error": str(e)}