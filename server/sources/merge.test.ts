import { describe, expect, it } from 'vitest'
import type { Lead } from '../db/schema.ts'
import {
  dedupeKeyFor,
  displayNameFor,
  isUsableCandidate,
  mergeIntoLead,
  mergeTrigger,
  normaliseCandidate,
  ownerKindFor,
} from './merge.ts'

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'L1',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    source: 'opa',
    status: 'new',
    persona: 'maya',
    icp_score: 50,
    owner_kind: 'unknown',
    full_name: null,
    first_name: null,
    last_name: null,
    company: null,
    email: null,
    email_status: 'unknown',
    phone: null,
    phone_type: 'unknown',
    linkedin_url: null,
    instagram_url: null,
    website: null,
    mailing_street: '5214 Baltimore Ave',
    mailing_city: 'Philadelphia',
    mailing_state: 'PA',
    mailing_zip: '19143',
    mailing_verified: false,
    property_count: 3,
    unit_count: 0,
    zips: ['19143'],
    trigger: { type: 'none' },
    channels: { email: false, mail: false, linkedin: false, instagram: false, call: false },
    enrichment: {},
    tags: [],
    notes: null,
    do_not_contact: false,
    unsubscribe_token: 'tok',
    last_contacted_at: null,
    last_replied_at: null,
    next_action_at: null,
    dedupe_key: '5214 BALTIMORE AVE|19143',
    ...over,
  }
}

describe('dedupeKeyFor', () => {
  it('uses normalised street and zip5', () => {
    expect(
      dedupeKeyFor({ mailing_street: '5214 Baltimore Avenue', mailing_zip: '19143-2116' }),
    ).toBe('5214 BALTIMORE AVE|19143')
    expect(dedupeKeyFor({ mailing_street: '5214 BALTIMORE AVE.', mailing_zip: '19143' })).toBe(
      '5214 BALTIMORE AVE|19143',
    )
  })
  it('falls back to the email, then null', () => {
    expect(dedupeKeyFor({ email: 'Ray@Example.com' })).toBe('ray@example.com')
    expect(dedupeKeyFor({ email: 'not an email' })).toBeNull()
    expect(dedupeKeyFor({})).toBeNull()
  })
  it('keeps a street without a zip apart from the same street with one', () => {
    expect(dedupeKeyFor({ mailing_street: '1 Main St' })).toBe('1 MAIN ST|')
  })
})

describe('ownerKindFor', () => {
  it('reads LLC suffixes', () => {
    expect(ownerKindFor({ company: 'Okafor Properties LLC' })).toBe('llc')
    expect(ownerKindFor({ full_name: 'Smith Family Trust' })).toBe('llc')
    expect(ownerKindFor({ full_name: 'Maya Chen' })).toBe('person')
    expect(ownerKindFor({ full_name: 'Ray Okafor', company: 'Okafor Properties LLC' })).toBe(
      'person',
    )
    expect(ownerKindFor({ company: 'Hall Mgmt' })).toBe('llc')
    expect(ownerKindFor({})).toBe('unknown')
  })
})

describe('normaliseCandidate', () => {
  it('title cases names, splits them, normalises email, phone, zip and state', () => {
    const c = normaliseCandidate({
      source: 'csv',
      full_name: 'MAYA   CHEN',
      email: ' Maya.Chen@Example.COM ',
      phone: '+1 (215) 555-0101',
      mailing_street: '1420 n 29th st',
      mailing_city: 'PHILADELPHIA',
      mailing_state: 'pa',
      mailing_zip: '19121-1234',
      property_count: 4,
    })
    expect(c.full_name).toBe('Maya Chen')
    expect(c.first_name).toBe('Maya')
    expect(c.last_name).toBe('Chen')
    expect(c.email).toBe('maya.chen@example.com')
    expect(c.phone).toBe('2155550101')
    expect(c.mailing_city).toBe('Philadelphia')
    expect(c.mailing_state).toBe('PA')
    expect(c.mailing_zip).toBe('19121')
    expect(c.owner_kind).toBe('person')
    expect(c.dedupe_key).toBe('1420 N 29TH ST|19121')
    expect(c.property_count).toBe(4)
    expect(c.trigger).toEqual({ type: 'none' })
  })
  it('moves an LLC name into company and sets owner_kind llc', () => {
    const c = normaliseCandidate({ source: 'opa', full_name: 'ROY BAKAL INVESTMENTS LLC' })
    expect(c.full_name).toBeNull()
    expect(c.company).toBe('Roy Bakal Investments LLC')
    expect(c.owner_kind).toBe('llc')
  })
  it('builds full_name from first and last and collects zips from properties', () => {
    const c = normaliseCandidate({
      source: 'li',
      first_name: 'ray',
      last_name: 'okafor',
      properties: [
        { address: '1 A St', zip: '19143-0001', units: 2, source: 'li' },
        { address: '2 B St', zip: '19146', units: 3, source: 'li' },
      ],
      property_count: 1,
    })
    expect(c.full_name).toBe('Ray Okafor')
    expect(c.zips).toEqual(['19143', '19146'])
    expect(c.property_count).toBe(2)
    expect(c.unit_count).toBe(5)
  })
  it('a bad email and junk whitespace become null', () => {
    const c = normaliseCandidate({ source: 'csv', email: 'nope', company: '   ' })
    expect(c.email).toBeNull()
    expect(c.company).toBeNull()
    expect(isUsableCandidate(c)).toBe(false)
  })
})

