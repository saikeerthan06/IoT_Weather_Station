import serial # $$$
import csv
import json
import logging
import signal  # X
import sys
import ast  # X
import threading
import requests  # $$$$
import time
from datetime import datetime
from sense_hat import SenseHat  # $ 
import subprocess
import tempfile
import os


API_KEY = "v2:d2887ab756d415d273b0bb9d6fbc59a79174f4ded13e0e867783142c7b8ae7f2:G2NlbWqa7278lxj2vR-1CxUaOXpWpo8g"
ONLINE_BACKUP_URL = "https://script.google.com/macros/s/AKfycbwhAE4sosdSrjO39O1vceJkGiWyaiA2FI870SkmxYVBNcIZnghfhySF9-8SroTplERw6w/exec?gid=0"
headers = {"X-Api-Key": API_KEY}
LOGS_PATH = "backend_log.log"
CSV_PATH = "data.csv"
JSON_PATH = "data_one.json"
PORT = "/dev/ttyACM0"
BAUD = 9600
DECODE = "utf-8"
FREQUENCY = 5
DB_NAME = "admin"
DB_USER = "admin"
DB_HOST = "localhost"
DB_PORT = 5432
DB_PASS = "admin"
DB_TABLE = "sensor_data"

# Project scope (active sensors): Temperature, Humidity (Arduino over /dev/ttyACM0) + Pressure (Sense HAT)
# Optional sensors (UV / rainfall / wind) are kept in this file but disabled (commented out) for now.

os.environ['PGPASSWORD'] = DB_PASS

logging.basicConfig(
    filename = LOGS_PATH,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] | %(message)s")
current = 0
logging.info(f"Starting Backend freq={FREQUENCY}s")
def signal_int():
    logging.info("SIGINT  Exiting Backend "); sys.exit(0)
signal.signal(signal.SIGINT, signal_int)
def signal_term():
    logging.info("SIGTERM Exiting Backend "); sys.exit(0)
signal.signal(signal.SIGTERM, signal_term)

class AllData():
    def __init__(self):
        
        with open(JSON_PATH, 'r') as file:
            data = json.load(file)
            logging.info(f"Resuming from time={data.get('time', 'wait... bad json file?')} at {JSON_PATH}")
            self.time = data.get("time")
            self.cidx = 0; self.msgs = "BLANK"; self.mdsc = ""
            self.temp = data.get("temp", 0); self.humi = data.get("humi", 0); self.pres = data.get("pres", 0)

            # --- Optional sensors (disabled for current project scope) ---
            # self.windspeed = data.get("windspeed", 0)
            # self.rainfall = data.get("rainfall", 0)
            # self.winddirection = data.get("winddirection", 0)
            # self.uvindex = data.get("uvindex", 0)

            self.count_attr = 0
            # Only expecting temp/humi/pres
            self.expect_attr = 3
            # (previously 7 when wind/rain/uv were enabled)
    def _tojson(self):
        return {
            "time": self.time,
            "cidx": self.cidx,
            "cattr": self.count_attr,
            "temp": self.temp,
            "humi": self.humi,
            "pres": self.pres,
            # --- Optional sensors (disabled for current project scope) ---
            # "windspeed": self.windspeed,
            # "winddirection": self.winddirection,
            # "rainfall": self.rainfall,
            # "uvindex": self.uvindex,
        }
    def _todatabase(self):
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            writer = csv.writer(f)
            writer.writerow([self.time, self.cidx, self.count_attr, self.temp, self.humi, self.pres])
            temp_filename=f.name
        try:
            command = ['psql',
                       '-d', DB_NAME,
                       '-U', DB_USER,
                       '-h', DB_HOST,
                       '-c', f"\\copy {DB_TABLE}(time, cidx, cattr, temp, humi, pres) FROM '{temp_filename}' CSV"
                    ]
            # Previous (disabled): windspeed/winddirection/rainfall/uvindex columns were also inserted.
            resp = subprocess.run(
                command,
                capture_output=True,
                text=True
            )
            
            if resp.returncode == 0:
                print("db", end=" ")
            else:
                print("Postgres Error:", resp.stderr)
        except Exception as e:
            print("Error:",e)
        finally:
            os.unlink(temp_filename)
            
    def _tobackup(self):
        try:
            resp = requests.post(ONLINE_BACKUP_URL, json=self.packet, timeout=5)
            if resp.status_code in (200, 302):
                print("gs", end=" ")
                logging.debug("Sent packet {self.cidx} to online backup with respstatus{resp.status_code}")
            else:
                logging.warning("Attempted to send packet {self.cidx} to online backup. Failed with resp status code {resp.status_code}")
        except requests.exceptions.ReadTimeout:
            logging.warning(f"Read Timed out. Check backup configuration if issue persists.")
        except requests.exceptions.RequestException as e:
            logging.error(f"Attempted to send packet {self.cidx} to online backup, Failed. {e}")
        except:
            logging.error(f"Failed to send packet {self.cidx} to online backup for unknown reason, failed with respstatus{resp.status_code}")
            

    @property
    def packet(self): return self._tojson()
    def _tocsv(self):
        with open(CSV_PATH, "a", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=self._tojson().keys())
            writer.writerow(self._tojson())
        print("csv", end=" ")
    def start(self):
        self.time = datetime.now().isoformat()
        self.count_attr = 0; self.cidx += 1
    def end(self):
        with open(JSON_PATH, 'w') as f:
            json.dump(self.packet, f)
        self._send_data_threaded()
    def sensor_attr(self, attr:str, value):
        self.count_attr += 1
        setattr(self, attr, value)
    def _send_data_threaded(self):
        t_csv = threading.Thread(target=self._tocsv)
        t_backup = threading.Thread(target=self._tobackup)
        t_database = threading.Thread(target=self._todatabase)
        # Current scope: only temp/humi/pres are collected; other sensors are disabled elsewhere.
        threads = [t_database, t_csv, t_backup]
    
        for t in threads: t.start()
        print('tstart2: ', end=" ")
        for t in threads: t.join()
        print(':tend2')

