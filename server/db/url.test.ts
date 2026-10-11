import { describe, expect, it } from 'vitest'
import { DEFAULT_DATABASE_URL, resolveDatabaseUrl } from './url.ts'
import { parseEnv } from '../env.ts'
import { ephemeralDbProblem } from './client.ts'

describe('database URL configuration', () => {
  it.each([undefined, '', '  ', 'postgres://example/db?sslmode=require', 'postgresql://example/db'])(
    'uses the SQLite default for an unset or injected PostgreSQL URL: %s',
    (value) => {
      expect(resolveDatabaseUrl(value)).toBe(DEFAULT_DATABASE_URL)
      expect(parseEnv({ DATABASE_URL: value }).DATABASE_URL).toBe(DEFAULT_DATABASE_URL)
    },
  )
  it.each(['file:./data/existing.db', 'file::memory:', 'libsql://example.turso.io'])(
    'preserves an explicitly configured SQLite/libsql URL: %s',
    (value) => expect(resolveDatabaseUrl(value)).toBe(value),
  )
  it('keeps the published-file data-loss safeguard enabled', () => {
    expect(ephemeralDbProblem(resolveDatabaseUrl('postgres://example/db'), {
      REPLIT_DEPLOYMENT: '1',
    })).not.toBeNull()
  })
})
