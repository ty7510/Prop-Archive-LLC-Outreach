import { describe, expect, it } from 'vitest'
import { ephemeralDbProblem } from './client.ts'

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
