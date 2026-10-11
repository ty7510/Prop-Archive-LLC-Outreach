// OPA property assessments (spec section 8): owner groups across target zips and the recent
// sales trigger. SQL builders are pure and only interpolate validated zips and integers.
// Owned by the sources builder.
import type { LeadTrigger } from '../../shared/types.ts'
import { isLlc, normaliseZip5, titleCase } from '../lib/text.ts'
import { daysBetween } from '../lib/time.ts'
import { cartoUrl, categoryList, int, zipList } from './carto.ts'
import { titleCaseStreet, type LeadCandidate, type PropertyCandidate } from './merge.ts'
import { RECENT_SALE_WINDOW_DAYS } from './score.ts'

export const OPA_TABLE = 'opa_properties_public'
export const OPA_OWNERS_PAGE_SIZE = 50
export const OPA_SALES_PAGE_SIZE = 500

/** One OPA parcel row as Carto returns it (the columns we select). */
export interface OpaRow {
  parcel_number: string | null
  location: string | null
  unit: string | null
  zip_code: string | null
  category_code_description: string | null
  sale_date: string | null
  sale_price: number | string | null
  market_value: number | string | null
  owner_1: string | null
  owner_2: string | null
  mailing_street: string | null
  mailing_city_state: string | null
  mailing_zip: string | null
  mailing_address_1: string | null
  mailing_address_2: string | null
  /** Group key computed in SQL: normalised mailing street (or the property when none). */
  key_street: string | null
  /** Group key computed in SQL: five digit mailing zip (or the property zip when none). */
  key_zip: string | null
  owner_property_count?: number | string | null
}

const OPA_COLUMNS = [
  'parcel_number',
  'location',
  'unit',
  'zip_code',
  'category_code_description',
  'sale_date',
  'sale_price',
  'market_value',
  'owner_1',
  'owner_2',
  'mailing_street',
  'mailing_city_state',
  'mailing_zip',
  'mailing_address_1',
  'mailing_address_2',
] as const

/** Postgres expression for the mailing street key. Falls back to the property when OPA has no mailing street. */
const KEY_STREET_SQL =
  "upper(regexp_replace(coalesce(nullif(trim(mailing_street), ''), location), '[^A-Za-z0-9 ]', '', 'g'))"
const KEY_ZIP_SQL = "left(coalesce(nullif(trim(mailing_zip), ''), zip_code), 5)"

function baseCte(zips: readonly string[]): string {
  return (
    `base AS (SELECT ${OPA_COLUMNS.join(', ')}, ${KEY_STREET_SQL} AS key_street, ${KEY_ZIP_SQL} AS key_zip ` +
    `FROM ${OPA_TABLE} WHERE left(zip_code, 5) IN (${zipList(zips)}) ` +
    `AND category_code_description IN (${categoryList()}))`
  )
}

function ownersCte(min: number, max: number, limit?: number, offset?: number): string {
  const page =
    limit === undefined ? '' : ` LIMIT ${int(limit, 'limit')} OFFSET ${int(offset ?? 0, 'offset')}`
  return (
    `owners AS (SELECT key_street, key_zip, count(*) AS n FROM base ` +
    `GROUP BY key_street, key_zip HAVING count(*) BETWEEN ${int(min, 'min')} AND ${int(max, 'max')} ` +
    `ORDER BY n DESC, key_street, key_zip${page})`
  )
}

/**
 * One page of owner groups with every parcel they own in the target zips.
 * Pages are `limit` owners (not parcels), ordered by parcel count then address, so paging is stable.
 */
export function buildOpaOwnersSql(
  zips: readonly string[],
  min: number,
  max: number,
  limit = OPA_OWNERS_PAGE_SIZE,
  offset = 0,
): string {
  if (min > max) throw new Error('min must not be above max')
  return (
    `WITH ${baseCte(zips)}, ${ownersCte(min, max, limit, offset)} ` +
    `SELECT ${OPA_COLUMNS.map((c) => `b.${c}`).join(', ')}, b.key_street, b.key_zip, o.n AS owner_property_count ` +
    `FROM base b JOIN owners o ON b.key_street = o.key_street AND b.key_zip = o.key_zip ` +
    `ORDER BY o.n DESC, b.key_street, b.key_zip, b.parcel_number`
  )
}

