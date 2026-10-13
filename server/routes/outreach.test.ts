// Supertest coverage for the outreach routes: sequences, leads enroll/stop/outcome, queue, public, webhooks.
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { enrollments, events, leads, messages, suppression } from '../db/schema.ts'
import { ensureWebhookSecret } from '../lib/settings.ts'
import { enrollLead } from '../outreach/enroll.ts'
import { setOutreachDeps } from '../outreach/index.ts'
import { sendDue } from '../outreach/send.ts'
import { insertLead, insertSequence, setSettings, setup } from '../outreach/testFixtures.ts'
import { PUBLIC_HITS_PER_MINUTE, publicLimiter } from './public.ts'

afterEach(() => setOutreachDeps(null))

async function loggedIn(overrides: Parameters<typeof setup>[0] = {}) {
  const fx = await setup(overrides)
  setOutreachDeps(fx.deps)
  const app = createApp(fx.db, { serveClient: false })
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ password: 'test-password' })
  expect(res.status).toBe(200)
  return { ...fx, app, agent }
}

const create = {
  name: 'Ray email',
  channel: 'email',
  persona: 'ray',
  trigger: 'any',
  steps: [
    {
      delay_days: 0,
      subject: 'Hi {{first_name}}',
      body: 'Hello {{first_name}} in {{neighborhood}}. {{demo_link}}',
    },
    { delay_days: 3, subject: 'Again', body: 'Second. {{beta_link}}' },
  ],
}

describe('sequences routes', () => {
  it('needs a login', async () => {
    const fx = await setup()
    setOutreachDeps(fx.deps)
    const app = createApp(fx.db, { serveClient: false })
    expect((await request(app).get('/api/sequences')).status).toBe(401)
  })

  it('creates, lists, updates, previews and deletes', async () => {
    const { agent } = await loggedIn()
    const created = await agent.post('/api/sequences').send(create)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      name: 'Ray email',
      channel: 'email',
      persona: 'ray',
      active: true,
      enrolled_count: 0,
    })
    expect(created.body.steps).toHaveLength(2)
    expect(created.body.steps[1]).toMatchObject({ step_index: 1, delay_days: 3, channel: 'email' })
    const id = created.body.id as string

    const list = await agent.get('/api/sequences')
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].steps).toHaveLength(2)

    const put = await agent
      .put(`/api/sequences/${id}`)
      .send({ name: 'Ray email v2', active: false })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ name: 'Ray email v2', active: false })
    expect(put.body.steps).toHaveLength(2)

    const replaced = await agent
      .put(`/api/sequences/${id}`)
      .send({ steps: [{ delay_days: 1, subject: 'Only', body: 'One step {{site_link}}' }] })
    expect(replaced.status).toBe(200)
    expect(replaced.body.steps).toHaveLength(1)
    expect(replaced.body.steps[0]).toMatchObject({ step_index: 0, delay_days: 1 })

    const preview = await agent.post(`/api/sequences/${id}/preview`).send({})
    expect(preview.status).toBe(200)
    expect(preview.body).toHaveLength(1)
    expect(preview.body[0].subject).toBe('Only')
    expect(preview.body[0].body).toContain(
      'One step https://outreach.test/r/sample-token/site?c=email&s=ray-email-v2',
    )
    expect(preview.body[0].body).toContain('No more emails: https://outreach.test/u/sample-token')

    const del = await agent.delete(`/api/sequences/${id}`)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
    expect((await agent.get('/api/sequences')).body).toEqual([])
    expect((await agent.delete(`/api/sequences/${id}`)).status).toBe(404)
  })

  it('refuses an em-dash in a step body with a plain message', async () => {
    const { agent } = await loggedIn()
    const bad = await agent
      .post('/api/sequences')
      .send({ ...create, steps: [{ delay_days: 0, subject: 'Hi', body: 'Hello — there' }] })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('EM_DASH')
    expect(bad.body.error).toMatch(/Step 1/)
    expect((await agent.get('/api/sequences')).body).toEqual([])

    const ok = await agent.post('/api/sequences').send(create)
    const put = await agent.put(`/api/sequences/${ok.body.id}`).send({ name: 'Bad — name' })
    expect(put.status).toBe(400)
    expect(put.body.code).toBe('EM_DASH')
  })

  it('validates bodies and needs subjects for email', async () => {
    const { agent } = await loggedIn()
    expect((await agent.post('/api/sequences').send({ name: 'x' })).status).toBe(400)
    const noSubject = await agent
      .post('/api/sequences')
      .send({ ...create, steps: [{ delay_days: 0, body: 'no subject' }] })
    expect(noSubject.status).toBe(400)
    expect(noSubject.body.error).toMatch(/subject/)
    const li = await agent.post('/api/sequences').send({
      ...create,
      channel: 'linkedin',
      steps: [{ delay_days: 0, body: 'fine without subject' }],
    })
    expect(li.status).toBe(201)
  })

  it('previews for a real lead and refuses to delete a sequence with leads in it', async () => {
    const { agent, db, deps } = await loggedIn()
    const lead = await insertLead(db, { first_name: 'Denise', zips: ['19104'] })
    const created = await agent.post('/api/sequences').send(create)
    const id = created.body.id as string
    const preview = await agent.post(`/api/sequences/${id}/preview`).send({ lead_id: lead.id })
    expect(preview.body[0].subject).toBe('Hi Denise')
    expect(preview.body[0].body).toContain('Hello Denise in University City.')
    expect(
      (await agent.post(`/api/sequences/${id}/preview`).send({ lead_id: 'nope' })).status,
    ).toBe(404)

    await enrollLead(deps, lead.id, id)
    const del = await agent.delete(`/api/sequences/${id}`)
    expect(del.status).toBe(400)
    expect(del.body.code).toBe('SEQUENCE_IN_USE')
    expect((await agent.get('/api/sequences')).body[0].enrolled_count).toBe(1)
  })

  it('test-send explains what is missing, then emails Theo step 1', async () => {
    const { agent, db, outbox } = await loggedIn()
    const created = await agent.post('/api/sequences').send(create)
    const id = created.body.id as string
    const noAddress = await agent.post(`/api/sequences/${id}/test-send`)
    expect(noAddress.status).toBe(400)
    expect(noAddress.body.code).toBe('NO_ADDRESS')
    await setSettings(db, { physical_address: '1 Main St, Philadelphia, PA 19146' })
    const ok = await agent.post(`/api/sequences/${id}/test-send`)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true, to: 'theo@proparchive.biz' })
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.to).toBe('theo@proparchive.biz')
    expect(outbox[0]!.subject).toBe('[Test] Hi Ray')
    expect(outbox[0]!.text).toContain('1 Main St, Philadelphia, PA 19146')
  })

  it('test-send without any email provider is a plain 400', async () => {
    const { agent, db } = await loggedIn({ smtp: null })
    await setSettings(db, { physical_address: '1 Main St' })
    const created = await agent.post('/api/sequences').send(create)
    const res = await agent.post(`/api/sequences/${created.body.id}/test-send`)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('NO_EMAIL_PROVIDER')
    expect(res.body.error).toContain('Sending inboxes')
  })
})

