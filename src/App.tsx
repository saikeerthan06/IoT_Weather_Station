import './App.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type HistoricalMetricId = 'temperature' | 'humidity' | 'pressure'
type MetricId = HistoricalMetricId | 'rainfall'
type LiveTimeframe = '1h' | '2h' | '6h' | '10h' | '12h'
type HistoricalTimeframe = 'all' | '1d' | '3d'
type ExpandedTimeframe = LiveTimeframe | HistoricalTimeframe
type HistoricalWindow = HistoricalTimeframe

type MetricPoint = {
  time: string
  value: number
}

type MetricSeries = {
  key: MetricId
  label: string
  unit: string
  points: MetricPoint[]
  latest: number | null
  min: number | null
  max: number | null
  delta: number | null
  available: boolean
}

type ForecastMode = 'off' | 'hourly' | 'weekly'

type ForecastMetricSeries = MetricSeries & {
  predictionPoints: MetricPoint[]
}

type MetricsRecord = Partial<Record<MetricId, MetricSeries>>
type LiveMetricsRecord = Record<MetricId, MetricSeries>
type HistoricalMetricsRecord = Record<HistoricalMetricId, MetricSeries>

type WindSnapshot = {
  speed: number | null
  speedUnit: string
  direction: number | null
  directionUnit: string
  cardinal: string | null
  timestamp: string | null
  stationId: string | null
  available: boolean
}

type LiveMetricsApiResponse = {
  metrics: LiveMetricsRecord
  wind?: WindSnapshot
}

type HistoricalMetricsApiResponse = {
  metrics: HistoricalMetricsRecord
}

type ExpandedMetricsApiResponse = {
  metrics: MetricsRecord
}

type ForecastApiResponse = {
  mode: Exclude<ForecastMode, 'off'>
  historyWindow: 'today' | 'all'
  source?: {
    historicalTable?: string
    sensorTable?: string
    modelPath?: string
  }
  generatedAt?: string
  warning?: string | null
  metrics: Record<HistoricalMetricId, ForecastMetricSeries>
}

type HistoricalInsightForecastContext = {
  enabled: boolean
  modelFamily: 'xgboost'
  mode: ForecastMode
  modelPath: string | null
  generatedAt: string | null
  warning: string | null
  predictionPointCount: number
}

type HistoricalInsightRequestPayload = {
  metric: {
    id: MetricId
    label: string
    unit: string
  }
  window: {
    timeframe: HistoricalTimeframe
    forecastMode: ForecastMode
  }
  location: string
  historical: {
    pointCount: number
    points: MetricPoint[]
    summary: TrendSummary
  }
  prediction: {
    pointCount: number
    points: MetricPoint[]
    summary: TrendSummary
  }
  assistantContext: {
    role: 'weather-station-operator-assistant'
    chartType: 'time-series'
    forecast: HistoricalInsightForecastContext
  }
}

type GeminiMessage = {
  role: 'user' | 'assistant'
  text: string
}

type TrendSummary = {
  startTime: string | null
  endTime: string | null
  startValue: number | null
  endValue: number | null
  change: number | null
  average: number | null
  min: number | null
  max: number | null
}

type ChartGeometry = {
  width: number
  height: number
  padding: number
  min: number
  max: number
  linePath: string
  areaPath: string
  dot: { x: number; y: number }
  points: Array<{ x: number; y: number; time: string; value: number }>
}

type OverviewStatus = 'Optimal' | 'Good' | 'Watch' | 'Alert'

const metricOrder: HistoricalMetricId[] = ['temperature', 'humidity', 'pressure']

const metricStyleConfig: Record<
  MetricId,
  { accent: string; fallbackUnit: string; defaultLabel: string }
> = {
  temperature: {
    accent: 'ember',
    fallbackUnit: 'C',
    defaultLabel: 'Temperature',
  },
  humidity: {
    accent: 'sky',
    fallbackUnit: '%',
    defaultLabel: 'Humidity',
  },
  pressure: {
    accent: 'teal',
    fallbackUnit: 'hPa',
    defaultLabel: 'Pressure',
  },
  rainfall: {
    accent: 'cyan',
    fallbackUnit: 'mm',
    defaultLabel: 'Rainfall',
  },
}

const liveTimeframeOptions: Array<{ value: LiveTimeframe; label: string }> = [
  { value: '1h', label: '1H' },
  { value: '2h', label: '2H' },
  { value: '6h', label: '6H' },
  { value: '10h', label: '10H' },
  { value: '12h', label: '12H' },
]

const historicalTimeframeOptions: Array<{ value: HistoricalTimeframe; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '1d', label: '1 Day' },
  { value: '3d', label: '3 Day' },
]

const timeframeMs: Record<LiveTimeframe, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '10h': 10 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
}

const defaultGreeting: GeminiMessage = {
  role: 'assistant',
  text: 'Hi! Ask me anything.',
}

const METRIC_MODAL_ANIMATION_MS = 220
const Y_AXIS_TICK_COUNT = 6
const LIVE_SNAPSHOT_POLL_MS = 60_000
const LIVE_MODAL_POLL_MS = 10_000
const HISTORICAL_POLL_MS = 15 * 60_000
const SNAPSHOT_WINDOW: LiveTimeframe = '12h'
const HISTORICAL_WINDOW: HistoricalWindow = '3d'
const OVERVIEW_RAIN_WINDOW_MS = 60 * 60 * 1000
const GEMINI_UI_ENABLED = false

const accentStyle = (accent: string): CSSProperties =>
  ({
    '--accent': `var(--accent-${accent})`,
  }) as CSSProperties

const meterStyle = (value: number): CSSProperties =>
  ({
    '--value': `${Math.max(0, Math.min(100, value))}%`,
  }) as CSSProperties

const formatLocalTime = (date: Date) =>
  date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })

const formatMetricValue = (metricId: MetricId, value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return '--'
  }

  if (metricId === 'pressure' || metricId === 'rainfall') {
    const truncated = Math.trunc(value * 100) / 100
    return truncated.toFixed(2)
  }

  if (metricId === 'humidity') {
    return String(Math.round(value))
  }

  return value.toFixed(1)
}

