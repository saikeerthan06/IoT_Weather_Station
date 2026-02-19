import { spawn } from 'node:child_process'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type DatagovMetricPoint = {
  time: string
  value: number
}

type ScriptMetricPayload = {
  timestamp?: unknown
  value?: unknown
  unit?: unknown
  stationId?: unknown
}

type ScriptPayload = {
  stationId?: unknown
  requestedStationId?: unknown
  fetchedAt?: unknown
  rainfall?: ScriptMetricPayload
  rainfallSeries?: unknown
  windspeed?: ScriptMetricPayload
  winddirection?: ScriptMetricPayload
}

type ParsedMetricPayload = {
  timestamp: string | null
  value: number | null
  unit: string
  stationId: string | null
}

type LiveDatagovWind = {
  speed: number | null
  speedUnit: string
  direction: number | null
  directionUnit: string
  cardinal: string | null
  timestamp: string | null
  stationId: string | null
  available: boolean
}

export type LiveDatagovSnapshot = {
  stationId: string
  requestedStationId: string
  fetchedAt: string | null
  rainfallUnit: string
  rainfallLatest: number | null
  rainfallTimestamp: string | null
  rainfallPoints: DatagovMetricPoint[]
  wind: LiveDatagovWind
  pollEveryMs: number
  lastError: string | null
}

const MIN_POLL_MS = 5 * 60 * 1000
const DEFAULT_POLL_MS = MIN_POLL_MS
const DEFAULT_HISTORY_HOURS = 24
const DEFAULT_SCRIPT_TIMEOUT_MS = 20_000

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const defaultScriptPath = resolve(__dirname, '../../scripts/live_datagov_fetch.py')

const parsePositiveInteger = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const rounded = Math.floor(parsed)
  return rounded > 0 ? rounded : fallback
}

const parseFiniteNumber = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) {
    return null
  }

  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

const parseIsoTime = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString()
}

const parseStationId = (raw: unknown): string | null => {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

const parseMetricPayload = (
  raw: ScriptMetricPayload | undefined,
  fallbackUnit: string,
  fallbackStationId: string | null,
): ParsedMetricPayload => {
  const timestamp = parseIsoTime(raw?.timestamp)
  const value = parseFiniteNumber(raw?.value)
  const unit =
    typeof raw?.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : fallbackUnit
  const stationId = parseStationId(raw?.stationId) ?? fallbackStationId

  return {
    timestamp,
    value,
    unit,
    stationId,
  }
}

const parseRainfallSeries = (raw: unknown): DatagovMetricPoint[] => {
  if (!Array.isArray(raw)) {
    return []
  }

  const points: DatagovMetricPoint[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const candidate = item as Record<string, unknown>
    const time = parseIsoTime(candidate.time)
    const value = parseFiniteNumber(candidate.value)
    if (!time || value === null) {
      continue
    }

    points.push({ time, value })
  }

  points.sort((left, right) => {
    const leftMs = Date.parse(left.time)
    const rightMs = Date.parse(right.time)
    return leftMs - rightMs
  })

  return points
}

const normalizeDegrees = (rawDegrees: number) => {
  const normalized = rawDegrees % 360
  return normalized < 0 ? normalized + 360 : normalized
}

const toCardinalDirection = (directionDegrees: number | null): string | null => {
  if (directionDegrees === null || Number.isNaN(directionDegrees)) {
    return null
  }

  const compass = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ]

  const normalized = normalizeDegrees(directionDegrees)
  const index = Math.round(normalized / 22.5) % compass.length
  return compass[index]
}

const resolveConfigPath = (raw: string | undefined, fallbackPath: string) => {
  if (!raw || !raw.trim()) {
    return fallbackPath
  }

  const trimmed = raw.trim()
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed)
}

const configuredPollMs = parsePositiveInteger(process.env.DATAGOV_POLL_MS, DEFAULT_POLL_MS)
const pollEveryMs = MIN_POLL_MS
const isCustomPollRequested = configuredPollMs !== MIN_POLL_MS
const historyHours = parsePositiveInteger(process.env.DATAGOV_HISTORY_HOURS, DEFAULT_HISTORY_HOURS)
const historyRetentionMs = historyHours * 60 * 60 * 1000
const scriptTimeoutMs = parsePositiveInteger(process.env.DATAGOV_SCRIPT_TIMEOUT_MS, DEFAULT_SCRIPT_TIMEOUT_MS)

const defaultStationId = process.env.DATAGOV_STATION_ID?.trim() || 'S109'
const pythonBin =
  process.env.DATAGOV_PYTHON_BIN?.trim() || process.env.FORECAST_PYTHON_BIN?.trim() || 'python3'
const scriptPath = resolveConfigPath(process.env.DATAGOV_SCRIPT_PATH, defaultScriptPath)

let refreshInFlight: Promise<void> | null = null
let lastAttemptAtMs = 0
let pollingStarted = false

