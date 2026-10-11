import { describe, expect, it } from 'vitest'
import type { Property } from '../../db/schema.ts'
import { ProviderHttpError } from '../http.ts'
import { makeContext, makeLead, queuedFetch } from '../testing.ts'
import {
  buildLicenseSql,
  createLiLicenseProvider,
  licenseUrl,
  mapLicenseRows,
  type LicenseRow,
} from './liLicense.ts'

const rows: LicenseRow[] = [
  {
    address: '4000 CHESTNUT ST',
    zip: '19104',
    opa_account_num: '271000100',
    opa_owner: 'CHESTNUT HOLDINGS LLC',
    licensenum: '123456',
    rentalcategory: 'Rental Dwelling',
    initialissuedate: '2026-08-15T00:00:00Z',
    mostrecentissuedate: '2026-08-15T00:00:00Z',
    expirationdate: '2027-08-15T00:00:00Z',
    licensestatus: 'Active',
    numberofunits: 3,
    legalfirstname: 'MAYA',
    legallastname: 'LOPEZ',
    legalname: null,
    legalentitytype: 'Individual',
    business_name: 'CHESTNUT HOLDINGS LLC',
    business_mailing_address: '12 OAK LN, PHILADELPHIA PA 19146',
    ownercontact1name: null,
    ownercontact1mailingaddress: '12 OAK LN',
    ownercontact1city: 'PHILADELPHIA',
    ownercontact1state: 'pa',
    ownercontact1zippostalcode: '19146-1234',
  },
  {
    address: '4002 CHESTNUT ST',
    zip: '19104',
    opa_account_num: '271000200',
    licensenum: '123457',
    mostrecentissuedate: '2025-01-01T00:00:00Z',
    licensestatus: 'Expired',
    numberofunits: '2',
    legalfirstname: null,
    legallastname: null,
    ownercontact1name: 'LOPEZ MAYA',
  },
  {
    // Same property as the first row, older license: ignored for units.
    address: '4000 CHESTNUT ST',
    opa_account_num: '271000100',
    licensenum: '000001',
    mostrecentissuedate: '2024-01-01T00:00:00Z',
    licensestatus: 'Expired',
    numberofunits: 9,
  },
]

describe('buildLicenseSql', () => {
  it('selects the known columns for the accounts, de-duplicated and quoted', () => {
    const sql = buildLicenseSql(['271000100', '271000100', " 27'1 "])
    expect(sql).toContain('FROM business_licenses')
    expect(sql).toContain("licensetype = 'Rental'")
    expect(sql).toContain("opa_account_num IN ('271000100','27''1')")
    expect(sql).toContain('numberofunits')
    expect(licenseUrl(sql)).toMatch(/^https:\/\/phl\.carto\.com\/api\/v2\/sql\?q=SELECT/)
  })
})

describe('mapLicenseRows', () => {
  it('turns an LLC into a person, sums units per property, keeps license facts', () => {
    const r = mapLicenseRows(rows, makeLead({ owner_kind: 'llc' }))
    expect(r.full_name).toBe('Maya Lopez')
    expect(r.first_name).toBe('Maya')
    expect(r.last_name).toBe('Lopez')
    expect(r.owner_kind).toBe('person')
    expect(r.company).toBe('Chestnut Holdings LLC')
    expect(r.unit_count).toBe(5) // 3 + 2, not the stale 9
    expect(r.confidence).toBe(0.9)
    expect(r.mailing_street).toBe('12 Oak Ln')
    expect(r.mailing_city).toBe('Philadelphia')
    expect(r.mailing_state).toBe('PA')
    expect(r.mailing_zip).toBe('19146')
    expect(r.property_updates).toEqual([
      {
        opa_account: '271000100',
        units: 3,
        license_num: '123456',
        license_issue_date: '2026-08-15T00:00:00Z',
        license_expiry: '2027-08-15T00:00:00Z',
      },
      {
        opa_account: '271000200',
        units: 2,
        license_num: '123457',
        license_issue_date: null,
        license_expiry: null,
      },
    ])
  })

  it('falls back to the owner contact name', () => {
    const r = mapLicenseRows([rows[1]!], makeLead())
    expect(r.full_name).toBe('Lopez Maya')
    expect(r.confidence).toBe(0.6)
  })

  it('returns an empty result for no rows', () => {
    const r = mapLicenseRows([], makeLead())
    expect(r.confidence).toBe(0)
    expect(r.full_name).toBeUndefined()
  })
})

describe('li_license provider', () => {
  const props = [
    { id: 'p1', lead_id: 'x', opa_account: '271000100' } as Property,
    { id: 'p2', lead_id: 'x', opa_account: null } as Property,
  ]

  it('is free, always configured and applies only with an OPA account', () => {
    const p = createLiLicenseProvider()
    expect(p.costPerCall).toBe(0)
    expect(p.isConfigured(makeContext().env)).toBe(true)
    expect(p.applies(makeLead(), makeContext({ properties: props }))).toBe(true)
    expect(p.applies(makeLead(), makeContext({ properties: [props[1]!] }))).toBe(false)
  })

  it('queries Carto and maps the rows', async () => {
    const f = queuedFetch([{ status: 200, body: { rows } }])
    const p = createLiLicenseProvider({ fetch: f, sleep: async () => {} })
    const r = await p.enrich(makeLead(), makeContext({ properties: props }))
    expect(f.calls[0]?.url).toContain('phl.carto.com')
    expect(decodeURIComponent(f.calls[0]?.url ?? '')).toContain("IN ('271000100')")
    expect(r.full_name).toBe('Maya Lopez')
    expect(r.unit_count).toBe(5)
  })

  it('retries 500 and reports a clean error', async () => {
    const f = queuedFetch([{ status: 500, text: 'oops' }])
    const p = createLiLicenseProvider({ fetch: f, sleep: async () => {} })
    await expect(p.enrich(makeLead(), makeContext({ properties: props }))).rejects.toBeInstanceOf(
      ProviderHttpError,
    )
    expect(f.calls).toHaveLength(3)
  })

  it('a Carto error body is an error, not a crash', async () => {
    const f = queuedFetch([{ status: 400, body: { error: ['syntax error'] } }])
    const p = createLiLicenseProvider({ fetch: f, sleep: async () => {} })
    await expect(p.enrich(makeLead(), makeContext({ properties: props }))).rejects.toThrow(
      /li_license: HTTP 400 syntax error/,
    )
  })
})
