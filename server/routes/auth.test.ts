import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.ts'
import { createTestDb } from '../db/client.ts'
import { loginLimiter } from '../lib/http.ts'

describe('login brute-force guard', () => {
  let app: ReturnType<typeof createApp>
  beforeEach(async () => {
    loginLimiter.resetAll()
    app = createApp(await createTestDb(), { serveClient: false })
  })

  it('returns 429 after ten wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/login')
        .send({ password: `wrong-${i}` })
      expect(res.status).toBe(401)
    }
    const blocked = await request(app).post('/api/login').send({ password: 'test-password' })
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe('TOO_MANY_TRIES')
  })

  it('a correct login clears the counter', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/login').send({ password: 'nope' })
    }
    const ok = await request(app).post('/api/login').send({ password: 'test-password' })
    expect(ok.status).toBe(200)
    for (let i = 0; i < 9; i++) {
      const res = await request(app).post('/api/login').send({ password: 'nope' })
      expect(res.status).toBe(401)
    }
  })
})
