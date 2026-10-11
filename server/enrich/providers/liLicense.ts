// li_license: Philadelphia L&I rental licenses (Carto, no key). Joins business_licenses.opa_account_num
// on the lead's properties.opa_account to turn an LLC into a human and learn units per property.
import type { OwnerKind } from '../../../shared/types.ts'
import type { Lead } from '../../db/schema.ts'
import { isLlc, normaliseZip5, splitName, titleCase } from '../../lib/text.ts'
import { fetchJson, type HttpDeps } from '../http.ts'
import { clean, emptyResult, type EnrichProvider, type ProviderResult } from '../types.ts'
import type { EnrichContext, PropertyUpdate } from '../types.ts'

export const CARTO_SQL_URL = 'https://phl.carto.com/api/v2/sql'
export const MAX_ACCOUNTS_PER_QUERY = 100

export const LICENSE_COLUMNS = [
  'address',
  'zip',
  'opa_account_num',
  'opa_owner',
  'licensenum',
  'rentalcategory',
  'initialissuedate',
  'mostrecentissuedate',
  'expirationdate',
  'licensestatus',
  'numberofunits',
  'legalfirstname',
  'legallastname',
  'legalname',
  'legalentitytype',
  'business_name',
  'business_mailing_address',
  'ownercontact1name',
  'ownercontact1mailingaddress',
  'ownercontact1city',
  'ownercontact1state',
  'ownercontact1zippostalcode',
] as const

export interface LicenseRow {
  address?: string | null
  zip?: string | null
  opa_account_num?: string | null
  opa_owner?: string | null
  licensenum?: string | null
  rentalcategory?: string | null
  initialissuedate?: string | null
  mostrecentissuedate?: string | null
  expirationdate?: string | null
  licensestatus?: string | null
  numberofunits?: number | string | null
  legalfirstname?: string | null
  legallastname?: string | null
  legalname?: string | null
  legalentitytype?: string | null
  business_name?: string | null
  business_mailing_address?: string | null
  ownercontact1name?: string | null
  ownercontact1mailingaddress?: string | null
  ownercontact1city?: string | null
  ownercontact1state?: string | null
  ownercontact1zippostalcode?: string | null
}

export interface CartoResponse {
  rows?: LicenseRow[]
  error?: string[]
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The L&I query for a set of OPA account numbers. Pure, unit tested. */
export function buildLicenseSql(opaAccounts: string[]): string {
  const accounts = [...new Set(opaAccounts.map((a) => a.trim()).filter(Boolean))].slice(
    0,
    MAX_ACCOUNTS_PER_QUERY,
  )
  const list = accounts.map(sqlString).join(',')
  return (
    `SELECT ${LICENSE_COLUMNS.join(', ')} FROM business_licenses ` +
    `WHERE licensetype = 'Rental' AND opa_account_num IN (${list}) ` +
    `ORDER BY mostrecentissuedate DESC NULLS LAST LIMIT 500`
  )
}

export function licenseUrl(sql: string): string {
  return `${CARTO_SQL_URL}?q=${encodeURIComponent(sql)}`
}

function toUnits(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function isActive(row: LicenseRow): boolean {
  const s = (row.licensestatus ?? '').toLowerCase()
  return s === '' || s === 'active'
}

/** Turn license rows into lead fields. Pure, unit tested. */
export function mapLicenseRows(rows: LicenseRow[], lead: Pick<Lead, 'owner_kind'>): ProviderResult {
  if (rows.length === 0) return emptyResult({ rows: [] })

  // Newest, active rows first; one row per property.
  const sorted = [...rows].sort((a, b) => {
    const act = Number(isActive(b)) - Number(isActive(a))
    if (act !== 0) return act
    return (b.mostrecentissuedate ?? '').localeCompare(a.mostrecentissuedate ?? '')
  })
  const byAccount = new Map<string, LicenseRow>()
  for (const row of sorted) {
    const acct = clean(row.opa_account_num)
    if (acct && !byAccount.has(acct)) byAccount.set(acct, row)
  }

  const property_updates: PropertyUpdate[] = []
  let unit_count = 0
  for (const [opa_account, row] of byAccount) {
    const units = toUnits(row.numberofunits)
    if (units) unit_count += units
    property_updates.push({
      opa_account,
      units,
      license_num: clean(row.licensenum),
      license_issue_date: clean(row.initialissuedate),
      license_expiry: clean(row.expirationdate),
    })
  }

  const result: ProviderResult = { raw: { rows }, confidence: 0.3, property_updates }
  if (unit_count > 0) result.unit_count = unit_count

  // A legal first/last name is the person behind the license.
  const withLegal = sorted.find((r) => clean(r.legalfirstname) && clean(r.legallastname))
  const withContact = sorted.find((r) => clean(r.ownercontact1name))
  let ownerKind: OwnerKind | undefined
  if (withLegal) {
    const first = titleCase(withLegal.legalfirstname)
    const last = titleCase(withLegal.legallastname)
    result.first_name = first
    result.last_name = last
    result.full_name = `${first} ${last}`.trim()
    result.confidence = 0.9
    ownerKind = 'person'
  } else if (withContact) {
    const name = titleCase(withContact.ownercontact1name)
    if (!isLlc(name)) {
      const parts = splitName(name)
      result.full_name = name
      if (parts.first_name) result.first_name = parts.first_name
      if (parts.last_name) result.last_name = parts.last_name
      result.confidence = 0.6
      ownerKind = 'person'
    }
  }

  const business = sorted.find((r) => clean(r.business_name) || clean(r.legalname))
  if (business) {
    const company = titleCase(clean(business.business_name) ?? clean(business.legalname))
    if (company && (isLlc(company) || !result.full_name || company !== result.full_name)) {
      result.company = company
    }
  }

  const contact = sorted.find((r) => clean(r.ownercontact1mailingaddress))
  if (contact) {
    result.mailing_street = titleCase(contact.ownercontact1mailingaddress)
    const city = clean(contact.ownercontact1city)
    const state = clean(contact.ownercontact1state)
    const zip = normaliseZip5(contact.ownercontact1zippostalcode)
    if (city) result.mailing_city = titleCase(city)
    if (state) result.mailing_state = state.toUpperCase().slice(0, 2)
    if (zip) result.mailing_zip = zip
  }

  if (ownerKind && lead.owner_kind !== 'person') result.owner_kind = ownerKind
  return result
}

export function createLiLicenseProvider(deps: HttpDeps = {}): EnrichProvider {
  return {
    id: 'li_license',
    costPerCall: 0,
    isConfigured: () => true,
    applies: (_lead: Lead, ctx: EnrichContext) =>
      ctx.properties.some((p) => Boolean(clean(p.opa_account))),
    async enrich(lead, ctx) {
      const accounts = ctx.properties
        .map((p) => clean(p.opa_account))
        .filter((a): a is string => Boolean(a))
      if (accounts.length === 0) return emptyResult({ rows: [] })
      const url = licenseUrl(buildLicenseSql(accounts))
      const res = await fetchJson<CartoResponse>('li_license', url, { method: 'GET' }, deps)
      if (res.status !== 200 || !res.data) {
        throw new Error(
          `li_license: HTTP ${res.status} ${res.data?.error?.join('; ') ?? ''}`.trim(),
        )
      }
      return mapLicenseRows(res.data.rows ?? [], lead)
    },
  }
}
