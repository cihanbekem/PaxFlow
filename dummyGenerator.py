import random
import time
from datetime import datetime
import string
import pandas as pd
import os

def random_masked_name():
    first_name_initial = random.choice(string.ascii_uppercase)
    last_name_initial = random.choice(string.ascii_uppercase)
    return f"{first_name_initial}*** {last_name_initial}***"

pnr_list = ["E3*****", "ET*****", "PM*****", "EY*****", "EW*****", "EV*****"]
origin_airports = ["DLM"]
destination_airports = ["AMS", "FRA", "MUC", "ZRH", "VIE", "PRG", "BUD", "ATH", "LIS", "GYD", "SAW", "IST", "ESB"]
iata_codes = ["TK", "PC", "VF", "J2", "HV", "ZF"]
flight_numbers = ["2555", "3121", "404", "062", "4071", "2285"]
error_reasons = ["Bilet Tarihi Uyumsuz!", "PNR Geçersiz!", "Uçuş Bulunamadı!", "Bilet Kullanılmış!"]

file_name = "flight_data.xlsx"

csv_file_name = "flight_data.csv"

# CSV yoksa başlıklarıyla oluştur
if not os.path.exists(csv_file_name):
    pd.DataFrame(columns=[
        "ID", "Name", "PNR", "OriginAirport", "DestinationAirport",
        "IATA", "FlightNumber", "FlightDate", "CheckDate",
        "IsSuccess", "ErrorReason", "Type"
    ]).to_csv(csv_file_name, index=False)



if not os.path.exists(file_name):
    df = pd.DataFrame(columns=[
        "ID", "Name", "PNR", "OriginAirport", "DestinationAirport",
        "IATA", "FlightNumber", "FlightDate", "CheckDate",
        "IsSuccess", "ErrorReason", "Type"
    ])
    df.to_excel(file_name, index=False)

def get_probability_by_hour(hour):
    if 8 <= hour < 12:    # 08:00 - 12:00 %90
        return 0.90
    elif 12 <= hour < 16: # 12:00 - 16:00 %30
        return 0.60
    elif 16 <= hour < 19: # 16:00 - 19:00 %60
        return 0.60
    elif 20 <= hour < 23: # 20:00 - 23:00 %90
        return 0.90
    elif hour >= 23 or hour < 4: # 23:00 - 04:00 %10
        return 0.10
    elif 4 <= hour < 8:  # 04:00 - 08:00 %30
        return 0.30
    else:
        return 0.10  # Default düşük yoğunluk

while True:
    current_hour = datetime.now().hour
    produce_probability = get_probability_by_hour(current_hour)

    if random.random() <= produce_probability:
        if random.random() < 0.9:
            is_success = 1
            error_reason = None
        else:
            is_success = 0
            error_reason = random.choice(error_reasons)

        new_data = {
            "ID": random.randint(1400000, 1500000),
            "Name": random_masked_name(),
            "PNR": random.choice(pnr_list),
            "OriginAirport": random.choice(origin_airports),
            "DestinationAirport": random.choice(destination_airports),
            "IATA": random.choice(iata_codes),
            "FlightNumber": random.choice(flight_numbers),
            "FlightDate": datetime.now().strftime("%j"),
            "CheckDate": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "IsSuccess": is_success,
            "ErrorReason": error_reason,
            "Type": random.choice(["DD", "DI"])
        }

        print(f"[{datetime.now().strftime('%H:%M:%S')}] Veri üretildi:", new_data)

        df_existing = pd.read_excel(file_name)
        df_existing = pd.concat([df_existing, pd.DataFrame([new_data])], ignore_index=True)
        df_existing.to_excel(file_name, index=False)
        # CSV'ye de ekle
        pd.DataFrame([new_data]).to_csv(csv_file_name, mode='a', header=False, index=False)

        
    else:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Yoğunluk düşük, veri yok.")

    # Bekleme süresi
    wait_time = random.randint(1, 4) if random.random() < 0.7 else random.randint(5, 20)
    time.sleep(wait_time)