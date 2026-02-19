# IoT Weather Station

Repository for an IoT Weather Station project.

## Tech Stack
- Frontend: React + TypeScript + Vite
- Backend: Node.js

## Prerequisites
- Node.js 18+ and npm

## Setup
1. Create the backend environment file.
- macOS/Linux: `cp backend/.env.example backend/.env`
- Windows (PowerShell): `Copy-Item backend\.env.example backend\.env`
- Windows (CMD): `copy backend\.env.example backend\.env`

2. Configure Postgres access (SSH tunnel on your Mac recommended).
- Open `backend/.env`
- Set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- Set `SENSOR_TABLE=sensor_data`
- Set `HISTORICAL_TABLE=historical_data`
- Optional: `ROLLUP_ENABLED=true`
- Forecasts (XGBoost joblib): ensure `python3` can import `joblib`, `pandas`, `numpy`, `xgboost`
- Optional forecast envs: `FORECAST_MODEL_PATH`, `FORECAST_SCRIPT_PATH`, `FORECAST_PYTHON_BIN`
- data.gov live feed (rainfall + wind): set `DATAGOV_STATION_ID` (default `S109`); backend polling is fixed at 5 minutes to avoid rate limits
- Optional data.gov envs: `DATAGOV_SCRIPT_PATH`, `DATAGOV_PYTHON_BIN`, `DATAGOV_TIMEOUT_SECONDS`, `DATAGOV_HISTORY_HOURS`, `DATAGOV_API_KEY`

## Run (macOS/Linux)
1. Make the helper script executable.
- `chmod +x run_dev.sh`

2. Start both dev servers.
- `./run_dev.sh`

3. Open the frontend.
- Look for the Vite URL like `http://localhost:5173/`

## Run (Windows)
1. Start the frontend dev server in the project root.
- `npm run dev`

2. Start the backend dev server in another terminal.
- `cd backend`
- `npm run dev`

3. Open the frontend.
- Look for the Vite URL like `http://localhost:5173/`

## Notes
- The backend default port is `5050`.


## Model-Training 

Will be using XGBoost model for the UI. The code to train is in `Climatrix2.ipynb`, and the model file is saved under `model-training/artefacts/XGB`
