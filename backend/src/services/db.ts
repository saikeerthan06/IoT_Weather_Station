import pg from 'pg'

const { Pool } = pg

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const shouldUseSsl = (raw: string | undefined) =>
  raw === '1' || raw?.toLowerCase() === 'true' || raw?.toLowerCase() === 'require'

const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: toNumber(process.env.PGPORT, 5432),
  user: process.env.PGUSER ?? 'admin',
  password: process.env.PGPASSWORD ?? 'admin',
  database: process.env.PGDATABASE ?? 'admin',
  max: toNumber(process.env.PGPOOL_MAX, 6),
  idleTimeoutMillis: toNumber(process.env.PG_IDLE_TIMEOUT, 10000),
  connectionTimeoutMillis: toNumber(process.env.PG_CONNECT_TIMEOUT, 3000),
  ssl: shouldUseSsl(process.env.PGSSLMODE)
    ? { rejectUnauthorized: false }
    : undefined,
})

export const db = pool
