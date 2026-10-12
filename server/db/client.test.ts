import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  ADDITIVE_COLUMNS,
  assertDatabaseReady,
  createTestDb,
  resolveDatabaseConfig,
} from './client.ts'
import { leads } from './schema.ts'
describe('Replit PostgreSQL configuration', () => {
  it.each(['postgresql://localhost/outreach', 'postgres://localhost/outreach'])(
    'uses the managed URL: %s',
    (url) => {
      expect(
        resolveDatabaseConfig({ DATABASE_URL: url, OUTREACH_DATABASE_URL: 'libsql://unused' }),
      ).toEqual({ url })
    },
  )
  it.each([undefined, '', 'file:./data/outreach.db', 'libsql://unused'])(
    'rejects missing or non-PostgreSQL URLs',
    (url) => {
      expect(() => resolveDatabaseConfig({ DATABASE_URL: url })).toThrow(
        'Replit PostgreSQL DATABASE_URL is required',
      )
    },
  )
})

describe('assertDatabaseReady', () => {
  it('adds a column a published database is missing, so lead queries work again', async () => {
    const db = await createTestDb()
    await db.execute(sql.raw('ALTER TABLE "leads" DROP COLUMN "facebook_url"'))
    await expect(db.select().from(leads).limit(1)).rejects.toThrow()
    await assertDatabaseReady(db)
    await expect(db.select().from(leads).limit(1)).resolves.toEqual([])
    // Safe to run again on every boot.
    await assertDatabaseReady(db)
  })

  it('lists every ADD COLUMN from the migrations after 0000', () => {
    const folder = resolve('drizzle/postgres')
    const added = readdirSync(folder)
      .filter((f) => f.endsWith('.sql') && !f.startsWith('0000'))
      .flatMap((f) => [
        ...readFileSync(resolve(folder, f), 'utf8').matchAll(
          /ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g,
        ),
      ])
      .map((m) => `"${m[1]}" ADD COLUMN IF NOT EXISTS "${m[2]}"`)
    expect(added.length).toBeGreaterThan(0)
    for (const column of added) {
      expect(ADDITIVE_COLUMNS.some((s) => s.includes(column))).toBe(true)
    }
  })
})