describe('lead enroll / stop / outcome routes', () => {
  it('enrolls, refuses twice, stops, and records an outcome', async () => {
    const { agent, db } = await loggedIn()
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)

    expect((await agent.post(`/api/leads/${lead.id}/enroll`).send({})).status).toBe(400)
    const enroll = await agent
      .post(`/api/leads/${lead.id}/enroll`)
      .send({ sequence_id: sequence.id })
    expect(enroll.status).toBe(200)
    expect(enroll.body).toEqual({ ok: true })
    expect(
      (await agent.post(`/api/leads/${lead.id}/enroll`).send({ sequence_id: sequence.id })).status,
    ).toBe(409)
    expect(
      (await agent.post(`/api/leads/nope/enroll`).send({ sequence_id: sequence.id })).status,
    ).toBe(404)

    const stop = await agent.post(`/api/leads/${lead.id}/stop`).send({ reason: 'manual' })
    expect(stop.status).toBe(200)
    expect(stop.body).toEqual({ ok: true, stopped: 1 })
    const [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('stopped_manual')

    await agent.post(`/api/leads/${lead.id}/enroll`).send({ sequence_id: sequence.id }) // re-enrol after a stop
    const outcome = await agent.post(`/api/leads/${lead.id}/outcome`).send({ kind: 'demo_booked' })
    expect(outcome.status).toBe(200)
    expect(outcome.body).toMatchObject({ id: lead.id, status: 'booked' })
    const enrs = await db.select().from(enrollments)
    expect(enrs[0]!.status).toBe('stopped_manual')
    expect((await db.select().from(events)).some((e) => e.kind === 'demo_booked')).toBe(true)
    expect((await agent.post(`/api/leads/${lead.id}/outcome`).send({ kind: 'nope' })).status).toBe(
      400,
    )
  })
})

