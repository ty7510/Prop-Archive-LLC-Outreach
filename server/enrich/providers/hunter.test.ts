import { describe, expect, it } from 'vitest'
import { ProviderHttpError } from '../http.ts'
import { hangingFetch, makeContext, makeLead, queuedFetch, testEnv } from '../testing.ts'
import { createHunterProvider, mapVerifierResult } from './hunter.ts'

const lead = () =>
  makeLead({ first_name: 'Denise', last_name: 'Park', website: 'https://www.parkpm.com' })
const ctx = () => makeContext({ env: testEnv({ HUNTER_API_KEY: 'hk' }) })
const noSleep = async () => {}

const finderBody = {
  data: {
    first_name: 'Denise',
    last_name: 'Park',
    email: 'denise.park@parkpm.com',
    score: 92,
    domain: 'parkpm.com',
    position: 'Owner',
    linkedin_url: 'https://www.linkedin.com/in/denisepark',
    phone_number: null,
    verification: { date: '2026-10-01', status: 'valid' },
    sources: [{ domain: 'parkpm.com', uri: 'https://parkpm.com/team' }],
  },
  meta: { params: {} },
}

describe('hunter', () => {
  it('maps verifier results', () => {
    expect(mapVerifierResult('deliverable')).toBe('valid')
    expect(mapVerifierResult('undeliverable')).toBe('invalid')
    expect(mapVerifierResult('risky')).toBe('risky')
    expect(mapVerifierResult(null)).toBe('unknown')
  })

  it('needs a key, a domain and a first and last name', () => {
    const p = createHunterProvider()
    expect(p.isConfigured(testEnv())).toBe(false)
    expect(p.isConfigured(testEnv({ HUNTER_API_KEY: 'k' }))).toBe(true)
    expect(p.applies(lead(), ctx())).toBe(true)
    expect(p.applies(makeLead({ first_name: 'A', last_name: 'B' }), ctx())).toBe(false)
    expect(p.applies(makeLead({ website: 'https://x.com' }), ctx())).toBe(false)
    expect(
      p.applies(makeLead({ first_name: 'A', last_name: 'B', website: 'gmail.com' }), ctx()),
    ).toBe(false)
  })

  it('finds then verifies an email and counts two credits', async () => {
    const f = queuedFetch([
      { status: 200, body: finderBody },
      { status: 200, body: { data: { status: 'valid', result: 'deliverable', score: 98 } } },
    ])
    const p = createHunterProvider({ fetch: f, sleep: noSleep })
    const r = await p.enrich(lead(), ctx())
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0]?.url).toContain('/v2/email-finder?')
    expect(f.calls[0]?.url).toContain('domain=parkpm.com')
    expect(f.calls[0]?.url).toContain('first_name=Denise')
    expect(f.calls[0]?.url).toContain('api_key=hk')
    expect(f.calls[1]?.url).toContain('/v2/email-verifier?email=denise.park%40parkpm.com')
    expect(r.email).toBe('denise.park@parkpm.com')
    expect(r.email_status).toBe('valid')
    expect(r.linkedin_url).toBe('https://www.linkedin.com/in/denisepark')
    expect(r.confidence).toBeCloseTo(0.92)
    expect(r.credits_used).toBe(2)
  })

  it('keeps a found email as unknown when the verifier fails', async () => {
    const f = queuedFetch([
      { status: 200, body: finderBody },
      { status: 500, text: 'x' },
    ])
    const p = createHunterProvider({ fetch: f, sleep: noSleep })
    const r = await p.enrich(lead(), ctx())
    expect(r.email).toBe('denise.park@parkpm.com')
    expect(r.email_status).toBe('unknown')
    expect((r.raw as { verifier_error?: string }).verifier_error).toMatch(/HTTP 500/)
  })

  it('no email found is an empty result costing one credit', async () => {
    const f = queuedFetch([{ status: 200, body: { data: { email: null, score: null } } }])
    const p = createHunterProvider({ fetch: f, sleep: noSleep })
    const r = await p.enrich(lead(), ctx())
    expect(r.email).toBeUndefined()
    expect(r.credits_used).toBe(1)
    expect(f.calls).toHaveLength(1)
  })

  it('retries 429 and gives a clean error after retries run out', async () => {
    const f = queuedFetch([{ status: 429, body: { errors: [{ details: 'Too many' }] } }])
    const p = createHunterProvider({ fetch: f, sleep: noSleep })
    await expect(p.enrich(lead(), ctx())).rejects.toBeInstanceOf(ProviderHttpError)
    expect(f.calls).toHaveLength(3)
  })

  it('a 401 is reported with Hunter’s detail', async () => {
    const f = queuedFetch([{ status: 401, body: { errors: [{ details: 'Invalid API key' }] } }])
    const p = createHunterProvider({ fetch: f, sleep: noSleep })
    await expect(p.enrich(lead(), ctx())).rejects.toThrow(/HTTP 401 Invalid API key/)
  })

  it('times out instead of hanging', async () => {
    const p = createHunterProvider({
      fetch: hangingFetch(),
      sleep: noSleep,
      timeoutMs: 5,
      retries: 0,
    })
    await expect(p.enrich(lead(), ctx())).rejects.toThrow(/abort/i)
  })
})
