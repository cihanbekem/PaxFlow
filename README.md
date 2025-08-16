
# PaxFlow — Boarding Pass Yoğunluk Paneli

Check‐in/boarding kapılarındaki **anlık yoğunluğu (ρ = λ̂ / μ)** izleyen, **EWMA** ile akışı yumuşatan ve **görevli sayısına göre** kapasiteyi hesaplayıp **renkli uyarılar + öneriler** üreten hafif bir panel.

- UI: `http://localhost:8000/ui/index.html`
- API Docs (Swagger): `http://localhost:8000/docs`

---

## Özellikler

- ⏱️ Dakikalık akış: CSV’den dakikadaki kişi sayısı (`n_t`) çıkarılır (eksik dakikalar 0 ile doldurulur).
- 📉 EWMA (λ̂) ile akış kestirimi: `λ̂_t = α·x_t + (1−α)·λ̂_{t−1}` (burada `x_t = n_t`).
- 🧮 Kapasite (μ): `μ = görevli_sayısı × MU_PER_OFFICER`.
- 🟥🟨🟩 Yoğunluk (ρ): `ρ = λ̂ / μ` → Yeşil / Sarı / Kırmızı durum ve aksiyon önerisi.
- 👮 Görevli sayısını ± ile UI’dan canlı ayarlama.
- 📊 Son 60 dk toplam geçiş bar grafiği + kart içi trend (sparkline) + CSV canlı akış tablosu.
- 🧪 İsteğe bağlı **dummy veri üreticisi** (CSV’ye örnek satırlar yazar).

---

## Dizin Yapısı

.
├─ backend/
│ └─ app.py # FastAPI (API + CSV watcher + EWMA)
├─ ui/
│ ├─ index.html # Panel (statik)
│ └─ app.js # UI mantığı (fetch & çizimler)
├─ data/
│ └─ flight_data.csv # Veri kaynağı (host↔container RW volume)
├─ scripts/
│ └─ dummyGenerator.py # Opsiyonel: örnek veri üreticisi
├─ requirements.txt
├─ Dockerfile
└─ docker-compose.yml



---

## 🚀 Hızlı Başlangıç — Docker ile

> Önkoşul: **Docker Desktop** (Compose v2).

### 1) Hazırlık

```bash
mkdir -p data
[ -f data/flight_data.csv ] || touch data/flight_data.csv
2) Geliştirme modu (hot-reload) + dummy veri
bash

docker compose up --build app-dev generator
Aç:

UI → http://localhost:8000/ui/index.html

Docs → http://localhost:8000/docs

Health → http://localhost:8000/health

Faydalı komutlar:

bash

docker compose ps
docker compose logs -f app-dev
docker compose logs -f generator
docker compose down
Not: generator servisi CSV’ye yazdıkça panelde CSV canlı akış ve metrikler yenilenir.

🧑‍💻 Lokal (Docker olmadan)
Gerekenler: Python 3.11+, pip

1) Sanal ortam + bağımlılıklar
macOS / Linux

bash

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
Windows (PowerShell)

powershell

python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
2) CSV ve uygulama


mkdir -p data && [ -f data/flight_data.csv ] || touch data/flight_data.csv
python -m uvicorn backend.app:app --reload --port 8000
Aç: http://localhost:8000/ui/index.html

3) (Opsiyonel) Dummy veri üreticisi


python scripts/dummyGenerator.py --out data/flight_data.csv
⚙️ Yapılandırma (ENV)
docker-compose.yml içinde set edilir; lokalde de export / $env: ile verebilirsin.

Değişken	Açıklama	Örnek
CSV_PATH	CSV’nin konteyner/lokal yolu	/data/flight_data.csv
MU_PER_OFFICER	1 görevlinin dakikalık kapasitesi (kişi/dk)	0.50
ALPHA	EWMA katsayısı (0–1)	0.25
GREEN	Yeşil eşik (ρ < GREEN)	0.7
YELLOW	Sarı eşik (GREEN ≤ ρ < YELLOW)	0.9
TZ	Saat dilimi	Europe/Istanbul

Kalibrasyon: Renk eşikleri ve MU_PER_OFFICER sahadaki gerçek işleme sürelerine göre güncellenmelidir.

🔌 API Kısa Referans
GET /health → { ok: true, csv: "/abs/path/flight_data.csv" }

GET /api/latest?minutes=60 → Son N dakikanın normalize kayıtları (dakika × CP tekilleştirilmiş)

GET /api/summary?minutes=15 → İnsan okunur özet + öneri (CP bazında)

POST /api/capacity → Görevli sayısını ayarla
Body: {"checkpoint_id":"CP1","officers":4}

GET /api/csv/latest?limit=50 → CSV’nin son N satırı (UI’da yeni satırlar vurgulanır)

GET /docs → Swagger UI

🧰 Sorun Giderme
Port 8000 dolu → lsof -i :8000 ile süreci kapat veya compose’ta ports: ["8080:8000"] yap.

Docker paused → Docker Desktop → Resume/Unpause.

uvicorn bulunamadı → Compose komutu array formunda ve python -m uvicorn olmalı; docker compose build --no-cache.

CSV okunmuyor → data/flight_data.csv var mı? Volume yolu/izinler doğru mu? GET /health kontrol et.

Dummy generator modül hataları (pandas, openpyxl) → requirements.txt’e ekle ve yeniden build et; ya da generator’ı paxboard:dev imajından koştur.
## Çalıştırma
http://127.0.0.1:8000/ui


