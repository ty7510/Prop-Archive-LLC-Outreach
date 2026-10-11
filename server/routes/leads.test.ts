import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { modules, registerModule, resetModules } from '../contracts.ts'
import { createTestDb, type Db } from '../db/client.ts'
import { enrollments, events, leads, messages, sequences } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { nowIso } from '../lib/time.ts'
import { sourcesModule } from '../sources/index.ts'

const SAMPLE = resolve(process.cwd(), 'server/seed/sample-leads.csv')

async function loggedIn() {
  const db = await createTestDb()
  const app = createApp(db, { serveClient: false })
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ password: 'test-password' })
  expect(res.status).toBe(200)
  return { app, agent, db }
}

async function importSample(agent: ReturnType<typeof request.agent>) {
  const res = await agent.post('/api/leads/import').attach('file', SAMPLE)
  expect(res.status).toBe(200)
  return res.body as {
    import_id: string
    filename: string
    row_count: number
    created: number
    merged: number
    skipped: number
    errors: string[]
  }
}

describe('leads API', () => {
  let agent: ReturnType<typeof request.agent>
  let db: Db

  beforeEach(async () => {
    resetModules()
    registerModule('sources', sourcesModule)
    const ctx = await loggedIn()
    agent = ctx.agent
    db = ctx.db
  })
  afterEach(() => resetModules())

  it('needs a login', async () => {
    const fresh = createApp(await createTestDb(), { serveClient: false })
    expect((await request(fresh).get('/api/leads')).status).toBe(401)
  })

  it('lists nothing at first, with paging fields', async () => {
    const res = await agent.get('/api/leads')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], page: 1, limit: 50, total: 0 })
  })

  it('imports the 5 row sample CSV: 3 created, 1 merged, 1 skipped', async () => {
    const result = await importSample(agent)
    expect(result).toMatchObject({ row_count: 5, created: 3, merged: 1, skipped: 1 })
    expect(result.filename).toBe('sample-leads.csv')
    expect(result.errors).toEqual([
      expect.stringMatching(/^Line 6: skipped, no name, company or email/),
    ])

    const list = await agent.get('/api/leads')
    expect(list.body.total).toBe(3)
    const names = list.body.items.map((l: { display_name: string }) => l.display_name).sort()
    expect(names).toEqual(['Hall Property Management LLC', 'Maya Chen', 'Ray Okafor'])

    const ray = list.body.items.find(
      (l: { display_name: string }) => l.display_name === 'Ray Okafor',
    )
    expect(ray).toMatchObject({
      source: 'csv',
      status: 'new',
      persona: 'ray',
      owner_kind: 'person',
      company: 'Okafor Properties LLC',
      email: 'ray@okafor-properties.example.com',
      phone: '2155550102',
      mailing_street: '5214 Baltimore Ave',
      mailing_zip: '19143',
      property_count: 9,
      unit_count: 14,
      neighborhood: 'Southwest Philly',
      dedupe_key: '5214 BALTIMORE AVE|19143',
    })
    expect(ray.trigger).toEqual({ type: 'csv' })
    // the merged second row appended its note without clearing anything
    expect(ray.notes).toContain('Wants quarterly owner reports')
    expect(ray.notes).toContain('Second row for the same address')

    const denise = list.body.items.find(
      (l: { display_name: string }) => l.display_name === 'Hall Property Management LLC',
    )
    expect(denise).toMatchObject({ persona: 'denise', owner_kind: 'llc', full_name: null })
    expect(denise.neighborhood).toBe('Point Breeze / Graduate Hospital')
  })

  it('importing the same file twice only merges', async () => {
    await importSample(agent)
    const second = await importSample(agent)
    expect(second).toMatchObject({ created: 0, merged: 4, skipped: 1 })
    expect((await agent.get('/api/leads')).body.total).toBe(3)
  })

  it('rejects an import without a file, an empty file and unknown columns', async () => {
    const none = await agent.post('/api/leads/import')
    expect(none.status).toBe(400)
    expect(none.body.code).toBe('NO_FILE')

    const empty = await agent.post('/api/leads/import').attach('file', Buffer.from(''), 'empty.csv')
    expect(empty.status).toBe(400)
    expect(empty.body.code).toBe('EMPTY_FILE')

    const odd = await agent
      .post('/api/leads/import')
      .attach('file', Buffer.from('colour,shape\nred,round\n'), 'odd.csv')
    expect(odd.status).toBe(400)
    expect(odd.body.code).toBe('NO_KNOWN_COLUMNS')
    expect(odd.body.error).not.toContain('—')
  })

  it('filters by status, persona and q, and pages', async () => {
    await importSample(agent)
    expect((await agent.get('/api/leads?persona=maya')).body.items).toHaveLength(1)
    expect((await agent.get('/api/leads?persona=denise')).body.items[0].company).toBe(
      'Hall Property Management LLC',
    )
    expect((await agent.get('/api/leads?q=okafor')).body.items).toHaveLength(1)
    expect((await agent.get('/api/leads?q=19146')).body.items).toHaveLength(1)
    expect((await agent.get('/api/leads?q=nobody')).body.total).toBe(0)
    expect((await agent.get('/api/leads?status=new')).body.total).toBe(3)
    expect((await agent.get('/api/leads?status=booked,joined')).body.total).toBe(0)
    expect((await agent.get('/api/leads?status=bogus')).status).toBe(400)
    expect((await agent.get('/api/leads?persona=bogus')).status).toBe(400)

    const page2 = await agent.get('/api/leads?limit=2&page=2')
    expect(page2.body).toMatchObject({ page: 2, limit: 2, total: 3 })
    expect(page2.body.items).toHaveLength(1)
  })

  it('GET /api/leads/:id returns the lead with its lists, 404 otherwise', async () => {
    await importSample(agent)
    const list = await agent.get('/api/leads?q=maya')
    const id = list.body.items[0].id as string
    const res = await agent.get(`/api/leads/${id}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id,
      display_name: 'Maya Chen',
      properties: [],
      enrollments: [],
      messages: [],
      events: [],
    })
    expect((await agent.get('/api/leads/01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404)
  })

  it('PATCH changes notes, tags, status and do_not_contact and writes events', async () => {
    await importSample(agent)
    const id = (await agent.get('/api/leads?q=maya')).body.items[0].id as string

    const bad = await agent.patch(`/api/leads/${id}`).send({ icp_score: 100 })
    expect(bad.status).toBe(400)
    expect((await agent.patch(`/api/leads/${id}`).send({})).status).toBe(400)
    expect((await agent.patch(`/api/leads/${id}`).send({ status: 'enrolled' })).status).toBe(400)

    const res = await agent
      .patch(`/api/leads/${id}`)
      .send({ notes: 'Called, call back Tuesday', tags: ['warm', 'warm'], status: 'disqualified' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      notes: 'Called, call back Tuesday',
      tags: ['warm'],
      status: 'disqualified',
      display_name: 'Maya Chen',
    })

    const dnc = await agent.patch(`/api/leads/${id}`).send({ do_not_contact: true })
    expect(dnc.body.do_not_contact).toBe(true)

    const detail = await agent.get(`/api/leads/${id}`)
    const kinds = detail.body.events.map((e: { kind: string }) => e.kind).sort()
    expect(kinds).toEqual(['do_not_contact', 'note', 'status_change'])
  })

  it('outcome sets the status, writes an event, stops open enrollments and skips queued messages', async () => {
    await importSample(agent)
    const id = (await agent.get('/api/leads?q=okafor')).body.items[0].id as string
    const seqId = newId()
    await db.insert(sequences).values({
      id: seqId,
      name: 'Email Ray',
      channel: 'email',
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    const enrId = newId()
    await db.insert(enrollments).values({
      id: enrId,
      lead_id: id,
      sequence_id: seqId,
      status: 'active',
      started_at: nowIso(),
    })
    await db.insert(messages).values({
      id: newId(),
      lead_id: id,
      enrollment_id: enrId,
      channel: 'email',
      status: 'queued',
      idempotency_key: `${enrId}:1`,
      body: 'hi',
      created_at: nowIso(),
    })

    expect((await agent.post(`/api/leads/${id}/outcome`).send({ kind: 'nope' })).status).toBe(400)

    // The outreach module's leadOutreachRouter answers this path (mounted ahead of leadsRouter).
    const res = await agent.post(`/api/leads/${id}/outcome`).send({ kind: 'demo_booked' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('booked')

    const [enr] = await db.select().from(enrollments).where(eq(enrollments.id, enrId))
    expect(enr?.status).toBe('stopped_manual')
    expect(enr?.ended_at).toBeTruthy()
    const [msg] = await db.select().from(messages).where(eq(messages.lead_id, id))
    expect(msg?.status).toBe('skipped')
    const evs = await db.select().from(events).where(eq(events.lead_id, id))
    expect(evs.map((e) => e.kind)).toContain('demo_booked')

    const detail = await agent.get(`/api/leads/${id}`)
    expect(detail.body.enrollments[0]).toMatchObject({
      sequence_name: 'Email Ray',
      channel: 'email',
    })

    expect(
      (await agent.post(`/api/leads/${id}/outcome`).send({ kind: 'beta_joined' })).body.status,
    ).toBe('joined')
    expect(
      (await agent.post(`/api/leads/${id}/outcome`).send({ kind: 'not_interested' })).body.status,
    ).toBe('not_interested')
  })

  it('do not contact hands off to the outreach module when it is registered', async () => {
    await importSample(agent)
    const id = (await agent.get('/api/leads?q=maya')).body.items[0].id as string
    const calls: [string, string][] = []
    registerModule('outreach', {
      enrollEligible: async () => ({ enrolled: 0 }),
      enrollLead: async () => {},
      stopLead: async (leadId, reason) => {
        calls.push([leadId, reason])
      },
      sendDue: async () => ({ sent: 0, dryRun: 0, queued: 0, skipped: 0 }),
      syncReplies: async () => ({ received: 0 }),
      renderStep: async () => ({ body: '' }),
    })
    await agent.patch(`/api/leads/${id}`).send({ do_not_contact: true })
    expect(calls).toEqual([[id, 'do_not_contact']])
    expect(modules.outreach).toBeDefined()
  })

  it('enroll and stop are served by the outreach router with plain 404s', async () => {
    await importSample(agent)
    const id = (await agent.get('/api/leads?q=maya')).body.items[0].id as string
    const enroll = await agent.post(`/api/leads/${id}/enroll`).send({ sequence_id: 'x' })
    expect(enroll.status).toBe(404)
    expect(enroll.body.code).toBe('SEQUENCE_NOT_FOUND')
    const stop = await agent.post(`/api/leads/${id}/stop`).send({})
    expect(stop.status).toBe(200)
    expect(stop.body).toEqual({ ok: true, stopped: 0 })
    expect(
      (await agent.post('/api/leads/01ARZ3NDEKTSV4RRFFQ69G5FAV/enroll').send({ sequence_id: 'x' }))
        .status,
    ).toBe(404)
  })

  it('discover validates the body, takes the job lock and answers counts', async () => {
    registerModule('sources', {
      ...sourcesModule,
      discover: async (opts) => {
        expect(opts).toEqual({ zips: ['19104'], limit: 5 })
        return { created: 2, merged: 1, skipped: 0 }
      },
    })
    expect((await agent.post('/api/leads/discover').send({ zips: ['1910'] })).status).toBe(400)
    const res = await agent.post('/api/leads/discover').send({ zips: ['19104'], limit: 5 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ created: 2, merged: 1, skipped: 0 })
  })

  it('discover answers 409 while another discover run holds the lock', async () => {
    let release: () => void = () => {}
    registerModule('sources', {
      ...sourcesModule,
      discover: () =>
        new Promise((r) => {
          release = () => r({ created: 0, merged: 0, skipped: 0 })
        }),
    })
    // superagent only sends on .then, so start the first request explicitly
    const first = agent
      .post('/api/leads/discover')
      .send({})
      .then((r) => r)
    await new Promise((r) => setTimeout(r, 50))
    const second = await agent.post('/api/leads/discover').send({})
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('RUNNING')
    release()
    expect((await first).status).toBe(200)
  })

  it('answers 501 when the sources module is not registered', async () => {
    resetModules()
    expect((await agent.post('/api/leads/discover').send({})).status).toBe(501)
    expect((await agent.post('/api/leads/import').attach('file', SAMPLE)).status).toBe(501)
    // listing still works: it only needs the database
    expect((await agent.get('/api/leads')).status).toBe(200)
  })

  it('leads rows carry no em-dash anywhere', async () => {
    await importSample(agent)
    const res = await agent.get('/api/leads')
    expect(JSON.stringify(res.body)).not.toContain('—')
    const [row] = await db.select().from(leads).limit(1)
    expect(row).toBeDefined()
  })
})
