import { describe, expect, it } from 'vitest'
import { linkedInKey, linkedInNameMatches, profileNameWords } from './linkedinName.ts'

const john = { full_name: 'John Smith', first_name: 'John', last_name: 'Smith', company: null }

describe('linkedInKey', () => {
  it('reduces profile and company links to one form', () => {
    expect(linkedInKey('https://www.linkedin.com/in/John-Smith-1a2b/?trk=x')).toBe(
      'in/john-smith-1a2b',
    )
    expect(linkedInKey('linkedin.com/in/john-smith-1a2b')).toBe('in/john-smith-1a2b')
    expect(linkedInKey('https://linkedin.com/company/doe-homes/about')).toBe('company/doe-homes')
    expect(linkedInKey('https://example.com/in/john')).toBeNull()
  })
})

describe('profileNameWords', () => {
  it('takes the name part of a LinkedIn search title', () => {
    expect(profileNameWords('John A. Smith - Owner - Smith Homes | LinkedIn')).toEqual([
      'JOHN',
      'SMITH',
    ])
    expect(profileNameWords('Dr. Jane Doe, MBA | LinkedIn')).toEqual(['JANE', 'DOE'])
  })
})

describe('linkedInNameMatches', () => {
  it('keeps a profile whose search title shows their first and last name', () => {
    const url = 'https://www.linkedin.com/in/jsmith42'
    expect(linkedInNameMatches(john, url, ['John Smith - Realtor | LinkedIn'])).toBe(true)
  })

  it('drops a profile whose title names someone else', () => {
    const url = 'https://www.linkedin.com/in/jdoe'
    expect(linkedInNameMatches(john, url, ['Jane Doe - Realtor | LinkedIn'])).toBe(false)
  })

  it('drops a profile that only shares the surname', () => {
    const url = 'https://www.linkedin.com/in/mary-smith-1234'
    expect(linkedInNameMatches(john, url, ['Mary Smith - Philadelphia | LinkedIn'])).toBe(false)
  })

  it('drops a name that only starts the same', () => {
    const url = 'https://www.linkedin.com/in/john-smithson'
    expect(linkedInNameMatches(john, url, ['John Smithson | LinkedIn'])).toBe(false)
  })

  it('keeps a profile whose link carries their name, with no title', () => {
    expect(linkedInNameMatches(john, 'https://www.linkedin.com/in/john-smith-1a2b3c', [])).toBe(
      true,
    )
    expect(linkedInNameMatches(john, 'https://www.linkedin.com/in/johnsmith', [])).toBe(true)
    expect(linkedInNameMatches(john, 'https://www.linkedin.com/in/smithjohn84', [])).toBe(true)
  })

  it('drops a link that does not carry their name and has no title', () => {
    expect(linkedInNameMatches(john, 'https://www.linkedin.com/in/jsmith42', [])).toBe(false)
    expect(linkedInNameMatches(john, 'https://www.linkedin.com/in/john-realestate', [])).toBe(false)
  })

  it('matches property-record order and middle initials', () => {
    const owner = {
      full_name: 'Smith John A',
      first_name: 'Smith',
      last_name: 'John A',
      company: null,
    }
    expect(
      linkedInNameMatches(owner, 'https://www.linkedin.com/in/x1', ['John Smith | LinkedIn']),
    ).toBe(true)
  })

  it('matches a hyphenated surname written either way', () => {
    const owner = {
      full_name: 'Jane Buda-Levin',
      first_name: 'Jane',
      last_name: 'Buda-Levin',
      company: null,
    }
    expect(
      linkedInNameMatches(owner, 'https://www.linkedin.com/in/x1', ['Jane Buda Levin | LinkedIn']),
    ).toBe(true)
    expect(linkedInNameMatches(owner, 'https://www.linkedin.com/in/jane-buda-levin', [])).toBe(true)
  })

  it('never gives a person profile to a lead with no person name', () => {
    const llc = { full_name: null, first_name: null, last_name: null, company: 'Doe Homes LLC' }
    expect(
      linkedInNameMatches(llc, 'https://www.linkedin.com/in/john-doe', ['John Doe | LinkedIn']),
    ).toBe(false)
  })

  it('keeps a company page that carries the company name', () => {
    const llc = {
      full_name: null,
      first_name: null,
      last_name: null,
      company: 'Wydler Brothers LLC',
    }
    expect(linkedInNameMatches(llc, 'https://www.linkedin.com/company/wydler-brothers', [])).toBe(
      true,
    )
    expect(
      linkedInNameMatches(llc, 'https://www.linkedin.com/company/123', [
        'Wydler Brothers | LinkedIn',
      ]),
    ).toBe(true)
    expect(linkedInNameMatches(llc, 'https://www.linkedin.com/company/acme-realty', [])).toBe(false)
  })

  it('never keeps a company page for a company with only common words', () => {
    const llc = {
      full_name: null,
      first_name: null,
      last_name: null,
      company: 'Real Estate Properties LLC',
    }
    expect(
      linkedInNameMatches(llc, 'https://www.linkedin.com/company/real-estate-properties', []),
    ).toBe(false)
  })
})
