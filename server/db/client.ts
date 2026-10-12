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
/** Verify schema availability; production DDL is owned by Replit's Publish flow. */
export async function assertDatabaseReady(db = getDb()): Promise<void> {
  await db.select().from(schema.settings).limit(1)
}
export async function createTestDb(): Promise<Db> {
  return (await import('./testing.ts')).createIsolatedTestDb()
}
export { schema }