describe('queue routes', () => {
  it('lists ready_for_human items grouped by channel, then done and skip', async () => {
    const { agent, db, deps } = await loggedIn()
    await setSettings(db, { channels: { mail: true }, mail_provider: 'print' })
    const lead = await insertLead(db, { full_name: 'Pat Owner' })
    const li = await insertSequence(db, { channel: 'linkedin', name: 'LI' }, [
      { delay_days: 0, body: 'Connect {{first_name}}' },
    ])
    const call = await insertSequence(db, { channel: 'call', name: 'Call' }, [
      { delay_days: 0, body: 'Script' },
    ])
    const mail = await insertSequence(db, { channel: 'mail', name: 'Mail' }, [
      { delay_days: 0, body: 'Dear {{first_name}}' },
    ])
    for (const s of [li, call, mail]) await enrollLead(deps, lead.id, s.sequence.id)
    expect((await sendDue(deps)).queued).toBe(3)

    const q = await agent.get('/api/queue')
    expect(q.status).toBe(200)
    expect(q.body.total).toBe(3)
    expect(q.body.groups.linkedin).toHaveLength(1)
    expect(q.body.groups.call).toHaveLength(1)
    expect(q.body.groups.mail).toHaveLength(1)
    expect(q.body.groups.email).toEqual([])
    expect(q.body.groups.linkedin[0]).toMatchObject({
      lead_id: lead.id,
      channel: 'linkedin',
      person: 'Pat Owner',
      to_address: lead.linkedin_url,
      body: 'Connect Lead',
      sequence_name: 'LI',
      step_index: 0,
    })

    const liId = q.body.groups.linkedin[0].message_id as string
    const callId = q.body.groups.call[0].message_id as string
    const mailId = q.body.groups.mail[0].message_id as string

    const done = await agent.post(`/api/queue/${liId}/done`).send({ note: 'sent it' })
    expect(done.status).toBe(200)
    expect(done.body).toEqual({ message_id: liId, status: 'sent' })
    const skip = await agent.post(`/api/queue/${callId}/skip`).send({})
    expect(skip.body).toEqual({ message_id: callId, status: 'skipped' })
    expect((await agent.post(`/api/queue/${liId}/done`).send({})).status).toBe(400)
    expect((await agent.post(`/api/queue/nope/done`).send({})).status).toBe(404)

    const [msg] = await db.select().from(messages).where(eq(messages.id, liId))
    expect(msg).toMatchObject({ status: 'sent', provider: 'human' })
    expect(msg!.sent_at).not.toBeNull()
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.last_contacted_at).not.toBeNull()

    expect((await agent.get('/api/queue')).body.total).toBe(1)

    const print = await agent.get(`/api/queue/print?ids=${mailId},${liId}`)
    expect(print.status).toBe(200)
    expect(print.headers['content-type']).toMatch(/text\/html/)
    expect(print.text).toContain('Dear Lead')
    expect(print.text).toContain('Pat Owner')
    expect(print.text).toContain(lead.mailing_street)
    expect(print.text).toContain('1 postcard')
    expect(print.text).toContain('class="card address"')
    expect(print.text).not.toContain('Connect Lead') // linkedin item is not a letter
    expect((await agent.get('/api/queue/print')).text).toContain('Nothing to print')
  })
})

