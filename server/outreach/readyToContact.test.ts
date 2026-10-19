import { describe, expect, it } from 'vitest'
import { linkedInFoundByEnrich, linkedInSlug, readyToContact } from './readyToContact.ts'

const enriched = (data: unknown) => ({ claude_research: { fetched_at: 'x', data } })

describe('ready to contact', () => {
  it('reads any spelling of a profile link', () => {
    expect(linkedInSlug('https://www.linkedin.com/in/Jane-Doe-1a2b/?trk=x')).toBe(
      'in/jane-doe-1a2b',
    )
    expect(linkedInSlug('linkedin.com/company/doe-homes')).toBe('company/doe-homes')
    expect(linkedInSlug('https://example.com/jane')).toBeNull()
    expect(linkedInSlug(null)).toBeNull()
  })

  it('counts a LinkedIn only when an Enrich provider found that same profile', () => {
    const url = 'https://www.linkedin.com/in/jane-doe/'
    expect(
      linkedInFoundByEnrich({
        linkedin_url: url,
        enrichment: enriched({ linkedin_url: 'http://linkedin.com/in/jane-doe' }),
      }),
    ).toBe(true)
    expect(
      linkedInFoundByEnrich({
        linkedin_url: url,
        enrichment: enriched({ linkedin_url: 'https://www.linkedin.com/in/jane-doe-2' }),
      }),
    ).toBe(false)
    expect(linkedInFoundByEnrich({ linkedin_url: url, enrichment: {} })).toBe(false)
    expect(
      linkedInFoundByEnrich({
        linkedin_url: url,
        enrichment: { linkedin_find: { fetched_at: 'x', data: { url } } },
      }),
    ).toBe(false)
  })

  it('needs at least one of: that LinkedIn, an email that is not bad, a mailing address', () => {
    const lead = {
      email: 'jane@example.com',
      email_status: 'valid' as const,
      mailing_street: '1 Main St',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      enrichment: enriched({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }),
    }
    expect(readyToContact(lead)).toBe(true)
    expect(readyToContact({ ...lead, email: ' ' })).toBe(true)
    expect(readyToContact({ ...lead, email: null })).toBe(true)
    expect(readyToContact({ ...lead, email_status: 'invalid' })).toBe(true)
    expect(readyToContact({ ...lead, mailing_street: null })).toBe(true)
    expect(readyToContact({ ...lead, enrichment: {} })).toBe(true)
    const none = { ...lead, email: null, mailing_street: null, enrichment: {} }
    expect(readyToContact(none)).toBe(false)
    expect(readyToContact({ ...none, linkedin_url: null, email: 'jane@example.com' })).toBe(true)
    expect(readyToContact({ ...none, email: 'jane@example.com', email_status: 'invalid' })).toBe(
      false,
    )
    expect(readyToContact({ ...none, mailing_street: '1 Main St' })).toBe(true)
    expect(readyToContact({ ...none, enrichment: lead.enrichment })).toBe(true)
  })
})
