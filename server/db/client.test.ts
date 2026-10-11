import { describe, expect, it } from 'vitest'
import { ephemeralDbProblem, resolveDatabaseConfig } from './client.ts'

describe('ephemeralDbProblem', () => {
  it('refuses a file database in a published Replit app', () => {
    expect(ephemeralDbProblem('file:./data/outreach.db', { REPLIT_DEPLOYMENT: '1' })).toMatch(
      /DATABASE_URL/,
    )
  })

  it('allows a hosted database when published', () => {
    expect(
      ephemeralDbProblem('libsql://outreach-theo.turso.io', { REPLIT_DEPLOYMENT: '1' }),
    ).toBeNull()
  })

  it('allows the file database in the workspace and on a laptop', () => {
    expect(ephemeralDbProblem('file:./data/outreach.db', { REPL_ID: 'x' })).toBeNull()
    expect(ephemeralDbProblem('file:./data/outreach.db', {})).toBeNull()
  })

  it('can be overridden on purpose', () => {
    expect(
      ephemeralDbProblem('file:./data/outreach.db', {
        REPLIT_DEPLOYMENT: '1',
        ALLOW_FILE_DB_IN_DEPLOYMENT: '1',
      }),
    ).toBeNull()
  })
})

describe('resolveDatabaseConfig', () => {
  it('skips the Postgres DATABASE_URL Replit adds and falls back to the file', () => {
    const c = resolveDatabaseConfig({
      DATABASE_URL:
        'postgresql://neondb_owner:x@ep-1.us-east-2.aws.neon.tech/neondb?sslmode=require',
    })
    expect(c.url).toBe('file:./data/outreach.db')
    expect(c.ignored).toMatch(/OUTREACH_DATABASE_URL/)
  })

  it('prefers OUTREACH_DATABASE_URL and its token', () => {
    expect(
      resolveDatabaseConfig({
        OUTREACH_DATABASE_URL: 'libsql://outreach-theo.turso.io',
        OUTREACH_DATABASE_AUTH_TOKEN: 'tok',
        DATABASE_URL: 'postgresql://x/y',
      }),
    ).toEqual({ url: 'libsql://outreach-theo.turso.io', authToken: 'tok' })
  })

  it('still reads a libsql or file DATABASE_URL', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'file::memory:' })).toEqual({
      url: 'file::memory:',
    })
    expect(resolveDatabaseConfig({})).toEqual({ url: 'file:./data/outreach.db' })
  })
})
