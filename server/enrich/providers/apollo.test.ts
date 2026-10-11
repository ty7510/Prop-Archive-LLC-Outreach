import { describe, expect, it } from 'vitest'
import { ProviderHttpError } from '../http.ts'
import { makeContext, makeLead, queuedFetch, testEnv } from '../testing.ts'
import {
  APOLLO_MATCH_URL,
  buildApolloBody,
  createApolloProvider,
  mapApolloEmailStatus,
  mapApolloPerson,
  mapApolloPhoneType,
} from './apollo.ts'

const person = {
  id: 'abc',
  first_name: 'Denise',
  last_name: 'Park',
  name: 'Denise Park',
  linkedin_url: 'http://www.linkedin.com/in/denisepark',
  title: 'Owner',
  email: 'denise@parkpm.com',
  email_status: 'verified',
  phone_numbers: [
    { raw_number: '+1 215-555-0100', sanitized_number: '+12155550100', type: 'work_hq' },
    { raw_number: '+1 215-555-0177', sanitized_number: '+12155550177', type: 'mobile' },
  ],
  organization: {
    name: 'Park Property Management',
    website_url: 'http://www.parkpm.com',
    primary_domain: 'parkpm.com',
  },
}

const lead = () => makeLead({ first_name: 'Denise', last_name: 'Park', company: 'Park PM' })
const ctx = () => makeContext({ env: testEnv({ APOLLO_API_KEY: 'ak' }) })
const noSleep = async () => {}

describe('apollo', () => {
  it('builds the match body and never asks for personal emails', () => {
    expect(
      buildApolloBody(
        makeLead({
          first_name: 'Denise',
          last_name: 'Park',
          company: 'Park PM',
          website: 'https://www.parkpm.com/',
        }),
      ),
    ).toEqual({
      first_name: 'Denise',
      last_name: 'Park',
      organization_name: 'Park PM',
      domain: 'parkpm.com',
      reveal_personal_emails: false,
    })
    expect(buildApolloBody(makeLead({ company: 'Only A Company LLC' }))).toBeNull()
  })

  it('maps statuses and phone types', () => {
    expect(mapApolloEmailStatus('verified')).toBe('valid')
    expect(mapApolloEmailStatus('guessed')).toBe('risky')
    expect(mapApolloEmailStatus('unavailable')).toBe('invalid')
    expect(mapApolloEmailStatus(undefined)).toBe('unknown')
    expect(mapApolloPhoneType('mobile')).toBe('mobile')
    expect(mapApolloPhoneType('work_hq')).toBe('landline')
    expect(mapApolloPhoneType('other')).toBe('unknown')
  })

  it('maps a person, preferring the mobile number', () => {
    const r = mapApolloPerson(person, { person })
    expect(r).toMatchObject({
      first_name: 'Denise',
      last_name: 'Park',
      full_name: 'Denise Park',
      linkedin_url: 'http://www.linkedin.com/in/denisepark',
      email: 'denise@parkpm.com',
      email_status: 'valid',
      phone: '+12155550177',
      phone_type: 'mobile',
      company: 'Park Property Management',
      website: 'http://www.parkpm.com',
      owner_kind: 'person',
      confidence: 0.7,
      credits_used: 1,
    })
    expect(mapApolloPerson(null, {}).confidence).toBe(0)
  })

  it('drops an unavailable email', () => {
    const r = mapApolloPerson({ ...person, email_status: 'unavailable' }, {})
    expect(r.email).toBeUndefined()
  })

  it('POSTs with the x-api-key header', async () => {
    const f = queuedFetch([{ status: 200, body: { person } }])
    const p = createApolloProvider({ fetch: f, sleep: noSleep })
    expect(p.isConfigured(testEnv())).toBe(false)
    expect(p.applies(lead(), ctx())).toBe(true)
    const r = await p.enrich(lead(), ctx())
    expect(f.calls[0]?.url).toBe(APOLLO_MATCH_URL)
    expect(f.calls[0]?.init?.method).toBe('POST')
    const headers = f.calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('ak')
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toMatchObject({
      first_name: 'Denise',
      reveal_personal_emails: false,
    })
    expect(r.email).toBe('denise@parkpm.com')
  })

  it('404 and an empty person are not errors', async () => {
    const p1 = createApolloProvider({
      fetch: queuedFetch([{ status: 404, body: {} }]),
      sleep: noSleep,
    })
    expect((await p1.enrich(lead(), ctx())).confidence).toBe(0)
    const p2 = createApolloProvider({
      fetch: queuedFetch([{ status: 200, body: { person: null } }]),
      sleep: noSleep,
    })
    expect((await p2.enrich(lead(), ctx())).email).toBeUndefined()
  })

  it('retries 500 then rejects cleanly; 422 rejects at once', async () => {
    const f = queuedFetch([{ status: 500, text: 'down' }])
    const p = createApolloProvider({ fetch: f, sleep: noSleep })
    await expect(p.enrich(lead(), ctx())).rejects.toBeInstanceOf(ProviderHttpError)
    expect(f.calls).toHaveLength(3)
    const f2 = queuedFetch([{ status: 422, body: { error: 'bad input' } }])
    const p2 = createApolloProvider({ fetch: f2, sleep: noSleep })
    await expect(p2.enrich(lead(), ctx())).rejects.toThrow(/apollo: HTTP 422 bad input/)
    expect(f2.calls).toHaveLength(1)
  })
})