/** How many owner groups match, for a preview before a full run. */
export function buildOpaOwnersCountSql(zips: readonly string[], min: number, max: number): string {
  if (min > max) throw new Error('min must not be above max')
  return `WITH ${baseCte(zips)}, ${ownersCte(min, max)} SELECT count(*) AS owners FROM owners`
}

/** Parcels sold in the last `days` days in the target zips, newest first. */
export function buildRecentSalesSql(
  zips: readonly string[],
  days = RECENT_SALE_WINDOW_DAYS,
  limit = OPA_SALES_PAGE_SIZE,
  offset = 0,
): string {
  return (
    `SELECT ${OPA_COLUMNS.join(', ')}, ${KEY_STREET_SQL} AS key_street, ${KEY_ZIP_SQL} AS key_zip ` +
    `FROM ${OPA_TABLE} WHERE left(zip_code, 5) IN (${zipList(zips)}) ` +
    `AND category_code_description IN (${categoryList()}) ` +
    `AND sale_date >= current_date - ${int(days, 'days')} ` +
    `ORDER BY sale_date DESC, parcel_number LIMIT ${int(limit, 'limit')} OFFSET ${int(offset, 'offset')}`
  )
}

export interface OpaOwnersPreview {
  zips: string[]
  min: number
  max: number
  page_size: number
  /** SQL that counts the owner groups. */
  count_sql: string
  /** SQL for the first page of owners with their parcels. */
  first_page_sql: string
  /** Ready to paste in a browser. */
  count_url: string
  first_page_url: string
}

/**
 * What a discover run would ask Carto for, without asking. Pure: builds the SQL and urls only.
 * Handy for checking a zip list by hand before pressing "Find new leads".
 */
export function previewOpaOwners(
  zips: readonly string[],
  min: number,
  max: number,
): OpaOwnersPreview {
  const countSql = buildOpaOwnersCountSql(zips, min, max)
  const firstPageSql = buildOpaOwnersSql(zips, min, max, OPA_OWNERS_PAGE_SIZE, 0)
  return {
    zips: [...new Set(zips)],
    min,
    max,
    page_size: OPA_OWNERS_PAGE_SIZE,
    count_sql: countSql,
    first_page_sql: firstPageSql,
    count_url: cartoUrl(countSql),
    first_page_url: cartoUrl(firstPageSql),
  }
}

// ---------- row parsing ----------

/** 'YYYY-MM-DD' from a Carto timestamp, or null. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

const toNumber = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * OPA writes people as "LAST FIRST MIDDLE". Companies stay as written.
 * parseOpaOwnerName('SMITH JOHN A') -> { full_name: 'John Smith', first_name: 'John', last_name: 'Smith' }
 */
