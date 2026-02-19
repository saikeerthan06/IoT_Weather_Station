import { Router } from 'express'

const router = Router()

/*
 * AI assistant routes are intentionally disabled.
 * If this is needed again later, restore the previous implementation
 * and re-enable route wiring in src/index.ts.
 */

router.all('*', (_req, res) => {
  return res.status(404).json({ error: 'AI assistant route is disabled.' })
})

export { router as geminiRouter }
