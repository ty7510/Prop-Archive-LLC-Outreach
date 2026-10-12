import { describe, expect, it } from 'vitest'
import { resolveDatabaseConfig } from './client.ts'
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
