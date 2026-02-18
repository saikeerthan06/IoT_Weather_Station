import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router } from 'express'
import { db } from '../services/db.js'

type MetricKey = 'temperature' | 'humidity' | 'pressure'

type MetricPoint = {
  time: string
  value: number
}

type MetricSeries = {
  key: MetricKey
  label: string
  unit: string
  points: MetricPoint[]
  latest: number | null
  min: number | null
  max: number | null
  delta: number | null
  available: boolean
}

type ForecastMetricSeries = MetricSeries & {
  predictionPoints: MetricPoint[]
}

type SensorRow = {
  time: string | Date | null
  temp: string | number | null
  humi: string | number | null
  pres: string | number | null
}

type ForecastMode = 'hourly' | 'weekly'

type ForecastInputRow = {
  time: string
  temp: number
  humi: number
  pres: number
}

type ForecastOutputRow = {
  time: string
  temp: number
  humi: number
  pres: number
}

type ForecastScriptOutput = {
  predictions: ForecastOutputRow[]
}

type MetricsRecord = Record<MetricKey, MetricSeries>
type ForecastMetricsRecord = Record<MetricKey, ForecastMetricSeries>

const router = Router()

const WINDOW_PRESETS: Record<string, number | null> = {
  '1d': 1,
  '3d': 3,
  all: null,
}

const DEFAULT_WINDOW = '3d'
const FORECAST_CONTEXT_DAYS = 45
const FORECAST_MIN_CONTEXT_POINTS = 6
const METRICS_FALLBACK_DAYS = 3
const FORECAST_TIMEOUT_MS = 20_000

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const defaultForecastScriptPath = resolve(__dirname, '../../scripts/forecast_xgb.py')
const defaultForecastModelPath = resolve(
  __dirname,
  '../../../model-training/artefacts/XGB/xgb_3models_robust.joblib',
)

const sanitizeTableName = (raw: string) => {
  const trimmed = raw.trim()
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new Error('Invalid table name.')
  }
  return trimmed
}

const parseNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const toIsoTime = (value: string | Date | null | undefined): string | null => {
  if (!value) {
    return null
  }

  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString()
}

const computeSeriesStats = (points: MetricPoint[]) => {
  if (points.length === 0) {
    return {
      latest: null,
      min: null,
      max: null,
      delta: null,
      available: false,
    }
  }

  const values = points.map((point) => point.value)
  const latest = values[values.length - 1]
  const previous = values.length > 1 ? values[values.length - 2] : null

  return {
    latest,
    min: Math.min(...values),
    max: Math.max(...values),
    delta: previous === null ? null : latest - previous,
    available: true,
  }
}

const parseWindowDays = (raw: string | undefined) => {
  const key = String(raw ?? DEFAULT_WINDOW).trim().toLowerCase()
  if (key in WINDOW_PRESETS) {
    return { key, days: WINDOW_PRESETS[key] }
  }

  return { key: DEFAULT_WINDOW, days: WINDOW_PRESETS[DEFAULT_WINDOW] }
}

const parseForecastMode = (raw: string | undefined): ForecastMode => {
  const key = String(raw ?? 'hourly').trim().toLowerCase()
  if (key === 'weekly') {
    return 'weekly'
  }
  return 'hourly'
}

const mergedRowsCte = (historicalTable: string, sensorTable: string) => `
WITH merged AS (
  SELECT time, temp, humi, pres, 0 AS source_priority
  FROM ${historicalTable}
  WHERE time IS NOT NULL
  UNION ALL
  SELECT time, temp, humi, pres, 1 AS source_priority
  FROM ${sensorTable}
  WHERE time IS NOT NULL
),
ranked AS (
  SELECT
    time,
    temp,
    humi,
    pres,
    ROW_NUMBER() OVER (
      PARTITION BY time::timestamptz
      ORDER BY source_priority DESC
    ) AS rn
  FROM merged
),
dedup AS (
  SELECT time, temp, humi, pres
  FROM ranked
  WHERE rn = 1
)
`

const rowsToHistoryPoints = (rows: SensorRow[]) => {
  const temperaturePoints: MetricPoint[] = []
  const humidityPoints: MetricPoint[] = []
  const pressurePoints: MetricPoint[] = []

  for (const row of rows) {
    const time = toIsoTime(row.time)
    if (!time) {
      continue
    }

    const temp = parseNumber(row.temp)
    if (temp !== null) {
      temperaturePoints.push({ time, value: temp })
    }

    const humi = parseNumber(row.humi)
    if (humi !== null) {
      humidityPoints.push({ time, value: humi })
    }

    const pres = parseNumber(row.pres)
    if (pres !== null) {
      pressurePoints.push({ time, value: pres })
    }
  }

  return {
    temperature: temperaturePoints,
    humidity: humidityPoints,
    pressure: pressurePoints,
  } satisfies Record<MetricKey, MetricPoint[]>
}

