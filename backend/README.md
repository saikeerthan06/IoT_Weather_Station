# Backend

This folder is reserved for the IoT Weather backend services (ingestion, storage, forecasting, and APIs).

## Structure
- `src/index.ts`: API entrypoint
- `src/routes/`: HTTP routes (Gemini endpoint lives here)
- `src/ingest/`: sensor ingestion pipeline (MQTT/HTTP)
- `src/forecast/`: ML forecast jobs + inference
- `src/models/`: domain models
- `src/repositories/`: DB access
- `src/services/`: business logic
- `src/jobs/`: scheduled tasks
- `src/middleware/`: auth, logging, validation
- `src/types/`: shared backend types
- `src/utils/`: helpers

## Quick start (when ready)
1. `npm install`
2. Copy `.env.example` to `.env` and fill in `GEMINI_API_KEY`
3. Fill in Postgres settings (use your SSH tunnel host/port if running locally).
4. Set `HISTORICAL_TABLE=historical_data` (and optionally `ROLLUP_ENABLED=false` to disable daily rollups).
5. `npm run dev`
