import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, type Db } from '../db/client.ts'
import { jobRuns } from '../db/schema.ts'
import { expireStaleLocks, lastRuns, withJobLock } from './locks.ts'

let db: Db

beforeEach(async () => {
  db = await createTestDb()
})

describe('withJobLock', () => {
  it('runs the job and records an ok row with the summary', async () => {
    const r = await withJobLock('send', async () => ({ sent: 3 }), db)
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.result).toEqual({ sent: 3 })
    const rows = await db.select().from(jobRuns)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('ok')
    expect(rows[0]?.job).toBe('send')
    expect(rows[0]?.summary).toEqual({ sent: 3 })
    expect(rows[0]?.finished_at).toBeTruthy()
  })

  it('skips while a running row younger than 10 minutes exists', async () => {
    let ran = 0
    // Start one job and hold it open.
    let release!: () => void
    const held = new Promise<void>((res) => (release = res))
    const first = withJobLock(
      'enrich',
      async () => {
        ran++
        await held
        return 'a'
      },
      db,
    )
    // Give the first call a moment to insert its running row.
    await new Promise((r) => setTimeout(r, 20))
    const second = await withJobLock(
      'enrich',
      async () => {
        ran++
        return 'b'
      },
      db,
    )
    expect(second).toEqual({ skipped: true, reason: 'running' })
    release()
    const r1 = await first
    expect(r1.skipped).toBe(false)
    expect(ran).toBe(1)
  })

  it('does not block a different job', async () => {
    await db.insert(jobRuns).values({
      id: 'x',
      job: 'discover',
      started_at: new Date().toISOString(),
      status: 'running',
    })
    const r = await withJobLock('send', async () => 1, db)
    expect(r.skipped).toBe(false)
  })

  it('ignores a running row older than 10 minutes', async () => {
    const old = new Date(Date.now() - 11 * 60_000).toISOString()
    await db.insert(jobRuns).values({ id: 'old', job: 'send', started_at: old, status: 'running' })
    const r = await withJobLock('send', async () => 'ok', db)
    expect(r.skipped).toBe(false)
  })

  it('records errors and rethrows', async () => {
    await expect(
      withJobLock(
        'sync_replies',
        async () => {
          throw new Error('imap down')
        },
        db,
      ),
    ).rejects.toThrow('imap down')
    const [row] = await db.select().from(jobRuns).where(eq(jobRuns.job, 'sync_replies'))
    expect(row?.status).toBe('error')
    expect(row?.error).toBe('imap down')
    // and the lock is free again
    const r = await withJobLock('sync_replies', async () => 'fine', db)
    expect(r.skipped).toBe(false)
  })

  it('uses the injected clock', async () => {
    const fixed = new Date('2026-10-11T12:00:00Z')
    await withJobLock(
      'housekeeping',
      async () => null,
      db,
      () => fixed,
    )
    const [row] = await db.select().from(jobRuns)
    expect(row?.started_at).toBe('2026-10-11T12:00:00.000Z')
  })
})

describe('expireStaleLocks', () => {
  it('marks old running rows as errors', async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString()
    await db.insert(jobRuns).values([
      { id: 'a', job: 'send', started_at: old, status: 'running' },
      { id: 'b', job: 'send', started_at: new Date().toISOString(), status: 'running' },
    ])
    expect(await expireStaleLocks(db)).toBe(1)
    const rows = await db.select().from(jobRuns)
    expect(rows.find((r) => r.id === 'a')?.status).toBe('error')
    expect(rows.find((r) => r.id === 'b')?.status).toBe('running')
  })
})

describe('lastRuns', () => {
  it('returns the newest run per job', async () => {
    await db.insert(jobRuns).values([
      { id: 'a', job: 'send', started_at: '2026-10-11T10:00:00.000Z', status: 'ok' },
      { id: 'b', job: 'send', started_at: '2026-10-11T11:00:00.000Z', status: 'error', error: 'x' },
      { id: 'c', job: 'enrich', started_at: '2026-10-11T09:00:00.000Z', status: 'ok' },
    ])
    const runs = await lastRuns(db)
    expect(runs.send?.started_at).toBe('2026-10-11T11:00:00.000Z')
    expect(runs.send?.status).toBe('error')
    expect(runs.enrich?.status).toBe('ok')
  })
})