const buildMetrics = (rows: SensorRow[]): MetricsRecord => {
  const points = rowsToHistoryPoints(rows)

  const temperatureStats = computeSeriesStats(points.temperature)
  const humidityStats = computeSeriesStats(points.humidity)
  const pressureStats = computeSeriesStats(points.pressure)

  return {
    temperature: {
      key: 'temperature',
      label: 'Temperature',
      unit: 'C',
      points: points.temperature,
      ...temperatureStats,
    },
    humidity: {
      key: 'humidity',
      label: 'Humidity',
      unit: '%',
      points: points.humidity,
      ...humidityStats,
    },
    pressure: {
      key: 'pressure',
      label: 'Pressure',
      unit: 'hPa',
      points: points.pressure,
      ...pressureStats,
    },
  }
}

const buildForecastMetrics = (
  historyRows: SensorRow[],
  predictionRows: ForecastOutputRow[],
): ForecastMetricsRecord => {
  const historyPoints = rowsToHistoryPoints(historyRows)

  const predictionPoints: Record<MetricKey, MetricPoint[]> = {
    temperature: [],
    humidity: [],
    pressure: [],
  }

  for (const row of predictionRows) {
    const time = toIsoTime(row.time)
    if (!time) {
      continue
    }

    if (Number.isFinite(row.temp)) {
      predictionPoints.temperature.push({ time, value: row.temp })
    }
    if (Number.isFinite(row.humi)) {
      predictionPoints.humidity.push({ time, value: row.humi })
    }
    if (Number.isFinite(row.pres)) {
      predictionPoints.pressure.push({ time, value: row.pres })
    }
  }

  const temperatureStats = computeSeriesStats(historyPoints.temperature)
  const humidityStats = computeSeriesStats(historyPoints.humidity)
  const pressureStats = computeSeriesStats(historyPoints.pressure)

  return {
    temperature: {
      key: 'temperature',
      label: 'Temperature',
      unit: 'C',
      points: historyPoints.temperature,
      predictionPoints: predictionPoints.temperature,
      ...temperatureStats,
    },
    humidity: {
      key: 'humidity',
      label: 'Humidity',
      unit: '%',
      points: historyPoints.humidity,
      predictionPoints: predictionPoints.humidity,
      ...humidityStats,
    },
    pressure: {
      key: 'pressure',
      label: 'Pressure',
      unit: 'hPa',
      points: historyPoints.pressure,
      predictionPoints: predictionPoints.pressure,
      ...pressureStats,
    },
  }
}

const rowsToForecastInput = (rows: SensorRow[]) => {
  const points: ForecastInputRow[] = []

  for (const row of rows) {
    const time = toIsoTime(row.time)
    if (!time) {
      continue
    }

    const temp = parseNumber(row.temp)
    const humi = parseNumber(row.humi)
    const pres = parseNumber(row.pres)
    if (temp === null || humi === null || pres === null) {
      continue
    }

    points.push({
      time,
      temp,
      humi,
      pres,
    })
  }

  return points
}

const runForecastScript = async ({
  mode,
  rows,
  modelPath,
  scriptPath,
  pythonBin,
  nowIso,
}: {
  mode: ForecastMode
  rows: ForecastInputRow[]
  modelPath: string
  scriptPath: string
  pythonBin: string
  nowIso: string
}) =>
  new Promise<ForecastOutputRow[]>((resolvePromise, rejectPromise) => {
    const child = spawn(
      pythonBin,
      [scriptPath, '--model', modelPath, '--mode', mode],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    let settled = false

    const settleReject = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      rejectPromise(error)
    }

    const settleResolve = (result: ForecastOutputRow[]) => {
      if (settled) {
        return
      }
      settled = true
      resolvePromise(result)
    }

    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM')
      settleReject(new Error('Forecast process timed out.'))
    }, FORECAST_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      clearTimeout(timeoutId)
      settleReject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timeoutId)

      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `Forecast process exited with ${code}.`
        settleReject(new Error(message))
        return
      }

      try {
        const parsed = JSON.parse(stdout) as ForecastScriptOutput
        if (!parsed || !Array.isArray(parsed.predictions)) {
          throw new Error('Invalid forecast payload.')
        }

        const points: ForecastOutputRow[] = []
        for (const row of parsed.predictions) {
          const time = toIsoTime(row.time)
          const temp = parseNumber(row.temp)
          const humi = parseNumber(row.humi)
          const pres = parseNumber(row.pres)
          if (!time || temp === null || humi === null || pres === null) {
            continue
          }

          points.push({ time, temp, humi, pres })
        }

        settleResolve(points)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to parse forecast payload.'
        settleReject(new Error(message))
      }
    })

    child.stdin.write(JSON.stringify({ now: nowIso, rows }))
    child.stdin.end()
  })

