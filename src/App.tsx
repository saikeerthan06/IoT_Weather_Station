import './App.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type MetricId = 'temperature' | 'humidity' | 'wind'
type Timeframe = '1h' | '6h' | '12h' | '24h' | '3d' | 'all'

type MetricPoint = {
  time: string
  value: number
}

type HistoricalMetric = {
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

type HistoryApiResponse = {
  metrics: Record<MetricId, HistoricalMetric>
}

type GeminiMessage = {
  role: 'user' | 'assistant'
  text: string
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

const metricOrder: MetricId[] = ['temperature', 'humidity', 'wind']

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
  wind: {
    accent: 'lime',
    fallbackUnit: 'km/h',
    defaultLabel: 'Wind',
  },
}

const timeframeOptions: Array<{ value: Timeframe; label: string }> = [
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '12h', label: '12H' },
  { value: '24h', label: '24H' },
  { value: '3d', label: '3D' },
  { value: 'all', label: 'All' },
]

const timeframeMs: Record<Exclude<Timeframe, 'all'>, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
}

const defaultGreeting: GeminiMessage = {
  role: 'assistant',
  text: 'Hi! Ask me anything.',
}

const METRIC_MODAL_ANIMATION_MS = 220
const Y_AXIS_TICK_COUNT = 6

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
    return '0'
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

  if (value >= 25) return 'Windy'
  if (value >= 12) return 'Breezy'
  return 'Calm'
}

