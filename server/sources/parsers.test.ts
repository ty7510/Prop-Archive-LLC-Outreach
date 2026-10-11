import { describe, expect, it } from 'vitest'
import {
  liMailingAddress,
  liOwnerName,
  liRowsToCandidates,
  newLicenseTrigger,
  parseOneLineAddress,
  type LiRow,
} from './li.ts'
import { neighborhoodFor, neighborhoodForLead } from './neighborhoods.ts'
import {
  isoDate,
  opaMailingAddress,
  opaRowsToCandidates,
  parseCityState,
  parseOpaOwnerName,
  recentSaleTrigger,
  type OpaRow,
} from './opa.ts'

const NOW = new Date('2026-10-11T12:00:00Z')

export function opaRow(over: Partial<OpaRow> = {}): OpaRow {
  return {
    parcel_number: '603072800',
    location: '5349 DELANCEY ST',
    unit: null,
    zip_code: '19143',
    category_code_description: 'SINGLE FAMILY',
    sale_date: '2019-05-01T04:00:00Z',
    sale_price: 150000,
    market_value: 230300,
    owner_1: 'OKAFOR RAY',
    owner_2: null,
    mailing_street: '5214 BALTIMORE AVE',
    mailing_city_state: 'PHILADELPHIA PA',
    mailing_zip: '19143',
    mailing_address_1: null,
    mailing_address_2: null,
    key_street: '5214 BALTIMORE AVE',
    key_zip: '19143',
    owner_property_count: 3,
    ...over,
  }
}

export function liRow(over: Partial<LiRow> = {}): LiRow {
  return {
    address: '5727 BEAUMONT ST',
    zip: '19143-5204',
    opa_account_num: '513284400',
    opa_owner: 'ROY BAKAL INVESTMENTS LLC',
    owneroccupied: 'No',
    licensenum: '1020154',
    rentalcategory: 'Residential Dwellings',
    initialissuedate: '2026-10-06T16:37:51Z',
    mostrecentissuedate: '2026-10-06T16:37:51Z',
    expirationdate: '2027-10-05T16:37:51Z',
    licensestatus: 'Active',
    numberofunits: 1,
    legalfirstname: null,
    legallastname: null,
    legalname: 'ROY BAKAL INVESTMENTS LLC',
    legalentitytype: 'Company',
    business_name: 'ROY BAKAL INVESTMENTS LLC',
    business_mailing_address: '7637 Overbrook Avenue #2 Phila, PA  19151 USA',
    ownercontact1name: 'EYAL TAKIZADE',
    ownercontact1mailingaddress: '7637 Overbrook Avenue #2',
    ownercontact1city: 'Phila',
    ownercontact1state: 'PA',
    ownercontact1zippostalcode: '19151',
    ...over,
  }
}

