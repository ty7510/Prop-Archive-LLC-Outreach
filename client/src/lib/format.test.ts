import { describe, expect, it } from 'vitest'
import {
  ensureHttp,
  humanise,
  leadName,
  leadNeighbourhood,
  mailingAddress,
  neighbourhood,
  orDash,
  plural,
  relativeTime,
  statusLabel,
  telHref,
} from './format.ts'

describe('neighbourhood', () => {
  it('maps the seven target zips', () => {
    expect(neighbourhood('19104')).toBe('University City')
    expect(neighbourhood('19125')).toBe('Fishtown / Kensington')
  })
  it('falls back to the five digit zip and handles zip+4', () => {
    expect(neighbourhood('19147-1234')).toBe('19147')
    expect(neighbourhood(null)).toBe('')
  })
  it('prefers property zips over the mailing zip', () => {
    expect(leadNeighbourhood({ zips: ['19139'], mailing_zip: '19104' })).toBe('West Philly')
    expect(leadNeighbourhood({ zips: [], mailing_zip: '19104' })).toBe('University City')
  })
})

describe('leadName', () => {
  it('uses full name, then company, then first and last', () => {
    const base = { full_name: null, company: null, first_name: null, last_name: null }
    expect(leadName({ ...base, full_name: 'Ray Dunn' })).toBe('Ray Dunn')
    expect(leadName({ ...base, company: 'Dunn LLC' })).toBe('Dunn LLC')
    expect(leadName({ ...base, first_name: 'Ray', last_name: 'Dunn' })).toBe('Ray Dunn')
    expect(leadName(base)).toBe('Unnamed lead')
  })
})

describe('mailingAddress', () => {
  it('joins the parts it has', () => {
    expect(
      mailingAddress({
        mailing_street: '12 Main St',
        mailing_city: 'Philadelphia',
        mailing_state: 'PA',
        mailing_zip: '19104',
      }),
    ).toBe('12 Main St, Philadelphia, PA 19104')
    expect(
      mailingAddress({
        mailing_street: null,
        mailing_city: null,
        mailing_state: null,
        mailing_zip: null,
      }),
    ).toBe('')
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-10-11T12:00:00Z')
  it('describes the past and the future', () => {
    expect(relativeTime('2026-10-11T11:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-10-11T11:30:00Z', now)).toBe('30 min ago')
    expect(relativeTime('2026-10-11T14:00:00Z', now)).toBe('in 2 h')
    expect(relativeTime('2026-10-10T12:00:00Z', now)).toBe('yesterday')
    expect(relativeTime('2026-10-12T12:00:00Z', now)).toBe('tomorrow')
    expect(relativeTime('2026-10-05T12:00:00Z', now)).toBe('6 days ago')
  })
  it('shows an en dash for nothing or junk', () => {
    expect(relativeTime(null, now)).toBe('–')
    expect(relativeTime('not a date', now)).toBe('–')
  })
})

describe('small helpers', () => {
  it('humanises snake case and labels statuses', () => {
    expect(humanise('not_interested')).toBe('Not interested')
    expect(statusLabel('booked')).toBe('Booked a demo')
    expect(statusLabel('something_else')).toBe('Something else')
  })
  it('never shows an empty cell', () => {
    expect(orDash('')).toBe('–')
    expect(orDash(null)).toBe('–')
    expect(orDash(3)).toBe('3')
  })
  it('pluralises and builds links', () => {
    expect(plural(1, 'property', 'properties')).toBe('1 property')
    expect(plural(4, 'property', 'properties')).toBe('4 properties')
    expect(telHref('(215) 555-0100')).toBe('tel:2155550100')
    expect(ensureHttp('linkedin.com/in/ray')).toBe('https://linkedin.com/in/ray')
    expect(ensureHttp('https://x.com/a')).toBe('https://x.com/a')
  })
})
