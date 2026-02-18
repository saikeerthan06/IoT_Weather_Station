import { Router } from 'express'
import { db } from '../services/db.js'

type MetricKey = 'temperature' | 'humidity' | 'pressure'

type MetricSeries = {
  key: MetricKey
  label: string
  unit: string
  points: Array<{ time: string; value: number }>
  latest: number | null
  min: number | null
  max: number | null
  delta: number | null
  available: boolean
}

type SensorRow = {
  time: string | Date | null
  temp: string | number | null
  humi: string | number | null
  pres: string | number | null
}

const router = Router()

const WINDOW_PRESETS: Record<string, number | null> = {
  '1d': 1,
  '3d': 3,
  all: null,
}

const DEFAULT_WINDOW = '3d'

const sanitizeTableName = (raw: string) => {
  const trimmed = raw.trim()
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new Error('Invalid historical table name.')
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

const computeSeriesStats = (points: Array<{ time: string; value: number }>) => {
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

const parseWindowMs = (raw: string | undefined) => {
  const key = String(raw ?? DEFAULT_WINDOW).trim().toLowerCase()
  if (key in WINDOW_PRESETS) {
    return { key, ms: WINDOW_PRESETS[key] }
  }

  return { key: DEFAULT_WINDOW, ms: WINDOW_PRESETS[DEFAULT_WINDOW] }
}

router.get('/metrics', async (req, res) => {
  try {
    const tableName = sanitizeTableName(process.env.HISTORICAL_TABLE ?? 'historical_data')
    const { key: windowKey, ms: windowMs } = parseWindowMs(
      typeof req.query.window === 'string' ? req.query.window : undefined,
    )

    const baseQuery = `SELECT time, temp, humi, pres FROM ${tableName}`
    let rows: SensorRow[] = []
    if (windowMs === null) {
      const result = await db.query<SensorRow>(
        `${baseQuery} ORDER BY time::timestamptz ASC`,
      )
      rows = result.rows
    } else {
      const days = windowMs
      const result = await db.query<SensorRow>(
        `${baseQuery}
         WHERE time::timestamptz >= (CURRENT_DATE - ($1::int * INTERVAL '1 day'))
           AND time::timestamptz < CURRENT_DATE
         ORDER BY time::timestamptz ASC`,
        [days],
      )
      rows = result.rows
    }

    const temperaturePoints: Array<{ time: string; value: number }> = []
    const humidityPoints: Array<{ time: string; value: number }> = []
    const pressurePoints: Array<{ time: string; value: number }> = []

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

    const temperatureStats = computeSeriesStats(temperaturePoints)
    const humidityStats = computeSeriesStats(humidityPoints)
    const pressureStats = computeSeriesStats(pressurePoints)

    return res.json({
      source: {
        table: tableName,
      },
      window: windowKey,
      generatedAt: new Date().toISOString(),
      metrics: {
        temperature: {
          key: 'temperature',
          label: 'Temperature',
          unit: 'C',
          points: temperaturePoints,
          ...temperatureStats,
        },
        humidity: {
          key: 'humidity',
          label: 'Humidity',
          unit: '%',
          points: humidityPoints,
          ...humidityStats,
        },
        pressure: {
          key: 'pressure',
          label: 'Pressure',
          unit: 'hPa',
          points: pressurePoints,
          ...pressureStats,
        },
      },
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to read historical metrics', error)
    return res.status(500).json({ error: 'Failed to load historical metrics.' })
  }
})

export { router as historyRouter }
