import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export type Db = NodePgDatabase<typeof schema>
let defaultDb: Db | null = null

export function resolveDatabaseConfig(e: Record<string, string | undefined> = process.env) {
  const url = e.DATABASE_URL?.trim()
  if (!url || !/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error(
      'Replit PostgreSQL DATABASE_URL is required. SQLite and Turso URLs are not supported.',
    )
  }
  return { url }
}

export function createDb(url: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
  })
  return drizzle(pool, { schema })
}

export function getDb(): Db {
  return (defaultDb ??= createDb(resolveDatabaseConfig().url))
}
export function setDefaultDb(db: Db | null): void {
  defaultDb = db
}
export async function dbOk(db = getDb()): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`)
    return true
  } catch {
    return false
  }
}
/**
 * Columns added after the first Publish. Publish copies schema changes from the workspace
 * database, and nothing migrates that database, so a new column never reaches production on
 * its own: on 2026-10-12 a missing leads.facebook_url made every lead query fail. Each
 * statement is additive and idempotent, so it is safe on every boot in every database.
 * Every ADD COLUMN in drizzle/postgres after 0000 must be listed here (client.test.ts checks).
 */
export const ADDITIVE_COLUMNS = [
  'ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "facebook_url" text',
] as const

/** Add any missing additive columns, then verify the schema answers. */
export async function assertDatabaseReady(db = getDb()): Promise<void> {
  for (const statement of ADDITIVE_COLUMNS) {
    try {
      await db.execute(sql.raw(statement))
    } catch (err) {
      // Never block boot on this; the app stays up and the query error names the column.
      console.warn(
        `schema: could not run "${statement}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  await db.select().from(schema.settings).limit(1)
}
export async function createTestDb(): Promise<Db> {
  return (await import('./testing.ts')).createIsolatedTestDb()
}
export { schema }
