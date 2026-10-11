// Drizzle + libsql client factory, migrations on boot, app singleton, test helper. Owned by the scaffold.
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import * as schema from './schema.ts'

export type Db = LibSQLDatabase<typeof schema>

export const DEFAULT_DATABASE_URL = 'file:./data/outreach.db'

/** Make sure the folder for a `file:` URL exists. No-op for memory databases. */
export function ensureDbFolder(url: string): void {
  if (!url.startsWith('file:')) return
  const path = url.slice('file:'.length).split('?')[0] ?? ''
  if (!path || path === ':memory:' || path.startsWith(':')) return
  const dir = dirname(resolve(process.cwd(), path))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** Create a drizzle database for a libsql URL (`file:./data/outreach.db` or `file::memory:`). */
export function createDb(url: string): Db {
  ensureDbFolder(url)
  const client = createClient({ url })
  return drizzle(client, { schema })
}

function findMigrationsFolder(): string {
  const candidates = [
    resolve(process.cwd(), 'drizzle'),
    fileURLToPath(new URL('../../drizzle', import.meta.url)),
    fileURLToPath(new URL('../../../../drizzle', import.meta.url)),
  ]
  for (const c of candidates) {
    if (existsSync(resolve(c, 'meta', '_journal.json'))) return c
  }
  throw new Error('drizzle/ migrations folder not found. Run: npm run db:generate')
}

/** Run the SQL migrations in drizzle/ and turn on foreign keys. Safe to call on every boot. */
export async function applyMigrations(db: Db): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = ON`)
  await migrate(db, { migrationsFolder: findMigrationsFolder() })
}

/** True when the database answers a trivial query. */
export async function dbOk(db: Db): Promise<boolean> {
  try {
    await db.run(sql`SELECT 1`)
    return true
  } catch {
    return false
  }
}

let defaultDb: Db | null = null

/**
 * The app's database. Created on first use from DATABASE_URL (default file:./data/outreach.db).
 * createApp(db) and tests call setDefaultDb so lib helpers share one connection.
 */
export function getDb(): Db {
  if (!defaultDb) {
    defaultDb = createDb(process.env.DATABASE_URL || DEFAULT_DATABASE_URL)
  }
  return defaultDb
}

export function setDefaultDb(db: Db | null): void {
  defaultDb = db
}

/** A fresh in-memory database with all migrations applied. One per test file or test. */
export async function createTestDb(): Promise<Db> {
  const db = createDb('file::memory:')
  await applyMigrations(db)
  return db
}

export { schema }