const state: LiveDatagovSnapshot = {
  stationId: defaultStationId,
  requestedStationId: defaultStationId,
  fetchedAt: null,
  rainfallUnit: 'mm',
  rainfallLatest: null,
  rainfallTimestamp: null,
  rainfallPoints: [],
  wind: {
    speed: null,
    speedUnit: 'knots',
    direction: null,
    directionUnit: 'degrees',
    cardinal: null,
    timestamp: null,
    stationId: defaultStationId,
    available: false,
  },
  pollEveryMs,
  lastError: null,
}

const pruneRainfallHistory = () => {
  const thresholdMs = Date.now() - historyRetentionMs

  state.rainfallPoints = state.rainfallPoints
    .filter((point) => {
      const parsed = Date.parse(point.time)
      return Number.isFinite(parsed) && parsed >= thresholdMs
    })
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
}

const upsertRainfallPoint = (point: DatagovMetricPoint) => {
  const existingIndex = state.rainfallPoints.findIndex((entry) => entry.time === point.time)
  if (existingIndex >= 0) {
    state.rainfallPoints[existingIndex] = point
    return
  }

  state.rainfallPoints.push(point)
}

const runDatagovScript = async (): Promise<ScriptPayload> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonBin, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`data.gov fetch timed out after ${scriptTimeoutMs}ms.`))
    }, scriptTimeoutMs)

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timeoutId)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeoutId)

      if (code !== 0) {
        rejectPromise(
          new Error(
            stderr.trim() || `data.gov fetch script exited with code ${code ?? 'unknown'}.`,
          ),
        )
        return
      }

      try {
        const parsed = JSON.parse(stdout) as ScriptPayload
        resolvePromise(parsed)
      } catch (error) {
        rejectPromise(
          new Error(
            `data.gov fetch script returned invalid JSON: ${
              error instanceof Error ? error.message : 'unknown parse error'
            }`,
          ),
        )
      }
    })
  })

const refreshFromDatagov = async (force = false): Promise<void> => {
  const nowMs = Date.now()

  if (!force && nowMs - lastAttemptAtMs < pollEveryMs) {
    return
  }

  if (refreshInFlight) {
    return refreshInFlight
  }

  lastAttemptAtMs = nowMs

  refreshInFlight = (async () => {
    try {
      const payload = await runDatagovScript()

      const requestedStationId =
        parseStationId(payload.requestedStationId) ?? state.requestedStationId
      const stationId = parseStationId(payload.stationId) ?? requestedStationId ?? state.stationId
      const fetchedAt = parseIsoTime(payload.fetchedAt) ?? new Date().toISOString()

      const rainfallMetric = parseMetricPayload(payload.rainfall, 'mm', stationId)
      const windspeedMetric = parseMetricPayload(payload.windspeed, 'knots', stationId)
      const winddirectionMetric = parseMetricPayload(payload.winddirection, 'degrees', stationId)
      const rainfallSeries = parseRainfallSeries(payload.rainfallSeries)

      state.stationId = stationId
      state.requestedStationId = requestedStationId
      state.fetchedAt = fetchedAt

      state.rainfallUnit = rainfallMetric.unit
      state.rainfallLatest = rainfallMetric.value
      state.rainfallTimestamp = rainfallMetric.timestamp ?? fetchedAt

      for (const point of rainfallSeries) {
        upsertRainfallPoint(point)
      }

      if (rainfallSeries.length === 0 && rainfallMetric.value !== null) {
        upsertRainfallPoint({
          time: rainfallMetric.timestamp ?? fetchedAt,
          value: rainfallMetric.value,
        })
      }

      pruneRainfallHistory()

      const windDirection = winddirectionMetric.value
      state.wind = {
        speed: windspeedMetric.value,
        speedUnit: windspeedMetric.unit,
        direction: windDirection,
        directionUnit: winddirectionMetric.unit,
        cardinal: toCardinalDirection(windDirection),
        timestamp: winddirectionMetric.timestamp ?? windspeedMetric.timestamp ?? fetchedAt,
        stationId: winddirectionMetric.stationId ?? windspeedMetric.stationId ?? stationId,
        available: windspeedMetric.value !== null || windDirection !== null,
      }

      state.lastError = null
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown data.gov fetch error.'
      state.lastError = message
      // eslint-disable-next-line no-console
      console.error('Failed to refresh data.gov live snapshot', message)
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

export const getLiveDatagovSnapshot = async (): Promise<LiveDatagovSnapshot> => {
  const nowMs = Date.now()

  if (lastAttemptAtMs === 0 || nowMs - lastAttemptAtMs >= pollEveryMs) {
    await refreshFromDatagov(lastAttemptAtMs === 0)
  } else if (refreshInFlight) {
    await refreshInFlight
  }

  return {
    ...state,
    rainfallPoints: [...state.rainfallPoints],
    wind: { ...state.wind },
  }
}

export const startLiveDatagovPolling = () => {
  if (pollingStarted) {
    return
  }

  pollingStarted = true
  if (isCustomPollRequested) {
    // eslint-disable-next-line no-console
    console.warn(
      `DATAGOV_POLL_MS=${configuredPollMs} ignored. Polling interval is fixed at ${pollEveryMs}ms (5 minutes).`,
    )
  }
  void refreshFromDatagov(true)

  const timer = setInterval(() => {
    void refreshFromDatagov()
  }, pollEveryMs)

  timer.unref?.()
}
