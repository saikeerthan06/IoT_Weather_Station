import './App.css'
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

const quickMetrics = [
  {
    label: 'Temperature',
    value: '28.4',
    unit: 'C',
    delta: '+0.6',
    note: 'Stable',
    accent: 'ember',
    bar: 72,
  },
  {
    label: 'Humidity',
    value: '56',
    unit: '%',
    delta: '-3',
    note: 'Comfort',
    accent: 'sky',
    bar: 56,
  },
  {
    label: 'Wind',
    value: '12',
    unit: 'km/h',
    delta: '+2.1',
    note: 'Breezy',
    accent: 'lime',
    bar: 35,
  },
  {
    label: 'Rain',
    value: '0.4',
    unit: 'mm',
    delta: 'Light',
    note: 'Drizzle',
    accent: 'teal',
    bar: 12,
  },
]

const trendCards = [
  {
    label: 'Temperature',
    value: '28.4',
    unit: 'C',
    range: '24-31 C',
    accent: 'ember',
    path: 'M4 62 L28 48 L52 54 L78 40 L104 44 L130 34 L156 40 L196 28',
    area:
      'M4 62 L28 48 L52 54 L78 40 L104 44 L130 34 L156 40 L196 28 L196 74 L4 74 Z',
    dot: { x: 196, y: 28 },
  },
  {
    label: 'Humidity',
    value: '56',
    unit: '%',
    range: '48-62 %',
    accent: 'sky',
    path: 'M4 48 L30 52 L60 46 L90 50 L120 44 L150 48 L180 40 L196 44',
    area:
      'M4 48 L30 52 L60 46 L90 50 L120 44 L150 48 L180 40 L196 44 L196 74 L4 74 Z',
    dot: { x: 196, y: 44 },
  },
  {
    label: 'Wind',
    value: '12',
    unit: 'km/h',
    range: '6-18 km/h',
    accent: 'lime',
    path: 'M4 64 L28 50 L52 62 L78 42 L104 54 L130 30 L156 50 L196 40',
    area:
      'M4 64 L28 50 L52 62 L78 42 L104 54 L130 30 L156 50 L196 40 L196 74 L4 74 Z',
    dot: { x: 196, y: 40 },
  },
  {
    label: 'Rain',
    value: '0.4',
    unit: 'mm',
    range: '0-3 mm',
    accent: 'teal',
    path: 'M4 68 L36 68 L68 68 L100 62 L132 66 L164 50 L196 64',
    area:
      'M4 68 L36 68 L68 68 L100 62 L132 66 L164 50 L196 64 L196 74 L4 74 Z',
    dot: { x: 196, y: 64 },
  },
]

const accentStyle = (accent: string): CSSProperties =>
  ({
    '--accent': `var(--accent-${accent})`,
  }) as CSSProperties

const meterStyle = (value: number): CSSProperties =>
  ({
    '--value': `${value}%`,
  }) as CSSProperties

const gaugeNeedleStyle: CSSProperties = {
  '--needle-rotation': '32deg',
} as CSSProperties

const formatLocalTime = (date: Date) =>
  date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })

function App() {
  const [localTime, setLocalTime] = useState(() => formatLocalTime(new Date()))

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setLocalTime(formatLocalTime(new Date()))
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon" aria-hidden="true" />
          <div className="brand-text">
            <p className="eyebrow">Weather Station</p>
            <h1>Harbor Field Lab - North Deck</h1>
            <p className="subtle">Live conditions - Updated 2 min ago</p>
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

      <main className="dashboard-grid">
        <section className="card summary-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Station Status</p>
              <h2>Weather Overview</h2>
            </div>
            <span className="chip chip-good">Clear</span>
          </div>
          <div className="summary-body">
            <div className="summary-ring">
              <div className="summary-core">
                <div className="summary-score">82</div>
                <div className="summary-status">Optimal</div>
              </div>
            </div>
          </div>
        </section>

        <section className="card metrics-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Live Snapshot</p>
              <h2>Sensor Readings</h2>
            </div>
            <span className="chip">Calibrated</span>
          </div>
          <div className="metrics-grid">
            {quickMetrics.map((metric) => {
              const trendClass = metric.delta.startsWith('+')
                ? 'trend-up'
                : metric.delta.startsWith('-')
                  ? 'trend-down'
                  : 'trend-flat'

              return (
                <div
                  className="mini-card"
                  key={metric.label}
                  style={accentStyle(metric.accent)}
                >
                  <div className="mini-top">
                    <span className="mini-label">{metric.label}</span>
                    <span className={`mini-trend ${trendClass}`}>
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
              )
            })}
          </div>
        </section>

        <section className="card gauge-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Wind Focus</p>
              <h2>Wind Intensity</h2>
            </div>
            <span className="chip chip-warn">Breezy</span>
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
              <span className="gauge-value">12</span>
              <span className="gauge-unit">km/h</span>
              <span className="gauge-sub">Gusts up to 16 km/h</span>
            </div>
            <div className="gauge-scale">
              <span>Calm</span>
              <span>Strong</span>
            </div>
          </div>
        </section>

        {trendCards.map((metric, index) => (
          <section
            className="card trend-card"
            key={metric.label}
            style={accentStyle(metric.accent)}
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
                <linearGradient
                  id={`spark-${index}`}
                  x1="0%"
                  y1="0%"
                  x2="100%"
                  y2="0%"
                >
                  <stop
                    offset="0%"
                    stopColor="var(--accent)"
                    stopOpacity="0.2"
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--accent)"
                    stopOpacity="0.7"
                  />
                </linearGradient>
              </defs>
              <path
                className="sparkline-area"
                d={metric.area}
                fill={`url(#spark-${index})`}
              />
              <path className="sparkline-line" d={metric.path} />
              <circle
                className="sparkline-dot"
                cx={metric.dot.x}
                cy={metric.dot.y}
                r="4"
              />
            </svg>
            <div className="trend-footer">{metric.range}</div>
          </section>
        ))}
      </main>

      <footer className="dashboard-footer">
        <div className="footer-left">
          <span className="footer-dot" />
          Mock data for UI preview only
        </div>
        <div className="footer-right">Weather Station UI Mockup</div>
      </footer>
    </div>
  )
}

export default App