alldata = AllData()

def api_get_rainfall():
    """unit = mm of rain"""
    url = "https://api-open.data.gov.sg/v2/real-time/api/rainfall"
    try:
        response = requests.get(url, headers=headers, timeout=3)
    except (requests.exceptions.Timeout, requests.exceptions.ReadTimeout):
        logging.warning("Connection to Rainfall API timed out."); return
    response = response.json().get("data")
    data = response.get("readings")[0].get("data")
    print('rf', end=' ')
    for i in data:
        if i["stationId"]=="S109":
            alldata.sensor_attr("rainfall", i["value"])
t_rainfall = threading.Thread(target=api_get_rainfall)

def api_get_windspeed():
    """unit = knots freq=5min"""
    url = "https://api-open.data.gov.sg/v2/real-time/api/wind-speed"
    try:
        response = requests.get(url, headers=headers, timeout=3)
    except (requests.exceptions.Timeout, requests.exceptions.ReadTimeout):
        logging.warning("Connection to WindSpeed API timed out."); return
    response = response.json().get("data")
    data = response.get("readings")[0].get("data")
    print('ws', end=' ')
    for i in data:
        if i["stationId"]=="S109":
            alldata.sensor_attr("windspeed", i["value"])

def api_get_winddirection():
    """unit = degrees, freq=5min"""
    url = "https://api-open.data.gov.sg/v2/real-time/api/wind-direction"
    try:
        response = requests.get(url, headers=headers, timeout=3)
    except (requests.exceptions.Timeout, requests.exceptions.ReadTimeout):
        logging.warning("Connection to WindDirection API timed out."); return
    response = response.json().get("data")
    data = response.get("readings")[0].get("data")
    print('wd', end=' ')
    for i in data:
        if i["stationId"]=="S109":
            alldata.sensor_attr("winddirection", i["value"])

def api_get_UV():
    """Moving Average. Check every 5 min. unit=UVindex"""
    url = "https://api-open.data.gov.sg/v2/real-time/api/uv"
    total = 0
    try:
        response = requests.get(url, headers=headers, timeout=3)
    except (requests.exceptions.Timeout, requests.exceptions.ReadTimeout):
        logging.warning("Connection to UV API timed out."); return
    response = response.json().get('data')
    data = response.get('records')[0]
    time = data["timestamp"]
    print("uv", end=" ")
    for i in data["index"]:
        total += i["value"]
        if i["hour"]==time:
            alldata.sensor_attr("uvindex", i["value"])
            return 
        else: total += i["value"]
        print(total/len(data["index"]), end=' ')
        alldata.sensor_attr("uvindex", total/len(data["index"]))

