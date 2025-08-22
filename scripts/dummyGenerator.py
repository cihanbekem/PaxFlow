#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import random, time, string, shutil, os, re, unicodedata
from datetime import datetime
from pathlib import Path
import pandas as pd

# =================== Proje yolları ===================
ROOT = Path(__file__).resolve().parents[1]   # scripts/.. = proje kökü
DATA = ROOT / "data"
XLSX = DATA / "flight_data.xlsx"
CSV  = DATA / "flight_data.csv"

# =================== Yardımcılar ===================
COLUMNS = ["ID","Name","PNR","OriginAirport","DestinationAirport","IATA",
           "FlightNumber","FlightDate","CheckDate","IsSuccess","ErrorReason","Type"]

def random_masked_name():
    return f"{random.choice(string.ascii_uppercase)}*** {random.choice(string.ascii_uppercase)}***"

pnr_list = ["E3*****","ET*****","PM*****","EY*****","EW*****","EV*****"]
origin_airports = ["DLM"]
# fallback destinasyon/IATA/havayolu/flightno listeleri (Playwright yoksa bunlar kullanılır)
destination_airports = ["AMS","FRA","MUC","ZRH","VIE","PRG","BUD","ATH","LIS","GYD","SAW","IST","ESB"]
iata_codes = ["TK","PC","VF","J2","HV","ZF"]
flight_numbers = ["2555","3121","404","062","4071","2285"]
error_reasons = ["Bilet Tarihi Uyumsuz!","PNR Geçersiz!","Uçuş Bulunamadı!","Bilet Kullanılmış!"]

