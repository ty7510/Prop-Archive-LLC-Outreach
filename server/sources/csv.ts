// CSV import: header auto-mapping and row to candidate (spec section 8). Pure, no database.
// Owned by the sources builder.
import { parse } from 'csv-parse/sync'
import type { LeadCandidate } from './merge.ts'

/** The lead fields a CSV column can land in. */
export const CSV_FIELDS = [
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'company',
  'mailing_street',
  'mailing_city',
  'mailing_state',
  'mailing_zip',
  'linkedin_url',
  'instagram_url',
  'website',
  'notes',
  'unit_count',
  'property_count',
  'zips',
  'tags',
] as const
export type CsvField = (typeof CSV_FIELDS)[number]

/** Header spellings we recognise, after squashing to lower-case letters and digits. */
const HEADER_ALIASES: Record<CsvField, readonly string[]> = {
  full_name: ['name', 'fullname', 'owner', 'ownername', 'contact', 'contactname', 'landlord'],
  first_name: ['first', 'firstname', 'fname', 'given', 'givenname'],
  last_name: ['last', 'lastname', 'lname', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'mail', 'emails', 'workemail', 'businessemail'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'cellphone', 'telephone', 'tel', 'number'],
  company: [
    'company',
    'companyname',
    'business',
    'businessname',
    'llc',
    'organization',
    'org',
    'entity',
    'firm',
  ],
  mailing_street: [
    'address',
    'street',
    'streetaddress',
    'address1',
    'addressline1',
    'mailingaddress',
    'mailingstreet',
  ],
  mailing_city: ['city', 'town', 'mailingcity'],
  mailing_state: ['state', 'st', 'province', 'mailingstate'],
  mailing_zip: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode', 'mailingzip'],
  linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile', 'li'],
  instagram_url: ['instagram', 'instagramurl', 'ig', 'insta'],
  website: ['website', 'web', 'url', 'site', 'domain', 'homepage'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks'],
  unit_count: ['units', 'unitcount', 'numberofunits', 'numunits', 'doors', 'totalunits'],
  property_count: [
    'properties',
    'propertycount',
    'props',
    'numproperties',
    'numberofproperties',
    'buildings',
    'portfolio',
    'portfoliosize',
  ],
  zips: ['zips', 'propertyzips', 'targetzips', 'areas'],
  tags: ['tags', 'tag', 'labels', 'segment'],
}

/** 'Email Address' -> 'emailaddress'. */
export function squashHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/#/g, 'number')
    .replace(/[^a-z0-9]/g, '')
}

const ALIAS_INDEX: Map<string, CsvField> = (() => {
  const m = new Map<string, CsvField>()
  for (const field of CSV_FIELDS) {
    for (const alias of HEADER_ALIASES[field]) m.set(alias, field)
    m.set(field.replace(/_/g, ''), field)
  }
  return m
})()

/** Which lead field one header lands in, or null when we do not recognise it. */
export function mapHeader(header: string): CsvField | null {
  const key = squashHeader(header)
  if (!key) return null
  const direct = ALIAS_INDEX.get(key)
  if (direct) return direct
  // Loose fallbacks for headers like "Owner Email (work)" or "Primary Phone".
  if (key.includes('email')) return 'email'
  if (key.includes('linkedin')) return 'linkedin_url'
  if (key.includes('instagram')) return 'instagram_url'
  if (key.includes('phone') || key.includes('mobile') || key.includes('cell')) return 'phone'
  if (key.includes('zip') || key.includes('postal')) return 'mailing_zip'
  if (key.includes('company') || key.includes('business')) return 'company'
  if (key.includes('firstname')) return 'first_name'
  if (key.includes('lastname')) return 'last_name'
  if (key.includes('address') || key.includes('street')) return 'mailing_street'
  if (key.includes('city')) return 'mailing_city'
  if (key.includes('state')) return 'mailing_state'
  if (key.includes('website') || key.includes('url')) return 'website'
  if (key.includes('unit')) return 'unit_count'
  if (key.includes('propert')) return 'property_count'
  if (key.includes('note') || key.includes('comment')) return 'notes'
  if (key.includes('name')) return 'full_name'
  return null
}

export interface HeaderMapping {
  /** header -> field, for recognised headers (first header wins per field). */
  mapped: Record<string, CsvField>
  unmapped: string[]
}

/** Map every header once; a second column for the same field is left unmapped. */
export function mapHeaders(headers: string[]): HeaderMapping {
  const mapped: Record<string, CsvField> = {}
  const unmapped: string[] = []
  const taken = new Set<CsvField>()
  for (const h of headers) {
    const field = mapHeader(h)
    if (field && !taken.has(field)) {
      mapped[h] = field
      taken.add(field)
    } else {
      unmapped.push(h)
    }
  }
  return { mapped, unmapped }
}

const toInt = (v: string | undefined): number | null => {
  if (!v) return null
  const n = Number.parseInt(v.replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

const splitList = (v: string | undefined): string[] =>
  (v ?? '')
    .split(/[;,|/]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** One parsed CSV row (header -> cell) to a lead candidate using the header mapping. */
export function rowToCandidate(
  row: Record<string, string>,
  mapping: HeaderMapping,
  fileNote?: string,
): LeadCandidate {
  const get = (field: CsvField): string | undefined => {
    for (const [header, f] of Object.entries(mapping.mapped)) {
      if (f === field) {
        const v = row[header]
        return v === undefined || v === null ? undefined : String(v).trim()
      }
    }
    return undefined
  }
  const notes = [get('notes'), fileNote].filter(Boolean).join('\n') || null
  return {
    source: 'csv',
    full_name: get('full_name') || null,
    first_name: get('first_name') || null,
    last_name: get('last_name') || null,
    company: get('company') || null,
    email: get('email') || null,
    phone: get('phone') || null,
    linkedin_url: get('linkedin_url') || null,
    instagram_url: get('instagram_url') || null,
    website: get('website') || null,
    mailing_street: get('mailing_street') || null,
    mailing_city: get('mailing_city') || null,
    mailing_state: get('mailing_state') || null,
    mailing_zip: get('mailing_zip') || null,
    property_count: toInt(get('property_count')),
    unit_count: toInt(get('unit_count')),
    zips: splitList(get('zips')),
    tags: splitList(get('tags')),
    notes,
    trigger: { type: 'csv' },
    properties: [],
  }
}

export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
  mapping: HeaderMapping
}

/** Parse a CSV buffer or string with a header row. Throws a plain Error on malformed input. */
export function parseCsv(input: Buffer | string): ParsedCsv {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input
  const rows = parse(text, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Record<string, string>[]
  const headers = rows.length > 0 ? Object.keys(rows[0] ?? {}) : headerLine(text)
  return { headers, rows, mapping: mapHeaders(headers) }
}

function headerLine(text: string): string[] {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  if (!first.trim()) return []
  try {
    const parsed = parse(first, { bom: true, trim: true, relax_quotes: true }) as string[][]
    return parsed[0] ?? []
  } catch {
    return []
  }
}
