import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { registerModule, resetModules } from '../contracts.ts'
import { createTestDb, type Db } from '../db/client.ts'
import { jobRuns, leads, providerUsage } from '../db/schema.ts'
import {
  enrichLeads,
  pickBatch,
  researchPause,
  type OrchestratorDeps,
} from '../enrich/orchestrator.ts'
import { recordUsage } from '../enrich/usage.ts'
import { fakeProvider, insertLead } from '../enrich/testing.ts'
import { updateSettings } from '../lib/settings.ts'

let db: Db
let agent: ReturnType<typeof request.agent>

beforeEach(async () => {
  db = await createTestDb()
  const app = createApp(db, { serveClient: false })
  agent = request.agent(app)
  const res = await agent.post('/api/login').send({ password: 'test-password' })
  expect(res.status).toBe(200)
})

afterEach(() => {
  resetModules()
})

function registerReal(providers: OrchestratorDeps['providers'] = {}) {
  registerModule('enrich', {
    pickBatch: (limit) => pickBatch(limit, { db }),
    enrichLeads: (ids) => enrichLeads(ids, { db, providers }),
    researchPause: () => researchPause({ db, providers }),
  })
}

describe('POST /api/leads/enrich', () => {
  it('is 401 without a session and 501 before the module is registered', async () => {
    const app = createApp(db, { serveClient: false })
    expect((await request(app).post('/api/leads/enrich').send({ all: true })).status).toBe(401)
    const res = await agent.post('/api/leads/enrich').send({ all: true })
    expect(res.status).toBe(501)
    expect(res.body).toEqual({ error: 'not built yet', code: 'NOT_BUILT' })
  })

  it('answers 409 while the autopilot holds the enrich lock', async () => {
    registerReal()
    await db.insert(jobRuns).values({
      id: 'running-enrich',
      job: 'enrich',
      started_at: new Date().toISOString(),
      status: 'running',
    })
    const res = await agent.post('/api/leads/enrich').send({ all: true })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('RUNNING')
  })

  it('validates the body', async () => {
    registerReal()
    const empty = await agent.post('/api/leads/enrich').send({})
    expect(empty.status).toBe(400)
    expect(empty.body.code).toBe('VALIDATION')
    expect(empty.body.error).toMatch(/ids .* or all: true/)
    const bad = await agent.post('/api/leads/enrich').send({ ids: 'x' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('VALIDATION')
  })

  it('enriches the given ids and returns counts', async () => {
    await updateSettings({ enrichment: { providers: ['li_license', 'pdl'] } }, db)
    const li = fakeProvider('li_license', { full_name: 'Maya Lopez' })
    registerReal({ li_license: li })
    const lead = await insertLead(db, { company: 'X LLC' })
    const dnc = await insertLead(db, { do_not_contact: true })
    const res = await agent.post('/api/leads/enrich').send({ ids: [lead.id, dnc.id, 'missing'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ enriched: 1, failed: 0, skipped: 2 })
    const after = (await db.select().from(leads).where(eq(leads.id, lead.id)))[0]!
    expect(after.status).toBe('enriched')
    expect(after.full_name).toBe('Maya Lopez')
    expect(after.first_name).toBe('Maya')
  })

  it('all: true picks every eligible new lead', async () => {
    await updateSettings({ enrichment: { providers: ['li_license'] }, min_icp_score: 50 }, db)
    registerReal({ li_license: fakeProvider('li_license', { company: 'Y LLC' }) })
    const a = await insertLead(db, { icp_score: 60 })
    const b = await insertLead(db, { icp_score: 80 })
    await insertLead(db, { icp_score: 10 })
    await insertLead(db, { status: 'enriched' })
    const res = await agent.post('/api/leads/enrich').send({ all: true })
    expect(res.body).toEqual({ enriched: 2, failed: 0, skipped: 0 })
    for (const id of [a.id, b.id]) {
      const row = (await db.select().from(leads).where(eq(leads.id, id)))[0]!
      expect(row.status).toBe('enriched')
      expect(row.company).toBe('Y LLC')
    }
  })

  it('works with no provider keys at all: only the free provider runs', async () => {
    registerReal()
    const lead = await insertLead(db, { company: 'Z LLC' })
    const res = await agent.post('/api/leads/enrich').send({ ids: [lead.id] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ enriched: 1, failed: 0, skipped: 0 })
    expect(await db.select().from(providerUsage)).toHaveLength(0)
  })
})

describe('POST /api/leads/enrich when research is out of lookups', () => {
  it('says the monthly research limit is used up, instead of a bare "Enriched 0"', async () => {
    await updateSettings(
      {
        enrichment: {
          providers: ['li_license', 'claude_research'],
          monthly_credit_cap: { hunter: 50, apollo: 100, pdl: 50, claude_research: 2 },
        },
      },
      db,
    )
    const research = fakeProvider('claude_research', { email: 'x@example.com' })
    registerReal({ li_license: fakeProvider('li_license', {}), claude_research: research })
    await insertLead(db, {})
    await recordUsage('claude_research', 2, null, new Date(), db)
    const res = await agent.post('/api/leads/enrich').send({ all: true })
    expect(res.status).toBe(200)
    expect(res.body.research_paused).toEqual({ reason: 'cap', used: 2, cap: 2 })
    expect(research.calls).toHaveLength(0)
  })
})

describe('GET /api/enrich/usage', () => {
  it('reports credits used this month per provider with caps and configuration', async () => {
    await db.insert(providerUsage).values([
      { id: 'u1', provider: 'hunter', lead_id: null, credits: 2, at: new Date().toISOString() },
      { id: 'u2', provider: 'hunter', lead_id: null, credits: 1, at: new Date().toISOString() },
      { id: 'u3', provider: 'pdl', lead_id: null, credits: 1, at: '2020-01-01T00:00:00.000Z' },
    ])
    const res = await agent.get('/api/enrich/usage')
    expect(res.status).toBe(200)
    expect(res.body.month).toMatch(/^\d{4}-\d{2}$/)
    expect(res.body.tz).toBe('America/New_York')
    const byId = Object.fromEntries(
      (res.body.providers as { provider: string }[]).map((p) => [p.provider, p]),
    )
    expect(Object.keys(byId).sort()).toEqual(
      ['apollo', 'claude_research', 'hunter', 'li_license', 'pdl'].sort(),
    )
    expect(byId.hunter).toEqual({
      provider: 'hunter',
      used: 3,
      calls: 2,
      cap: 50,
      enabled: true,
      configured: false,
      env_keys: ['HUNTER_API_KEY'],
    })
    expect(byId.pdl).toMatchObject({ used: 0, calls: 0, cap: 50 })
    expect(byId.li_license).toMatchObject({ cap: null, configured: true, env_keys: [] })
    expect(byId.claude_research).toMatchObject({ cap: 200, env_keys: ['CLAUDE_API_KEY'] })
  })

  it('is 401 without a session', async () => {
    const app = createApp(db, { serveClient: false })
    expect((await request(app).get('/api/enrich/usage')).status).toBe(401)
  })
})