const formatMetricDelta = (metricId: MetricId, delta: number | null) => {
  if (delta === null || Number.isNaN(delta)) {
    return '--'
  }

  if (delta === 0) {
    return metricId === 'pressure' || metricId === 'rainfall' ? '0.00' : '0'
  }

  if (metricId === 'pressure' || metricId === 'rainfall') {
    const truncated = Math.trunc(delta * 100) / 100
    return `${truncated > 0 ? '+' : ''}${truncated.toFixed(2)}`
  }

  if (metricId === 'humidity') {
    const rounded = Math.round(delta)
    return `${rounded > 0 ? '+' : ''}${rounded}`
  }

  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`
}

const trendClassFromDelta = (delta: number | null) => {
  if (delta === null || delta === 0) {
    return 'trend-flat'
  }

  return delta > 0 ? 'trend-up' : 'trend-down'
}

const metricNote = (metricId: MetricId, value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return 'No data'
  }

  if (metricId === 'temperature') {
    if (value >= 34) return 'Very warm'
    if (value >= 28) return 'Warm'
    if (value >= 22) return 'Mild'
    return 'Cool'
  }

  if (metricId === 'humidity') {
    if (value >= 70) return 'Humid'
    if (value >= 45) return 'Comfort'
    return 'Dry'
  }

  if (metricId === 'rainfall') {
    if (value >= 15) return 'Heavy rain'
    if (value >= 5) return 'Steady rain'
    if (value > 0) return 'Light rain'
    return 'Dry spell'
  }

  if (value >= 1025) return 'High pressure'
  if (value >= 1012) return 'Stable'
  if (value >= 1000) return 'Low'
  return 'Very low'
}

const rangeLabel = (
  metricId: MetricId,
  points: MetricPoint[],
  unit: string,
  sourceLabel: 'live' | 'historical',
) => {
  if (points.length === 0) {
    return `No ${sourceLabel} ${metricStyleConfig[metricId].defaultLabel.toLowerCase()} data`
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const point of points) {
    if (point.value < min) min = point.value
    if (point.value > max) max = point.value
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 'No data'
  }

  if (metricId === 'humidity') {
    return `${Math.round(min)}-${Math.round(max)} ${unit}`
  }

  if (metricId === 'pressure' || metricId === 'rainfall') {
    const minTrunc = Math.trunc(min * 100) / 100
    const maxTrunc = Math.trunc(max * 100) / 100
    return `${minTrunc.toFixed(2)}-${maxTrunc.toFixed(2)} ${unit}`
  }

  return `${min.toFixed(1)}-${max.toFixed(1)} ${unit}`
}

const normalizeMeterValue = (metric: MetricSeries | null) => {
  if (!metric || metric.latest === null || metric.min === null || metric.max === null) {
    return 0
  }

  if (metric.max === metric.min) {
    return 50
  }

  return ((metric.latest - metric.min) / (metric.max - metric.min)) * 100
}

const filterByTimeframe = (points: MetricPoint[], timeframe: LiveTimeframe) => {
  if (points.length === 0) {
    return points
  }

  const latest = new Date(points[points.length - 1].time).getTime()
  if (Number.isNaN(latest)) {
    return points
  }

  const threshold = latest - timeframeMs[timeframe]
  return points.filter((point) => {
    const timestamp = new Date(point.time).getTime()
    return Number.isFinite(timestamp) && timestamp >= threshold
  })
}

const resamplePoints = (points: MetricPoint[], maxPoints: number) => {
  if (points.length <= maxPoints) {
    return points
  }

  const sampled: MetricPoint[] = []
  const step = (points.length - 1) / (maxPoints - 1)

  for (let i = 0; i < maxPoints; i += 1) {
    sampled.push(points[Math.round(i * step)])
  }

  return sampled
}

const buildChartGeometry = (
  points: MetricPoint[],
  width: number,
  height: number,
  padding: number,
): ChartGeometry | null => {
  if (points.length === 0) {
    return null
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const point of points) {
    if (point.value < min) min = point.value
    if (point.value > max) max = point.value
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null
  }

  const valueRange = max - min || 1
  const chartWidth = width - padding * 2
  const chartHeight = height - padding * 2

  const chartPoints = points.map((point, index) => {
    const xRatio = points.length === 1 ? 0 : index / (points.length - 1)
    const normalizedValue = (point.value - min) / valueRange

    const x = padding + xRatio * chartWidth
    const y = padding + (1 - normalizedValue) * chartHeight

    return {
      x,
      y,
      time: point.time,
      value: point.value,
    }
  })

  const linePath = chartPoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')

  const baseline = height - padding
  const first = chartPoints[0]
  const last = chartPoints[chartPoints.length - 1]
  const areaPath = `${linePath} L${last.x.toFixed(2)} ${baseline.toFixed(2)} L${first.x.toFixed(2)} ${baseline.toFixed(2)} Z`

  return {
    width,
    height,
    padding,
    min,
    max,
    linePath,
    areaPath,
    dot: { x: last.x, y: last.y },
    points: chartPoints,
  }
}

const buildLinePathFromChartPoints = (points: Array<{ x: number; y: number }>) => {
  if (points.length === 0) {
    return ''
  }

  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
}

const summarizeTrendPoints = (points: MetricPoint[]): TrendSummary => {
  if (points.length === 0) {
    return {
      startTime: null,
      endTime: null,
      startValue: null,
      endValue: null,
      change: null,
      average: null,
      min: null,
      max: null,
    }
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let total = 0

  for (const point of points) {
    if (point.value < min) min = point.value
    if (point.value > max) max = point.value
    total += point.value
  }

  const first = points[0]
  const last = points[points.length - 1]

  return {
    startTime: first?.time ?? null,
    endTime: last?.time ?? null,
    startValue: first?.value ?? null,
    endValue: last?.value ?? null,
    change:
      first && last && Number.isFinite(first.value) && Number.isFinite(last.value)
        ? last.value - first.value
        : null,
    average: total / points.length,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
  }
}

const formatTimestamp = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

const formatAxisTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

const formatForecastDay = (iso: string) =>
  new Date(iso).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

const formatForecastHour = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const weightedAverage = (parts: Array<{ value: number | null; weight: number }>) => {
  let weightedTotal = 0
  let totalWeight = 0

  for (const part of parts) {
    if (part.value === null || Number.isNaN(part.value) || part.weight <= 0) {
      continue
    }

    weightedTotal += part.value * part.weight
    totalWeight += part.weight
  }

  if (totalWeight === 0) {
    return null
  }

  return weightedTotal / totalWeight
}

const maxRecentValue = (points: MetricPoint[], windowMs: number) => {
  if (points.length === 0) {
    return null
  }

  const latestMs = Date.parse(points[points.length - 1].time)
  if (!Number.isFinite(latestMs)) {
    return null
  }

  const thresholdMs = latestMs - windowMs
  let max = Number.NEGATIVE_INFINITY

  for (const point of points) {
    const pointMs = Date.parse(point.time)
    if (!Number.isFinite(pointMs) || pointMs < thresholdMs) {
      continue
    }

    if (point.value > max) {
      max = point.value
    }
  }

  if (!Number.isFinite(max)) {
    return null
  }

  return max
}

const rainScoreFromMm = (mm: number | null) => {
  if (mm === null || Number.isNaN(mm)) {
    return null
  }

  if (mm <= 0) return 100
  if (mm <= 2) return 85
  if (mm <= 10) return 60
  if (mm <= 20) return 35
  return 10
}

const windScoreFromKnots = (knots: number | null) => {
  if (knots === null || Number.isNaN(knots)) {
    return null
  }

  if (knots <= 4) return 90
  if (knots <= 8) return 100
  if (knots <= 12) return 92
  if (knots <= 18) return 70
  if (knots <= 25) return 45
  return 20
}

const averageDelta = (points: MetricPoint[], windowSize: number) => {
  if (points.length < 2) {
    return null
  }

  const recent = points.slice(-windowSize)
  if (recent.length < 2) {
    return null
  }

  let total = 0
  for (let i = 1; i < recent.length; i += 1) {
    total += Math.abs(recent[i].value - recent[i - 1].value)
  }

  return total / (recent.length - 1)
}

const stabilityFromDelta = (avgDelta: number | null, safeDelta: number) => {
  if (avgDelta === null) {
    return 70
  }

  return clamp(100 - (avgDelta / safeDelta) * 100, 0, 100)
}

const mapScoreToStatus = (score: number): OverviewStatus => {
  if (score >= 80) {
    return 'Optimal'
  }

  if (score >= 60) {
    return 'Good'
  }

  if (score >= 40) {
    return 'Watch'
  }

  return 'Alert'
}

const statusChipClass = (status: OverviewStatus) => {
  if (status === 'Optimal' || status === 'Good') {
    return 'chip-good'
  }

  return 'chip-warn'
}

function App() {
  const [localTime, setLocalTime] = useState(() => formatLocalTime(new Date()))
  const [snapshotMetrics, setSnapshotMetrics] = useState<LiveMetricsRecord | null>(null)
  const [windSnapshot, setWindSnapshot] = useState<WindSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [historicalMetrics, setHistoricalMetrics] = useState<HistoricalMetricsRecord | null>(null)
  const [historicalError, setHistoricalError] = useState<string | null>(null)
  const [expandedMetrics, setExpandedMetrics] = useState<MetricsRecord | null>(null)
  const [expandedError, setExpandedError] = useState<string | null>(null)
  const [isOverviewModalOpen, setIsOverviewModalOpen] = useState(false)
  const [isOverviewFormulaOpen, setIsOverviewFormulaOpen] = useState(false)

  const [expandedMetric, setExpandedMetric] = useState<MetricId | null>(null)
  const [expandedMode, setExpandedMode] = useState<'live' | 'historical' | null>(null)
  const [isMetricClosing, setIsMetricClosing] = useState(false)
  const [showExpandedAxes, setShowExpandedAxes] = useState(false)
  const [expandedTimeframe, setExpandedTimeframe] = useState<ExpandedTimeframe>('12h')
  const [expandedForecastMode, setExpandedForecastMode] = useState<ForecastMode>('off')
  const [expandedForecastMetrics, setExpandedForecastMetrics] = useState<
    Record<HistoricalMetricId, ForecastMetricSeries> | null
  >(null)
  const [expandedForecastContext, setExpandedForecastContext] =
    useState<HistoricalInsightForecastContext | null>(null)
  const [isForecastLoading, setIsForecastLoading] = useState(false)
  const [expandedForecastError, setExpandedForecastError] = useState<string | null>(null)
  const [expandedHoverIndex, setExpandedHoverIndex] = useState<number | null>(null)
  const [isPredictionFocusActive, setIsPredictionFocusActive] = useState(false)
  const [hoveredForecastPointIndexes, setHoveredForecastPointIndexes] = useState<number[]>([])
  const [hoveredForecastRowKey, setHoveredForecastRowKey] = useState<string | null>(null)
  const [historicalGeminiOpen, setHistoricalGeminiOpen] = useState(false)
  const [historicalGeminiText, setHistoricalGeminiText] = useState('')
  const [historicalGeminiError, setHistoricalGeminiError] = useState<string | null>(null)
  const [isHistoricalGeminiStreaming, setIsHistoricalGeminiStreaming] = useState(false)
  const historicalGeminiAbortRef = useRef<AbortController | null>(null)

  const [geminiOpen, setGeminiOpen] = useState(false)
  const [messages, setMessages] = useState<GeminiMessage[]>([defaultGreeting])
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setLocalTime(formatLocalTime(new Date()))
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    const loadSnapshot = async () => {
      try {
        const response = await fetch(`/api/live/metrics?window=${SNAPSHOT_WINDOW}`, {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error('Failed to load live metrics.')
        }

        const payload = (await response.json()) as LiveMetricsApiResponse
        setSnapshotMetrics(payload.metrics)
        setWindSnapshot(payload.wind ?? null)
        setSnapshotError(null)
      } catch (loadError) {
        if (controller.signal.aborted) {
          return
        }

        const message =
          loadError instanceof Error ? loadError.message : 'Failed to load live metrics.'
        setSnapshotError(message)
      }
    }

    void loadSnapshot()
    const intervalId = window.setInterval(loadSnapshot, LIVE_SNAPSHOT_POLL_MS)

    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    const loadHistorical = async () => {
      try {
        const response = await fetch(`/api/history/metrics?window=${HISTORICAL_WINDOW}`, {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error('Failed to load historical metrics.')
        }

        const payload = (await response.json()) as HistoricalMetricsApiResponse
        setHistoricalMetrics(payload.metrics)
        setHistoricalError(null)
      } catch (loadError) {
        if (controller.signal.aborted) {
          return
        }

        const message =
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load historical metrics.'
        setHistoricalError(message)
      }
    }

    void loadHistorical()
    const intervalId = window.setInterval(loadHistorical, HISTORICAL_POLL_MS)

    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (!expandedMetric || !expandedMode) {
      setExpandedMetrics(null)
      setExpandedError(null)
      return
    }

    if (expandedMode === 'historical' && expandedForecastMode !== 'off') {
      setExpandedError(null)
      return
    }

    const controller = new AbortController()

    const loadExpanded = async () => {
      try {
        const endpoint =
          expandedMode === 'live'
            ? `/api/live/metrics?window=${expandedTimeframe}`
            : `/api/history/metrics?window=${expandedTimeframe}`
        const response = await fetch(endpoint, {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(
            expandedMode === 'live'
              ? 'Failed to load live metric stream.'
              : 'Failed to load historical metrics.',
          )
        }

        const payload = (await response.json()) as ExpandedMetricsApiResponse
        setExpandedMetrics(payload.metrics)
        setExpandedError(null)
      } catch (loadError) {
        if (controller.signal.aborted) {
          return
        }

        const message =
          loadError instanceof Error
            ? loadError.message
            : expandedMode === 'live'
              ? 'Failed to load live metric stream.'
              : 'Failed to load historical metrics.'
        setExpandedError(message)
      }
    }

    void loadExpanded()
    const intervalId =
      expandedMode === 'live' ? window.setInterval(loadExpanded, LIVE_MODAL_POLL_MS) : null

    return () => {
      controller.abort()
      if (intervalId !== null) {
        window.clearInterval(intervalId)
      }
    }
  }, [expandedMetric, expandedMode, expandedTimeframe, expandedForecastMode])

  useEffect(() => {
    if (expandedMode !== 'historical' || expandedForecastMode === 'off' || !expandedMetric) {
      setExpandedForecastMetrics(null)
      setExpandedForecastContext(null)
      setIsForecastLoading(false)
      setExpandedForecastError(null)
      return
    }

    const controller = new AbortController()
    const requestedMode = expandedForecastMode

    const loadForecast = async () => {
      setIsForecastLoading(true)
      try {
        const response = await fetch(`/api/history/forecast?mode=${requestedMode}`, {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error('Failed to load forecast.')
        }

        const payload = (await response.json()) as ForecastApiResponse
        setExpandedForecastMetrics(payload.metrics)
        setExpandedForecastContext({
          enabled: true,
          modelFamily: 'xgboost',
          mode: requestedMode,
          modelPath: payload.source?.modelPath?.trim() || null,
          generatedAt: payload.generatedAt ? String(payload.generatedAt) : null,
          warning: payload.warning ? String(payload.warning) : null,
          predictionPointCount:
            expandedMetric === 'temperature'
              ? payload.metrics.temperature.predictionPoints.length
              : expandedMetric === 'humidity'
                ? payload.metrics.humidity.predictionPoints.length
                : payload.metrics.pressure.predictionPoints.length,
        })
        setExpandedForecastError(
          payload.warning ? String(payload.warning) : null,
        )
      } catch (loadError) {
        if (controller.signal.aborted) {
          return
        }

        const message =
          loadError instanceof Error ? loadError.message : 'Failed to load forecast.'
        setExpandedForecastMetrics(null)
        setExpandedForecastContext(null)
        setExpandedForecastError(message)
      } finally {
        if (!controller.signal.aborted) {
          setIsForecastLoading(false)
        }
      }
    }

    void loadForecast()

    return () => {
      controller.abort()
    }
  }, [expandedMode, expandedForecastMode, expandedMetric])

  useEffect(() => {
    if (!isMetricClosing) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setExpandedMetric(null)
      setExpandedMode(null)
      setIsMetricClosing(false)
    }, METRIC_MODAL_ANIMATION_MS)

    return () => window.clearTimeout(timeoutId)
  }, [isMetricClosing])

  const openExpandedMetric = useCallback(
    (metricId: MetricId, mode: 'live' | 'historical') => {
      if (historicalGeminiAbortRef.current) {
        historicalGeminiAbortRef.current.abort()
        historicalGeminiAbortRef.current = null
      }
      setIsHistoricalGeminiStreaming(false)
      setExpandedMetric(metricId)
      setExpandedMode(mode)
      setExpandedTimeframe(mode === 'historical' ? '3d' : '12h')
      setExpandedForecastMode('off')
      setExpandedForecastMetrics(null)
      setExpandedForecastContext(null)
      setExpandedForecastError(null)
      setExpandedHoverIndex(null)
      setIsPredictionFocusActive(false)
      setHoveredForecastPointIndexes([])
      setHoveredForecastRowKey(null)
      setHistoricalGeminiOpen(false)
      setHistoricalGeminiText('')
      setHistoricalGeminiError(null)
      setShowExpandedAxes(false)
      setIsMetricClosing(false)
      setExpandedMetrics(null)
      setExpandedError(null)
    },
    [],
  )

  const openOverviewModal = useCallback(() => {
    setIsOverviewModalOpen(true)
    setIsOverviewFormulaOpen(false)
  }, [])

  const closeOverviewModal = useCallback(() => {
    setIsOverviewModalOpen(false)
    setIsOverviewFormulaOpen(false)
  }, [])

  const closeExpandedMetric = useCallback(() => {
    if (!expandedMetric || isMetricClosing) {
      return
    }

    if (historicalGeminiAbortRef.current) {
      historicalGeminiAbortRef.current.abort()
      historicalGeminiAbortRef.current = null
    }
    setIsHistoricalGeminiStreaming(false)
    setHistoricalGeminiOpen(false)
    setIsMetricClosing(true)
  }, [expandedMetric, isMetricClosing])

  useEffect(() => {
    if (!isOverviewModalOpen) {
      return
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeOverviewModal()
      }
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isOverviewModalOpen, closeOverviewModal])

  useEffect(() => {
    if (!expandedMetric) {
      return
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeExpandedMetric()
      }
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expandedMetric, closeExpandedMetric])

  useEffect(() => {
    setExpandedHoverIndex(null)
    setHoveredForecastPointIndexes([])
    setHoveredForecastRowKey(null)
  }, [expandedMetric, expandedMode, expandedTimeframe, expandedForecastMode])

  const stopHistoricalGeminiStream = useCallback(() => {
    const controller = historicalGeminiAbortRef.current
    if (controller) {
      controller.abort()
      historicalGeminiAbortRef.current = null
    }
    setIsHistoricalGeminiStreaming(false)
  }, [])

  useEffect(() => {
    return () => {
      stopHistoricalGeminiStream()
    }
  }, [stopHistoricalGeminiStream])

  const latestObservationTime = useMemo(() => {
    if (!snapshotMetrics) {
      return null
    }

    const latest = snapshotMetrics.temperature.points.at(-1)
    if (!latest) {
      return null
    }

    return formatTimestamp(latest.time)
  }, [snapshotMetrics])

  const weatherOverview = useMemo(() => {
    const temp = snapshotMetrics?.temperature.latest ?? null
    const humi = snapshotMetrics?.humidity.latest ?? null
    const pres = snapshotMetrics?.pressure.latest ?? null
    const rainfallPoints = snapshotMetrics?.rainfall.points ?? []
    const rainfallRecent = maxRecentValue(rainfallPoints, OVERVIEW_RAIN_WINDOW_MS)
    const windSpeed = windSnapshot?.speed ?? null

    const temperatureComfort =
      temp === null || Number.isNaN(temp) ? null : clamp(100 - Math.abs(temp - 27) * 6, 0, 100)
    const humidityComfort =
      humi === null || Number.isNaN(humi) ? null : clamp(100 - Math.abs(humi - 55) * 2, 0, 100)
    const comfortScore = weightedAverage([
      { value: temperatureComfort, weight: 0.6 },
      { value: humidityComfort, weight: 0.4 },
    ])

    const pressureScore =
      pres === null || Number.isNaN(pres) ? null : clamp(100 - Math.abs(pres - 1013) * 1.5, 0, 100)

    const temperaturePoints = snapshotMetrics?.temperature.points ?? []
    const humidityPoints = snapshotMetrics?.humidity.points ?? []
    const pressurePoints = snapshotMetrics?.pressure.points ?? []

    const tempStability =
      temperaturePoints.length < 2
        ? null
        : stabilityFromDelta(averageDelta(temperaturePoints, 12), 0.35)
    const humiStability =
      humidityPoints.length < 2
        ? null
        : stabilityFromDelta(averageDelta(humidityPoints, 12), 1.2)
    const pressureStability =
      pressurePoints.length < 2
        ? null
        : stabilityFromDelta(averageDelta(pressurePoints, 12), 0.6)
    const stabilityScore = weightedAverage([
      { value: tempStability, weight: 0.45 },
      { value: humiStability, weight: 0.35 },
      { value: pressureStability, weight: 0.2 },
    ])

    const rainScore = rainScoreFromMm(rainfallRecent)
    const windScore = windScoreFromKnots(windSpeed)

    const compositeScore = weightedAverage([
      { value: comfortScore, weight: 0.4 },
      { value: pressureScore, weight: 0.15 },
      { value: stabilityScore, weight: 0.2 },
      { value: rainScore, weight: 0.15 },
      { value: windScore, weight: 0.1 },
    ])

    if (compositeScore === null) {
      return {
        score: null as number | null,
        status: null as OverviewStatus | null,
        chipClass: 'chip',
        rainfallRecent: null as number | null,
        rainScore: null as number | null,
        windScore: null as number | null,
      }
    }

    const score = Math.round(clamp(compositeScore, 0, 100))
    const status = mapScoreToStatus(score)

    return {
      score,
      status,
      chipClass: `chip ${statusChipClass(status)}`,
      rainfallRecent,
      rainScore,
      windScore,
    }
  }, [snapshotMetrics, windSnapshot])

  const quickMetrics = useMemo(() => {
    const temperature = snapshotMetrics?.temperature ?? null
    const humidity = snapshotMetrics?.humidity ?? null
    const pressure = snapshotMetrics?.pressure ?? null
    const rainfall = snapshotMetrics?.rainfall ?? null

    return [
      {
        metricId: 'temperature' as const,
        label: 'Temperature',
        value: formatMetricValue('temperature', temperature?.latest ?? null),
        unit: temperature?.unit ?? metricStyleConfig.temperature.fallbackUnit,
        delta: formatMetricDelta('temperature', temperature?.delta ?? null),
        note: metricNote('temperature', temperature?.latest ?? null),
        accent: metricStyleConfig.temperature.accent,
        bar: normalizeMeterValue(temperature),
      },
      {
        metricId: 'humidity' as const,
        label: 'Humidity',
        value: formatMetricValue('humidity', humidity?.latest ?? null),
        unit: humidity?.unit ?? metricStyleConfig.humidity.fallbackUnit,
        delta: formatMetricDelta('humidity', humidity?.delta ?? null),
        note: metricNote('humidity', humidity?.latest ?? null),
        accent: metricStyleConfig.humidity.accent,
        bar: normalizeMeterValue(humidity),
      },
      {
        metricId: 'pressure' as const,
        label: 'Pressure',
        value: formatMetricValue('pressure', pressure?.latest ?? null),
        unit: pressure?.unit ?? metricStyleConfig.pressure.fallbackUnit,
        delta: formatMetricDelta('pressure', pressure?.delta ?? null),
        note: metricNote('pressure', pressure?.latest ?? null),
        accent: metricStyleConfig.pressure.accent,
        bar: normalizeMeterValue(pressure),
      },
      {
        metricId: 'rainfall' as const,
        label: 'Rainfall',
        value: formatMetricValue('rainfall', rainfall?.latest ?? null),
        unit: rainfall?.unit ?? metricStyleConfig.rainfall.fallbackUnit,
        delta: formatMetricDelta('rainfall', rainfall?.delta ?? null),
        note: metricNote('rainfall', rainfall?.latest ?? null),
        accent: metricStyleConfig.rainfall.accent,
        bar: normalizeMeterValue(rainfall),
      },
    ]
  }, [snapshotMetrics])

  const overviewReadings = useMemo(
    () => [
      {
        label: 'Temperature',
        value: formatMetricValue('temperature', snapshotMetrics?.temperature.latest ?? null),
        unit: metricStyleConfig.temperature.fallbackUnit,
      },
      {
        label: 'Humidity',
        value: formatMetricValue('humidity', snapshotMetrics?.humidity.latest ?? null),
        unit: metricStyleConfig.humidity.fallbackUnit,
      },
      {
        label: 'Pressure',
        value: formatMetricValue('pressure', snapshotMetrics?.pressure.latest ?? null),
        unit: metricStyleConfig.pressure.fallbackUnit,
      },
      {
        label: 'Rainfall (last 1h max)',
        value: formatMetricValue('rainfall', weatherOverview.rainfallRecent ?? null),
        unit: metricStyleConfig.rainfall.fallbackUnit,
      },
      {
        label: 'Rain Score',
        value:
          weatherOverview.rainScore === null || Number.isNaN(weatherOverview.rainScore)
            ? '--'
            : String(Math.round(weatherOverview.rainScore)),
        unit: '/100',
      },
      {
        label: 'Wind Score',
        value:
          weatherOverview.windScore === null || Number.isNaN(weatherOverview.windScore)
            ? '--'
            : String(Math.round(weatherOverview.windScore)),
        unit: '/100',
      },
    ],
    [snapshotMetrics, weatherOverview.rainfallRecent, weatherOverview.rainScore, weatherOverview.windScore],
  )

  const trendCards = useMemo(() => {
    return metricOrder.map((metricId) => {
      const metric = historicalMetrics?.[metricId] ?? null
      const points = metric ? metric.points : []
      const previewPoints = resamplePoints(points, 64)
      const geometry = buildChartGeometry(previewPoints, 200, 80, 4)

      return {
        metricId,
        label: metric?.label ?? metricStyleConfig[metricId].defaultLabel,
        value: formatMetricValue(metricId, metric?.latest ?? null),
        unit: metric?.unit ?? metricStyleConfig[metricId].fallbackUnit,
        range: rangeLabel(
          metricId,
          points,
          metric?.unit ?? metricStyleConfig[metricId].fallbackUnit,
          'historical',
        ),
        accent: metricStyleConfig[metricId].accent,
        geometry,
      }
    })
  }, [historicalMetrics])

  const windDirectionNow = windSnapshot?.direction ?? null
  const windCompassStyle: CSSProperties = useMemo(() => {
    if (windDirectionNow === null || Number.isNaN(windDirectionNow)) {
      return { '--wind-angle': '0deg' } as CSSProperties
    }

    const normalized = ((windDirectionNow % 360) + 360) % 360
    return { '--wind-angle': `${normalized}deg` } as CSSProperties
  }, [windDirectionNow])
  const windSpeedValue =
    windSnapshot?.speed === null ||
    windSnapshot?.speed === undefined ||
    Number.isNaN(windSnapshot.speed)
      ? '--'
      : windSnapshot.speed.toFixed(1)
  const windSpeedUnit = windSnapshot?.speedUnit ?? 'knots'
  const windDirectionLabel = windSnapshot?.cardinal ?? '--'
  const windDirectionDegrees =
    windDirectionNow === null || Number.isNaN(windDirectionNow)
      ? null
      : Math.round(((windDirectionNow % 360) + 360) % 360)
  const windDirectionDegreesLabel =
    windDirectionDegrees === null ? '-- deg' : `${windDirectionDegrees} deg`
  const windDirectionText =
    windDirectionDegrees === null
      ? 'Direction unavailable'
      : `${windDirectionDegreesLabel} (${windDirectionLabel})`
  const windStationLabel = windSnapshot?.stationId ? `Station ${windSnapshot.stationId}` : 'Station unavailable'
  const windUpdatedLabel = windSnapshot?.timestamp
    ? `Updated ${formatTimestamp(windSnapshot.timestamp)}`
    : 'Waiting for data.gov feed'
  const windChip = useMemo(() => {
    if (!windSnapshot?.available) {
      return {
        label: 'No feed',
        className: 'chip',
      }
    }

    const speed = windSnapshot.speed
    if (speed === null || Number.isNaN(speed)) {
      return {
        label: 'Directional',
        className: 'chip chip-good',
      }
    }

    if (speed >= 18) {
      return {
        label: 'Strong',
        className: 'chip chip-warn',
      }
    }

    if (speed >= 8) {
      return {
        label: 'Breezy',
        className: 'chip chip-good',
      }
    }

    return {
      label: 'Light',
      className: 'chip chip-good',
    }
  }, [windSnapshot])

  const expandedFallbackMetricData =
    expandedMetric === null
      ? null
      : expandedMode === 'historical'
        ? expandedMetric === 'rainfall'
          ? null
          : historicalMetrics?.[expandedMetric] ?? null
        : snapshotMetrics?.[expandedMetric] ?? null
  const expandedMetricData = expandedMetric
    ? expandedMetrics?.[expandedMetric] ?? expandedFallbackMetricData ?? null
    : null
  const isHistoricalForecastActive =
    expandedMode === 'historical' && expandedForecastMode !== 'off'
  const geminiInsightScopeLabel = isHistoricalForecastActive
    ? `Analyzing current chart + XGBoost (${expandedForecastMode}) predictions...`
    : 'Analyzing the currently visible dashboard trend...'
  const expandedForecastMetricData =
    expandedMetric && expandedMetric !== 'rainfall' && isHistoricalForecastActive
      ? expandedForecastMetrics?.[expandedMetric] ?? null
      : null
  const expandedMetricKey: MetricId =
    expandedForecastMetricData?.key ?? expandedMetricData?.key ?? expandedMetric ?? 'temperature'
  const expandedMetricLabel =
    expandedForecastMetricData?.label ??
    expandedMetricData?.label ??
    metricStyleConfig[expandedMetricKey].defaultLabel
  const expandedMetricUnit =
    expandedForecastMetricData?.unit ??
    expandedMetricData?.unit ??
    metricStyleConfig[expandedMetricKey].fallbackUnit
  const activeTimeframeOptions =
    expandedMode === 'live' ? liveTimeframeOptions : historicalTimeframeOptions
  const isTimeframeLockedByForecast = isHistoricalForecastActive

  useEffect(() => {
    if (isHistoricalForecastActive) {
      return
    }

    setIsPredictionFocusActive(false)
    setHoveredForecastPointIndexes([])
    setHoveredForecastRowKey(null)
  }, [isHistoricalForecastActive])

  const expandedPoints = useMemo(() => {
    if (isHistoricalForecastActive) {
      if (expandedForecastMetricData) {
        return expandedForecastMetricData.points
      }

      return expandedMetricData?.points ?? []
    }

    if (!expandedMetricData) {
      return []
    }

    if (expandedMode === 'historical') {
      return expandedMetricData.points
    }

    return filterByTimeframe(expandedMetricData.points, expandedTimeframe as LiveTimeframe)
  }, [
    expandedForecastMetricData,
    expandedMetricData,
    expandedMode,
    expandedTimeframe,
    isHistoricalForecastActive,
  ])

  const expandedPredictionPoints = useMemo(() => {
    if (!isHistoricalForecastActive) {
      return []
    }

    return expandedForecastMetricData?.predictionPoints ?? []
  }, [expandedForecastMetricData, isHistoricalForecastActive])

  const expandedHistoricalDisplayPoints = useMemo(
    () => resamplePoints(expandedPoints, isHistoricalForecastActive ? 360 : 500),
    [expandedPoints, isHistoricalForecastActive],
  )
  const expandedPredictionDisplayPoints = useMemo(
    () => (isHistoricalForecastActive ? expandedPredictionPoints : []),
    [expandedPredictionPoints, isHistoricalForecastActive],
  )
  const isPredictionFocusChartActive =
    isHistoricalForecastActive &&
    isPredictionFocusActive &&
    expandedPredictionDisplayPoints.length > 0
  const expandedDisplayPoints = useMemo(
    () =>
      isPredictionFocusChartActive
        ? expandedPredictionDisplayPoints
        : [...expandedHistoricalDisplayPoints, ...expandedPredictionDisplayPoints],
    [
      expandedHistoricalDisplayPoints,
      expandedPredictionDisplayPoints,
      isPredictionFocusChartActive,
    ],
  )
  const predictionDisplayStartIndex = isPredictionFocusChartActive
    ? 0
    : expandedHistoricalDisplayPoints.length
  const expandedFirstPoint = expandedDisplayPoints[0]
  const expandedLastPoint = expandedDisplayPoints[expandedDisplayPoints.length - 1]

  const liveDelta = useMemo(() => {
    if (expandedMode !== 'live' || expandedPoints.length < 2) {
      return null
    }

    const first = expandedPoints[0]
    const last = expandedPoints[expandedPoints.length - 1]
    if (!first || !last) {
      return null
    }

    return last.value - first.value
  }, [expandedMode, expandedPoints])

  const expandedGeometry = useMemo(
    () =>
      buildChartGeometry(
        expandedDisplayPoints,
        1000,
        420,
        showExpandedAxes ? 64 : 28,
      ),
    [expandedDisplayPoints, showExpandedAxes],
  )
  const expandedHistoricalPath = useMemo(() => {
    if (!expandedGeometry) {
      return ''
    }

    if (!isHistoricalForecastActive || expandedPredictionDisplayPoints.length === 0) {
      return expandedGeometry.linePath
    }

    if (isPredictionFocusChartActive) {
      return ''
    }

    return buildLinePathFromChartPoints(
      expandedGeometry.points.slice(0, predictionDisplayStartIndex),
    )
  }, [
    expandedGeometry,
    expandedPredictionDisplayPoints.length,
    isHistoricalForecastActive,
    isPredictionFocusChartActive,
    predictionDisplayStartIndex,
  ])
  const expandedPredictionPath = useMemo(() => {
    if (
      !expandedGeometry ||
      !isHistoricalForecastActive ||
      expandedPredictionDisplayPoints.length === 0
    ) {
      return ''
    }

    if (isPredictionFocusChartActive) {
      return expandedGeometry.linePath
    }

    const startIndex = predictionDisplayStartIndex > 0 ? predictionDisplayStartIndex - 1 : 0
    return buildLinePathFromChartPoints(expandedGeometry.points.slice(startIndex))
  }, [
    expandedGeometry,
    expandedPredictionDisplayPoints.length,
    isHistoricalForecastActive,
    isPredictionFocusChartActive,
    predictionDisplayStartIndex,
  ])
  const expandedHistoricalDot =
    isPredictionFocusChartActive
      ? null
      : expandedGeometry && predictionDisplayStartIndex > 0
      ? expandedGeometry.points[predictionDisplayStartIndex - 1]
      : expandedGeometry?.dot
  const expandedPredictionDot =
    expandedGeometry && expandedPredictionDisplayPoints.length > 0
      ? expandedGeometry.points[expandedGeometry.points.length - 1]
      : null
  const predictionAnimationKey = useMemo(() => {
    if (expandedPredictionDisplayPoints.length === 0) {
      return 'none'
    }

    const first = expandedPredictionDisplayPoints[0]?.time ?? 'start'
    const last =
      expandedPredictionDisplayPoints[expandedPredictionDisplayPoints.length - 1]?.time ??
      'end'

    return `${expandedForecastMode}-${expandedPredictionDisplayPoints.length}-${first}-${last}`
  }, [expandedForecastMode, expandedPredictionDisplayPoints])
  const chartAnimationKey = useMemo(() => {
    if (!isHistoricalForecastActive) {
      return 'base'
    }

    const first = expandedDisplayPoints[0]?.time ?? 'start'
    const last = expandedDisplayPoints[expandedDisplayPoints.length - 1]?.time ?? 'end'
    return `${expandedForecastMode}-${isPredictionFocusChartActive ? 'focus' : 'full'}-${expandedDisplayPoints.length}-${first}-${last}`
  }, [
    expandedDisplayPoints,
    expandedForecastMode,
    isHistoricalForecastActive,
    isPredictionFocusChartActive,
  ])
  const expandedMin = expandedGeometry?.min ?? null
  const expandedMax = expandedGeometry?.max ?? null
  const expandedPointCount = isHistoricalForecastActive
    ? expandedPoints.length + expandedPredictionPoints.length
    : expandedPoints.length
  const forecastPeriodLabel = useMemo(() => {
    if (!isHistoricalForecastActive || expandedPredictionPoints.length === 0) {
      return null
    }

    const first = expandedPredictionPoints[0]
    const last = expandedPredictionPoints[expandedPredictionPoints.length - 1]
    if (!first || !last) {
      return null
    }

    if (expandedForecastMode === 'weekly') {
      const firstDay = formatForecastDay(first.time)
      const lastDay = formatForecastDay(last.time)
      return firstDay === lastDay ? firstDay : `${firstDay} to ${lastDay}`
    }

    return `${formatAxisTime(first.time)} to ${formatAxisTime(last.time)}`
  }, [expandedForecastMode, expandedPredictionPoints, isHistoricalForecastActive])
  const weeklyForecastRows = useMemo(() => {
    if (!isHistoricalForecastActive || expandedForecastMode !== 'weekly') {
      return [] as Array<{
        dayKey: string
        day: string
        average: number
        min: number
        max: number
        pointIndexes: number[]
      }>
    }

    const dailyBuckets = new Map<
      string,
      { dayKey: string; day: string; values: number[]; pointIndexes: number[] }
    >()

    for (const [pointIndex, point] of expandedPredictionPoints.entries()) {
      const timestamp = new Date(point.time)
      if (Number.isNaN(timestamp.getTime())) {
        continue
      }

      const key = timestamp.toISOString().slice(0, 10)
      const bucket = dailyBuckets.get(key)
      if (bucket) {
        bucket.values.push(point.value)
        bucket.pointIndexes.push(pointIndex)
      } else {
        dailyBuckets.set(key, {
          dayKey: key,
          day: formatForecastDay(point.time),
          values: [point.value],
          pointIndexes: [pointIndex],
        })
      }
    }

    return Array.from(dailyBuckets.values())
      .map((bucket) => {
        const min = Math.min(...bucket.values)
        const max = Math.max(...bucket.values)
        const sum = bucket.values.reduce((total, value) => total + value, 0)
        const average = bucket.values.length > 0 ? sum / bucket.values.length : 0

        return {
          dayKey: bucket.dayKey,
          day: bucket.day,
          average,
          min,
          max,
          pointIndexes: bucket.pointIndexes,
        }
      })
      .slice(0, 7)
  }, [expandedForecastMode, expandedPredictionPoints, isHistoricalForecastActive])
  const hourlyForecastRows = useMemo(() => {
    if (!isHistoricalForecastActive || expandedForecastMode !== 'hourly') {
      return [] as Array<{ key: string; time: string; value: number; pointIndexes: number[] }>
    }

    return expandedPredictionPoints.map((point, pointIndex) => ({
      key: `${point.time}-${pointIndex}`,
      time: formatForecastHour(point.time),
      value: point.value,
      pointIndexes: [pointIndex],
    }))
  }, [expandedForecastMode, expandedPredictionPoints, isHistoricalForecastActive])

  const expandedYAxisTicks = useMemo(() => {
    if (!expandedGeometry) {
      return []
    }

    const tickCount = Math.max(2, Y_AXIS_TICK_COUNT)
    const ticks: Array<{ key: number; y: number; value: number }> = []
    const range = expandedGeometry.max - expandedGeometry.min
    const chartHeight = expandedGeometry.height - expandedGeometry.padding * 2

    for (let i = 0; i <= tickCount; i += 1) {
      const ratio = i / tickCount
      const y = expandedGeometry.padding + ratio * chartHeight
      const value =
        range === 0
          ? expandedGeometry.max
          : expandedGeometry.max - ratio * range

      ticks.push({ key: i, y, value })
    }

    return ticks
  }, [expandedGeometry])

  const expandedHoverPoint =
    expandedGeometry &&
    expandedHoverIndex !== null &&
    expandedHoverIndex >= 0 &&
    expandedHoverIndex < expandedGeometry.points.length
      ? expandedGeometry.points[expandedHoverIndex]
      : null
  const expandedHoverIsPrediction =
    isHistoricalForecastActive &&
    expandedPredictionDisplayPoints.length > 0 &&
    expandedHoverIndex !== null &&
    (isPredictionFocusChartActive || expandedHoverIndex >= predictionDisplayStartIndex)

  const highlightedPredictionChartPoints = useMemo(() => {
    if (
      !expandedGeometry ||
      hoveredForecastPointIndexes.length === 0 ||
      !isHistoricalForecastActive ||
      expandedPredictionDisplayPoints.length === 0
    ) {
      return [] as Array<{ x: number; y: number; time: string }>
    }

    const chartPoints: Array<{ x: number; y: number; time: string }> = []
    const seen = new Set<number>()

    for (const predictionPointIndex of hoveredForecastPointIndexes) {
      if (
        predictionPointIndex < 0 ||
        predictionPointIndex >= expandedPredictionDisplayPoints.length
      ) {
        continue
      }

      const chartPointIndex = isPredictionFocusChartActive
        ? predictionPointIndex
        : predictionDisplayStartIndex + predictionPointIndex

      if (
        chartPointIndex < 0 ||
        chartPointIndex >= expandedGeometry.points.length ||
        seen.has(chartPointIndex)
      ) {
        continue
      }

      seen.add(chartPointIndex)
      const chartPoint = expandedGeometry.points[chartPointIndex]
      chartPoints.push({ x: chartPoint.x, y: chartPoint.y, time: chartPoint.time })
    }

    return chartPoints
  }, [
    expandedGeometry,
    expandedPredictionDisplayPoints.length,
    hoveredForecastPointIndexes,
    isHistoricalForecastActive,
    isPredictionFocusChartActive,
    predictionDisplayStartIndex,
  ])

  const expandedTooltipStyle = useMemo(() => {
    if (!expandedGeometry || !expandedHoverPoint) {
      return undefined
    }

    return {
      left: `${(expandedHoverPoint.x / expandedGeometry.width) * 100}%`,
      top: `${(expandedHoverPoint.y / expandedGeometry.height) * 100}%`,
    }
  }, [expandedGeometry, expandedHoverPoint])

  const historicalInsightPayload = useMemo<HistoricalInsightRequestPayload | null>(() => {
    if (expandedMode !== 'historical') {
      return null
    }

    const timeframe = expandedTimeframe as HistoricalTimeframe
    const historicalSampledPoints = resamplePoints(expandedPoints, 220)
    const predictionSampledPoints = resamplePoints(expandedPredictionPoints, 140)
    const forecastContext: HistoricalInsightForecastContext =
      expandedForecastMode === 'off'
        ? {
            enabled: false,
            modelFamily: 'xgboost',
            mode: 'off',
            modelPath: null,
            generatedAt: null,
            warning: null,
            predictionPointCount: 0,
          }
        : {
            enabled: true,
            modelFamily: 'xgboost',
            mode: expandedForecastContext?.mode ?? expandedForecastMode,
            modelPath: expandedForecastContext?.modelPath ?? null,
            generatedAt: expandedForecastContext?.generatedAt ?? null,
            warning: expandedForecastContext?.warning ?? expandedForecastError ?? null,
            predictionPointCount: expandedPredictionPoints.length,
          }

    return {
      metric: {
        id: expandedMetricKey,
        label: expandedMetricLabel,
        unit: expandedMetricUnit,
      },
      window: {
        timeframe,
        forecastMode: expandedForecastMode,
      },
      location: 'Ang Mo Kio',
      historical: {
        pointCount: expandedPoints.length,
        points: historicalSampledPoints,
        summary: summarizeTrendPoints(expandedPoints),
      },
      prediction: {
        pointCount: expandedPredictionPoints.length,
        points: predictionSampledPoints,
        summary: summarizeTrendPoints(expandedPredictionPoints),
      },
      assistantContext: {
        role: 'weather-station-operator-assistant',
        chartType: 'time-series',
        forecast: forecastContext,
      },
    }
  }, [
    expandedMode,
    expandedTimeframe,
    expandedPoints,
    expandedPredictionPoints,
    expandedMetricKey,
    expandedMetricLabel,
    expandedMetricUnit,
    expandedForecastMode,
    expandedForecastContext,
    expandedForecastError,
  ])

  const requestHistoricalGeminiInsight = useCallback(async () => {
    if (!historicalInsightPayload || isHistoricalGeminiStreaming) {
      return
    }

    stopHistoricalGeminiStream()

    const controller = new AbortController()
    historicalGeminiAbortRef.current = controller
    setIsHistoricalGeminiStreaming(true)
    setHistoricalGeminiText('')
    setHistoricalGeminiError(null)

    try {
      const response = await fetch('/api/gemini/historical-insights/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(historicalInsightPayload),
        signal: controller.signal,
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error ?? 'Gemini historical insight failed.')
      }

      if (!response.body) {
        throw new Error('Streaming response is unavailable.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        if (value) {
          fullText += decoder.decode(value, { stream: true })
          setHistoricalGeminiText(fullText)
        }
      }

      fullText += decoder.decode()
      if (fullText) {
        setHistoricalGeminiText(fullText)
      }

      if (!fullText.trim()) {
        setHistoricalGeminiError('No insight was returned.')
      }
    } catch (streamError) {
      if (controller.signal.aborted) {
        return
      }

      const message =
        streamError instanceof Error
          ? streamError.message
          : 'Gemini historical insight failed.'
      setHistoricalGeminiError(message)
    } finally {
      if (!controller.signal.aborted) {
        setIsHistoricalGeminiStreaming(false)
      }
      if (historicalGeminiAbortRef.current === controller) {
        historicalGeminiAbortRef.current = null
      }
    }
  }, [
    historicalInsightPayload,
    isHistoricalGeminiStreaming,
    stopHistoricalGeminiStream,
  ])

  const openHistoricalGeminiPopup = useCallback(() => {
    setHistoricalGeminiOpen(true)
    void requestHistoricalGeminiInsight()
  }, [requestHistoricalGeminiInsight])

  const closeHistoricalGeminiPopup = useCallback(() => {
    stopHistoricalGeminiStream()
    setHistoricalGeminiOpen(false)
    setHistoricalGeminiText('')
    setHistoricalGeminiError(null)
  }, [stopHistoricalGeminiStream])

  const startNewConversation = () => {
    setMessages([defaultGreeting])
    setError(null)
    setInput('')
  }

  const sendToGemini = async () => {
    const trimmed = input.trim()
    if (!trimmed || isSending) {
      return
    }

    setMessages((current) => [...current, { role: 'user', text: trimmed }])
    setInput('')
    setIsSending(true)
    setError(null)

    try {
      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error ?? 'Gemini request failed.')
      }

      const payload = await response.json()
      const text = String(payload?.text ?? '').trim() || 'No response received.'
      setMessages((current) => [...current, { role: 'assistant', text }])
    } catch (sendError) {
      const message =
        sendError instanceof Error ? sendError.message : 'Gemini request failed.'
      setError(message)
    } finally {
      setIsSending(false)
    }
  }

  const setForecastTableHover = useCallback(
    (rowKey: string, pointIndexes: number[]) => {
      setHoveredForecastRowKey(rowKey)
      setHoveredForecastPointIndexes(pointIndexes)

      const [firstPointIndex] = pointIndexes
      if (firstPointIndex === undefined) {
        setExpandedHoverIndex(null)
        return
      }

      setExpandedHoverIndex(
        isPredictionFocusChartActive
          ? firstPointIndex
          : predictionDisplayStartIndex + firstPointIndex,
      )
    },
    [isPredictionFocusChartActive, predictionDisplayStartIndex],
  )

  const clearForecastTableHover = useCallback(() => {
    setHoveredForecastRowKey(null)
    setHoveredForecastPointIndexes([])
    setExpandedHoverIndex(null)
  }, [])

  const handleExpandedChartMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!expandedGeometry) {
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    const xInSvg = ((event.clientX - bounds.left) / bounds.width) * expandedGeometry.width

    const relative = (xInSvg - expandedGeometry.padding) /
      (expandedGeometry.width - expandedGeometry.padding * 2)

    const clamped = Math.max(0, Math.min(1, relative))
    const pointIndex = Math.round(clamped * (expandedGeometry.points.length - 1))
    setExpandedHoverIndex(pointIndex)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon" aria-hidden="true">
            <svg className="brand-icon-svg" viewBox="0 0 46 46" role="presentation">
              <circle className="brand-icon-orbit" cx="23" cy="23" r="19.4" />
              <circle className="brand-icon-core" cx="23" cy="23" r="15.6" />
              <line className="brand-icon-horizon" x1="11.2" y1="28.7" x2="34.8" y2="28.7" />
              <circle className="brand-icon-sun" cx="14.4" cy="13.8" r="3.7" />
              <line className="brand-icon-sun-ray" x1="14.4" y1="8.1" x2="14.4" y2="6.7" />
              <line className="brand-icon-sun-ray" x1="18.3" y1="13.8" x2="19.7" y2="13.8" />
              <line className="brand-icon-sun-ray" x1="10.5" y1="13.8" x2="9.1" y2="13.8" />
              <line className="brand-icon-sun-ray" x1="17.2" y1="10.9" x2="18.2" y2="9.9" />
              <path
                className="brand-icon-cloud"
                d="M13.8 24.2c0-2 1.6-3.7 3.7-3.7 1.2 0 2.3.6 3 1.6.7-1 1.8-1.6 3.1-1.6 2.1 0 3.9 1.7 3.9 3.8 1.5.2 2.6 1.4 2.6 2.9 0 1.7-1.4 3.1-3.1 3.1H17c-1.8 0-3.2-1.4-3.2-3.2 0-1.3.8-2.4 2-2.9z"
              />
              <path className="brand-icon-rain" d="M18 30.7l-1.2 2.1M22 30.7l-1.2 2.1M26 30.7l-1.2 2.1" />
              <line className="brand-icon-mast" x1="23" y1="13.2" x2="23" y2="33.5" />
              <line className="brand-icon-arm" x1="23" y1="16.1" x2="31.8" y2="16.1" />
              <path className="brand-icon-vane" d="M31.8 16.1l-3.9-2.2v4.4z" />
              <circle className="brand-icon-pivot" cx="23" cy="16.1" r="1.3" />
              <path
                className="brand-icon-wave"
                d="M9.4 35.1c1.7 0 1.7-1.3 3.4-1.3s1.7 1.3 3.4 1.3 1.7-1.3 3.4-1.3 1.7 1.3 3.4 1.3 1.7-1.3 3.4-1.3 1.7 1.3 3.4 1.3"
              />
            </svg>
          </div>
          <div className="brand-text">
            <p className="eyebrow">Weather Station</p>
            <h1>Nanyang Polytechnic - Ang Mo Kio</h1>
            <p className="subtle">
              Live sync {latestObservationTime ? `- ${latestObservationTime}` : '- Loading...'}
            </p>
          </div>
        </div>
        <div className="topbar-meta">
          <div className="meta-block">
            <span className="meta-label">Local Time</span>
            <span className="meta-value">{localTime}</span>
          </div>
          <div className="status-pill">
            <span className="status-dot" />
            Online
          </div>
        </div>
      </header>

      {snapshotError && <div className="history-error">{snapshotError}</div>}
      {historicalError && <div className="history-error">{historicalError}</div>}

      <main className="dashboard-grid">
        <button
          type="button"
          className="card summary-card summary-card-button"
          onClick={openOverviewModal}
        >
          <div className="card-header">
            <div>
              <p className="eyebrow">Station Status</p>
              <h2>Weather Overview</h2>
            </div>
            <span className={weatherOverview.chipClass}>
              {weatherOverview.status ?? 'Loading'}
            </span>
          </div>
          <div className="summary-body">
            <div className="summary-ring">
              <div className="summary-core">
                <div className="summary-score">
                  {weatherOverview.score === null ? '--' : weatherOverview.score}
                </div>
                <div className="summary-status">
                  {weatherOverview.status ?? 'Loading'}
                </div>
              </div>
            </div>
            <div className="summary-hint">Tap to view details</div>
          </div>
        </button>

        <section className="card metrics-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Live Snapshot</p>
              <h2>Sensor Readings</h2>
            </div>
            <span className="chip">Calibrated</span>
          </div>
          <div className="metrics-grid">
            {quickMetrics.map((metric) => (
              <button
                type="button"
                className="mini-card mini-card-button"
                key={metric.label}
                style={accentStyle(metric.accent)}
                onClick={() => openExpandedMetric(metric.metricId, 'live')}
                aria-label={`Open live ${metric.label.toLowerCase()} chart`}
              >
                <div className="mini-top">
                  <span className="mini-label">{metric.label}</span>
                  <span className={`mini-trend ${trendClassFromDelta(
                    metric.delta === '--' || metric.delta === 'Light'
                      ? null
                      : Number(metric.delta),
                  )}`}>
                    {metric.delta}
                  </span>
                </div>
                <div className="mini-value">
                  {metric.value} <span>{metric.unit}</span>
                </div>
                <p className="mini-note">{metric.note}</p>
                <div className="mini-meter" style={meterStyle(metric.bar)}>
                  <span />
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="card wind-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Wind Focus</p>
              <h2>Direction Compass</h2>
            </div>
            <span className={windChip.className}>
              {windChip.label}
            </span>
          </div>
          <div className="wind-wrap">
            <div className="wind-compass" style={windCompassStyle}>
              <span className="wind-north-marker">N</span>
              <span className="wind-east-marker">E</span>
              <span className="wind-south-marker">S</span>
              <span className="wind-west-marker">W</span>
              <div className="wind-tick-ring" aria-hidden="true" />
              <div className="wind-crosshair" aria-hidden="true" />
              <div className="wind-arrow" aria-hidden="true" />
              <div className="wind-ring">
                <div className="wind-core">
                  <span className="wind-cardinal">{windDirectionLabel}</span>
                  <span className="wind-degree">{windDirectionDegreesLabel}</span>
                  <span className="wind-speed">{windSpeedValue}</span>
                  <span className="wind-speed-unit">{windSpeedUnit}</span>
                </div>
              </div>
            </div>
            <div className="wind-readout">
              <span className="wind-sub">{windDirectionText}</span>
              <span className="wind-sub">{windStationLabel}</span>
              <span className="wind-sub">{windUpdatedLabel}</span>
            </div>
          </div>
        </section>

        <div className="section-header">
          <p className="eyebrow">Historical Data</p>
          <div className="section-line" aria-hidden="true" />
        </div>

        {trendCards.map((metric, index) => (
          <button
            type="button"
            className="card trend-card trend-card-button"
            key={metric.metricId}
            style={accentStyle(metric.accent)}
            onClick={() => openExpandedMetric(metric.metricId, 'historical')}
          >
            <div className="trend-header">
              <div>
                <p className="eyebrow">Last 3 days</p>
                <h3>{metric.label}</h3>
              </div>
              <div className="trend-value">
                {metric.value} <span>{metric.unit}</span>
              </div>
            </div>
            <svg
              className="sparkline"
              viewBox="0 0 200 80"
              role="img"
              aria-label={`${metric.label} trend`}
            >
              <defs>
                <linearGradient id={`spark-${index}`} x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.7" />
                </linearGradient>
              </defs>
              {metric.geometry ? (
                <>
                  <path
                    className="sparkline-area"
                    d={metric.geometry.areaPath}
                    fill={`url(#spark-${index})`}
                  />
                  <path className="sparkline-line" d={metric.geometry.linePath} />
                  <circle
                    className="sparkline-dot"
                    cx={metric.geometry.dot.x}
                    cy={metric.geometry.dot.y}
                    r="4"
                  />
                </>
              ) : (
                <path className="sparkline-line" d="M4 40 L196 40" />
              )}
            </svg>
            <div className="trend-footer">{metric.range}</div>
          </button>
        ))}
      </main>

      <footer className="dashboard-footer">
        <div className="footer-left">
          <span className="footer-dot" />
          Live metrics powered by sensor_data + data.gov.sg (rainfall/wind). Historical metrics powered by historical_data + sensor_data.
        </div>
        <div className="footer-right">Weather Station UI</div>
      </footer>

      {isOverviewModalOpen && (
        <div className="overview-modal" role="dialog" aria-modal="true">
          <button
            type="button"
            className="overview-modal-backdrop"
            aria-label="Close weather overview details"
            onClick={closeOverviewModal}
          />
          <section className="overview-modal-panel">
            <div className="overview-modal-header">
              <div className="overview-modal-title">
                <div className="overview-title-row">
                  <h3>Weather Overview</h3>
                  <button
                    type="button"
                    className="overview-help-button"
                    aria-expanded={isOverviewFormulaOpen}
                    aria-label="Show weather overview formula"
                    onClick={() =>
                      setIsOverviewFormulaOpen((current) => !current)
                    }
                  >
                    ?
                  </button>
                </div>
                <p>Composite score from the latest live readings.</p>
              </div>
              <button
                type="button"
                className="metric-close"
                onClick={closeOverviewModal}
              >
                Close
              </button>
            </div>

            {isOverviewFormulaOpen && (
              <div className="overview-formula">
                <p>
                  Formula:{' '}
                  <strong>
                    0.40 * Comfort + 0.15 * Pressure + 0.20 * Stability + 0.15 * Rain + 0.10 * Wind
                  </strong>
                </p>
                <p>
                  Comfort blends temperature and humidity, pressure rewards barometric conditions, stability rewards smooth recent changes, rain comes from the latest 1-hour rainfall intensity, and wind comes from live wind speed.
                </p>
              </div>
            )}

            <div className="overview-modal-content">
              <div className="overview-left">
                <div className="overview-orbit">
                  <div className="overview-orbit-pulse" />
                  <div className="overview-orbit-core">
                    <div className="overview-score">
                      {weatherOverview.score === null ? '--' : weatherOverview.score}
                    </div>
                    <div className="overview-status">
                      {weatherOverview.status ?? 'Loading'}
                    </div>
                  </div>
                </div>
              </div>
              <div className="overview-right">
                <h4>Readings Used</h4>
                {overviewReadings.map((reading) => (
                  <div key={reading.label} className="overview-reading-row">
                    <span>{reading.label}</span>
                    <strong>
                      {reading.value} {reading.unit}
                    </strong>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {expandedMetric && (
        <div
          className={`metric-modal ${isMetricClosing ? 'closing' : ''}`}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="metric-modal-backdrop"
            aria-label="Close expanded metric"
            onClick={closeExpandedMetric}
          />
          <section
            className="metric-modal-panel"
            style={accentStyle(metricStyleConfig[expandedMetricKey].accent)}
          >
            <div className="metric-modal-header">
              <div>
                <p className="eyebrow">
                  {expandedMode === 'live' ? 'Live Metric' : 'Historical Metric'}
                </p>
                <h3>{expandedMetricLabel}</h3>
                <p className="metric-modal-subtitle">
                  {rangeLabel(
                    expandedMetricKey,
                    expandedPoints,
                    expandedMetricUnit,
                    expandedMode === 'live' ? 'live' : 'historical',
                  )}
                </p>
              </div>
              <div className="metric-modal-actions">
                <div className="timeframe-group" role="tablist" aria-label="Timeframe selector">
                  {activeTimeframeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`timeframe-chip ${
                        expandedTimeframe === option.value ? 'active' : ''
                      } ${isTimeframeLockedByForecast ? 'disabled' : ''}`}
                      disabled={isTimeframeLockedByForecast}
                      aria-disabled={isTimeframeLockedByForecast}
                      title={
                        isTimeframeLockedByForecast
                          ? 'Forecast mode controls historical range.'
                          : undefined
                      }
                      onClick={() => setExpandedTimeframe(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {expandedMode === 'historical' && (
                  <label className="forecast-select">
                    <span>Show predictions/forecast</span>
                    <select
                      value={expandedForecastMode}
                      onChange={(event) => {
                        const mode = event.target.value as ForecastMode
                        setExpandedForecastMode(mode)
                        setExpandedHoverIndex(null)
                        setHoveredForecastPointIndexes([])
                        setHoveredForecastRowKey(null)
                        if (mode === 'weekly') {
                          setExpandedTimeframe('all')
                        } else if (mode === 'hourly') {
                          setExpandedTimeframe('1d')
                        } else {
                          setIsPredictionFocusActive(false)
                        }
                      }}
                    >
                      <option value="off">Off</option>
                      <option value="hourly">Hourly (today)</option>
                      <option value="weekly">Weekly (next 7 days)</option>
                    </select>
                  </label>
                )}
                {GEMINI_UI_ENABLED && expandedMode === 'historical' && (
                  <button
                    type="button"
                    className="metric-gemini-trigger"
                    onClick={openHistoricalGeminiPopup}
                    disabled={isHistoricalGeminiStreaming || expandedPoints.length === 0}
                  >
                    {isHistoricalGeminiStreaming ? 'Gemini...' : 'Use Gemini (Chart + XGB)'}
                  </button>
                )}
                {expandedMode === 'historical' && isHistoricalForecastActive && (
                  <button
                    type="button"
                    className={`prediction-focus-toggle${
                      isPredictionFocusChartActive ? ' active' : ''
                    }`}
                    onClick={() => {
                      setIsPredictionFocusActive((current) => {
                        const next = !current
                        if (next) {
                          setShowExpandedAxes(true)
                        }
                        return next
                      })
                      setExpandedHoverIndex(null)
                      setHoveredForecastPointIndexes([])
                      setHoveredForecastRowKey(null)
                    }}
                    disabled={expandedPredictionPoints.length === 0}
                    aria-pressed={isPredictionFocusChartActive}
                  >
                    {isPredictionFocusChartActive ? 'Show full trend' : 'Focus on predictions'}
                  </button>
                )}
                <label className="axis-toggle">
                  <input
                    type="checkbox"
                    checked={showExpandedAxes}
                    onChange={(event) => setShowExpandedAxes(event.target.checked)}
                  />
                  Show axes
                </label>
                <button
                  type="button"
                  className="metric-close"
                  onClick={closeExpandedMetric}
                >
                  Close
                </button>
              </div>
            </div>

            {GEMINI_UI_ENABLED && expandedMode === 'historical' && historicalGeminiOpen && (
              <aside className="metric-gemini-popover" aria-live="polite">
                <div className="metric-gemini-header">
                  <div>
                    <p className="eyebrow">Gemini Insight</p>
                    <h4>
                      {expandedMetricLabel} Trend
                      {isHistoricalForecastActive
                        ? ` + ${expandedForecastMode.toUpperCase()} XGB`
                        : ''}
                    </h4>
                  </div>
                  <button
                    type="button"
                    className="metric-gemini-close"
                    onClick={closeHistoricalGeminiPopup}
                  >
                    Close
                  </button>
                </div>
                <div className="metric-gemini-body">
                  {!historicalGeminiText && !historicalGeminiError && (
                    <p className="metric-gemini-placeholder">
                      {geminiInsightScopeLabel}
                    </p>
                  )}
                  {historicalGeminiText && (
                    <div className="metric-gemini-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {historicalGeminiText}
                      </ReactMarkdown>
                    </div>
                  )}
                  {isHistoricalGeminiStreaming && (
                    <div className="metric-gemini-typing">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
                  )}
                  {historicalGeminiError && (
                    <div className="gemini-error">{historicalGeminiError}</div>
                  )}
                </div>
                <div className="metric-gemini-footer">
                  <button
                    type="button"
                    className="metric-gemini-refresh"
                    onClick={() => {
                      void requestHistoricalGeminiInsight()
                    }}
                    disabled={isHistoricalGeminiStreaming || expandedPoints.length === 0}
                  >
                    Regenerate
                  </button>
                </div>
              </aside>
            )}

            <div className="metric-modal-value">
              {formatMetricValue(
                expandedMetricKey,
                expandedForecastMetricData?.latest ?? expandedMetricData?.latest ?? null,
              )}{' '}
              <span>{expandedMetricUnit}</span>
              {expandedMode === 'live' && liveDelta !== null && (
                <span
                  className={`metric-modal-delta ${trendClassFromDelta(liveDelta)}`}
                >
                  ({formatMetricDelta(expandedMetricKey, liveDelta)})
                </span>
              )}
            </div>

            {isHistoricalForecastActive && expandedPredictionDisplayPoints.length > 0 && (
              <div className="forecast-legend">
                <span className="forecast-legend-item">
                  <i className="forecast-line-solid" />
                  Historical
                </span>
                <span className="forecast-legend-item">
                  <i className="forecast-line-dotted" />
                  Predictions
                </span>
              </div>
            )}

            <div
              className={`expanded-chart-wrap${isPredictionFocusChartActive ? ' prediction-focus-active' : ''}`}
            >
              {isHistoricalForecastActive && isForecastLoading && (
                <div className="forecast-loading-overlay">
                  <span>Generating forecast...</span>
                </div>
              )}
              {expandedGeometry ? (
                <>
                  <svg
                    key={chartAnimationKey}
                    className={`expanded-sparkline${
                      isHistoricalForecastActive ? ' forecast-chart-enter' : ''
                    }${isPredictionFocusChartActive ? ' prediction-only' : ''}`}
                    viewBox={`0 0 ${expandedGeometry.width} ${expandedGeometry.height}`}
                    role="img"
                    aria-label={`${expandedMetricLabel} ${
                      expandedMode === 'live' ? 'live' : 'historical'
                    } graph`}
                    onMouseMove={handleExpandedChartMove}
                    onMouseLeave={() => setExpandedHoverIndex(null)}
                  >
                    <defs>
                      <linearGradient
                        id="spark-expanded"
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="0%"
                      >
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.72" />
                      </linearGradient>
                    </defs>
                    {!isHistoricalForecastActive && (
                      <path
                        className="sparkline-area"
                        d={expandedGeometry.areaPath}
                        fill="url(#spark-expanded)"
                      />
                    )}
                    {showExpandedAxes && (
                      <>
                        <line
                          className="chart-axis"
                          x1={expandedGeometry.padding}
                          y1={expandedGeometry.height - expandedGeometry.padding}
                          x2={expandedGeometry.width - expandedGeometry.padding}
                          y2={expandedGeometry.height - expandedGeometry.padding}
                        />
                        <line
                          className="chart-axis"
                          x1={expandedGeometry.padding}
                          y1={expandedGeometry.padding}
                          x2={expandedGeometry.padding}
                          y2={expandedGeometry.height - expandedGeometry.padding}
                        />
                        {expandedYAxisTicks.map((tick) => (
                          <g key={tick.key}>
                            <line
                              className="chart-grid-line"
                              x1={expandedGeometry.padding}
                              y1={tick.y}
                              x2={expandedGeometry.width - expandedGeometry.padding}
                              y2={tick.y}
                            />
                            <line
                              className="chart-axis"
                              x1={expandedGeometry.padding - 6}
                              y1={tick.y}
                              x2={expandedGeometry.padding}
                              y2={tick.y}
                            />
                            <text
                              className="chart-axis-tick"
                              x={expandedGeometry.padding - 10}
                              y={tick.y + 4}
                              textAnchor="end"
                            >
                              {formatMetricValue(expandedMetricKey, tick.value)}
                            </text>
                          </g>
                        ))}
                        {expandedFirstPoint && (
                          <text
                            className="chart-axis-tick"
                            x={expandedGeometry.padding}
                            y={expandedGeometry.height - expandedGeometry.padding + 24}
                            textAnchor="start"
                          >
                            {formatAxisTime(expandedFirstPoint.time)}
                          </text>
                        )}
                        {expandedLastPoint && (
                          <text
                            className="chart-axis-tick"
                            x={expandedGeometry.width - expandedGeometry.padding}
                            y={expandedGeometry.height - expandedGeometry.padding + 24}
                            textAnchor="end"
                          >
                            {formatAxisTime(expandedLastPoint.time)}
                          </text>
                        )}
                        <text
                          className="chart-axis-label"
                          x={expandedGeometry.width / 2}
                          y={expandedGeometry.height - 10}
                          textAnchor="middle"
                        >
                          Time
                        </text>
                        <text
                          className="chart-axis-label"
                          x={22}
                          y={expandedGeometry.height / 2}
                          textAnchor="middle"
                          transform={`rotate(-90 22 ${expandedGeometry.height / 2})`}
                        >
                          {expandedMetricLabel} ({expandedMetricUnit})
                        </text>
                      </>
                    )}
                    {expandedHistoricalPath && (
                      <path className="sparkline-line" d={expandedHistoricalPath} />
                    )}
                    {expandedPredictionPath && (
                      <path
                        key={`${predictionAnimationKey}-${isPredictionFocusChartActive ? 'focus' : 'context'}`}
                        className={`sparkline-line sparkline-prediction-line forecast-fade-in${
                          isPredictionFocusChartActive ? ' prediction-focus-line' : ''
                        }`}
                        d={expandedPredictionPath}
                      />
                    )}
                    {!expandedPredictionPath && expandedGeometry.dot && (
                      <circle
                        className={`sparkline-dot${expandedMode === 'live' ? ' live-dot' : ''}`}
                        cx={expandedGeometry.dot.x}
                        cy={expandedGeometry.dot.y}
                        r="5"
                      />
                    )}
                    {expandedPredictionPath && expandedHistoricalDot && (
                      <circle
                        className="sparkline-dot"
                        cx={expandedHistoricalDot.x}
                        cy={expandedHistoricalDot.y}
                        r="5"
                      />
                    )}
                    {expandedPredictionPath && expandedPredictionDot && (
                      <circle
                        className="sparkline-dot sparkline-prediction-dot"
                        cx={expandedPredictionDot.x}
                        cy={expandedPredictionDot.y}
                        r="5"
                      />
                    )}
                    {highlightedPredictionChartPoints.map((point) => (
                      <circle
                        key={`${point.time}-${point.x}-${point.y}`}
                        className="forecast-table-hover-point"
                        cx={point.x}
                        cy={point.y}
                        r={isPredictionFocusChartActive ? '6' : '5'}
                      />
                    ))}
                    {expandedHoverPoint && (
                      <>
                        <line
                          className="sparkline-crosshair"
                          x1={expandedHoverPoint.x}
                          y1={expandedGeometry.padding}
                          x2={expandedHoverPoint.x}
                          y2={expandedGeometry.height - expandedGeometry.padding}
                        />
                        <circle
                          className="sparkline-hover-dot"
                          cx={expandedHoverPoint.x}
                          cy={expandedHoverPoint.y}
                          r="6"
                        />
                      </>
                    )}
                  </svg>

                  {expandedHoverPoint && expandedTooltipStyle && (
                    <div className="chart-tooltip" style={expandedTooltipStyle}>
                      <span>{formatTimestamp(expandedHoverPoint.time)}</span>
                      {isHistoricalForecastActive && (
                        <span>{expandedHoverIsPrediction ? 'Prediction' : 'Historical'}</span>
                      )}
                      <strong>
                        {formatMetricValue(expandedMetricKey, expandedHoverPoint.value)}{' '}
                        {expandedMetricUnit}
                      </strong>
                    </div>
                  )}
                </>
              ) : (
                <div className="expanded-chart-empty">
                  {expandedError
                    ? expandedError
                    : isHistoricalForecastActive
                      ? expandedForecastMetricData
                        ? 'No forecast data available for this metric.'
                        : 'Loading forecast...'
                      : expandedMetricData
                        ? `No ${expandedMode === 'live' ? 'live' : 'historical'} data in this timeframe.`
                        : `Loading ${expandedMode === 'live' ? 'live' : 'historical'} data...`}
                </div>
              )}
            </div>

            {expandedError && (
              <div className="expanded-error">{expandedError}</div>
            )}
            {expandedForecastError && (
              <div className="expanded-error">{expandedForecastError}</div>
            )}

            <div className="expanded-stats">
              <div>
                <span>Min</span>
                <strong>
                  {formatMetricValue(expandedMetricKey, expandedMin)} {expandedMetricUnit}
                </strong>
              </div>
              <div>
                <span>Max</span>
                <strong>
                  {formatMetricValue(expandedMetricKey, expandedMax)} {expandedMetricUnit}
                </strong>
              </div>
              <div>
                <span>Points</span>
                <strong>{expandedPointCount}</strong>
              </div>
            </div>

            {isHistoricalForecastActive && expandedPredictionPoints.length > 0 && (
              <section className="forecast-insights-panel">
                <div className="forecast-insights-header">
                  <p className="eyebrow">Forecast Insights</p>
                  <h4>
                    {expandedMetricLabel} ({expandedMetricUnit}) -{' '}
                    {expandedForecastMode === 'weekly' ? 'Weekly' : 'Hourly'}
                  </h4>
                  {forecastPeriodLabel && (
                    <p className="forecast-insights-period">{forecastPeriodLabel}</p>
                  )}
                </div>

                <div className="forecast-insights-table-wrap">
                  {expandedForecastMode === 'weekly' ? (
                    <table className="forecast-insights-table forecast-table-transition">
                      <thead>
                        <tr>
                          <th>Day</th>
                          <th>Avg</th>
                          <th>Min</th>
                          <th>Max</th>
                        </tr>
                      </thead>
                      <tbody>
                        {weeklyForecastRows.map((row) => (
                          <tr
                            key={row.dayKey}
                            className={
                              hoveredForecastRowKey === row.dayKey ? 'is-hovered' : undefined
                            }
                            onMouseEnter={() =>
                              setForecastTableHover(row.dayKey, row.pointIndexes)
                            }
                            onMouseLeave={clearForecastTableHover}
                          >
                            <td>{row.day}</td>
                            <td>{formatMetricValue(expandedMetricKey, row.average)}</td>
                            <td>{formatMetricValue(expandedMetricKey, row.min)}</td>
                            <td>{formatMetricValue(expandedMetricKey, row.max)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <table className="forecast-insights-table forecast-table-transition">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>{expandedMetricLabel}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hourlyForecastRows.map((row) => (
                          <tr
                            key={row.key}
                            className={hoveredForecastRowKey === row.key ? 'is-hovered' : undefined}
                            onMouseEnter={() => setForecastTableHover(row.key, row.pointIndexes)}
                            onMouseLeave={clearForecastTableHover}
                          >
                            <td>{row.time}</td>
                            <td>{formatMetricValue(expandedMetricKey, row.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            )}
          </section>
        </div>
      )}

      {GEMINI_UI_ENABLED && (
        <>
          <button
            className="gemini-fab"
            type="button"
            onClick={() => {
              if (geminiOpen) {
                startNewConversation()
              } else {
                setGeminiOpen(true)
              }
            }}
            aria-expanded={geminiOpen}
            aria-controls="gemini-panel"
          >
            {geminiOpen ? 'New conversation' : 'Gemini'}
          </button>

          <aside
            id="gemini-panel"
            className={`gemini-panel ${geminiOpen ? 'open' : ''}`}
            aria-hidden={!geminiOpen}
          >
            <div className="gemini-header">
              <div>
                <p className="eyebrow">Ask Gemini</p>
                <h3>Quick Chat</h3>
              </div>
              <button
                className="gemini-close"
                type="button"
                onClick={() => setGeminiOpen(false)}
                aria-label="Close Gemini panel"
              >
                Close
              </button>
            </div>

            <div className="gemini-messages" aria-live="polite">
              {messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`gemini-message ${message.role}`}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {message.text}
                  </ReactMarkdown>
                </div>
              ))}
              {isSending && (
                <div className="gemini-message assistant gemini-typing">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              )}
            </div>

            {error && <div className="gemini-error">{error}</div>}

            <form
              className="gemini-input"
              onSubmit={(event) => {
                event.preventDefault()
                void sendToGemini()
              }}
            >
              <textarea
                rows={2}
                placeholder="Ask Gemini anything..."
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey) {
                    return
                  }
                  if (event.nativeEvent.isComposing) {
                    return
                  }
                  event.preventDefault()
                  if (!isSending) {
                    void sendToGemini()
                  }
                }}
                disabled={isSending}
              />
              <button type="submit" disabled={isSending || !input.trim()}>
                {isSending ? 'Sending...' : 'Send'}
              </button>
            </form>
          </aside>
        </>
      )}
    </div>
  )
}

export default App
