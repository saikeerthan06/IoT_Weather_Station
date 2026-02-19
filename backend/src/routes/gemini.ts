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
  assistantContext: {
    role: string
    chartType: string
    forecast: {
      enabled: boolean
      modelFamily: string
      mode: string
      modelPath: string | null
      generatedAt: string | null
      warning: string | null
      predictionPointCount: number
    }
  }
}

const router = Router()

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  // eslint-disable-next-line no-console
  console.warn('GEMINI_API_KEY is not set. Set it in backend/.env')
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null

const DEFAULT_GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]

const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504])

const readPositiveInt = (raw: string | undefined, fallback: number, min = 0) => {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback
  }
  return parsed
}

const geminiModelCandidates = (
  process.env.GEMINI_MODEL_CANDIDATES ??
  process.env.GEMINI_MODELS ??
  DEFAULT_GEMINI_MODELS.join(',')
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

const geminiRetriesPerModel = readPositiveInt(process.env.GEMINI_RETRIES_PER_MODEL, 2)
const geminiRetryBaseMs = readPositiveInt(process.env.GEMINI_RETRY_BASE_MS, 900, 150)
const geminiRetryMaxMs = readPositiveInt(process.env.GEMINI_RETRY_MAX_MS, 6000, geminiRetryBaseMs)

type StreamRequest = Parameters<GoogleGenAI['models']['generateContentStream']>[0]
type StreamResponse = Awaited<ReturnType<GoogleGenAI['models']['generateContentStream']>>

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const getGeminiStatusCode = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') {
    return null
  }

  const candidates = [
    (error as { status?: unknown }).status,
    (error as { code?: unknown }).code,
  ]

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return null
}

const isRetryableGeminiError = (error: unknown) => {
  const status = getGeminiStatusCode(error)
  if (status !== null && RETRYABLE_GEMINI_STATUSES.has(status)) {
    return true
  }

  const message = String((error as { message?: unknown })?.message ?? '').toLowerCase()
  if (!message) {
    return false
  }

  return (
    message.includes('high demand') ||
    message.includes('unavailable') ||
    message.includes('rate limit') ||
    message.includes('timed out') ||
    message.includes('deadline exceeded')
  )
}

const retryDelayMs = (attemptIndex: number) => {
  const exponential = Math.min(geminiRetryBaseMs * 2 ** (attemptIndex - 1), geminiRetryMaxMs)
  const jitter = Math.round(Math.random() * 220)
  return exponential + jitter
}

const buildStreamRequest = (
  request: StreamRequest,
  model: string,
  thinkingLevel: ThinkingLevel,
): StreamRequest => {
  const existingThinking = request.config?.thinkingConfig ?? {}
  return {
    ...request,
    model,
    config: {
      ...(request.config ?? {}),
      thinkingConfig: {
        ...existingThinking,
        thinkingLevel,
      },
    },
  }
}

