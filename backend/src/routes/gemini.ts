import { Router } from 'express'
import { GoogleGenAI, ThinkingLevel } from '@google/genai'

type HistoricalInsightPoint = {
  time: string
  value: number
}

type HistoricalInsightPayload = {
  metric: {
    id: string
    label: string
    unit: string
  }
  window: {
    timeframe: string
    forecastMode: string
  }
  location: string
  historical: {
    pointCount: number
    points: HistoricalInsightPoint[]
    summary: Record<string, unknown>
  }
  prediction: {
    pointCount: number
    points: HistoricalInsightPoint[]
    summary: Record<string, unknown>
  }
}

const router = Router()

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  // eslint-disable-next-line no-console
  console.warn('GEMINI_API_KEY is not set. Set it in backend/.env')
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null

const normalizeInsightPoints = (raw: unknown, maxPoints: number) => {
  if (!Array.isArray(raw)) {
    return [] as HistoricalInsightPoint[]
  }

  const points: HistoricalInsightPoint[] = []

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const point = entry as { time?: unknown; value?: unknown }
    const time = String(point.time ?? '').trim()
    const value = Number(point.value)
    if (!time || !Number.isFinite(value)) {
      continue
    }

    points.push({ time, value })
    if (points.length >= maxPoints) {
      break
    }
  }

  return points
}

const normalizeSummary = (raw: unknown) =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

const toHistoricalInsightPayload = (raw: unknown): HistoricalInsightPayload => {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const metricRaw =
    body.metric && typeof body.metric === 'object'
      ? (body.metric as Record<string, unknown>)
      : {}
  const windowRaw =
    body.window && typeof body.window === 'object'
      ? (body.window as Record<string, unknown>)
      : {}
  const historicalRaw =
    body.historical && typeof body.historical === 'object'
      ? (body.historical as Record<string, unknown>)
      : {}
  const predictionRaw =
    body.prediction && typeof body.prediction === 'object'
      ? (body.prediction as Record<string, unknown>)
      : {}

  const historicalPoints = normalizeInsightPoints(historicalRaw.points, 240)
  const predictionPoints = normalizeInsightPoints(predictionRaw.points, 160)
  const historicalPointCountRaw = Number(historicalRaw.pointCount)
  const predictionPointCountRaw = Number(predictionRaw.pointCount)

  return {
    metric: {
      id: String(metricRaw.id ?? 'unknown'),
      label: String(metricRaw.label ?? 'Metric'),
      unit: String(metricRaw.unit ?? ''),
    },
    window: {
      timeframe: String(windowRaw.timeframe ?? 'unknown'),
      forecastMode: String(windowRaw.forecastMode ?? 'off'),
    },
    location: String(body.location ?? 'Ang Mo Kio'),
    historical: {
      pointCount: Number.isFinite(historicalPointCountRaw)
        ? historicalPointCountRaw
        : historicalPoints.length,
      points: historicalPoints,
      summary: normalizeSummary(historicalRaw.summary),
    },
    prediction: {
      pointCount: Number.isFinite(predictionPointCountRaw)
        ? predictionPointCountRaw
        : predictionPoints.length,
      points: predictionPoints,
      summary: normalizeSummary(predictionRaw.summary),
    },
  }
}

router.post('/historical-insights/stream', async (req, res) => {
  const payload = toHistoricalInsightPayload(req.body)

  if (!payload.historical.points.length) {
    return res.status(400).json({ error: 'Historical dashboard points are required.' })
  }

  if (!ai) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set.' })
  }

  let clientClosed = false
  const handleClose = () => {
    clientClosed = true
  }

  req.on('close', handleClose)

  try {
    const prompt = `You are "Weather Station Insight Assistant" for NYP Ang Mo Kio.

Hard constraints:
- Use ONLY the provided DASHBOARD_DATA JSON.
- Do NOT use external tools, weather APIs, internet facts, or hidden knowledge.
- If data is insufficient, say that clearly.
- You may mention "Ang Mo Kio" only for local operational context in recommendations, not as evidence.

Output format (Markdown):
1) **Trend Summary**
2) **Notable Changes / Anomalies**
3) **Actionable Recommendations (Ang Mo Kio Context)**
4) **Data Scope Used** (timeframe + point counts)

DASHBOARD_DATA:
${JSON.stringify(payload)}`

    const response = await ai.models.generateContentStream({
      model: 'gemini-3-flash-preview',
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.HIGH,
        },
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    })

    res.status(200)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    for await (const chunk of response) {
      if (clientClosed) {
        break
      }

      if (chunk.text) {
        res.write(chunk.text)
      }
    }

    if (!res.writableEnded) {
      res.end()
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Gemini historical insight stream failed', error)
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Gemini historical insight failed.' })
    }

    if (!res.writableEnded) {
      res.write('\n\nUnable to complete insight stream.')
      res.end()
    }
  } finally {
    req.off('close', handleClose)
  }
})

router.post('/', async (req, res) => {
  const message = String(req.body?.message ?? '').trim()

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' })
  }

  if (!ai) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set.' })
  }

  try {
    const tools = [{ googleSearch: {} }]
    const config = {
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.HIGH,
      },
      tools,
    }

    const prompt = `You are a helpful assistant. Format your response in Markdown with readable paragraphs, bold for key facts, and bullet points for lists when appropriate.\n\nUser: ${message}`

    const response = await ai.models.generateContentStream({
      model: 'gemini-3-flash-preview',
      config,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    })

    let fullText = ''
    for await (const chunk of response) {
      if (chunk.text) {
        fullText += chunk.text
      }
    }

    return res.json({ text: fullText })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Gemini request failed', error)
    return res.status(500).json({ error: 'Gemini request failed.' })
  }
})

export { router as geminiRouter }