describe('OPA parsing', () => {
  it('isoDate trims Carto timestamps', () => {
    expect(isoDate('2026-09-23T04:00:00Z')).toBe('2026-09-23')
    expect(isoDate(null)).toBeNull()
    expect(isoDate('nope')).toBeNull()
  })
  it('parseOpaOwnerName reads LAST FIRST and keeps companies whole', () => {
    expect(parseOpaOwnerName('SMITH JOHN A')).toEqual({
      full_name: 'John Smith',
      first_name: 'John',
      last_name: 'Smith',
      company: null,
    })
    expect(parseOpaOwnerName('MARTIN ADRIANE H')).toMatchObject({ full_name: 'Adriane Martin' })
    expect(parseOpaOwnerName('OKAFOR RAY')).toMatchObject({
      first_name: 'Ray',
      last_name: 'Okafor',
    })
    expect(parseOpaOwnerName('ROY BAKAL INVESTMENTS LLC')).toEqual({
      full_name: null,
      first_name: null,
      last_name: null,
      company: 'Roy Bakal Investments LLC',
    })
    expect(parseOpaOwnerName('MADONNA')).toMatchObject({
      full_name: 'Madonna',
      last_name: 'Madonna',
    })
    expect(parseOpaOwnerName(null).full_name).toBeNull()
  })
  it('parseCityState splits the trailing state', () => {
    expect(parseCityState('PHILADELPHIA PA')).toEqual({ city: 'Philadelphia', state: 'PA' })
    expect(parseCityState('CHERRY HILL, NJ')).toEqual({ city: 'Cherry Hill', state: 'NJ' })
    expect(parseCityState('LONDON')).toEqual({ city: 'London', state: null })
    expect(parseCityState(null)).toEqual({ city: null, state: null })
  })
  it('opaMailingAddress falls back to the property when OPA has no mailing street', () => {
    expect(opaMailingAddress(opaRow())).toEqual({
      mailing_street: '5214 Baltimore Ave',
      mailing_city: 'Philadelphia',
      mailing_state: 'PA',
      mailing_zip: '19143',
    })
    expect(
      opaMailingAddress(
        opaRow({ mailing_street: null, mailing_zip: null, mailing_city_state: null }),
      ),
    ).toEqual({
      mailing_street: '5349 Delancey St',
      mailing_city: 'Philadelphia',
      mailing_state: 'PA',
      mailing_zip: '19143',
    })
  })
  it('recentSaleTrigger picks the newest real sale in the window and ignores $1 transfers', () => {
    const props = opaRowsToCandidates(
      [
        opaRow({ parcel_number: '1', sale_date: '2026-09-23T04:00:00Z', sale_price: 1 }),
        opaRow({ parcel_number: '2', sale_date: '2026-08-26T04:00:00Z', sale_price: 235000 }),
        opaRow({ parcel_number: '3', sale_date: '2026-09-01T04:00:00Z', sale_price: 300000 }),
        opaRow({ parcel_number: '4', sale_date: '2026-01-01T04:00:00Z', sale_price: 900000 }),
      ],
      NOW,
    )[0]!.properties!
    const t = recentSaleTrigger(props, NOW)
    expect(t.type).toBe('recent_sale')
    expect(t.date).toBe('2026-09-01')
    expect(t.detail).toContain('$300,000')
    expect(recentSaleTrigger([props[3]!], NOW)).toEqual({ type: 'none' })
  })
  it('opaRowsToCandidates groups parcels by owner key', () => {
    const rows = [
      opaRow({ parcel_number: '1', zip_code: '19143', category_code_description: 'MULTI FAMILY' }),
      opaRow({ parcel_number: '2', zip_code: '19146', unit: 'A', owner_2: 'OKAFOR ADA' }),
      opaRow({ parcel_number: '3', zip_code: '19104' }),
      opaRow({
        parcel_number: '9',
        owner_1: 'CHEN MAYA',
        mailing_street: '1420 N 29TH ST',
        mailing_zip: '19121',
        key_street: '1420 N 29TH ST',
        key_zip: '19121',
        owner_property_count: 4,
      }),
    ]
    const out = opaRowsToCandidates(rows, NOW)
    expect(out).toHaveLength(2)
    const ray = out[0]!
    expect(ray).toMatchObject({
      source: 'opa',
      full_name: 'Ray Okafor',
      mailing_street: '5214 Baltimore Ave',
      mailing_zip: '19143',
      property_count: 3,
    })
    expect(ray.zips).toEqual(['19143', '19146', '19104'])
    expect(ray.properties).toHaveLength(3)
    expect(ray.properties![1]).toMatchObject({
      address: '5349 DELANCEY ST Unit A',
      opa_account: '2',
      source: 'opa',
    })
    expect(ray.notes).toContain('Also on the deed: Ada Okafor')
    expect(ray.trigger).toEqual({ type: 'none' })
    const maya = out[1]!
    expect(maya.full_name).toBe('Maya Chen')
    // The SQL count says 4 even though this page only showed one parcel.
    expect(maya.property_count).toBe(4)
  })
})

