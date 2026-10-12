// One-time, development-only data copy. Never modifies the SQLite source or production.
import 'dotenv/config'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { resolveDatabaseConfig } from '../server/db/client.ts'

if (process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production') {
  throw new Error('SQLite import is only allowed in the development workspace')
}
const tables = [
  'leads',
  'properties',
  'sequences',
  'sequence_steps',
  'enrollments',
  'messages',
  'events',
  'suppression',
  'settings',
  'job_runs',
  'activity_log',
  'imports',
  'provider_usage',
]
const source = new DatabaseSync('data/outreach.db', { readOnly: true })
const pool = new pg.Pool({ connectionString: resolveDatabaseConfig().url, max: 1 })
const target = await pool.connect()
try {
  source.exec('BEGIN')
  await target.query('BEGIN')
  await target.query(`LOCK TABLE ${tables.map((t) => `"${t}"`).join(', ')} IN EXCLUSIVE MODE`)
  for (const table of tables) {
    const count = await target.query(`SELECT count(*) FROM "${table}"`)
    if (Number(count.rows[0].count))
      throw new Error(`Target ${table} is not empty; refusing to overwrite data`)
  }
  for (const table of tables) {
    const columns = await target.query(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', table],
    )
    const types = new Map(columns.rows.map((r) => [r.column_name, r.data_type]))
    const rows = source.prepare(`SELECT * FROM "${table}"`).all()
    for (const row of rows) {
      const keys = Object.keys(row)
      if (keys.some((k) => !types.has(k))) throw new Error(`Unexpected column in ${table}`)
      const values = keys.map((k) =>
        row[k] === null ? null : types.get(k) === 'boolean' ? Boolean(row[k]) : row[k],
      )
      await target.query(
        `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
        values,
      )
    }
    const count = await target.query(`SELECT count(*) FROM "${table}"`)
    if (Number(count.rows[0].count) !== rows.length) throw new Error(`Row count mismatch: ${table}`)
    console.log(`${table}: ${rows.length} rows copied`)
  }
  await target.query('COMMIT')
  source.exec('COMMIT')
} catch (error) {
  await target.query('ROLLBACK')
  throw error
} finally {
  source.close()
  target.release()
  await pool.end()
}
