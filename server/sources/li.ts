// L&I rental licenses as a trigger (spec section 8, use 1): a license first issued in the last
// N days in a target zip means a brand-new landlord. Pure SQL builder plus row parsing.
// The enrichment use (join on opa_account_num) belongs to the enrich builder.
// Owned by the sources builder.
import type { LeadTrigger } from '../../shared/types.ts'
import { isLlc, normaliseZip5, titleCase } from '../lib/text.ts'
import { int, zipList } from './carto.ts'
import {
  dedupeKeyFor,
  titleCaseStreet,
  type LeadCandidate,
  type PropertyCandidate,
} from './merge.ts'
import { isoDate } from './opa.ts'
import { NEW_LICENSE_WINDOW_DAYS } from './score.ts'

export const LI_TABLE = 'business_licenses'
export const LI_PAGE_SIZE = 500

export interface LiRow {
  address: string | null
  zip: string | null
  opa_account_num: string | null
  opa_owner: string | null
  owneroccupied: string | null
  licensenum: string | null
  rentalcategory: string | null
  initialissuedate: string | null
  mostrecentissuedate: string | null
  expirationdate: string | null
  licensestatus: string | null
  numberofunits: number | string | null
  legalfirstname: string | null
  legallastname: string | null
  legalname: string | null
  legalentitytype: string | null
  business_name: string | null
  business_mailing_address: string | null
  ownercontact1name: string | null
  ownercontact1mailingaddress: string | null
  ownercontact1city: string | null
  ownercontact1state: string | null
  ownercontact1zippostalcode: string | null
}

export const LI_COLUMNS = [
  'address',
  'zip',
  'opa_account_num',
  'opa_owner',
  'owneroccupied',
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

/** Rental licenses first issued in the last `days` days in the target zips, newest first. */
export function buildNewLicensesSql(
  zips: readonly string[],
  days = NEW_LICENSE_WINDOW_DAYS,
  limit = LI_PAGE_SIZE,
  offset = 0,
): string {
  return (
    `SELECT ${LI_COLUMNS.join(', ')} FROM ${LI_TABLE} ` +
    `WHERE licensetype = 'Rental' AND left(zip, 5) IN (${zipList(zips)}) ` +
    `AND initialissuedate >= current_date - ${int(days, 'days')} ` +
    `ORDER BY initialissuedate DESC, licensenum LIMIT ${int(limit, 'limit')} OFFSET ${int(offset, 'offset')}`
  )
}

const clean = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim()

const toInt = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * "123 MAIN ST PHILADELPHIA PA 19104" or "123 Main St, Philadelphia, PA 19104-1234"
 * -> street / city / state / zip. Best effort; returns what it can.
 */
export function parseOneLineAddress(value: string | null | undefined): {
  mailing_street: string | null
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
} {
  // L&I writes "7637 Overbrook Avenue #2 Phila, PA  19151 USA"; drop the country.
  const raw = clean(value).replace(/[,\s]+(USA|US|UNITED STATES)\.?$/i, '')
  if (!raw)
    return { mailing_street: null, mailing_city: null, mailing_state: null, mailing_zip: null }
  const m = /^(.*?)[,\s]+([A-Za-z][A-Za-z .]*?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5})(?:-?\d{4})?$/.exec(
    raw,
  )
  if (m) {
    return {
      mailing_street: titleCaseStreet(m[1]?.replace(/,$/, '')) || null,
      mailing_city: titleCase(m[2]) || null,
      mailing_state: (m[3] ?? '').toUpperCase(),
      mailing_zip: m[4] ?? null,
    }
  }
  const zipOnly = /^(.*?)[,\s]+(\d{5})(?:-?\d{4})?$/.exec(raw)
  if (zipOnly) {
    return {
      mailing_street: titleCaseStreet(zipOnly[1]?.replace(/,$/, '')) || null,
      mailing_city: null,
      mailing_state: null,
      mailing_zip: zipOnly[2] ?? null,
    }
  }
  return {
    mailing_street: titleCaseStreet(raw),
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
  }
}