router.get('/metrics', async (req, res) => {
  try {
    const historicalTable = sanitizeTableName(process.env.HISTORICAL_TABLE ?? 'historical_data')
    const sensorTable = sanitizeTableName(process.env.SENSOR_TABLE ?? 'sensor_data')
    const { key: windowKey, days: windowDays } = parseWindowDays(
      typeof req.query.window === 'string' ? req.query.window : undefined,
    )
    const mergedCte = mergedRowsCte(historicalTable, sensorTable)

    let rows: SensorRow[] = []
    let fallback = null as string | null

    if (windowDays === null) {
      const result = await db.query<SensorRow>(
        `${mergedCte}
         SELECT time, temp, humi, pres
         FROM dedup
         ORDER BY time::timestamptz ASC`,
      )
      rows = result.rows
    } else {
      const result = await db.query<SensorRow>(
        `${mergedCte}
         SELECT time, temp, humi, pres
         FROM dedup
         WHERE time::timestamptz >= (NOW() - ($1::int * INTERVAL '1 day'))
           AND time::timestamptz <= NOW()
         ORDER BY time::timestamptz ASC`,
        [windowDays],
      )
      rows = result.rows

      if (rows.length < 2) {
        const fallbackResult = await db.query<SensorRow>(
          `${mergedCte},
           latest AS (
             SELECT MAX(time::timestamptz) AS latest_time
             FROM dedup
           )
           SELECT d.time, d.temp, d.humi, d.pres
           FROM dedup d
           JOIN latest l ON l.latest_time IS NOT NULL
           WHERE d.time::timestamptz >= (l.latest_time - ($1::int * INTERVAL '1 day'))
             AND d.time::timestamptz <= l.latest_time
           ORDER BY d.time::timestamptz ASC`,
          [METRICS_FALLBACK_DAYS],
        )

        if (fallbackResult.rows.length > 0) {
          rows = fallbackResult.rows
          fallback = `latest-${METRICS_FALLBACK_DAYS}d`
        }
      }
    }

    return res.json({
      source: {
        historicalTable,
        sensorTable,
      },
      window: windowKey,
      fallback,
      generatedAt: new Date().toISOString(),
      metrics: buildMetrics(rows),
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to read historical metrics', error)
    return res.status(500).json({ error: 'Failed to load historical metrics.' })
  }
})

router.get('/forecast', async (req, res) => {
  try {
    const historicalTable = sanitizeTableName(process.env.HISTORICAL_TABLE ?? 'historical_data')
    const sensorTable = sanitizeTableName(process.env.SENSOR_TABLE ?? 'sensor_data')
    const mode = parseForecastMode(
      typeof req.query.mode === 'string' ? req.query.mode : undefined,
    )
    const mergedCte = mergedRowsCte(historicalTable, sensorTable)

    const historyRowsResult = await db.query<SensorRow>(
      mode === 'hourly'
        ? `${mergedCte}
           SELECT time, temp, humi, pres
           FROM dedup
           WHERE time::timestamptz >= date_trunc('day', NOW())
             AND time::timestamptz <= NOW()
           ORDER BY time::timestamptz ASC`
        : `${mergedCte}
           SELECT time, temp, humi, pres
           FROM dedup
           ORDER BY time::timestamptz ASC`,
    )

    const contextRowsResult = await db.query<SensorRow>(
      `${mergedCte}
       SELECT time, temp, humi, pres
       FROM dedup
       WHERE time::timestamptz >= (NOW() - ($1::int * INTERVAL '1 day'))
         AND time::timestamptz <= NOW()
       ORDER BY time::timestamptz ASC`,
      [FORECAST_CONTEXT_DAYS],
    )

    const contextRows = rowsToForecastInput(contextRowsResult.rows)

    const scriptPath = process.env.FORECAST_SCRIPT_PATH?.trim() || defaultForecastScriptPath
    const modelPath = process.env.FORECAST_MODEL_PATH?.trim() || defaultForecastModelPath
    const pythonBin = process.env.FORECAST_PYTHON_BIN?.trim() || 'python3'

    let warning: string | null = null
    let forecastRows: ForecastOutputRow[] = []

    if (contextRows.length < FORECAST_MIN_CONTEXT_POINTS) {
      warning = 'Not enough historical context to generate forecast.'
    } else {
      try {
        forecastRows = await runForecastScript({
          mode,
          rows: contextRows,
          modelPath,
          scriptPath,
          pythonBin,
          nowIso: new Date().toISOString(),
        })
      } catch (error) {
        warning =
          error instanceof Error ? error.message : 'Failed to generate forecast.'
      }
    }

    return res.json({
      mode,
      historyWindow: mode === 'hourly' ? 'today' : 'all',
      source: {
        historicalTable,
        sensorTable,
        modelPath,
      },
      warning,
      generatedAt: new Date().toISOString(),
      metrics: buildForecastMetrics(historyRowsResult.rows, forecastRows),
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to generate historical forecast', error)
    return res.status(500).json({ error: 'Failed to generate historical forecast.' })
  }
})

export { router as historyRouter }