def is_valid_xlsx(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            return f.read(4) == b"PK\x03\x04"   # XLSX zip imzası
    except FileNotFoundError:
        return False

def ensure_files():
    DATA.mkdir(parents=True, exist_ok=True)
    if not CSV.exists():
        pd.DataFrame(columns=COLUMNS).to_csv(CSV, index=False)
    if not is_valid_xlsx(XLSX):
        if XLSX.exists():
            backup = XLSX.with_suffix(f".xlsx.corrupt-{int(time.time())}")
            shutil.move(str(XLSX), str(backup))
            print(f"Uyarı: Bozuk XLSX yedeklendi -> {backup.name}")
        pd.DataFrame(columns=COLUMNS).to_excel(XLSX, index=False)

def safe_read_xlsx() -> pd.DataFrame:
    try:
        return pd.read_excel(XLSX, engine="openpyxl")
    except Exception as e:
        print("Uyarı:", e, "-> Excel sıfırlanıyor.")
        pd.DataFrame(columns=COLUMNS).to_excel(XLSX, index=False)
        return pd.DataFrame(columns=COLUMNS)

def atomic_write_xlsx(df: pd.DataFrame, target: Path):
    tmp = target.with_suffix(".tmp.xlsx")
    df.to_excel(tmp, index=False)
    tmp.replace(target)  # atomik replace

# =================== YOĞUNLUK (AYNEN SENİN KODUN) ===================
def get_probability_by_hour(hour: int) -> float:
    if 8 <= hour < 12:    # 08:00 - 12:00 ~%90
        return 0.90
    elif 12 <= hour < 16: # 12:00 - 16:00 ~%60
        return 0.60
    elif 16 <= hour < 19: # 16:00 - 19:00 ~%60
        return 0.60
    elif 20 <= hour < 23: # 20:00 - 23:00 ~%90
        return 0.90
    elif hour >= 23 or hour < 4: # 23:00 - 04:00 ~%10
        return 0.10
    elif 4 <= hour < 8:  # 04:00 - 08:00 ~%30
        return 0.30
    else:
        return 0.10

# =================== (Opsiyonel) Uçuşlardan doldurma ===================
# Playwright varsa bugünkü uçuşlardan aktif bir hedef seçer; yoksa fallback listeler kullanılır.
def _norm(s:str)->str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = s.replace("İ","I").replace("ı","i")
    return s.lower().strip()

IATA_MAP = {
    "istanbul havalimani":"IST","istanbul havalimanı":"IST","istanbul":"IST",
    "istanbul sabiha gokcen":"SAW","istanbul sabiha gökçen":"SAW","ankara esenboga":"ESB","ankara esenboğa":"ESB","dalaman":"DLM",
    "londra gatwick":"LGW","londra stansted":"STN","londra heathrow":"LHR","londra southend":"SEN","londra luton":"LTN",
    "manchester":"MAN","birmingham":"BHX","bristol":"BRS","east midlands":"EMA","liverpool john lennon":"LPL",
    "newcastle":"NCL","norwich":"NWI","glasgow":"GLA","leeds bradford":"LBA","bournemouth":"BOH",
    "belfast uluslararası":"BFS","belfast uluslararasi":"BFS",
    "amsterdam schiphol":"AMS","zurich":"ZRH","dublin":"DUB","edinburgh":"EDI","frankfurt main":"FRA",
    "hannover":"HAJ","köln bonn":"CGN","koln bonn":"CGN","stuttgart":"STR","düsseldorf":"DUS","dusseldorf":"DUS",
    "nürnberg":"NUE","nurnberg":"NUE","berlin brandenburg":"BER","sofya":"SOF","varşova chopin":"WAW","gdansk":"GDN","katowice":"KTW",
    "belgrad nikola tesla":"BEG","moskova sheremetyevo":"SVO","moskova vnukovo":"VKO","saint petersburg":"LED","bakü haydar aliyev":"GYD",
    "beirut":"BEY",
}
KNOWN_IATA = sorted(set(IATA_MAP.values()))

def pull_active_flight():
    """Bugünkü gelecekteki uçuşlardan rastgele birini döndür (iata, number, dest_iata). Hata olursa None."""
    try:
        from playwright.sync_api import sync_playwright
        import re as _re
        DATE_RE  = _re.compile(r"^\d{2}/\d{2}/\d{4}$")
        TIME_RE  = _re.compile(r"^\d{2}:\d{2}$")
        FLIGHT_RE= _re.compile(r"^([A-Z0-9]+?)(\d+)$")
        URL = "https://www.dalamanairport.aero/tr/u%C3%A7u%C5%9Flar"

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(locale="tr-TR")
            page.goto(URL, wait_until="domcontentloaded")
            try: page.wait_for_load_state("networkidle", timeout=12000)
            except: pass
            text = page.evaluate("document.body.innerText")
            browser.close()

        lines = [re.sub(r"\s+"," ",ln).strip() for ln in text.splitlines() if ln.strip()]
        idxs = [i for i,ln in enumerate(lines) if DATE_RE.fullmatch(ln)]
        today = datetime.now().strftime("%d/%m/%Y")
        now = datetime.now()
        cand = []
        for k in range(len(idxs)):
            s = idxs[k]; e = idxs[k+1] if k+1 < len(idxs) else len(lines)
            g = lines[s:e]
            if len(g)>=4 and g[0]==today and TIME_RE.fullmatch(g[3]):
                # gelecekteki uçuş
                hh, mm = map(int, g[3].split(":"))
                sched = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
                if (sched - now).total_seconds()/60.0 < 0:  # geçmişse atla
                    continue
                m = FLIGHT_RE.match(g[1])
                if not m: continue
                iata = m.group(1)
                number = m.group(2)
                dest = IATA_MAP.get(_norm(g[2])) or random.choice(KNOWN_IATA)
                # yakın olana daha fazla ağırlık
                weight = 1.0/(1.0 + (sched-now).total_seconds()/60.0)
                cand.append((weight, iata, number, dest))
        if not cand:
            return None
        # ağırlığa göre seçim
        weights = [w for w,_,_,_ in cand]
        items   = [(i,n,d) for _,i,n,d in cand]
        return random.choices(items, weights=weights, k=1)[0]
    except Exception:
        return None

# =================== Başlat ===================
ensure_files()

while True:
    current_hour = datetime.now().hour
    produce_probability = get_probability_by_hour(current_hour)

    if random.random() <= produce_probability:
        # Başarı oranı ve hata mesajı (senin koddaki gibi)
        if random.random() < 0.9:
            is_success = 1
            error_reason = None
        else:
            is_success = 0
            error_reason = random.choice(error_reasons)

        # Uçuş bilgilerini mümkünse siteden; yoksa fallback listelerden al
        picked = pull_active_flight()
        if picked:
            iata, fno, dest = picked
        else:
            iata = random.choice(iata_codes)
            fno  = random.choice(flight_numbers)
            dest = random.choice(destination_airports)

        new_data = {
            # >>> ID: eski koddaki gibi rastgele aralıktan
            "ID": random.randint(1_400_000, 1_500_000),
            "Name": random_masked_name(),
            "PNR": random.choice(pnr_list),
            "OriginAirport": random.choice(origin_airports),   # DLM
            "DestinationAirport": dest,
            "IATA": iata,
            "FlightNumber": fno,
            "FlightDate": datetime.now().strftime("%j"),       # yılın günü (aynı mantık)
            "CheckDate": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "IsSuccess": is_success,
            "ErrorReason": error_reason,
            "Type": random.choice(["DD","DI"])
        }

        # Excel'i güvenli oku + atomik yaz
        df_existing = safe_read_xlsx()
        df_existing = pd.concat([df_existing, pd.DataFrame([new_data])], ignore_index=True)
        atomic_write_xlsx(df_existing, XLSX)

        # CSV'ye ekle (append)
        pd.DataFrame([new_data]).to_csv(CSV, mode='a', header=False, index=False)

        print(f"[{datetime.now().strftime('%H:%M:%S')}] Üretildi → {new_data['IATA']}{new_data['FlightNumber']} / {new_data['DestinationAirport']}")
    else:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Yoğunluk düşük, üretim yok.")

    # Bekleme (AYNEN senin koddaki gibi)
    wait_time = random.randint(1, 4) if random.random() < 0.7 else random.randint(5, 20)
    time.sleep(wait_time)
