import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { resolveDatabaseConfig, type Db } from './client.ts'
import * as schema from './schema.ts'

const resources: { name: string; pool: pg.Pool; admin: pg.Pool }[] = []
export async function createIsolatedTestDb(): Promise<Db> {
  if (process.env.NODE_ENV !== 'test' || process.env.REPLIT_DEPLOYMENT === '1') {
    throw new Error(
      'Isolated database tests are only allowed outside published apps in NODE_ENV=test',
    )
  }
  const name = `outreach_test_${randomUUID().replaceAll('-', '')}`
  const connectionString = resolveDatabaseConfig().url
  const admin = new pg.Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  })
  await admin.query(`CREATE SCHEMA "${name}"`)
  const pool = new pg.Pool({
    connectionString,
    options: `-c search_path=${name}`,
    max: 1,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  })
  resources.push({ name, pool, admin })
  const folder = resolve('drizzle/postgres')
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await pool.query(
      readFileSync(resolve(folder, file), 'utf8').replaceAll('"public".', `"${name}".`),
    )
  }
  return drizzle(pool, { schema })
}
export async function closeTestDbs() {
  for (const { name, pool, admin } of resources.splice(0)) {
    await pool.end()
    await admin.query(`DROP SCHEMA "${name}" CASCADE`)
    await admin.end()
  }
}