const generateStreamWithResilience = async ({
  client,
  requestName,
  request,
  thinkingLevels,
}: {
  client: GoogleGenAI
  requestName: string
  request: StreamRequest
  thinkingLevels: ThinkingLevel[]
}): Promise<StreamResponse> => {
  const models = geminiModelCandidates.length ? geminiModelCandidates : DEFAULT_GEMINI_MODELS
  const attemptsPerModel = geminiRetriesPerModel + 1
  let lastError: unknown = null

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex]

    for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
      const level = thinkingLevels[Math.min(attempt - 1, thinkingLevels.length - 1)]
      const requestForAttempt = buildStreamRequest(request, model, level)

      try {
        if (attempt > 1 || modelIndex > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[Gemini] Retrying ${requestName} with model=${model} attempt=${attempt}/${attemptsPerModel} thinking=${level}.`,
          )
        }
        return await client.models.generateContentStream(requestForAttempt)
      } catch (error) {
        lastError = error
        const status = getGeminiStatusCode(error)
        const retryable = isRetryableGeminiError(error)
        const shouldRetrySameModel = retryable && attempt < attemptsPerModel
        const shouldTryNextModel = modelIndex < models.length - 1

        // eslint-disable-next-line no-console
        console.warn(
          `[Gemini] ${requestName} failed on model=${model} attempt=${attempt}/${attemptsPerModel}${status !== null ? ` status=${status}` : ''}.`,
        )

        if (shouldRetrySameModel) {
          await wait(retryDelayMs(attempt))
          continue
        }

        if (!shouldTryNextModel) {
          throw lastError
        }

        break
      }
    }
  }

  throw lastError ?? new Error(`[Gemini] ${requestName} failed without error details.`)
}

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

const asBoolean = (raw: unknown, fallback = false) => {
  if (typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'true') {
      return true
    }
    if (normalized === 'false') {
      return false
    }
  }
  return fallback
}

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
  const assistantContextRaw =
    body.assistantContext && typeof body.assistantContext === 'object'
      ? (body.assistantContext as Record<string, unknown>)
      : {}
  const forecastContextRaw =
    assistantContextRaw.forecast && typeof assistantContextRaw.forecast === 'object'
      ? (assistantContextRaw.forecast as Record<string, unknown>)
      : {}

  const historicalPoints = normalizeInsightPoints(historicalRaw.points, 240)
  const predictionPoints = normalizeInsightPoints(predictionRaw.points, 160)
  const historicalPointCountRaw = Number(historicalRaw.pointCount)
  const predictionPointCountRaw = Number(predictionRaw.pointCount)
  const forecastPredictionCountRaw = Number(forecastContextRaw.predictionPointCount)

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
    assistantContext: {
      role: String(assistantContextRaw.role ?? 'weather-station-operator-assistant'),
      chartType: String(assistantContextRaw.chartType ?? 'time-series'),
      forecast: {
        enabled: asBoolean(forecastContextRaw.enabled, false),
        modelFamily: String(forecastContextRaw.modelFamily ?? 'xgboost'),
        mode: String(forecastContextRaw.mode ?? 'off'),
        modelPath: forecastContextRaw.modelPath
          ? String(forecastContextRaw.modelPath)
          : null,
        generatedAt: forecastContextRaw.generatedAt
          ? String(forecastContextRaw.generatedAt)
          : null,
        warning: forecastContextRaw.warning ? String(forecastContextRaw.warning) : null,
        predictionPointCount: Number.isFinite(forecastPredictionCountRaw)
          ? forecastPredictionCountRaw
          : predictionPoints.length,
      },
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

Role:
- Act as an on-shift assistant for weather station operators.
- Analyze the currently visible chart trend and, when available, the XGBoost forecast output.

Hard constraints:
- Use ONLY the provided DASHBOARD_DATA JSON.
- Do NOT use external tools, weather APIs, internet facts, or hidden knowledge.
- If data is insufficient, say that clearly.
- Treat historical.points as the graph currently visible to the user.
- Treat prediction.points as XGBoost forecast values when assistantContext.forecast.enabled=true.

Output format (Markdown):
1) **Trend Summary (Current Chart)**
2) **XGBoost Forecast Outlook**
3) **Notable Changes / Risk Watch**
4) **Operator Actions (Next Shift)**
5) **Data Scope Used** (timeframe + point counts + forecast mode/model path if present)

DASHBOARD_DATA:
${JSON.stringify(payload)}`

    const response = await generateStreamWithResilience({
      client: ai,
      requestName: 'historical insight stream',
      request: {
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
      },
      thinkingLevels: [ThinkingLevel.HIGH, ThinkingLevel.MEDIUM, ThinkingLevel.LOW],
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
      const status = getGeminiStatusCode(error)
      const responseStatus = status && status >= 400 && status < 600 ? status : 500
      const message =
        responseStatus === 503
          ? 'Gemini is temporarily busy. Please retry in a short while.'
          : 'Gemini historical insight failed.'
      return res.status(responseStatus).json({ error: message })
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
        thinkingLevel: ThinkingLevel.MEDIUM,
      },
      tools,
    }

    const prompt = `You are a helpful assistant. Format your response in Markdown with readable paragraphs, bold for key facts, and bullet points for lists when appropriate.\n\nUser: ${message}`

    const response = await generateStreamWithResilience({
      client: ai,
      requestName: 'chat completion',
      request: {
        model: 'gemini-3-flash-preview',
        config,
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      },
      thinkingLevels: [ThinkingLevel.MEDIUM, ThinkingLevel.LOW, ThinkingLevel.MINIMAL],
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
    const status = getGeminiStatusCode(error)
    const responseStatus = status && status >= 400 && status < 600 ? status : 500
    const message =
      responseStatus === 503
        ? 'Gemini is temporarily busy. Please retry in a short while.'
        : 'Gemini request failed.'
    return res.status(responseStatus).json({ error: message })
  }
})

export { router as geminiRouter }
