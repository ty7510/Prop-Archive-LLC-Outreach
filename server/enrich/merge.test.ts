import { describe, expect, it } from 'vitest'
import { computeChannels, hasEnoughContact } from './channels.ts'
import { mergeProviderResult, shouldReplaceEmail } from './merge.ts'
import { makeLead } from './testing.ts'

describe('shouldReplaceEmail', () => {
  it('fills an empty email', () => {
    expect(
      shouldReplaceEmail(
        { email: null, email_status: 'unknown' },
        { email: 'a@b.co', email_status: 'unknown' },
      ),
    ).toBe(true)
  })

  it('never replaces a valid email with an unverified one', () => {
    expect(
      shouldReplaceEmail(
        { email: 'good@b.co', email_status: 'valid' },
        { email: 'other@b.co', email_status: 'unknown' },
      ),
    ).toBe(false)
    expect(
      shouldReplaceEmail(
        { email: 'good@b.co', email_status: 'valid' },
        { email: 'other@b.co', email_status: 'risky' },
      ),
    ).toBe(false)
    expect(
      shouldReplaceEmail(
        { email: 'good@b.co', email_status: 'valid' },
        { email: 'other@b.co', email_status: 'valid' },
      ),
    ).toBe(false)
  })

  it('upgrades an unknown email to a verified one', () => {
    expect(
      shouldReplaceEmail(
        { email: 'guess@b.co', email_status: 'unknown' },
        { email: 'real@b.co', email_status: 'valid' },
      ),
    ).toBe(true)
    expect(
      shouldReplaceEmail(
        { email: 'guess@b.co', email_status: 'unknown' },
        { email: 'guess@b.co', email_status: 'valid' },
      ),
    ).toBe(true)
  })

  it('does not swap one unverified email for another', () => {
    expect(
      shouldReplaceEmail(
        { email: 'a@b.co', email_status: 'risky' },
        { email: 'c@d.co', email_status: 'unknown' },
      ),
    ).toBe(false)
  })

  it('replaces an invalid email with anything', () => {
    expect(
      shouldReplaceEmail(
        { email: 'dead@b.co', email_status: 'invalid' },
        { email: 'c@d.co', email_status: 'unknown' },
      ),
    ).toBe(true)
  })
})

describe('mergeProviderResult', () => {
  it('fills empty fields and leaves filled ones alone', () => {
    const lead = makeLead({ company: 'Keep LLC', website: null })
    const patch = mergeProviderResult(lead, {
      raw: {},
      confidence: 0.5,
      company: 'Other LLC',
      website: 'https://keep.com',
      linkedin_url: ' https://linkedin.com/in/x ',
    })
    expect(patch).toEqual({
      website: 'https://keep.com',
      linkedin_url: 'https://linkedin.com/in/x',
    })
  })

  it('never writes an empty value over a value', () => {
    const lead = makeLead({ full_name: 'Maya Lopez', first_name: 'Maya', last_name: 'Lopez' })
    const patch = mergeProviderResult(lead, {
      raw: {},
      confidence: 1,
      full_name: '',
      company: '  ',
    })
    expect(patch).toEqual({})
  })

  it('normalises and keeps a verified email, drops a worse one', () => {
    const lead = makeLead({ email: 'Owner@Example.com', email_status: 'valid' })
    expect(
      mergeProviderResult(lead, {
        raw: {},
        confidence: 1,
        email: 'x@y.com',
        email_status: 'unknown',
      }),
    ).toEqual({})
    const empty = makeLead()
    expect(
      mergeProviderResult(empty, { raw: {}, confidence: 1, email: ' Owner@Example.com ' }),
    ).toEqual({ email: 'owner@example.com', email_status: 'unknown' })
  })

  it('ignores an email that is not an email', () => {
    expect(mergeProviderResult(makeLead(), { raw: {}, confidence: 1, email: 'none' })).toEqual({})
  })

  it('normalises phone and upgrades the type for the same number', () => {
    const lead = makeLead()
    expect(
      mergeProviderResult(lead, {
        raw: {},
        confidence: 1,
        phone: '+1 (215) 555-0100',
        phone_type: 'mobile',
      }),
    ).toEqual({ phone: '2155550100', phone_type: 'mobile' })
    const known = makeLead({ phone: '2155550100', phone_type: 'unknown' })
    expect(
      mergeProviderResult(known, {
        raw: {},
        confidence: 1,
        phone: '215-555-0100',
        phone_type: 'mobile',
      }),
    ).toEqual({ phone_type: 'mobile' })
    expect(mergeProviderResult(makeLead(), { raw: {}, confidence: 1, phone: '555' })).toEqual({})
  })

  it('splits a learned full name into first and last', () => {
    const patch = mergeProviderResult(makeLead(), {
      raw: {},
      confidence: 1,
      full_name: 'ray torres',
    })
    expect(patch).toEqual({ full_name: 'ray torres', first_name: 'Ray', last_name: 'Torres' })
  })

  it('builds a full name from learned parts', () => {
    const patch = mergeProviderResult(makeLead(), {
      raw: {},
      confidence: 1,
      first_name: 'Denise',
      last_name: 'Park',
    })
    expect(patch).toEqual({ first_name: 'Denise', last_name: 'Park', full_name: 'Denise Park' })
  })

  it('raises unit_count but never lowers it, and moves llc to person only', () => {
    const lead = makeLead({ unit_count: 6, owner_kind: 'llc' })
    expect(
      mergeProviderResult(lead, { raw: {}, confidence: 1, unit_count: 4, owner_kind: 'llc' }),
    ).toEqual({})
    expect(
      mergeProviderResult(lead, { raw: {}, confidence: 1, unit_count: 9, owner_kind: 'person' }),
    ).toEqual({ unit_count: 9, owner_kind: 'person' })
    const person = makeLead({ owner_kind: 'person' })
    expect(mergeProviderResult(person, { raw: {}, confidence: 1, owner_kind: 'llc' })).toEqual({})
  })
})

describe('channels', () => {
  it('computes what we can use', () => {
    expect(computeChannels(makeLead())).toEqual({
      email: false,
      mail: false,
      linkedin: false,
      instagram: false,
      call: false,
    })
    expect(
      computeChannels(
        makeLead({
          email: 'a@b.co',
          email_status: 'risky',
          phone: '2155550100',
          linkedin_url: 'https://linkedin.com/in/a',
          mailing_street: '1 Main St',
          mailing_zip: '19104',
        }),
      ),
    ).toEqual({ email: true, mail: true, linkedin: true, instagram: false, call: true })
  })

  it('an invalid email is not a channel', () => {
    expect(computeChannels(makeLead({ email: 'a@b.co', email_status: 'invalid' })).email).toBe(
      false,
    )
  })

  it('hasEnoughContact needs email and linkedin or phone', () => {
    expect(hasEnoughContact(makeLead({ email: 'a@b.co' }))).toBe(false)
    expect(hasEnoughContact(makeLead({ linkedin_url: 'x', phone: '1' }))).toBe(false)
    expect(hasEnoughContact(makeLead({ email: 'a@b.co', linkedin_url: 'x' }))).toBe(true)
    expect(hasEnoughContact(makeLead({ email: 'a@b.co', phone: '2155550100' }))).toBe(true)
  })
})