describe('isUsableCandidate', () => {
  it('needs someone and somewhere', () => {
    expect(isUsableCandidate(normaliseCandidate({ source: 'csv', full_name: 'Sam Rivera' }))).toBe(
      false,
    )
    expect(
      isUsableCandidate(
        normaliseCandidate({ source: 'csv', full_name: 'Sam', phone: '2155550000' }),
      ),
    ).toBe(true)
    expect(isUsableCandidate(normaliseCandidate({ source: 'csv', email: 'a@b.co' }))).toBe(true)
  })
})

describe('mergeTrigger', () => {
  it('a real trigger beats none and csv, newer wins among equals', () => {
    expect(mergeTrigger({ type: 'none' }, { type: 'csv' })).toEqual({ type: 'csv' })
    expect(mergeTrigger({ type: 'csv' }, { type: 'recent_sale', date: '2026-09-01' })).toEqual({
      type: 'recent_sale',
      date: '2026-09-01',
    })
    expect(
      mergeTrigger(
        { type: 'new_license', date: '2026-09-10' },
        { type: 'recent_sale', date: '2026-08-01' },
      ),
    ).toEqual({ type: 'new_license', date: '2026-09-10' })
    expect(mergeTrigger({ type: 'new_license', date: '2026-09-10' }, { type: 'none' })).toEqual({
      type: 'new_license',
      date: '2026-09-10',
    })
  })
})

describe('mergeIntoLead', () => {
  it('fills blanks but never overwrites a filled field with an empty one', () => {
    const existing = lead({ full_name: 'Ray Okafor', email: 'ray@example.com' })
    const patch = mergeIntoLead(
      existing,
      normaliseCandidate({
        source: 'csv',
        full_name: '',
        email: null,
        phone: '215-555-0102',
        company: 'Okafor Properties LLC',
        mailing_street: '5214 Baltimore Avenue',
        mailing_zip: '19143',
      }),
    )
    expect(patch.full_name).toBeUndefined()
    expect(patch.email).toBeUndefined()
    expect(patch.phone).toBe('2155550102')
    expect(patch.company).toBe('Okafor Properties LLC')
    expect(patch.mailing_street).toBeUndefined()
    expect(patch.owner_kind).toBe('person')
  })
  it('counts only grow, zips and tags union, notes append', () => {
    const existing = lead({ property_count: 5, unit_count: 2, tags: ['a'], notes: 'first' })
    const patch = mergeIntoLead(
      existing,
      normaliseCandidate({
        source: 'csv',
        full_name: 'X',
        property_count: 3,
        unit_count: 9,
        zips: ['19146'],
        tags: ['a', 'b'],
        notes: 'second',
      }),
    )
    expect(patch.property_count).toBeUndefined()
    expect(patch.unit_count).toBe(9)
    expect(patch.zips).toEqual(['19143', '19146'])
    expect(patch.tags).toEqual(['a', 'b'])
    expect(patch.notes).toBe('first\nsecond')
  })
  it('returns an empty patch when nothing is new', () => {
    const existing = lead({
      full_name: 'Ray Okafor',
      first_name: 'Ray',
      last_name: 'Okafor',
      owner_kind: 'person',
    })
    const patch = mergeIntoLead(
      existing,
      normaliseCandidate({ source: 'opa', full_name: 'Ray Okafor', zips: ['19143'] }),
    )
    expect(patch).toEqual({})
  })
})

describe('displayNameFor', () => {
  it('prefers name, then company, then email, then the address', () => {
    expect(displayNameFor({ full_name: 'Maya Chen', company: 'X LLC' })).toBe('Maya Chen')
    expect(displayNameFor({ company: 'X LLC' })).toBe('X LLC')
    expect(displayNameFor({ email: 'a@b.co' })).toBe('a@b.co')
    expect(displayNameFor({ mailing_street: '5214 BALTIMORE AVE' })).toBe(
      'Owner at 5214 Baltimore Ave',
    )
    expect(displayNameFor({})).toBe('Unknown owner')
  })
})
