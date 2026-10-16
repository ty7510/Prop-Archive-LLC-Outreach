import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetModules } from '../contracts.ts'
import { createTestDb, type Db } from '../db/client.ts'
import { activityLog, jobRuns } from '../db/schema.ts'
import { invalidateSettingsCache } from '../lib/settings.ts'
import { hasEmDash } from '../lib/text.ts'
import { INSIDE_WINDOW, OUTSIDE_WINDOW, clock, registerFakes } from './testFakes.ts'
import { JOB_ORDER, runTick, type TickSummary } from './tick.ts'

let db: Db
let calls: string[]

beforeEach(async () => {
  db = await createTestDb()
  invalidateSettingsCache()
  calls = []
})

afterEach(() => {
  resetModules()
})

const statuses = (t: TickSummary) => Object.fromEntries(t.jobs.map((j) => [j.job, j.status]))

describe('runTick', () => {
  it('runs the seven jobs in spec order and records ok rows', async () => {
    registerFakes(calls)
    const c = clock(INSIDE_WINDOW)
    const t = await runTick({ db, now: c.now, warned: new Set() })

    expect(t.jobs.map((j) => j.job)).toEqual([...JOB_ORDER])
    expect(statuses(t)).toEqual({
      discover: 'ok',
      enrich: 'ok',
      enroll: 'ok',
      send: 'ok',
      todo: 'ok',
      sync_replies: 'ok',
      housekeeping: 'ok',
    })
    expect(calls).toEqual([
      'discover',
      'pickBatch:10',
      'enrichLeads',
      'enroll',
      'send',
      'todo',
      'sync_replies',
    ])
    expect(t.jobs.find((j) => j.job === 'enrich')?.summary).toEqual({
      picked: 2,
      enriched: 2,
      failed: 0,
      skipped: 0,
    })
    expect(t.jobs.find((j) => j.job === 'housekeeping')?.summary).toMatchObject({
      expired_locks: 0,
      today: { discovered: 0, sent: 0 },
    })

    const rows = await db.select().from(jobRuns)
    expect(rows).toHaveLength(7)
    expect(rows.every((r) => r.status === 'ok')).toBe(true)
    expect(rows.every((r) => r.started_at === INSIDE_WINDOW.toISOString())).toBe(true)

    const log = await db.select().from(activityLog)
    expect(log).toHaveLength(7)
    expect(log.every((l) => l.level === 'info')).toBe(true)
    expect(log.map((l) => l.event).sort()).toEqual([...JOB_ORDER].sort())
    expect(log.find((l) => l.event === 'send')?.detail).toEqual({
      sent: 0,
      dryRun: 4,
      queued: 2,
      skipped: 0,
    })
  })

  it('a minute later: discover, sync_replies and housekeeping are not due, the rest run', async () => {
    registerFakes(calls)
    const c = clock(INSIDE_WINDOW)
    await runTick({ db, now: c.now, warned: new Set() })
    calls.length = 0
    c.advanceMinutes(1)
    const t = await runTick({ db, now: c.now, warned: new Set() })
    expect(statuses(t)).toEqual({
      discover: 'not_due',
      enrich: 'ok',
      enroll: 'ok',
      send: 'ok',
      todo: 'ok',
      sync_replies: 'not_due',
      housekeeping: 'not_due',
    })
    expect(calls).toEqual(['pickBatch:10', 'enrichLeads', 'enroll', 'send', 'todo'])
  })

  it('sync_replies runs again after 10 minutes, housekeeping after an hour, discover the next day', async () => {
    registerFakes(calls)
    const c = clock(INSIDE_WINDOW)
    await runTick({ db, now: c.now, warned: new Set() })

    c.advanceMinutes(11)
    let t = await runTick({ db, now: c.now, warned: new Set() })
    expect(statuses(t)).toMatchObject({
      discover: 'not_due',
      sync_replies: 'ok',
      housekeeping: 'not_due',
    })

    c.advanceMinutes(50) // 61 minutes after the first tick
    t = await runTick({ db, now: c.now, warned: new Set() })
    expect(statuses(t)).toMatchObject({ discover: 'not_due', housekeeping: 'ok' })

    // 23:59 New York the same day: still not due.
    c.set(new Date('2026-10-14T03:59:00.000Z'))
    t = await runTick({ db, now: c.now, warned: new Set() })
    expect(statuses(t).discover).toBe('not_due')

    // 00:00 New York the next day: due again.
    c.set(new Date('2026-10-14T04:00:00.000Z'))
    t = await runTick({ db, now: c.now, warned: new Set() })
    expect(statuses(t).discover).toBe('ok')
  })

  it('skips a job whose lock is held and still runs the others', async () => {
    registerFakes(calls)
    await db.insert(jobRuns).values({
      id: 'held',
      job: 'enrich',
      started_at: new Date(INSIDE_WINDOW.getTime() - 60_000).toISOString(),
      status: 'running',
    })
    const t = await runTick({ db, now: () => INSIDE_WINDOW, warned: new Set() })
    expect(statuses(t)).toMatchObject({
      discover: 'ok',
      enrich: 'skipped',
      enroll: 'ok',
      send: 'ok',
    })
    expect(calls).not.toContain('pickBatch:10')
    expect(calls).toContain('enroll')
    // The held row is untouched and no second enrich row was written.
    const rows = await db.select().from(jobRuns).where(eq(jobRuns.job, 'enrich'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('running')
  })

  it('a stale lock (older than 10 minutes) does not block the job', async () => {
    registerFakes(calls)
    await db.insert(jobRuns).values({
      id: 'stale',
      job: 'send',
      started_at: new Date(INSIDE_WINDOW.getTime() - 11 * 60_000).toISOString(),
      status: 'running',
    })
    const t = await runTick({ db, now: () => INSIDE_WINDOW, warned: new Set() })
    expect(statuses(t).send).toBe('ok')
    // housekeeping ran in the same tick and expired it
    expect(t.jobs.find((j) => j.job === 'housekeeping')?.summary).toMatchObject({
      expired_locks: 1,
    })
  })

  it('treats missing modules as not_built with one warn line each, and never throws', async () => {
    resetModules()
    const warned = new Set<string>()
    const t = await runTick({ db, now: () => INSIDE_WINDOW, warned })
    expect(statuses(t)).toEqual({
      discover: 'not_built',
      enrich: 'not_built',
      enroll: 'not_built',
      send: 'not_built',
      todo: 'not_built',
      sync_replies: 'not_built',
      housekeeping: 'ok',
    })
    const warns = (await db.select().from(activityLog)).filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(3)
    expect(warns.map((w) => (w.detail as { module: string }).module).sort()).toEqual([
      'enrich',
      'outreach',
      'sources',
    ])
    expect(hasEmDash(JSON.stringify(warns))).toBe(false)

    // A second tick with the same memory adds no more warn lines.
    await runTick({ db, now: () => INSIDE_WINDOW, warned })
    const again = (await db.select().from(activityLog)).filter((l) => l.level === 'warn')
    expect(again).toHaveLength(3)
    // and only housekeeping took a lock row
    const rows = await db.select().from(jobRuns)
    expect(rows.map((r) => r.job)).toEqual(['housekeeping'])
  })

  it('records a failing job as error and moves on to the next job', async () => {
    registerFakes(calls, { discoverError: 'carto is down' })
    const t = await runTick({ db, now: () => INSIDE_WINDOW, warned: new Set() })
    const discover = t.jobs.find((j) => j.job === 'discover')
    expect(discover?.status).toBe('error')
    expect(discover?.error).toBe('carto is down')
    expect(statuses(t)).toMatchObject({ enrich: 'ok', enroll: 'ok', send: 'ok' })

    const [row] = await db.select().from(jobRuns).where(eq(jobRuns.job, 'discover'))
    expect(row?.status).toBe('error')
    expect(row?.error).toBe('carto is down')
    const errors = (await db.select().from(activityLog)).filter((l) => l.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.detail).toEqual({ error: 'carto is down' })
  })

  it('a failed discover is tried again on the next tick of the same day', async () => {
    registerFakes(calls, { discoverError: 'carto is down' })
    const c = clock(INSIDE_WINDOW)
    const first = await runTick({ db, now: c.now, warned: new Set() })
    expect(statuses(first).discover).toBe('error')
    c.advanceMinutes(1)
    const second = await runTick({ db, now: c.now, warned: new Set() })
    expect(statuses(second).discover).toBe('error') // tried again, not 'not_due'
    expect(calls.filter((x) => x === 'discover')).toHaveLength(2)
    const rows = await db.select().from(jobRuns).where(eq(jobRuns.job, 'discover'))
    expect(rows).toHaveLength(2)
  })

  it('does not send outside the send window', async () => {
    registerFakes(calls)
    const t = await runTick({ db, now: () => OUTSIDE_WINDOW, warned: new Set() })
    expect(statuses(t)).toMatchObject({ enroll: 'ok', send: 'outside_window' })
    expect(calls).not.toContain('send')
    const rows = await db.select().from(jobRuns).where(eq(jobRuns.job, 'send'))
    expect(rows).toHaveLength(0)
  })

  it('does not call enrichLeads when the batch is empty', async () => {
    registerFakes(calls, { batch: [] })
    const t = await runTick({ db, now: () => INSIDE_WINDOW, warned: new Set() })
    expect(t.jobs.find((j) => j.job === 'enrich')?.summary).toEqual({
      picked: 0,
      enriched: 0,
      failed: 0,
      skipped: 0,
    })
    expect(calls).not.toContain('enrichLeads')
  })
})
