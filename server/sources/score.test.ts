import { describe, expect, it } from 'vitest'
import {
  categoryPoints,
  isPhiladelphiaAddress,
  localOwnerPoints,
  personaFor,
  propertyCountPoints,
  scoreLead,
  triggerPoints,
  zipPoints,
} from './score.ts'

const NOW = new Date('2026-10-11T12:00:00Z')
const TARGET = ['19104', '19121', '19122', '19139', '19143', '19146', '19125']

describe('propertyCountPoints', () => {
  it('follows the spec buckets', () => {
    expect(propertyCountPoints(0)).toBe(15)
    expect(propertyCountPoints(null)).toBe(15)
    expect(propertyCountPoints(1)).toBe(5)
    expect(propertyCountPoints(2)).toBe(5)
    expect(propertyCountPoints(3)).toBe(40)
    expect(propertyCountPoints(6)).toBe(40)
    expect(propertyCountPoints(7)).toBe(40)
    expect(propertyCountPoints(14)).toBe(40)
    expect(propertyCountPoints(15)).toBe(35)
    expect(propertyCountPoints(20)).toBe(35)
    expect(propertyCountPoints(21)).toBe(10)
    expect(propertyCountPoints(200)).toBe(10)
  })
})

describe('zipPoints', () => {
  it('scores any overlap 20 and full overlap 25', () => {
    expect(zipPoints(['19104', '19020'], TARGET)).toBe(20)
    expect(zipPoints(['19104', '19121'], TARGET)).toBe(25)
    expect(zipPoints(['19104'], TARGET)).toBe(25)
    expect(zipPoints(['19020'], TARGET)).toBe(0)
    expect(zipPoints([], TARGET)).toBe(0)
    expect(zipPoints(null, TARGET)).toBe(0)
  })
  it('tolerates zip+4 and duplicates', () => {
    expect(zipPoints(['19104-2301', '19104'], TARGET)).toBe(25)
  })
})

describe('triggerPoints', () => {
  it('new license within 60 days is 20, older is 0', () => {
    expect(triggerPoints({ type: 'new_license', date: '2026-09-01' }, NOW)).toBe(20)
    expect(triggerPoints({ type: 'new_license', date: '2026-08-13' }, NOW)).toBe(20)
    expect(triggerPoints({ type: 'new_license', date: '2026-08-01' }, NOW)).toBe(0)
  })
  it('recent sale within 90 days is 20, older is 0', () => {
    expect(triggerPoints({ type: 'recent_sale', date: '2026-08-01' }, NOW)).toBe(20)
    expect(triggerPoints({ type: 'recent_sale', date: '2026-07-14' }, NOW)).toBe(20)
    expect(triggerPoints({ type: 'recent_sale', date: '2026-06-01' }, NOW)).toBe(0)
  })
  it('none, csv, missing or bad dates score 0', () => {
    expect(triggerPoints({ type: 'none' }, NOW)).toBe(0)
    expect(triggerPoints({ type: 'csv' }, NOW)).toBe(0)
    expect(triggerPoints({ type: 'new_license' }, NOW)).toBe(0)
    expect(triggerPoints({ type: 'new_license', date: 'yesterday' }, NOW)).toBe(0)
    expect(triggerPoints(null, NOW)).toBe(0)
    expect(triggerPoints({ type: 'recent_sale', date: '2027-01-01' }, NOW)).toBe(0)
  })
})

describe('categoryPoints', () => {
  it('is 10 for multi family, mixed use or apartments', () => {
    expect(categoryPoints(['SINGLE FAMILY', 'MULTI FAMILY'])).toBe(10)
    expect(categoryPoints(['MIXED USE'])).toBe(10)
    expect(categoryPoints(['APARTMENTS  > 4 UNITS'])).toBe(10)
    expect(categoryPoints(['SINGLE FAMILY', null, undefined])).toBe(0)
    expect(categoryPoints([])).toBe(0)
    expect(categoryPoints(null)).toBe(0)
  })
})

describe('local owner', () => {
  it('spots Philadelphia by zip or city', () => {
    expect(isPhiladelphiaAddress({ mailing_zip: '19143' })).toBe(true)
    expect(isPhiladelphiaAddress({ mailing_city: 'Philadelphia', mailing_state: 'PA' })).toBe(true)
    expect(isPhiladelphiaAddress({ mailing_city: 'PHILA', mailing_state: 'PA' })).toBe(true)
    expect(isPhiladelphiaAddress({ mailing_city: 'Philadelphia', mailing_state: 'MS' })).toBe(false)
    expect(isPhiladelphiaAddress({ mailing_city: 'Cherry Hill', mailing_state: 'NJ' })).toBe(false)
    expect(isPhiladelphiaAddress({ mailing_city: 'Pittsburgh', mailing_state: 'PA' })).toBe(false)
    expect(isPhiladelphiaAddress({})).toBe(false)
  })
  it('gives 5 for local, 0 for anywhere else', () => {
    expect(localOwnerPoints({ mailing_zip: '19104' })).toBe(5)
    expect(localOwnerPoints({ mailing_state: 'NJ', mailing_zip: '08002' })).toBe(0)
    expect(localOwnerPoints({ mailing_city: 'Pittsburgh', mailing_state: 'PA' })).toBe(0)
  })
})

describe('scoreLead', () => {
  it('adds the parts and clamps to 100', () => {
    const maya = scoreLead(
      {
        property_count: 4,
        zips: ['19121'],
        trigger: { type: 'new_license', date: '2026-09-20' },
        categories: ['MULTI FAMILY', 'SINGLE FAMILY'],
        mailing_zip: '19121',
      },
      { target_zips: TARGET },
      NOW,
    )
    expect(maya).toBe(40 + 25 + 20 + 10 + 5)
  })
  it('an out of state owner of one house outside the zips scores low', () => {
    const low = scoreLead(
      { property_count: 1, zips: ['19020'], trigger: { type: 'none' }, mailing_state: 'FL' },
      { target_zips: TARGET },
      NOW,
    )
    expect(low).toBe(5)
  })
  it('a CSV lead with no properties still gets the unknown bucket', () => {
    expect(
      scoreLead(
        { property_count: 0, zips: [], trigger: { type: 'csv' } },
        { target_zips: TARGET },
        NOW,
      ),
    ).toBe(15)
  })
  it('never goes outside 0..100', () => {
    const s = scoreLead(
      {
        property_count: 10,
        zips: ['19104'],
        trigger: { type: 'recent_sale', date: '2026-10-01' },
        categories: ['APARTMENTS  > 4 UNITS'],
        mailing_zip: '19104',
      },
      { target_zips: TARGET },
      NOW,
    )
    expect(s).toBeLessThanOrEqual(100)
    expect(s).toBe(100)
  })
})

describe('personaFor', () => {
  it('maps counts to Maya, Ray, Denise', () => {
    expect(personaFor(0)).toBe('unknown')
    expect(personaFor(null)).toBe('unknown')
    expect(personaFor(1)).toBe('maya')
    expect(personaFor(3)).toBe('maya')
    expect(personaFor(6)).toBe('maya')
    expect(personaFor(7)).toBe('ray')
    expect(personaFor(14)).toBe('ray')
    expect(personaFor(15)).toBe('denise')
    expect(personaFor(20)).toBe('denise')
    expect(personaFor(45)).toBe('denise')
  })
})
