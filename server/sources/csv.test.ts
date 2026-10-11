import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapHeader, mapHeaders, parseCsv, rowToCandidate, squashHeader } from './csv.ts'
import { normaliseCandidate } from './merge.ts'

const SAMPLE = resolve(process.cwd(), 'server/seed/sample-leads.csv')

describe('mapHeader', () => {
  it('recognises the spec header names in any spelling', () => {
    const cases: Record<string, string> = {
      Name: 'full_name',
      'Full Name': 'full_name',
      'Owner Name': 'full_name',
      First: 'first_name',
      'First Name': 'first_name',
      Last: 'last_name',
      Surname: 'last_name',
      Email: 'email',
      'Email Address': 'email',
      'E-mail': 'email',
      'Work Email (primary)': 'email',
      Phone: 'phone',
      'Phone Number': 'phone',
      Cell: 'phone',
      Mobile: 'phone',
      Company: 'company',
      'Business Name': 'company',
      LLC: 'company',
      Address: 'mailing_street',
      'Street Address': 'mailing_street',
      'Address Line 1': 'mailing_street',
      'Mailing Address': 'mailing_street',
      City: 'mailing_city',
      State: 'mailing_state',
      ST: 'mailing_state',
      Zip: 'mailing_zip',
      'ZIP Code': 'mailing_zip',
      'Postal Code': 'mailing_zip',
      LinkedIn: 'linkedin_url',
      'LinkedIn URL': 'linkedin_url',
      Instagram: 'instagram_url',
      Website: 'website',
      Notes: 'notes',
      Comments: 'notes',
      Units: 'unit_count',
      '# Units': 'unit_count',
      Doors: 'unit_count',
      Properties: 'property_count',
      '# Properties': 'property_count',
      'Number of Properties': 'property_count',
      'Portfolio Size': 'property_count',
      Tags: 'tags',
      Zips: 'zips',
    }
    for (const [header, field] of Object.entries(cases)) {
      expect(mapHeader(header), header).toBe(field)
    }
  })
  it('returns null for columns it does not know', () => {
    expect(mapHeader('Favourite colour')).toBeNull()
    expect(mapHeader('')).toBeNull()
    expect(mapHeader('   ')).toBeNull()
  })
  it('squashHeader strips case, spaces and punctuation', () => {
    expect(squashHeader(' E-mail Address ')).toBe('emailaddress')
    expect(squashHeader('# Units')).toBe('numberunits')
  })
})

describe('mapHeaders', () => {
  it('maps each field once and lists the rest as unmapped', () => {
    const m = mapHeaders(['Name', 'Email', 'Email 2', 'Nickname', 'Zip'])
    expect(m.mapped).toEqual({ Name: 'full_name', Email: 'email', Zip: 'mailing_zip' })
    expect(m.unmapped).toEqual(['Email 2', 'Nickname'])
  })
})

describe('parseCsv and rowToCandidate', () => {
  it('parses the sample file with mixed columns', () => {
    const parsed = parseCsv(readFileSync(SAMPLE))
    expect(parsed.rows).toHaveLength(5)
    expect(parsed.headers).toContain('Street Address')
    expect(parsed.mapping.mapped['Email Address']).toBe('email')
    expect(parsed.mapping.mapped['# Properties']).toBe('property_count')
    expect(parsed.mapping.unmapped).toEqual([])

    const first = rowToCandidate(parsed.rows[0]!, parsed.mapping, 'Imported from sample-leads.csv')
    expect(first).toMatchObject({
      source: 'csv',
      full_name: 'Maya Chen',
      email: 'maya.chen@example.com',
      phone: '(215) 555-0101',
      company: null,
      mailing_street: '1420 N 29th St',
      mailing_city: 'Philadelphia',
      mailing_state: 'PA',
      mailing_zip: '19121',
      property_count: 4,
      unit_count: 6,
      linkedin_url: 'https://www.linkedin.com/in/maya-chen-example',
      trigger: { type: 'csv' },
    })
    expect(first.notes).toBe('Met at the REIA meetup\nImported from sample-leads.csv')

    const quoted = rowToCandidate(parsed.rows[2]!, parsed.mapping)
    expect(quoted.mailing_street).toBe('2100 Washington Ave, Suite 300')
    expect(quoted.full_name).toBeNull()
    expect(quoted.company).toBe('Hall Property Management LLC')
  })

  it('rows 2 and 4 of the sample share a dedupe key', () => {
    const parsed = parseCsv(readFileSync(SAMPLE))
    const a = normaliseCandidate(rowToCandidate(parsed.rows[1]!, parsed.mapping))
    const b = normaliseCandidate(rowToCandidate(parsed.rows[3]!, parsed.mapping))
    expect(a.dedupe_key).toBe('5214 BALTIMORE AVE|19143')
    expect(b.dedupe_key).toBe(a.dedupe_key)
  })

  it('handles a BOM, CRLF, semicolon lists and a short row', () => {
    const text = '﻿first,last,email,tags,zips\r\nray,okafor,RAY@x.io,"a; b",19143|19146\r\nsolo\r\n'
    const parsed = parseCsv(text)
    expect(parsed.headers).toEqual(['first', 'last', 'email', 'tags', 'zips'])
    expect(parsed.rows).toHaveLength(2)
    const c = rowToCandidate(parsed.rows[0]!, parsed.mapping)
    expect(c.first_name).toBe('ray')
    expect(c.tags).toEqual(['a', 'b'])
    expect(c.zips).toEqual(['19143', '19146'])
    const n = normaliseCandidate(c)
    expect(n.full_name).toBe('Ray Okafor')
    expect(n.email).toBe('ray@x.io')
  })

  it('an empty file has no headers', () => {
    expect(parseCsv('')).toMatchObject({ headers: [], rows: [] })
  })

  it('a header only file keeps the headers', () => {
    const parsed = parseCsv('Name,Email\n')
    expect(parsed.headers).toEqual(['Name', 'Email'])
    expect(parsed.rows).toEqual([])
  })
})
