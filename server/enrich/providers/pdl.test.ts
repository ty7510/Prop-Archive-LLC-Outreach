import { describe, expect, it } from 'vitest'
import { ProviderHttpError } from '../http.ts'
import { hangingFetch, makeContext, makeLead, queuedFetch, testEnv } from '../testing.ts'
import { createPdlProvider, mapPdlResponse, pdlName, pdlUrl } from './pdl.ts'

const body = {
  status: 200,
  likelihood: 8,
  data: {
    full_name: 'ray torres',
    first_name: 'ray',
    last_name: 'torres',
    linkedin_url: 'linkedin.com/in/raytorres',
    work_email: 'ray@torrespg.com',
    emails: [{ address: 'ray.torres@gmail.com', type: 'personal' }],
    mobile_phone: '+12155550199',
    phone_numbers: ['+12155550100'],
    job_company_name: 'torres property group',
    job_company_website: 'torrespg.com',
    job_title: 'owner',
  },
}

const lead = () => makeLead({ full_name: 'Ray Torres', company: 'Torres Property Group LLC' })
const ctx = () => makeContext({ env: testEnv({ PDL_API_KEY: 'pk' }) })
const noSleep = async () => {}

describe('pdl', () => {
  it('needs a name and builds the url', () => {
    expect(pdlName(makeLead())).toBeNull()
    expect(pdlName(makeLead({ first_name: 'A', last_name: 'B' }))).toBe('A B')
    expect(pdlName(lead())).toBe('Ray Torres')
    expect(pdlUrl('Ray Torres', 'Torres PG')).toBe(
      'https://api.peopledatalabs.com/v5/person/enrich?name=Ray+Torres&company=Torres+PG&location=Philadelphia&min_likelihood=6',
    )
  })

  it('maps a person: work email first, mobile first, schemes added', () => {
    const r = mapPdlResponse(body)
    expect(r).toMatchObject({
      full_name: 'ray torres',
      first_name: 'ray',
      last_name: 'torres',
      linkedin_url: 'https://linkedin.com/in/raytorres',
      email: 'ray@torrespg.com',
      email_status: 'unknown',
      phone: '+12155550199',
      phone_type: 'mobile',
      company: 'torres property group',
      website: 'https://torrespg.com',
      owner_kind: 'person',
      confidence: 0.8,
      credits_used: 1,
    })
    const noMobile = mapPdlResponse({
      ...body,
      data: { ...body.data, mobile_phone: null, work_email: null },
    })
    expect(noMobile.phone).toBe('+12155550100')
    expect(noMobile.phone_type).toBe('unknown')
    expect(noMobile.email).toBe('ray.torres@gmail.com')
  })

  it('GETs with the X-Api-Key header', async () => {
    const f = queuedFetch([{ status: 200, body }])
    const p = createPdlProvider({ fetch: f, sleep: noSleep })
    expect(p.isConfigured(testEnv())).toBe(false)
    expect(p.applies(lead(), ctx())).toBe(true)
    const r = await p.enrich(lead(), ctx())
    expect(f.calls[0]?.url).toContain('name=Ray+Torres')
    expect(f.calls[0]?.url).toContain('company=Torres+Property+Group+LLC')
    const headers = f.calls[0]?.init?.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe('pk')
    expect(r.linkedin_url).toBe('https://linkedin.com/in/raytorres')
  })

  it('404 is "no match" and costs nothing', async () => {
    const f = queuedFetch([
      { status: 404, body: { status: 404, error: { type: 'not_found', message: 'No records' } } },
    ])
    const p = createPdlProvider({ fetch: f, sleep: noSleep })
    const r = await p.enrich(lead(), ctx())
    expect(r.confidence).toBe(0)
    expect(r.credits_used).toBe(0)
    expect(f.calls).toHaveLength(1)
  })

  it('retries 429 and 5xx then rejects; 402 rejects with the message', async () => {
    const f = queuedFetch([{ status: 429, body: {} }, { status: 503, body: {} }, { status: 502 }])
    const p = createPdlProvider({ fetch: f, sleep: noSleep })
    await expect(p.enrich(lead(), ctx())).rejects.toBeInstanceOf(ProviderHttpError)
    expect(f.calls).toHaveLength(3)
    const f2 = queuedFetch([
      { status: 402, body: { status: 402, error: { type: 'payment', message: 'Out of credits' } } },
    ])
    const p2 = createPdlProvider({ fetch: f2, sleep: noSleep })
    await expect(p2.enrich(lead(), ctx())).rejects.toThrow(/pdl: HTTP 402 Out of credits/)
  })

  it('times out', async () => {
    const p = createPdlProvider({ fetch: hangingFetch(), sleep: noSleep, timeoutMs: 5, retries: 0 })
    await expect(p.enrich(lead(), ctx())).rejects.toThrow(/abort/i)
  })
})
