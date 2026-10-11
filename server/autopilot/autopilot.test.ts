import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetModules } from '../contracts.ts'
import { createTestDb, type Db } from '../db/client.ts'
import { jobRuns } from '../db/schema.ts'
import { invalidateSettingsCache, updateSettings } from '../lib/settings.ts'
import { Autopilot } from './autopilot.ts'
import { INSIDE_WINDOW, clock, registerFakes } from './testFakes.ts'

let db: Db
let calls: string[]
let pilot: Autopilot | null = null

beforeEach(async () => {
  db = await createTestDb()
  invalidateSettingsCache()
  calls = []
  registerFakes(calls)
})

afterEach(() => {
  pilot?.stop()
  pilot = null
  resetModules()
})

async function waitFor(pred: () => Promise<boolean> | boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out waiting')
}

describe('Autopilot', () => {
  it('status before anything ran', async () => {
    pilot = new Autopilot({ db: () => db, now: () => INSIDE_WINDOW })
    const s = await pilot.status()
    expect(s).toEqual({
      on: false,
      liveMode: false,
      lastTick: null,
      nextTick: null,
      today: {
        discovered: 0,
        enriched: 0,
        enrolled: 0,
        sent: 0,
        queued: 0,
        replied: 0,
        booked: 0,
        joined: 0,
      },
      jobs: {},
    })
    expect(pilot.running).toBe(false)
  })

  it('a manual tick runs even while autopilot is off and shows up in status', async () => {
    pilot = new Autopilot({ db: () => db, now: () => INSIDE_WINDOW })
    const t = await pilot.runTick()
    expect(t.jobs).toHaveLength(6)
    expect(calls).toContain('discover')
    const s = await pilot.status()
    expect(s.on).toBe(false)
    expect(s.lastTick).toBe(INSIDE_WINDOW.toISOString())
    expect(s.nextTick).toBeNull()
    expect(Object.keys(s.jobs).sort()).toEqual([
      'discover',
      'enrich',
      'enroll',
      'housekeeping',
      'send',
      'sync_replies',
    ])
    expect(s.jobs.send?.status).toBe('ok')
    expect(s.jobs.send?.summary).toEqual({ sent: 0, dryRun: 4, queued: 2, skipped: 0 })
  })

  it('lastTick falls back to the newest job run after a restart', async () => {
    await db.insert(jobRuns).values([
      { id: 'a', job: 'send', started_at: '2026-10-12T15:00:00.000Z', status: 'ok' },
      { id: 'b', job: 'enrich', started_at: '2026-10-12T16:00:00.000Z', status: 'ok' },
    ])
    pilot = new Autopilot({ db: () => db, now: () => INSIDE_WINDOW })
    expect((await pilot.status()).lastTick).toBe('2026-10-12T16:00:00.000Z')
  })

  it('start schedules the interval but ticks only while settings.autopilot_on', async () => {
    const c = clock(INSIDE_WINDOW)
    pilot = new Autopilot({ db: () => db, now: c.now, intervalMs: 15 })
    pilot.start()
    expect(pilot.running).toBe(true)
    // nextTick is hidden while off
    expect((await pilot.status()).nextTick).toBeNull()
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toEqual([])
    expect(await db.select().from(jobRuns)).toHaveLength(0)

    await updateSettings({ autopilot_on: true }, db)
    const s = await pilot.status()
    expect(s.on).toBe(true)
    expect(s.nextTick).toBe(new Date(INSIDE_WINDOW.getTime() + 15).toISOString())
    await waitFor(() => calls.includes('send'))
    expect(calls.slice(0, 6)).toEqual([
      'discover',
      'pickBatch:10',
      'enrichLeads',
      'enroll',
      'send',
      'sync_replies',
    ])

    pilot.stop()
    expect(pilot.running).toBe(false)
    expect((await pilot.status()).nextTick).toBeNull()
    const before = calls.length
    await new Promise((r) => setTimeout(r, 60))
    expect(calls.length).toBe(before)
  })

  it('start twice keeps one interval, stop twice is harmless', async () => {
    pilot = new Autopilot({ db: () => db, now: () => INSIDE_WINDOW, intervalMs: 60_000 })
    pilot.start()
    pilot.start()
    expect(pilot.running).toBe(true)
    pilot.stop()
    pilot.stop()
    expect(pilot.running).toBe(false)
  })

  it('two overlapping runTick calls share one tick', async () => {
    pilot = new Autopilot({ db: () => db, now: () => INSIDE_WINDOW })
    const a = pilot.runTick()
    const b = pilot.runTick()
    expect(a).toBe(b)
    await a
    expect(calls.filter((x) => x === 'discover')).toHaveLength(1)
    // and a later tick is a new one
    const t2 = await pilot.runTick()
    expect(t2.jobs.find((j) => j.job === 'discover')?.status).toBe('not_due')
  })
})