export function parseOpaOwnerName(owner: string | null | undefined): {
  full_name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
} {
  const raw = (owner ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return { full_name: null, first_name: null, last_name: null, company: null }
  if (isLlc(raw))
    return { full_name: null, first_name: null, last_name: null, company: titleCase(raw) }
  const tokens = raw.split(' ').filter(Boolean)
  if (tokens.length === 1) {
    const only = titleCase(tokens[0])
    return { full_name: only, first_name: null, last_name: only, company: null }
  }
  const last = titleCase(tokens[0])
  // Drop a trailing single-letter middle initial (with or without a dot).
  const rest = tokens
    .slice(1)
    .filter((t, i, arr) => !(i === arr.length - 1 && /^[A-Z]\.?$/i.test(t) && arr.length > 1))
  const first = titleCase(rest.join(' ') || tokens[1])
  return { full_name: `${first} ${last}`, first_name: first, last_name: last, company: null }
}

/** 'PHILADELPHIA PA' -> { city: 'Philadelphia', state: 'PA' }. */
export function parseCityState(value: string | null | undefined): {
  city: string | null
  state: string | null
} {
  const raw = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return { city: null, state: null }
  const m = /^(.*?)[,\s]+([A-Za-z]{2})$/.exec(raw)
  if (m) return { city: titleCase(m[1]) || null, state: (m[2] ?? '').toUpperCase() }
  return { city: titleCase(raw), state: null }
}

/** The address a letter would go to for this parcel's owner. */
export function opaMailingAddress(row: OpaRow): {
  mailing_street: string | null
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
} {
  const street = (row.mailing_street ?? '').trim()
  if (street) {
    const cs = parseCityState(row.mailing_city_state)
    return {
      mailing_street: titleCaseStreet(street),
      mailing_city: cs.city,
      mailing_state: cs.state,
      mailing_zip: normaliseZip5(row.mailing_zip) || null,
    }
  }
  // No mailing address on file: OPA mails to the property itself.
  return {
    mailing_street: row.location ? titleCase(row.location) : null,
    mailing_city: 'Philadelphia',
    mailing_state: 'PA',
    mailing_zip: normaliseZip5(row.zip_code) || null,
  }
}

export function opaRowToProperty(row: OpaRow): PropertyCandidate {
  const unit = (row.unit ?? '').trim()
  return {
    address: [row.location?.trim(), unit ? `Unit ${unit}` : ''].filter(Boolean).join(' ') || null,
    zip: normaliseZip5(row.zip_code) || null,
    category: row.category_code_description ?? null,
    units: null,
    sale_date: isoDate(row.sale_date),
    sale_price: toNumber(row.sale_price),
    market_value: toNumber(row.market_value),
    opa_account: row.parcel_number ?? null,
    source: 'opa',
    raw: row,
  }
}

/** Sales under this are deed transfers between family or into an LLC, not a purchase. */
export const NOMINAL_SALE_PRICE = 1_000

/** The most recent real sale inside the window, as a trigger, or 'none'. */
export function recentSaleTrigger(
  properties: PropertyCandidate[],
  now = new Date(),
  windowDays = RECENT_SALE_WINDOW_DAYS,
): LeadTrigger {
  let best: PropertyCandidate | null = null
  for (const p of properties) {
    if (!p.sale_date) continue
    if (p.sale_price !== null && p.sale_price !== undefined && p.sale_price < NOMINAL_SALE_PRICE)
      continue
    const age = daysBetween(new Date(p.sale_date), now)
    if (age < -1 || age > windowDays) continue
    if (!best || (best.sale_date ?? '') < p.sale_date) best = p
  }
  if (!best?.sale_date) return { type: 'none' }
  const price = best.sale_price ? ` for $${best.sale_price.toLocaleString('en-US')}` : ''
  return {
    type: 'recent_sale',
    date: best.sale_date,
    detail: `Bought ${best.address ?? 'a property'}${price} on ${best.sale_date}`,
  }
}

const groupKey = (row: OpaRow): string =>
  `${(row.key_street ?? '').trim()}|${(row.key_zip ?? '').trim()}`

/** Most common non-empty value, ties broken by first seen. */
function mostCommon(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) {
    const t = (v ?? '').trim()
    if (!t) continue
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v
      bestN = n
    }
  }
  return best
}

/**
 * Group parcel rows by owner (the SQL key) and make one candidate per owner.
 * Works for both the owners query and the recent sales query.
 */
export function opaRowsToCandidates(rows: OpaRow[], now = new Date()): LeadCandidate[] {
  const groups = new Map<string, OpaRow[]>()
  for (const row of rows) {
    const key = groupKey(row)
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const out: LeadCandidate[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (!first) continue
    const ownerName = mostCommon(group.map((r) => r.owner_1))
    const name = parseOpaOwnerName(ownerName)
    const mailing = opaMailingAddress(first)
    const properties = group.map(opaRowToProperty)
    const coOwnerRaw = mostCommon(group.map((r) => r.owner_2))
    const coOwnerName = parseOpaOwnerName(coOwnerRaw)
    const coOwner = coOwnerName.full_name ?? coOwnerName.company
    const careOf = mostCommon(group.map((r) => r.mailing_address_1))
    const notes =
      [
        coOwner ? `Also on the deed: ${coOwner}` : '',
        careOf ? `Mailing line: ${titleCase(careOf)}` : '',
      ]
        .filter(Boolean)
        .join('\n') || null
    const total = toNumber(first.owner_property_count ?? null)
    out.push({
      source: 'opa',
      ...name,
      ...mailing,
      property_count: Math.max(total ?? 0, properties.length),
      unit_count: 0,
      zips: properties.map((p) => p.zip ?? '').filter(Boolean),
      trigger: recentSaleTrigger(properties, now),
      notes,
      properties,
    })
  }
  return out
}