try:
    ser = serial.Serial(PORT, BAUD, timeout=1)
    time.sleep(2)
except: print(f"{PORT} related error, serial failed to init. Maybe try reconnecting the device?"); exit()

# def get_temp_humi():
#     ser.write(0x60)
#     time.sleep(3)
#     if ser.in_waiting:
#         data = ser.read(ser.in_waiting).decode('utf-8')
#         data = json.loads(data)
#     else:
#         logging.warning(f"{PORT} packet lost.")
#         return
#     print("th", end=" ")
#     if data.get("msgs", "BLANK") in ("OK   ", "OK"):
#         alldata.sensor_attr("temp", data.get("temp", alldata.temp))
#         alldata.sensor_attr("humi", data.get("humi", alldata.humi))
#     else:
#         logging.warning(f"{PORT} raised {data.get('msgs', 'BLANK')} '{data.get('mdsc', 'blank?')}'")

def get_temp_humi():
    try:
        # Read exactly one line from Arduino
        raw = ser.readline().decode("utf-8", errors="ignore").strip()

        if not raw:
            logging.warning("Arduino serial: empty line")
            return

        # If Arduino prints extra text, try to extract JSON object
        if raw[0] != "{":
            import re
            m = re.search(r"\{.*\}", raw)
            if not m:
                logging.warning(f"Arduino serial: non-JSON: {raw!r}")
                return
            raw = m.group(0)

        data = json.loads(raw)

        # Accept temp/humi directly (don’t depend on msgs)
        if "temp" in data:
            alldata.sensor_attr("temp", float(data["temp"]))
        if "humi" in data:
            alldata.sensor_attr("humi", float(data["humi"]))

        print("th", end=" ")

    except json.JSONDecodeError:
        logging.warning(f"Arduino serial: bad JSON: {raw!r}")
    except Exception as e:
        logging.exception(f"get_temp_humi failed: {e}")


try:
    sense = SenseHat()
except:
    logging.error("Sensehat failed to init for an unknown reason. Check physical connections and file permissions.")

def get_pressure():  # barometric data
    try:
        p = sense.get_pressure()
        alldata.sensor_attr("pres", p)
        time.sleep(0.1); print('pr', end=" ")
    except:
        logging.warning("Failed to read Sensehat Pressure Sensor for an unknown reason.")
    
def get_data_threaded():
    # --- Optional sensors (disabled for current project scope) ---
    # t_rainfall = threading.Thread(target=api_get_rainfall)
    # t_windspeed = threading.Thread(target=api_get_windspeed)
    # t_winddirection = threading.Thread(target=api_get_winddirection)
    # t_UV = threading.Thread(target=api_get_UV)
    t_temp_humi = threading.Thread(target=get_temp_humi)
    t_pres = threading.Thread(target=get_pressure)
    
    threads = [t_temp_humi, t_pres]

    # Previous (disabled):
    # threads = [t_UV, t_winddirection, t_windspeed, t_rainfall, t_temp_humi, t_pres]
    
    for t in threads: t.start()
    print('tstart: ', end=" ")
    for t in threads: t.join()
    print(':tend', end=" ")
    


process_time = time.time()

"""
while True:
    alldata.start()
    get_data_threaded()
    alldata.end()
    try:
        time.sleep(FREQUENCY-time.time()+process_time)
    except ValueError:
        logging.error("Main Process exceeded time limit", FREQUENCY, time.time()-process_time)
    process_time = time.time()
"""

while True:
    alldata.start()
    get_data_threaded()
    print(f"T={alldata.temp:.2f}C H={alldata.humi:.2f}% P={alldata.pres:.2f}HPa")
    alldata.end()
    
    # sleep so that each loop starts roughly evert FREQUENCY seconds 
    
    elapsed = time.time() - process_time
    sleep_s = FREQUENCY - elapsed
    
    if sleep_s > 0:
        time.sleep(sleep_s)
    else:
        logging.warning(
        f"Main loop overran by {-sleep_s:.2f}s (FREQUENCY={FREQUENCY}s, elapsed={elapsed:.2f}s)")
        
    process_time = time.time()