/** Who holds the license: a person when L&I has first and last names, else the legal entity. */
export function liOwnerName(row: LiRow): {
  full_name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
} {
  const first = clean(row.legalfirstname)
  const last = clean(row.legallastname)
  const legal = clean(row.legalname)
  const business = clean(row.business_name)
  const contact = clean(row.ownercontact1name)

  let company: string | null = null
  if (legal && isLlc(legal)) company = titleCase(legal)
  else if (business && isLlc(business)) company = titleCase(business)
  else if (business && business.toUpperCase() !== legal.toUpperCase()) company = titleCase(business)

  if (first && last) {
    return {
      full_name: `${titleCase(first)} ${titleCase(last)}`,
      first_name: titleCase(first),
      last_name: titleCase(last),
      company,
    }
  }
  if (legal && !isLlc(legal)) {
    return { full_name: titleCase(legal), first_name: null, last_name: null, company }
  }
  if (contact && !isLlc(contact)) {
    return { full_name: titleCase(contact), first_name: null, last_name: null, company }
  }
  if (!company && legal) company = titleCase(legal)
  return { full_name: null, first_name: null, last_name: null, company }
}

/** Where to write to the licensee: contact address, then the business line, then the property itself. */
export function liMailingAddress(row: LiRow): {
  mailing_street: string | null
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
} {
  const contactStreet = clean(row.ownercontact1mailingaddress)
  if (contactStreet) {
    return {
      mailing_street: titleCaseStreet(contactStreet),
      mailing_city: titleCase(row.ownercontact1city) || null,
      mailing_state: clean(row.ownercontact1state).toUpperCase().slice(0, 2) || null,
      mailing_zip: normaliseZip5(row.ownercontact1zippostalcode) || null,
    }
  }
  const business = parseOneLineAddress(row.business_mailing_address)
  if (business.mailing_street) return business
  return {
    mailing_street: row.address ? titleCaseStreet(row.address) : null,
    mailing_city: 'Philadelphia',
    mailing_state: 'PA',
    mailing_zip: normaliseZip5(row.zip) || null,
  }
}

export function liRowToProperty(row: LiRow): PropertyCandidate {
  return {
    address: clean(row.address) || null,
    zip: normaliseZip5(row.zip) || null,
    category: row.rentalcategory ? `RENTAL ${clean(row.rentalcategory).toUpperCase()}` : null,
    units: toInt(row.numberofunits),
    sale_date: null,
    sale_price: null,
    market_value: null,
    opa_account: clean(row.opa_account_num) || null,
    license_num: clean(row.licensenum) || null,
    license_issue_date: isoDate(row.initialissuedate),
    license_expiry: isoDate(row.expirationdate),
    source: 'li',
    raw: row,
  }
}

export function newLicenseTrigger(rows: LiRow[]): LeadTrigger {
  let best: LiRow | null = null
  for (const r of rows) {
    const d = isoDate(r.initialissuedate)
    if (!d) continue
    if (!best || (isoDate(best.initialissuedate) ?? '') < d) best = r
  }
  const date = isoDate(best?.initialissuedate)
  if (!best || !date) return { type: 'none' }
  const units = toInt(best.numberofunits)
  const unitText = units ? ` (${units} unit${units === 1 ? '' : 's'})` : ''
  return {
    type: 'new_license',
    date,
    detail:
      `New rental license ${clean(best.licensenum) || ''} for ${clean(best.address) || 'a property'}${unitText} issued ${date}`.replace(
        /\s+/g,
        ' ',
      ),
  }
}

/** Group license rows by the licensee's mailing address and make one candidate per licensee. */
export function liRowsToCandidates(rows: LiRow[]): LeadCandidate[] {
  const groups = new Map<string, LiRow[]>()
  for (const row of rows) {
    const mailing = liMailingAddress(row)
    const key = dedupeKeyFor(mailing) ?? `license:${clean(row.licensenum) || clean(row.address)}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const out: LeadCandidate[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (!first) continue
    const properties = group.map(liRowToProperty)
    const units = properties.reduce((s, p) => s + (p.units ?? 0), 0)
    out.push({
      source: 'li',
      ...liOwnerName(first),
      ...liMailingAddress(first),
      property_count: properties.length,
      unit_count: units,
      zips: properties.map((p) => p.zip ?? '').filter(Boolean),
      trigger: newLicenseTrigger(group),
      properties,
    })
  }
  return out
}
