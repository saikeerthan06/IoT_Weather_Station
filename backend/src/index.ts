import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { scheduleDailyRollup } from './jobs/rollup.js'
import { geminiRouter } from './routes/gemini.js'
import { historyRouter } from './routes/history.js'
import { liveRouter } from './routes/live.js'

const app = express()

app.use(cors({ origin: true }))
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/api/gemini', geminiRouter)
app.use('/api/history', historyRouter)
app.use('/api/live', liveRouter)

const port = Number(process.env.PORT) || 5050
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`)
})

scheduleDailyRollup()
