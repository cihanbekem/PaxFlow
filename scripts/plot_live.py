# plot_live.py
import time
import requests
import matplotlib.pyplot as plt
from datetime import datetime

API = "http://127.0.0.1:8000/api/latest?minutes=60"  # son 60 dk

def fetch():
    r = requests.get(API, timeout=5)
    r.raise_for_status()
    data = r.json()
    # veri kronolojik gelmiyorsa sırala
    data = sorted(data, key=lambda d: d.get("ts_minute",""))
    # x-ekseni: zaman
    t = [datetime.fromisoformat(d["ts_minute"]) for d in data]
    # seriler
    n_t = [d.get("n_t", 0) for d in data]
    lam = [d.get("lambda_hat", 0.0) for d in data]
    rho = [d.get("rho", 0.0) for d in data]
    return t, n_t, lam, rho

def main():
    plt.ion()  # interaktif mod
    fig = plt.figure(figsize=(10,5))

    # ilk çizim
    t, n_t, lam, rho = fetch()
    ln1, = plt.plot(t, n_t, label="n_t (dakikadaki geçiş)")
    ln2, = plt.plot(t, lam, label="λ̂ (EWMA)")
    plt.legend()
    plt.title("Boarding Pass Yoğunluğu (Canlı)")
    plt.xlabel("Zaman")
    plt.ylabel("Kişi/dk")
    plt.tight_layout()
    plt.show()

    while True:
        try:
            t, n_t, lam, rho = fetch()
            ln1.set_xdata(t); ln1.set_ydata(n_t)
            ln2.set_xdata(t); ln2.set_ydata(lam)
            # eksenleri yeni verilere göre ayarla
            if t:
                plt.gca().set_xlim(min(t), max(t))
                ymin = min(min(n_t or [0]), min(lam or [0]))
                ymax = max(max(n_t or [1]), max(lam or [1]))
                if ymin == ymax:
                    ymax = ymin + 1
                plt.gca().set_ylim(ymin, ymax)
            plt.draw()
            plt.pause(2.0)  # 2 sn’de bir güncelle
        except KeyboardInterrupt:
            break
        except Exception as e:
            print("Hata:", e)
            time.sleep(2)

if __name__ == "__main__":
    main()
