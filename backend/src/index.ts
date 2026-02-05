import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { geminiRouter } from './routes/gemini.js'

const app = express()

app.use(cors({ origin: true }))
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/api/gemini', geminiRouter)

const port = Number(process.env.PORT) || 5050
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`)
})
