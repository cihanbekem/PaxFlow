FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Bağımlılıklar
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Uygulama kodu
COPY backend/ /app/backend/
COPY ui/ /app/ui/

# Varsayılan ENV (compose ile override edeceğiz)
ENV CSV_PATH=/data/flight_data.csv \
    HOST=0.0.0.0 \
    PORT=8000 \
    TZ=Europe/Istanbul

EXPOSE 8000

# Prod komutu (dev'de compose ile --reload kullanacağız)
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