describe('L&I parsing', () => {
  it('parseOneLineAddress handles the L&I one-liner with a country', () => {
    expect(parseOneLineAddress('7637 Overbrook Avenue #2 Phila, PA  19151 USA')).toEqual({
      mailing_street: '7637 Overbrook Avenue #2',
      mailing_city: 'Phila',
      mailing_state: 'PA',
      mailing_zip: '19151',
    })
    expect(parseOneLineAddress('123 Main St, Cherry Hill, NJ 08002-1234')).toEqual({
      mailing_street: '123 Main St',
      mailing_city: 'Cherry Hill',
      mailing_state: 'NJ',
      mailing_zip: '08002',
    })
    expect(parseOneLineAddress('PO Box 12 19104')).toMatchObject({
      mailing_street: 'PO Box 12',
      mailing_zip: '19104',
    })
    expect(parseOneLineAddress('')).toMatchObject({ mailing_street: null })
  })
  it('liOwnerName prefers a real person, keeps the LLC as company', () => {
    expect(liOwnerName(liRow())).toEqual({
      full_name: 'Eyal Takizade',
      first_name: null,
      last_name: null,
      company: 'Roy Bakal Investments LLC',
    })
    expect(
      liOwnerName(
        liRow({
          legalfirstname: 'maya',
          legallastname: 'CHEN',
          legalname: 'MAYA CHEN',
          business_name: null,
        }),
      ),
    ).toEqual({ full_name: 'Maya Chen', first_name: 'Maya', last_name: 'Chen', company: null })
    expect(liOwnerName(liRow({ ownercontact1name: null })).full_name).toBeNull()
  })
  it('liMailingAddress prefers the contact address, then the business line, then the property', () => {
    expect(liMailingAddress(liRow())).toEqual({
      mailing_street: '7637 Overbrook Avenue #2',
      mailing_city: 'Phila',
      mailing_state: 'PA',
      mailing_zip: '19151',
    })
    expect(liMailingAddress(liRow({ ownercontact1mailingaddress: null })).mailing_zip).toBe('19151')
    expect(
      liMailingAddress(
        liRow({ ownercontact1mailingaddress: null, business_mailing_address: null }),
      ),
    ).toEqual({
      mailing_street: '5727 Beaumont St',
      mailing_city: 'Philadelphia',
      mailing_state: 'PA',
      mailing_zip: '19143',
    })
  })
  it('newLicenseTrigger uses the newest license', () => {
    const t = newLicenseTrigger([
      liRow({ initialissuedate: '2026-09-01T00:00:00Z', licensenum: 'OLD' }),
      liRow({ initialissuedate: '2026-10-06T16:37:51Z', licensenum: 'NEW', numberofunits: 3 }),
    ])
    expect(t).toMatchObject({ type: 'new_license', date: '2026-10-06' })
    expect(t.detail).toContain('NEW')
    expect(t.detail).toContain('3 units')
    expect(newLicenseTrigger([liRow({ initialissuedate: null })])).toEqual({ type: 'none' })
  })
  it('liRowsToCandidates groups licenses by the licensee address', () => {
    const out = liRowsToCandidates([
      liRow({ licensenum: '1', address: '5727 BEAUMONT ST' }),
      liRow({ licensenum: '2', address: '5729 BEAUMONT ST', numberofunits: 2 }),
      liRow({
        licensenum: '3',
        address: '100 OTHER ST',
        zip: '19104',
        ownercontact1mailingaddress: '1 Elsewhere Rd',
        ownercontact1zippostalcode: '08002',
        ownercontact1state: 'NJ',
        ownercontact1city: 'Cherry Hill',
        legalname: 'SAM RIVERA',
        business_name: null,
        ownercontact1name: 'SAM RIVERA',
      }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'li',
      company: 'Roy Bakal Investments LLC',
      full_name: 'Eyal Takizade',
      property_count: 2,
      unit_count: 3,
      mailing_zip: '19151',
    })
    expect(out[0]!.properties![0]).toMatchObject({
      opa_account: '513284400',
      license_num: '1',
      license_issue_date: '2026-10-06',
      license_expiry: '2027-10-05',
      units: 1,
      source: 'li',
      category: 'RENTAL RESIDENTIAL DWELLINGS',
    })
    expect(out[0]!.trigger?.type).toBe('new_license')
    expect(out[1]).toMatchObject({ full_name: 'Sam Rivera', company: null, mailing_state: 'NJ' })
  })
})

describe('neighborhoods', () => {
  it('names the default zips and falls back to the mailing zip', () => {
    expect(neighborhoodFor('19104')).toBe('University City')
    expect(neighborhoodFor('19125-1234')).toBe('Fishtown / Kensington')
    expect(neighborhoodFor('99999')).toBe('')
    expect(neighborhoodForLead({ zips: ['99999', '19146'] })).toBe(
      'Point Breeze / Graduate Hospital',
    )
    expect(neighborhoodForLead({ zips: [], mailing_zip: '19139' })).toBe('West Philly')
    expect(neighborhoodForLead({})).toBe('')
  })
})
