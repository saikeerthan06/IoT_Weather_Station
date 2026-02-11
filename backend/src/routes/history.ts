import { Router } from 'express'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type MetricKey = 'temperature' | 'humidity' | 'wind'

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

type ParsedRow = Record<string, string>

const router = Router()

const currentDir = dirname(fileURLToPath(import.meta.url))
const datasetsDir = resolve(currentDir, '../../../model-training/datasets')
const historicalUiPath = resolve(datasetsDir, 'official_historical_ui.csv')
const officialDataPath = resolve(datasetsDir, 'official_data.csv')

const csvToRows = (content: string): ParsedRow[] => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    return []
  }

  const headers = lines[0].split(',').map((header) => header.trim())

  return lines.slice(1).map((line) => {
    const values = line.split(',').map((value) => value.trim())
    const row: ParsedRow = {}

    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = values[i] ?? ''
    }

    return row
  })
}

const parseNumber = (raw: string | undefined): number | null => {
  if (!raw) {
    return null
  }

  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const toIsoTime = (raw: string | undefined): string | null => {
  if (!raw) {
    return null
  }

  const parsed = new Date(raw)
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

const parseWindowToMs = (windowParam: string): number | null => {
  const trimmed = windowParam.trim().toLowerCase()
  if (!trimmed || trimmed === 'all') {
    return null
  }

  const match = trimmed.match(/^(\d+)([hd])$/)
  if (!match) {
    return null
  }

  const amount = Number(match[1])
  const unit = match[2]
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  if (unit === 'h') {
    return amount * 60 * 60 * 1000
  }

  return amount * 24 * 60 * 60 * 1000
}

const applyWindow = (
  points: Array<{ time: string; value: number }>,
  windowMs: number | null,
) => {
  if (!windowMs || points.length === 0) {
    return points
  }

  const latest = new Date(points[points.length - 1].time).getTime()
  const start = latest - windowMs
  return points.filter((point) => new Date(point.time).getTime() >= start)
}

const buildSeries = async (): Promise<Record<MetricKey, MetricSeries>> => {
  const historicalRaw = await readFile(historicalUiPath, 'utf8')
  const historicalRows = csvToRows(historicalRaw)

  const temperaturePoints: Array<{ time: string; value: number }> = []
  const humidityPoints: Array<{ time: string; value: number }> = []
  const windPoints: Array<{ time: string; value: number }> = []

  const windByTime = new Map<string, number>()
  let hasWindInHistoricalCsv = false

  for (const row of historicalRows) {
    const rawTime = row.time ?? row.timestamp
    const time = toIsoTime(rawTime)
    if (!time) {
      continue
    }

    const temp = parseNumber(row.temp ?? row.temperature)
    if (temp !== null) {
      temperaturePoints.push({ time, value: temp })
    }

    const humi = parseNumber(row.humi ?? row.humidity)
    if (humi !== null) {
      humidityPoints.push({ time, value: humi })
    }

    const wind = parseNumber(row.wind ?? row.windspeed ?? row.wind_speed)
    if (wind !== null) {
      hasWindInHistoricalCsv = true
      windPoints.push({ time, value: wind })
      windByTime.set(time, wind)
    }
  }

  if (!hasWindInHistoricalCsv) {
    const officialRaw = await readFile(officialDataPath, 'utf8')
    const officialRows = csvToRows(officialRaw)

    for (const row of officialRows) {
      const time = toIsoTime(row.time ?? row.timestamp)
      const wind = parseNumber(row.windspeed ?? row.wind ?? row.wind_speed)
      if (!time || wind === null) {
        continue
      }

      windByTime.set(time, wind)
    }

    for (const temperaturePoint of temperaturePoints) {
      const wind = windByTime.get(temperaturePoint.time)
      if (wind !== undefined) {
        windPoints.push({ time: temperaturePoint.time, value: wind })
      }
    }
  }

  temperaturePoints.sort((a, b) => a.time.localeCompare(b.time))
  humidityPoints.sort((a, b) => a.time.localeCompare(b.time))
  windPoints.sort((a, b) => a.time.localeCompare(b.time))

  const temperatureStats = computeSeriesStats(temperaturePoints)
  const humidityStats = computeSeriesStats(humidityPoints)
  const windStats = computeSeriesStats(windPoints)

  return {
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
    wind: {
      key: 'wind',
      label: 'Wind',
      unit: 'km/h',
      points: windPoints,
      ...windStats,
    },
  }
}

router.get('/metrics', async (req, res) => {
  try {
    const allSeries = await buildSeries()
    const rawWindow = String(req.query.window ?? 'all')
    const windowMs = parseWindowToMs(rawWindow)

    const metrics = {
      temperature: (() => {
        const points = applyWindow(allSeries.temperature.points, windowMs)
        return {
          ...allSeries.temperature,
          points,
          ...computeSeriesStats(points),
        }
      })(),
      humidity: (() => {
        const points = applyWindow(allSeries.humidity.points, windowMs)
        return {
          ...allSeries.humidity,
          points,
          ...computeSeriesStats(points),
        }
      })(),
      wind: (() => {
        const points = applyWindow(allSeries.wind.points, windowMs)
        return {
          ...allSeries.wind,
          points,
          ...computeSeriesStats(points),
        }
      })(),
    }

    return res.json({
      source: {
        historical: 'official_historical_ui.csv',
        windFallback: 'official_data.csv',
      },
      metrics,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to read historical metrics', error)
    return res.status(500).json({ error: 'Failed to load historical metrics.' })
  }
})

export { router as historyRouter }