describe('public routes', () => {
  it('GET /u/:token only shows a button (link scanners must not unsubscribe anyone); POST does it', async () => {
    const { app, db, deps } = await loggedIn()
    await setSettings(db, { site_url: 'https://proparchive.app/"><s>' })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)

    const get = await request(app).get(`/u/${lead.unsubscribe_token}`)
    expect(get.status).toBe(200)
    expect(get.text).toContain('Stop emails to me')
    expect(get.text).toContain('<form method="post">')
    expect(get.text).not.toContain('"><s>') // the site link is escaped
    expect(get.text).not.toContain('—')
    expect(await db.select().from(suppression)).toHaveLength(0)
    let [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('active')

    const post = await request(app)
      .post(`/u/${lead.unsubscribe_token}`)
      .type('form')
      .send('List-Unsubscribe=One-Click')
    expect(post.status).toBe(200)
    expect(post.text).toContain('You will not get more email from us')
    expect(await db.select().from(suppression)).toHaveLength(1)
    ;[enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('stopped_unsubscribed')

    const again = await request(app).get(`/u/${lead.unsubscribe_token}`)
    expect(again.text).toContain('You are unsubscribed')
    expect(again.text).not.toContain('Stop emails to me')

    const bad = await request(app).get('/u/not-a-token')
    expect(bad.status).toBe(404)
    expect(bad.text).toContain('This link is not valid')
  })

  it('a replayed tracked link is one click, and the public routes have a per-client limit', async () => {
    const { app, db } = await loggedIn()
    const lead = await insertLead(db)
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get(`/r/${lead.unsubscribe_token}/demo`)).status).toBe(302)
    }
    expect((await db.select().from(events)).filter((e) => e.kind === 'click')).toHaveLength(1)
    expect((await request(app).get(`/r/${lead.unsubscribe_token}/beta`)).status).toBe(302)
    expect((await db.select().from(events)).filter((e) => e.kind === 'click')).toHaveLength(2)

    publicLimiter.resetAll()
    for (let i = 0; i < PUBLIC_HITS_PER_MINUTE; i++) {
      expect((await request(app).get('/r/unknown/site')).status).toBe(302)
    }
    const limited = await request(app).get(`/r/${lead.unsubscribe_token}/demo`)
    expect(limited.status).toBe(429)
    expect(limited.text).not.toContain('—')
    publicLimiter.resetAll()
    expect((await request(app).get(`/r/${lead.unsubscribe_token}/demo`)).status).toBe(302)
  })

  it('PUT live_mode on restarts sequences that only ever dry-ran', async () => {
    const { agent, db, deps, outbox } = await loggedIn()
    await setSettings(db, { physical_address: '1 Main St, Philadelphia, PA 19146' })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db, {}, [
      { delay_days: 0, subject: 'Only step', body: 'Hello {{first_name}}' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    expect((await sendDue(deps)).dryRun).toBe(1)
    expect((await db.select().from(enrollments))[0]!.status).toBe('done')

    const res = await agent.put('/api/settings').send({ live_mode: true })
    expect(res.status).toBe(200)
    const [enr] = await db.select().from(enrollments)
    expect(enr).toMatchObject({ status: 'active', current_step: 0, run: 1 })
    expect((await sendDue(deps)).sent).toBe(1)
    expect(outbox).toHaveLength(1)
  })

  it('GET /r/:token/:dest redirects with utm tags and records a click', async () => {
    const { app, db } = await loggedIn()
    const lead = await insertLead(db)
    const res = await request(app).get(`/r/${lead.unsubscribe_token}/demo?c=linkedin&s=ray-li`)
    expect(res.status).toBe(302)
    const url = new URL(res.headers.location!)
    expect(url.origin + url.pathname).toBe('https://proparchive.app/demo')
    expect(url.searchParams.get('utm_source')).toBe('outreach')
    expect(url.searchParams.get('utm_medium')).toBe('linkedin')
    expect(url.searchParams.get('utm_campaign')).toBe('ray-li')
    expect(url.searchParams.get('ref')).toBe(lead.id)
    const evs = await db.select().from(events)
    expect(evs).toHaveLength(1)
    expect(evs[0]!.kind).toBe('click')

    expect((await request(app).get(`/r/${lead.unsubscribe_token}/nowhere`)).status).toBe(404)
    const unknown = await request(app).get('/r/unknown/site')
    expect(unknown.status).toBe(302)
    expect(unknown.headers.location).toMatch(/^https:\/\/proparchive\.app\/\?utm_source=outreach/)
  })
})

describe('webhooks', () => {
  it('needs the secret header, finds the lead by id or email, records the outcome', async () => {
    const { app, db } = await loggedIn()
    const secret = await ensureWebhookSecret(db)
    const lead = await insertLead(db, { email: 'who@example.com' })

    const noSecret = await request(app)
      .post('/api/webhooks/outcome')
      .send({ lead_id: lead.id, kind: 'demo_booked' })
    expect(noSecret.status).toBe(401)
    const wrong = await request(app)
      .post('/api/webhooks/outcome')
      .set('x-outreach-secret', 'nope')
      .send({ lead_id: lead.id, kind: 'demo_booked' })
    expect(wrong.status).toBe(401)

    const badBody = await request(app)
      .post('/api/webhooks/outcome')
      .set('x-outreach-secret', secret)
      .send({ kind: 'demo_booked' })
    expect(badBody.status).toBe(400)

    const byEmail = await request(app)
      .post('/api/webhooks/outcome')
      .set('x-outreach-secret', secret)
      .send({ email: 'Who@Example.com', kind: 'beta_joined' })
    expect(byEmail.status).toBe(200)
    expect(byEmail.body).toEqual({ ok: true, lead_id: lead.id })
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.status).toBe('joined')
    expect((await db.select().from(events)).some((e) => e.kind === 'beta_joined')).toBe(true)

    const missing = await request(app)
      .post('/api/webhooks/outcome')
      .set('x-outreach-secret', secret)
      .send({ email: 'nobody@example.com', kind: 'demo_booked' })
    expect(missing.status).toBe(404)
  })
})
