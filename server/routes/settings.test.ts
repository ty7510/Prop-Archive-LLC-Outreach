import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'
import { createApp } from '../app.ts'
import { createTestDb } from '../db/client.ts'

async function loggedIn() {
  const db = await createTestDb()
  const app = createApp(db, { serveClient: false })
  const agent = request.agent(app)
  const res = await agent.post('/api/login').send({ password: 'test-password' })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ loggedIn: true })
  return { app, agent, db }
}

describe('auth', () => {
  let app: ReturnType<typeof createApp>
  beforeEach(async () => {
    app = createApp(await createTestDb(), { serveClient: false })
  })

  it('GET /api/health works without login', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, dbOk: true, liveMode: false, autopilotOn: false })
    expect(typeof res.body.version).toBe('string')
  })

  it('GET /api/me says logged out', async () => {
    const res = await request(app).get('/api/me')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ loggedIn: false })
  })

  it('GET /api/settings is 401 without a session', async () => {
    const res = await request(app).get('/api/settings')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Please log in', code: 'UNAUTHORIZED' })
  })

  it('rejects a wrong password', async () => {
    const res = await request(app).post('/api/login').send({ password: 'nope' })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('WRONG_PASSWORD')
  })

  it('rejects a missing password with 400', async () => {
    const res = await request(app).post('/api/login').send({})
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION')
  })

  it('logs out', async () => {
    const agent = request.agent(app)
    await agent.post('/api/login').send({ password: 'test-password' })
    expect((await agent.get('/api/me')).body).toEqual({ loggedIn: true })
    await agent.post('/api/logout')
    expect((await agent.get('/api/me')).body).toEqual({ loggedIn: false })
    expect((await agent.get('/api/settings')).status).toBe(401)
  })

  it('unknown /api paths are 404 JSON', async () => {
    const agent = request.agent(app)
    await agent.post('/api/login').send({ password: 'test-password' })
    const res = await agent.get('/api/nothing-here')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
  })
})

describe('settings routes', () => {
  it('GET returns the defaults', async () => {
    const { agent } = await loggedIn()
    const res = await agent.get('/api/settings')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(DEFAULT_SETTINGS)
  })

  it('PUT merges a partial update and GET reflects it', async () => {
    const { agent } = await loggedIn()
    const put = await agent
      .put('/api/settings')
      .send({ owner_name: 'Theo', channels: { mail: true }, target_zips: ['19146', '19125'] })
    expect(put.status).toBe(200)
    expect(put.body.owner_name).toBe('Theo')
    expect(put.body.channels).toEqual({ ...DEFAULT_SETTINGS.channels, mail: true })
    expect(put.body.target_zips).toEqual(['19146', '19125'])
    const get = await agent.get('/api/settings')
    expect(get.body).toEqual(put.body)
  })

  it('PUT validates', async () => {
    const { agent } = await loggedIn()
    const bad = await agent.put('/api/settings').send({ send_window: { start: '25:00' } })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('VALIDATION')
    expect(bad.body.error).toContain('send_window.start')

    const unknown = await agent.put('/api/settings').send({ nope: true })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toContain('nope')

    const badZip = await agent.put('/api/settings').send({ target_zips: ['1910'] })
    expect(badZip.status).toBe(400)
  })

  it('PUT live_mode flips the health pill', async () => {
    const { agent } = await loggedIn()
    await agent.put('/api/settings').send({ live_mode: true })
    const res = await agent.get('/api/health')
    expect(res.body.liveMode).toBe(true)
  })

  it('GET /providers returns booleans and env key names, never values', async () => {
    const { agent } = await loggedIn()
    const res = await agent.get('/api/settings/providers')
    expect(res.status).toBe(200)
    for (const k of ['anthropic', 'smtp', 'resend', 'imap', 'lob', 'hunter', 'apollo', 'pdl']) {
      expect(typeof res.body[k], k).toBe('boolean')
    }
    expect(res.body.env_keys.smtp).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'])
    expect(JSON.stringify(res.body)).not.toContain('test-password')
  })

  it('bad JSON is a 400', async () => {
    const { agent } = await loggedIn()
    const res = await agent
      .put('/api/settings')
      .set('content-type', 'application/json')
      .send('{not json')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BAD_JSON')
  })
})
