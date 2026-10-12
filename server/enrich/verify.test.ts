import { describe, expect, it } from 'vitest'
import {
  checkContacts,
  normaliseContact,
  streetKey,
  streetKeysIn,
  type ContactEvidence,
  type OwnerFacts,
} from './verify.ts'

const facts: OwnerFacts = {
  full_name: 'Daniel Liez',
  first_name: 'Daniel',
  last_name: 'Liez',
  company: 'Sunrise Center City LLC',
  mailing_street: '4253 Regent Sq',
  property_addresses: ['1022 PINE ST', '650 N 54TH ST'],
}

function evidence(patch: Partial<ContactEvidence>): ContactEvidence {
  return {
    field: 'phone',
    value: '(610) 209-5093',
    role: 'owner',
    source_url: 'https://hotpads.com/1022-pine-st-phila-pa-19107-tnv33c/202/pad',
    quote: '1022 Pine St #202, Philadelphia, PA 19107. Property manager (610) 209-5093',
    ...patch,
  }
}

describe('street keys', () => {
  it('match an address however it is written', () => {
    expect(streetKey('1022 Pine Street #202')).toBe('1022 PINE')
    expect(streetKey('650 N. 54th Street')).toBe('650 54TH')
    expect(streetKey('Pine St')).toBeNull()
    expect([...streetKeysIn('Studio at 1022 Pine St, $1,190. Also 650 North 54th St.')]).toEqual(
      expect.arrayContaining(['1022 PINE', '650 54TH']),
    )
  })
})

describe('checkContacts', () => {
  it('verifies a phone shown on a listing at their own property', () => {
    const [c] = checkContacts([evidence({})], facts)
    expect(c).toMatchObject({ value: '6102095093', verdict: 'verified' })
    expect(c!.reason).toContain('1022 PINE ST')
  })

  it('verifies a contact tied to their mailing address', () => {
    const [c] = checkContacts(
      [evidence({ quote: 'D. Liez, 4253 Regent Square, Philadelphia. Tel 610 209 5093' })],
      facts,
    )
    expect(c!.verdict).toBe('verified')
  })

  it('calls a name or company match likely, not verified', () => {
    const [byName, byCompany] = checkContacts(
      [
        evidence({ quote: 'Daniel Liez, Keystone Floor Works, 610-209-5093' }),
        evidence({ quote: 'Sunrise Center City LLC (610) 209-5093' }),
      ],
      facts,
    )
    expect(byName!.verdict).toBe('likely')
    expect(byCompany!.verdict).toBe('likely')
  })

  it('verifies a site or email whose source shows an already verified phone', () => {
    const checked = checkContacts(
      [
        evidence({
          field: 'website',
          value: 'keystonefloorworks.com',
          source_url: 'https://www.keystonefloorworks.com/contact',
          quote: 'Keystone Floor Works, keystonefloorworks.com, call 610-209-5093',
        }),
        evidence({}), // the phone, checked first whatever the order
      ],
      facts,
    )
    const site = checked.find((c) => c.field === 'website')
    expect(site).toMatchObject({ value: 'https://keystonefloorworks.com', verdict: 'verified' })
  })

  it('rejects a value the quote does not show, a missing source, and an untied source', () => {
    const [wrong, noSource, untied] = checkContacts(
      [
        evidence({ value: '610-209-0000' }),
        evidence({ source_url: '' }),
        evidence({ quote: 'Call 610-209-5093 for apartments in Center City' }),
      ],
      facts,
    )
    expect(wrong!.verdict).toBe('rejected')
    expect(noSource!.verdict).toBe('rejected')
    expect(untied).toMatchObject({
      verdict: 'rejected',
      reason: 'nothing ties the source to this owner',
    })
  })

  it('needs both first and last name, and a company word longer than a few letters', () => {
    const shortCompany: OwnerFacts = { ...facts, first_name: null, company: 'M & M LLC' }
    const [lastOnly, mm] = checkContacts(
      [evidence({ quote: 'Liez 610-209-5093' }), evidence({ quote: 'M & M LLC 610-209-5093' })],
      shortCompany,
    )
    expect(lastOnly!.verdict).toBe('rejected')
    expect(mm!.verdict).toBe('rejected')
  })
})

describe('normaliseContact', () => {
  it('accepts real profile and site links only', () => {
    expect(normaliseContact('linkedin_url', 'https://www.linkedin.com/in/dliez')).toEqual({
      value: 'https://www.linkedin.com/in/dliez',
    })
    expect('problem' in normaliseContact('linkedin_url', 'https://example.com/dliez')).toBe(true)
    expect('problem' in normaliseContact('instagram_url', 'https://instagram.com/p/abc123')).toBe(
      true,
    )
    expect('problem' in normaliseContact('facebook_url', 'https://facebook.com/search?q=x')).toBe(
      true,
    )
    expect('problem' in normaliseContact('website', 'https://www.zillow.com/homedetails/x')).toBe(
      true,
    )
    expect('problem' in normaliseContact('website', 'https://www.apartments.com/x')).toBe(true)
    expect(normaliseContact('website', 'keystonefloorworks.com')).toEqual({
      value: 'https://keystonefloorworks.com',
    })
    expect('problem' in normaliseContact('phone', '555-0199')).toBe(true)
    expect('problem' in normaliseContact('email', 'not-an-email')).toBe(true)
  })
})
