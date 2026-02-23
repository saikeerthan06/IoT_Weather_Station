import { Router } from 'express'
import { db } from '../services/db.js'
import { getLiveDatagovSnapshot } from '../services/liveDatagov.js'

type MetricKey = 'temperature' | 'humidity' | 'pressure' | 'rainfall' | 'windspeed'

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

const WINDOW_PRESETS: Record<string, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '10h': 10 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
}

const DEFAULT_WINDOW = '12h'
const DEFAULT_SENSOR_ONLINE_THRESHOLD_MS = 15 * 60 * 1000
const SENSOR_STATUS_LOOKBACK_ROWS = 24

const sanitizeTableName = (raw: string) => {
  const trimmed = raw.trim()
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new Error('Invalid sensor table name.')
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

const parsePositiveInteger = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const rounded = Math.floor(parsed)
  return rounded > 0 ? rounded : fallback
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

const computeObservedCadenceMs = (times: string[]) => {
  if (times.length < 2) {
    return null
  }

  const intervals: number[] = []
  for (let index = 1; index < times.length; index += 1) {
    const newerMs = Date.parse(times[index - 1] ?? '')
    const olderMs = Date.parse(times[index] ?? '')
    if (!Number.isFinite(newerMs) || !Number.isFinite(olderMs)) {
      continue
    }

    const delta = newerMs - olderMs
    if (delta > 0) {
      intervals.push(delta)
    }
  }

  if (intervals.length === 0) {
    return null
  }

  intervals.sort((left, right) => left - right)
  const mid = Math.floor(intervals.length / 2)
  if (intervals.length % 2 === 1) {
    return intervals[mid] ?? null
  }

  const leftMid = intervals[mid - 1]
  const rightMid = intervals[mid]
  if (leftMid === undefined || rightMid === undefined) {
    return null
  }
  return Math.round((leftMid + rightMid) / 2)
}

const sensorOnlineThresholdMs = parsePositiveInteger(
  process.env.SENSOR_ONLINE_THRESHOLD_MS,
  DEFAULT_SENSOR_ONLINE_THRESHOLD_MS,
)

router.get('/metrics', async (req, res) => {
  try {
    const tableName = sanitizeTableName(process.env.SENSOR_TABLE ?? 'sensor_data')
    const { key: windowKey, ms: windowMs } = parseWindowMs(
      typeof req.query.window === 'string' ? req.query.window : undefined,
    )

    const nowMs = Date.now()
    const windowStartMs = nowMs - windowMs
    const windowStart = new Date(windowStartMs).toISOString()
    const { rows } = await db.query<SensorRow>(
      `SELECT time, temp, humi, pres
       FROM ${tableName}
       WHERE time::timestamptz >= GREATEST($1::timestamptz, CURRENT_DATE::timestamptz)
         AND time::timestamptz < (CURRENT_DATE + INTERVAL '1 day')::timestamptz
       ORDER BY time::timestamptz ASC`,
      [windowStart],
    )
    const recentSensorResult = await db.query<SensorRow>(
      `SELECT time, temp, humi, pres
       FROM ${tableName}
       WHERE time IS NOT NULL
         AND (temp IS NOT NULL OR humi IS NOT NULL OR pres IS NOT NULL)
       ORDER BY time::timestamptz DESC
       LIMIT $1`,
      [SENSOR_STATUS_LOOKBACK_ROWS],
    )
    const recentSensorTimes = recentSensorResult.rows
      .map((row) => toIsoTime(row.time))
      .filter((time): time is string => time !== null)
    const latestSensorTime = recentSensorTimes[0] ?? null
    let sensorStalenessMs: number | null = null
    if (latestSensorTime) {
      const parsed = Date.parse(latestSensorTime)
      if (Number.isFinite(parsed)) {
        sensorStalenessMs = Math.max(0, nowMs - parsed)
      }
    }
    const observedCadenceMs = computeObservedCadenceMs(recentSensorTimes)
    const adaptiveThresholdMs =
      observedCadenceMs === null
        ? sensorOnlineThresholdMs
        : Math.max(sensorOnlineThresholdMs, observedCadenceMs * 3)
    const sensorConnected =
      sensorStalenessMs !== null &&
      sensorStalenessMs <= adaptiveThresholdMs

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
    const datagovSnapshot = await getLiveDatagovSnapshot()
    const rainfallPoints = datagovSnapshot.rainfallPoints.filter((point) => {
      const parsed = Date.parse(point.time)
      return Number.isFinite(parsed) && parsed >= windowStartMs
    })
    const rainfallStats = computeSeriesStats(rainfallPoints)
    const windspeedPoints = datagovSnapshot.windspeedPoints.filter((point) => {
      const parsed = Date.parse(point.time)
      return Number.isFinite(parsed) && parsed >= windowStartMs
    })
    const windspeedStats = computeSeriesStats(windspeedPoints)
    const winddirectionPoints = datagovSnapshot.winddirectionPoints.filter((point) => {
      const parsed = Date.parse(point.time)
      return Number.isFinite(parsed) && parsed >= windowStartMs
    })

    return res.json({
      source: {
        table: tableName,
        sensor: {
          connected: sensorConnected,
          lastSeen: latestSensorTime,
          stalenessMs: sensorStalenessMs,
          thresholdMs: adaptiveThresholdMs,
          observedCadenceMs,
          sampleCount: recentSensorTimes.length,
        },
        datagov: {
          stationId: datagovSnapshot.stationId,
          requestedStationId: datagovSnapshot.requestedStationId,
          sampledEveryMs: datagovSnapshot.pollEveryMs,
          lastError: datagovSnapshot.lastError,
        },
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
        rainfall: {
          key: 'rainfall',
          label: 'Rainfall',
          unit: datagovSnapshot.rainfallUnit,
          points: rainfallPoints,
          ...rainfallStats,
        },
        windspeed: {
          key: 'windspeed',
          label: 'Wind Speed',
          unit: datagovSnapshot.wind.speedUnit,
          points: windspeedPoints,
          ...windspeedStats,
        },
      },
      wind: datagovSnapshot.wind,
      windHistory: {
        directionUnit: datagovSnapshot.wind.directionUnit,
        directionPoints: winddirectionPoints,
      },
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load live metrics', error)
    return res.status(500).json({ error: 'Failed to load live metrics.' })
  }
})

export { router as liveRouter }
