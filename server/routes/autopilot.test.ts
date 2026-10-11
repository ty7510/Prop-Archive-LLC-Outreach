import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.ts'
import { registerModule, resetModules } from '../contracts.ts'
import { createTestDb, type Db } from '../db/client.ts'
import { invalidateSettingsCache } from '../lib/settings.ts'
import { Autopilot } from '../autopilot/autopilot.ts'
import { INSIDE_WINDOW, registerFakes } from '../autopilot/testFakes.ts'
import { JOB_ORDER } from '../autopilot/tick.ts'

let db: Db
let pilot: Autopilot
let calls: string[]
let agent: ReturnType<typeof request.agent>

beforeEach(async () => {
  db = await createTestDb()
  invalidateSettingsCache()
  calls = []
  registerFakes(calls)
  pilot = new Autopilot({ db: () => db, now: () => INSIDE_WINDOW, intervalMs: 60_000 })
  registerModule('autopilot', pilot)
  const app = createApp(db, { serveClient: false })
  agent = request.agent(app)
  const res = await agent.post('/api/login').send({ password: 'test-password' })
  expect(res.status).toBe(200)
})

afterEach(() => {
  pilot.stop()
  resetModules()
})

describe('/api/autopilot', () => {
  it('needs a login', async () => {
    const app = createApp(db, { serveClient: false })
    const res = await request(app).get('/api/autopilot')
    expect(res.status).toBe(401)
  })

  it('is 501 NOT_BUILT when no module is registered', async () => {
    resetModules()
    const res = await agent.get('/api/autopilot')
    expect(res.status).toBe(501)
    expect(res.body).toEqual({ error: 'not built yet', code: 'NOT_BUILT' })
  })

  it('GET returns the status shape', async () => {
    const res = await agent.get('/api/autopilot')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
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
  })

  it('POST start flips the setting and schedules; POST stop undoes both', async () => {
    const start = await agent.post('/api/autopilot/start')
    expect(start.status).toBe(200)
    expect(start.body.on).toBe(true)
    expect(typeof start.body.nextTick).toBe('string')
    expect(pilot.running).toBe(true)
    expect((await agent.get('/api/settings')).body.autopilot_on).toBe(true)
    expect((await agent.get('/api/health')).body.autopilotOn).toBe(true)

    const stop = await agent.post('/api/autopilot/stop')
    expect(stop.status).toBe(200)
    expect(stop.body.on).toBe(false)
    expect(stop.body.nextTick).toBeNull()
    expect(pilot.running).toBe(false)
    expect((await agent.get('/api/settings')).body.autopilot_on).toBe(false)
    expect((await agent.get('/api/health')).body.autopilotOn).toBe(false)
  })

  it('POST tick runs one tick now and returns the per-job summary with the status', async () => {
    const res = await agent.post('/api/autopilot/tick')
    expect(res.status).toBe(200)
    expect(res.body.on).toBe(false)
    expect(res.body.lastTick).toBe(INSIDE_WINDOW.toISOString())
    expect(res.body.tick.jobs.map((j: { job: string }) => j.job)).toEqual([...JOB_ORDER])
    expect(res.body.tick.jobs.every((j: { status: string }) => j.status === 'ok')).toBe(true)
    expect(res.body.jobs.discover.status).toBe('ok')
    expect(res.body.jobs.discover.summary).toEqual({ created: 2, merged: 1, skipped: 0 })
    expect(calls).toContain('send')

    const again = await agent.post('/api/autopilot/tick')
    expect(again.body.tick.jobs.find((j: { job: string }) => j.job === 'discover').status).toBe(
      'not_due',
    )
  })

  it('POST tick works with a module that only implements the contract', async () => {
    resetModules()
    let ticks = 0
    registerModule('autopilot', {
      start() {},
      stop() {},
      async tick() {
        ticks++
      },
      async status() {
        return pilot.status()
      },
    })
    const res = await agent.post('/api/autopilot/tick')
    expect(res.status).toBe(200)
    expect(ticks).toBe(1)
    expect(res.body.tick).toBeNull()
  })
})

describe('/api/activity', () => {
  it('lists newest first and honours limit', async () => {
    await agent.post('/api/autopilot/tick')
    const res = await agent.get('/api/activity')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(6)
    const ats = res.body.map((e: { at: string }) => e.at)
    expect([...ats].sort().reverse()).toEqual(ats)
    expect(res.body.every((e: { level: string }) => e.level === 'info')).toBe(true)
    expect(res.body.map((e: { event: string }) => e.event).sort()).toEqual([...JOB_ORDER].sort())

    const two = await agent.get('/api/activity?limit=2')
    expect(two.body).toHaveLength(2)
  })

  it('rejects a bad limit', async () => {
    const res = await agent.get('/api/activity?limit=0')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION')
    expect((await agent.get('/api/activity?limit=abc')).status).toBe(400)
  })

  it('needs a login', async () => {
    const res = await request(createApp(db, { serveClient: false })).get('/api/activity')
    expect(res.status).toBe(401)
  })
})