const rangeLabel = (metricId: MetricId, points: MetricPoint[], unit: string) => {
  if (points.length === 0) {
    return `No historical ${metricStyleConfig[metricId].defaultLabel.toLowerCase()} data`
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

  return `${min.toFixed(1)}-${max.toFixed(1)} ${unit}`
}

const normalizeMeterValue = (metric: HistoricalMetric | null) => {
  if (!metric || metric.latest === null || metric.min === null || metric.max === null) {
    return 0
  }

  if (metric.max === metric.min) {
    return 50
  }

  return ((metric.latest - metric.min) / (metric.max - metric.min)) * 100
}

const filterByTimeframe = (points: MetricPoint[], timeframe: Timeframe) => {
  if (timeframe === 'all' || points.length === 0) {
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

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

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
  const [historyMetrics, setHistoryMetrics] = useState<
    Record<MetricId, HistoricalMetric> | null
  >(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [isOverviewModalOpen, setIsOverviewModalOpen] = useState(false)
  const [isOverviewFormulaOpen, setIsOverviewFormulaOpen] = useState(false)

  const [expandedMetric, setExpandedMetric] = useState<MetricId | null>(null)
  const [isMetricClosing, setIsMetricClosing] = useState(false)
  const [showExpandedAxes, setShowExpandedAxes] = useState(false)
  const [expandedTimeframe, setExpandedTimeframe] = useState<Timeframe>('12h')
  const [expandedHoverIndex, setExpandedHoverIndex] = useState<number | null>(null)

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

    const loadMetrics = async () => {
      try {
        const response = await fetch('/api/history/metrics', {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error('Failed to load historical metrics.')
        }

        const payload = (await response.json()) as HistoryApiResponse
        setHistoryMetrics(payload.metrics)
        setHistoryError(null)
      } catch (loadError) {
        if (controller.signal.aborted) {
          return
        }

        const message =
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load historical metrics.'
        setHistoryError(message)
      }
    }

    void loadMetrics()

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!isMetricClosing) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setExpandedMetric(null)
      setIsMetricClosing(false)
    }, METRIC_MODAL_ANIMATION_MS)

    return () => window.clearTimeout(timeoutId)
  }, [isMetricClosing])

  const openExpandedMetric = useCallback((metricId: MetricId) => {
    setExpandedMetric(metricId)
    setExpandedTimeframe('12h')
    setExpandedHoverIndex(null)
    setShowExpandedAxes(false)
    setIsMetricClosing(false)
  }, [])

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
  }, [expandedMetric, expandedTimeframe])

  const latestObservationTime = useMemo(() => {
    if (!historyMetrics) {
      return null
    }

    const latest = historyMetrics.temperature.points.at(-1)
    if (!latest) {
      return null
    }

    return formatTimestamp(latest.time)
  }, [historyMetrics])

  const weatherOverview = useMemo(() => {
    const temp = historyMetrics?.temperature.latest ?? null
    const humi = historyMetrics?.humidity.latest ?? null
    const wind = historyMetrics?.wind.latest ?? null

    if (temp === null || humi === null || wind === null) {
      return {
        score: null as number | null,
        status: null as OverviewStatus | null,
        chipClass: 'chip',
      }
    }

    const temperatureComfort = clamp(100 - Math.abs(temp - 27) * 6, 0, 100)
    const humidityComfort = clamp(100 - Math.abs(humi - 55) * 2, 0, 100)
    const comfortScore = 0.6 * temperatureComfort + 0.4 * humidityComfort

    const windScore = clamp(100 - Math.abs(wind - 8) * 7, 0, 100)

    const tempStability = stabilityFromDelta(
      averageDelta(historyMetrics?.temperature.points ?? [], 12),
      0.35,
    )
    const humiStability = stabilityFromDelta(
      averageDelta(historyMetrics?.humidity.points ?? [], 12),
      1.2,
    )
    const windStability = stabilityFromDelta(
      averageDelta(historyMetrics?.wind.points ?? [], 12),
      1.0,
    )
    const stabilityScore =
      0.45 * tempStability + 0.35 * humiStability + 0.2 * windStability

    const score = Math.round(
      clamp(
        0.55 * comfortScore + 0.25 * windScore + 0.2 * stabilityScore,
        0,
        100,
      ),
    )

    const status = mapScoreToStatus(score)

    return {
      score,
      status,
      chipClass: `chip ${statusChipClass(status)}`,
    }
  }, [historyMetrics])

  const quickMetrics = useMemo(() => {
    const temperature = historyMetrics?.temperature ?? null
    const humidity = historyMetrics?.humidity ?? null
    const wind = historyMetrics?.wind ?? null

    return [
      {
        label: 'Temperature',
        value: formatMetricValue('temperature', temperature?.latest ?? null),
        unit: temperature?.unit ?? metricStyleConfig.temperature.fallbackUnit,
        delta: formatMetricDelta('temperature', temperature?.delta ?? null),
        note: metricNote('temperature', temperature?.latest ?? null),
        accent: metricStyleConfig.temperature.accent,
        bar: normalizeMeterValue(temperature),
      },
      {
        label: 'Humidity',
        value: formatMetricValue('humidity', humidity?.latest ?? null),
        unit: humidity?.unit ?? metricStyleConfig.humidity.fallbackUnit,
        delta: formatMetricDelta('humidity', humidity?.delta ?? null),
        note: metricNote('humidity', humidity?.latest ?? null),
        accent: metricStyleConfig.humidity.accent,
        bar: normalizeMeterValue(humidity),
      },
      {
        label: 'Wind',
        value: formatMetricValue('wind', wind?.latest ?? null),
        unit: wind?.unit ?? metricStyleConfig.wind.fallbackUnit,
        delta: formatMetricDelta('wind', wind?.delta ?? null),
        note: metricNote('wind', wind?.latest ?? null),
        accent: metricStyleConfig.wind.accent,
        bar: normalizeMeterValue(wind),
      },
    ]
  }, [historyMetrics])

  const overviewReadings = useMemo(
    () => [
      {
        label: 'Temperature',
        value: formatMetricValue('temperature', historyMetrics?.temperature.latest ?? null),
        unit: metricStyleConfig.temperature.fallbackUnit,
      },
      {
        label: 'Humidity',
        value: formatMetricValue('humidity', historyMetrics?.humidity.latest ?? null),
        unit: metricStyleConfig.humidity.fallbackUnit,
      },
      {
        label: 'Wind',
        value: formatMetricValue('wind', historyMetrics?.wind.latest ?? null),
        unit: metricStyleConfig.wind.fallbackUnit,
      },
    ],
    [historyMetrics],
  )

  const trendCards = useMemo(() => {
    return metricOrder.map((metricId) => {
      const metric = historyMetrics?.[metricId] ?? null
      const points = metric ? filterByTimeframe(metric.points, '12h') : []
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
        ),
        accent: metricStyleConfig[metricId].accent,
        geometry,
      }
    })
  }, [historyMetrics])

  const windNow = historyMetrics?.wind.latest ?? null
  const gaugeNeedleStyle: CSSProperties = useMemo(() => {
    if (windNow === null || Number.isNaN(windNow)) {
      return { '--needle-rotation': '0deg' } as CSSProperties
    }

    const normalized = Math.max(0, Math.min(1, windNow / 35))
    const rotation = -80 + normalized * 160
    return { '--needle-rotation': `${rotation}deg` } as CSSProperties
  }, [windNow])

  const expandedMetricData = expandedMetric ? historyMetrics?.[expandedMetric] ?? null : null

  const expandedPoints = useMemo(() => {
    if (!expandedMetricData) {
      return []
    }

    return filterByTimeframe(expandedMetricData.points, expandedTimeframe)
  }, [expandedMetricData, expandedTimeframe])

  const expandedFirstPoint = expandedPoints[0]
  const expandedLastPoint = expandedPoints[expandedPoints.length - 1]

  const expandedDisplayPoints = useMemo(
    () => resamplePoints(expandedPoints, 500),
    [expandedPoints],
  )

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

  const expandedTooltipStyle = useMemo(() => {
    if (!expandedGeometry || !expandedHoverPoint) {
      return undefined
    }

    return {
      left: `${(expandedHoverPoint.x / expandedGeometry.width) * 100}%`,
      top: `${(expandedHoverPoint.y / expandedGeometry.height) * 100}%`,
    }
  }, [expandedGeometry, expandedHoverPoint])

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
          <div className="brand-icon" aria-hidden="true" />
          <div className="brand-text">
            <p className="eyebrow">Weather Station</p>
            <h1>Nanyang Polytechnic - Ang Mo Kio</h1>
            <p className="subtle">
              Historical sync {latestObservationTime ? `- ${latestObservationTime}` : '- Loading...'}
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

      {historyError && <div className="history-error">{historyError}</div>}

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
              <div
                className="mini-card"
                key={metric.label}
                style={accentStyle(metric.accent)}
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
              </div>
            ))}
          </div>
        </section>

        <section className="card gauge-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Wind Focus</p>
              <h2>Wind Intensity</h2>
            </div>
            <span className="chip chip-warn">
              {metricNote('wind', historyMetrics?.wind.latest ?? null)}
            </span>
          </div>
          <div className="gauge-wrap">
            <div className="gauge">
              <svg
                className="gauge-svg"
                viewBox="0 0 260 160"
                aria-hidden="true"
              >
                <path
                  d="M30 130 A100 100 0 0 1 80 43.4"
                  className="gauge-arc arc-good"
                />
                <path
                  d="M80 43.4 A100 100 0 0 1 180 43.4"
                  className="gauge-arc arc-mid"
                />
                <path
                  d="M180 43.4 A100 100 0 0 1 230 130"
                  className="gauge-arc arc-high"
                />
              </svg>
              <div className="gauge-needle" style={gaugeNeedleStyle} />
              <div className="gauge-center" />
            </div>
            <div className="gauge-readout">
              <span className="gauge-value">
                {formatMetricValue('wind', historyMetrics?.wind.latest ?? null)}
              </span>
              <span className="gauge-unit">km/h</span>
              <span className="gauge-sub">
                {historyMetrics?.wind.max !== null &&
                historyMetrics?.wind.max !== undefined
                  ? `Peak ${historyMetrics.wind.max.toFixed(1)} km/h`
                  : 'Historical wind unavailable'}
              </span>
            </div>
            <div className="gauge-scale">
              <span>Calm</span>
              <span>Strong</span>
            </div>
          </div>
        </section>

        {trendCards.map((metric, index) => (
          <button
            type="button"
            className="card trend-card trend-card-button"
            key={metric.metricId}
            style={accentStyle(metric.accent)}
            onClick={() => openExpandedMetric(metric.metricId)}
          >
            <div className="trend-header">
              <div>
                <p className="eyebrow">Last 12h</p>
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
          Historical metrics powered by backend CSV API
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
                <p>Composite score from the latest historical readings.</p>
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
                  Formula: <strong>0.55 * Comfort + 0.25 * Wind + 0.20 * Stability</strong>
                </p>
                <p>
                  Comfort combines temperature and humidity around target
                  conditions, wind rewards moderate airflow, and stability
                  rewards smoother recent changes.
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

      {expandedMetricData && expandedGeometry && (
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
            style={accentStyle(metricStyleConfig[expandedMetricData.key].accent)}
          >
            <div className="metric-modal-header">
              <div>
                <p className="eyebrow">Historical Metric</p>
                <h3>{expandedMetricData.label}</h3>
                <p className="metric-modal-subtitle">
                  {rangeLabel(
                    expandedMetricData.key,
                    expandedPoints,
                    expandedMetricData.unit,
                  )}
                </p>
              </div>
              <div className="metric-modal-actions">
                <div className="timeframe-group" role="tablist" aria-label="Timeframe selector">
                  {timeframeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`timeframe-chip ${
                        expandedTimeframe === option.value ? 'active' : ''
                      }`}
                      onClick={() => setExpandedTimeframe(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
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

            <div className="metric-modal-value">
              {formatMetricValue(expandedMetricData.key, expandedMetricData.latest)}{' '}
              <span>{expandedMetricData.unit}</span>
            </div>

            <div className="expanded-chart-wrap">
              <svg
                className="expanded-sparkline"
                viewBox={`0 0 ${expandedGeometry.width} ${expandedGeometry.height}`}
                role="img"
                aria-label={`${expandedMetricData.label} historical graph`}
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
                <path
                  className="sparkline-area"
                  d={expandedGeometry.areaPath}
                  fill="url(#spark-expanded)"
                />
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
                          {formatMetricValue(expandedMetricData.key, tick.value)}
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
                      {expandedMetricData.label} ({expandedMetricData.unit})
                    </text>
                  </>
                )}
                <path className="sparkline-line" d={expandedGeometry.linePath} />
                <circle
                  className="sparkline-dot"
                  cx={expandedGeometry.dot.x}
                  cy={expandedGeometry.dot.y}
                  r="5"
                />
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
                  <strong>
                    {formatMetricValue(expandedMetricData.key, expandedHoverPoint.value)}{' '}
                    {expandedMetricData.unit}
                  </strong>
                </div>
              )}
            </div>

            <div className="expanded-stats">
              <div>
                <span>Min</span>
                <strong>
                  {formatMetricValue(expandedMetricData.key, expandedGeometry.min)}{' '}
                  {expandedMetricData.unit}
                </strong>
              </div>
              <div>
                <span>Max</span>
                <strong>
                  {formatMetricValue(expandedMetricData.key, expandedGeometry.max)}{' '}
                  {expandedMetricData.unit}
                </strong>
              </div>
              <div>
                <span>Points</span>
                <strong>{expandedPoints.length}</strong>
              </div>
            </div>
          </section>
        </div>
      )}

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
    </div>
  )
}

export default App
