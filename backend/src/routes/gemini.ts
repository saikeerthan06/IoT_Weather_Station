import { Router } from 'express'
import { GoogleGenAI, ThinkingLevel } from '@google/genai'

const router = Router()

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  // eslint-disable-next-line no-console
  console.warn('GEMINI_API_KEY is not set. Set it in backend/.env')
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null

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
