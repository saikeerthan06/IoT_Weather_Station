import { db } from '../services/db.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

const sanitizeTableName = (raw: string) => {
  const trimmed = raw.trim()
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    throw new Error('Invalid table name.')
  }
  return trimmed
}

const isRollupEnabled = () => process.env.ROLLUP_ENABLED?.toLowerCase() !== 'false'

const runDailyRollup = async (label: string) => {
  if (!isRollupEnabled()) {
    return
  }

  const sensorTable = sanitizeTableName(process.env.SENSOR_TABLE ?? 'sensor_data')
  const historicalTable = sanitizeTableName(process.env.HISTORICAL_TABLE ?? 'historical_data')

  const query = `
    INSERT INTO ${historicalTable} (time, temp, humi, pres)
    SELECT s.time, s.temp, s.humi, s.pres
    FROM ${sensorTable} s
    WHERE s.time::timestamptz >= (CURRENT_DATE - INTERVAL '1 day')
      AND s.time::timestamptz < CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM ${historicalTable} h
        WHERE h.time = s.time
      )
  `

  try {
    const result = await db.query(query)
    // eslint-disable-next-line no-console
    console.log(`Historical rollup (${label}) inserted ${result.rowCount ?? 0} rows.`)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Historical rollup failed', error)
  }
}

const scheduleNextRollup = () => {
  const now = new Date()
  const next = new Date(now)
  next.setHours(0, 0, 0, 0)
  if (next <= now) {
    next.setTime(next.getTime() + ONE_DAY_MS)
  }

  const delay = next.getTime() - now.getTime()
  setTimeout(async () => {
    await runDailyRollup('scheduled')
    scheduleNextRollup()
  }, delay)
}

export const scheduleDailyRollup = () => {
  if (!isRollupEnabled()) {
    // eslint-disable-next-line no-console
    console.log('Historical rollup disabled via ROLLUP_ENABLED=false')
    return
  }

  void runDailyRollup('startup')
  scheduleNextRollup()
}
