// Dedupe and merge rules (spec section 8). Pure functions, no database.
// Owned by the sources builder.
import type { LeadSource, LeadTrigger, OwnerKind } from '../../shared/types.ts'
import type { Lead, NewProperty } from '../db/schema.ts'
import {
  isLlc,
  normaliseEmail,
  normalisePhone,
  normaliseStreet,
  normaliseZip5,
  splitName,
  titleCase,
} from '../lib/text.ts'

/** A property as a source found it, before it has a lead id. */
export type PropertyCandidate = Omit<NewProperty, 'id' | 'lead_id'>

/** A lead as a source found it: the fields a source can know, plus its properties. */
export interface LeadCandidate {
  source: LeadSource
  full_name?: string | null
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  linkedin_url?: string | null
  instagram_url?: string | null
  website?: string | null
  mailing_street?: string | null
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
  property_count?: number | null
  unit_count?: number | null
  zips?: string[] | null
  trigger?: LeadTrigger | null
  tags?: string[] | null
  notes?: string | null
  properties?: PropertyCandidate[]
}

/** The same candidate with every field in its canonical form. */
export interface NormalisedCandidate extends LeadCandidate {
  full_name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  email: string | null
  phone: string | null
  mailing_street: string | null
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
  property_count: number
  unit_count: number
  zips: string[]
  trigger: LeadTrigger
  tags: string[]
  properties: PropertyCandidate[]
  owner_kind: OwnerKind
  dedupe_key: string | null
}

const clean = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null
  const t = String(v).replace(/\s+/g, ' ').trim()
  return t ? t : null
}

const nonNegInt = (v: number | null | undefined): number => {
  if (v === null || v === undefined || Number.isNaN(v)) return 0
  return Math.max(0, Math.floor(v))
}

/**
 * Owner kind: 'person' when we know a human (even one who owns through an LLC),
 * 'llc' when all we have is a company name, 'unknown' when we have neither.
 */
export function ownerKindFor(input: {
  full_name?: string | null
  company?: string | null
}): OwnerKind {
  if (input.full_name && !isLlc(input.full_name)) return 'person'
  if (input.full_name || input.company) return 'llc'
  return 'unknown'
}

/** Title Case for a street line that keeps "PO Box" readable. */
export function titleCaseStreet(input: string | null | undefined): string {
  return titleCase(input).replace(/^Po Box\b/, 'PO Box')
}

/**
 * The key two sources must share to be the same owner:
 * normalised `street|zip5`, else the lower-cased email, else null (no safe way to dedupe).
 */
export function dedupeKeyFor(input: {
  mailing_street?: string | null
  mailing_zip?: string | null
  email?: string | null
}): string | null {
  const street = normaliseStreet(input.mailing_street)
  const zip = normaliseZip5(input.mailing_zip)
  if (street && zip) return `${street}|${zip}`
  if (street) return `${street}|`
  const email = normaliseEmail(input.email)
  if (email) return email
  return null
}

/** Make a lead from the parts a source knows: Title Case names, zip5, LLC detection, dedupe key. */
export function normaliseCandidate(c: LeadCandidate): NormalisedCandidate {
  let company = clean(c.company)
  let fullName = clean(c.full_name)
  let firstName = clean(c.first_name)
  let lastName = clean(c.last_name)

  // A "name" that reads as a company moves over to company.
  if (fullName && !company && isLlc(fullName)) {
    company = fullName
    fullName = null
  }
  if (!fullName && (firstName || lastName)) {
    fullName = [firstName, lastName].filter(Boolean).join(' ')
  }
  if (fullName && !firstName && !lastName) {
    const parts = splitName(fullName)
    firstName = parts.first_name || null
    lastName = parts.last_name || null
  }
  fullName = fullName ? titleCase(fullName) : null
  firstName = firstName ? titleCase(firstName) : null
  lastName = lastName ? titleCase(lastName) : null
  company = company ? titleCase(company) : null

  const email = normaliseEmail(c.email) || null
  const phone = normalisePhone(c.phone) || null
  const mailingStreet = clean(c.mailing_street)
  const mailingZip = normaliseZip5(c.mailing_zip) || null
  const mailingState = clean(c.mailing_state)?.toUpperCase().slice(0, 2) ?? null
  const mailingCity = c.mailing_city ? titleCase(c.mailing_city) : null

  const propZips = (c.properties ?? []).map((p) => normaliseZip5(p.zip)).filter(Boolean)
  const zips = uniq([...(c.zips ?? []).map((z) => normaliseZip5(z)).filter(Boolean), ...propZips])

  const properties = (c.properties ?? []).map((p) => ({
    ...p,
    zip: normaliseZip5(p.zip) || null,
    address: clean(p.address),
  }))
  const propertyCount = Math.max(nonNegInt(c.property_count), properties.length)
  const unitsFromProps = properties.reduce((sum, p) => sum + nonNegInt(p.units), 0)
  const unitCount = Math.max(nonNegInt(c.unit_count), unitsFromProps)

  const base = { full_name: fullName, company }
  return {
    ...c,
    full_name: fullName,
    first_name: firstName,
    last_name: lastName,
    company,
    email,
    phone,
    linkedin_url: clean(c.linkedin_url),
    instagram_url: clean(c.instagram_url),
    website: clean(c.website),
    mailing_street: mailingStreet,
    mailing_city: mailingCity,
    mailing_state: mailingState,
    mailing_zip: mailingZip,
    property_count: propertyCount,
    unit_count: unitCount,
    zips,
    trigger: c.trigger ?? { type: 'none' },
    tags: uniq((c.tags ?? []).map((t) => t.trim()).filter(Boolean)),
    notes: clean(c.notes),
    properties,
    owner_kind: ownerKindFor(base),
    dedupe_key: dedupeKeyFor({ mailing_street: mailingStreet, mailing_zip: mailingZip, email }),
  }
}

/** True when the candidate has something we could ever contact or identify. */
export function isUsableCandidate(c: NormalisedCandidate): boolean {
  const hasWho = Boolean(c.full_name || c.company || c.email)
  const hasWhere = Boolean(c.dedupe_key || c.email || c.phone || c.linkedin_url)
  return hasWho && hasWhere
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)]
}

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** Pick the newer trigger; a real trigger always beats 'none' or 'csv'. */
export function mergeTrigger(existing: LeadTrigger, incoming: LeadTrigger): LeadTrigger {
  const weight = (t: LeadTrigger) => (t.type === 'none' ? 0 : t.type === 'csv' ? 1 : 2)
  if (weight(incoming) > weight(existing)) return incoming
  if (weight(incoming) < weight(existing)) return existing
  if (incoming.date && existing.date) return incoming.date > existing.date ? incoming : existing
  if (!existing.date && incoming.date) return incoming
  return existing
}

/** Text fields a merge may fill in when the existing lead has them empty. */
export const MERGE_TEXT_FIELDS = [
  'full_name',
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
  'linkedin_url',
  'instagram_url',
  'website',
  'mailing_street',
  'mailing_city',
  'mailing_state',
  'mailing_zip',
] as const
export type MergeTextField = (typeof MERGE_TEXT_FIELDS)[number]

export type LeadMergePatch = Partial<
  Pick<
    Lead,
    | MergeTextField
    | 'property_count'
    | 'unit_count'
    | 'zips'
    | 'trigger'
    | 'tags'
    | 'notes'
    | 'owner_kind'
  >
>

/**
 * What changes when `incoming` lands on an existing lead. Never overwrites a non-empty field with
 * an empty one. Counts only grow. Zips and tags are unioned. Notes are appended when new.
 * Returns only the fields that actually change.
 */
export function mergeIntoLead(existing: Lead, incoming: NormalisedCandidate): LeadMergePatch {
  const patch: LeadMergePatch = {}
  for (const f of MERGE_TEXT_FIELDS) {
    const next = incoming[f]
    if (isEmpty(existing[f]) && !isEmpty(next)) patch[f] = next as string
  }
  if (incoming.property_count > existing.property_count) {
    patch.property_count = incoming.property_count
  }
  if (incoming.unit_count > existing.unit_count) patch.unit_count = incoming.unit_count

  const zips = uniq([...existing.zips, ...incoming.zips])
  if (zips.length !== existing.zips.length) patch.zips = zips

  const tags = uniq([...existing.tags, ...incoming.tags])
  if (tags.length !== existing.tags.length) patch.tags = tags

  const trigger = mergeTrigger(existing.trigger, incoming.trigger)
  if (trigger !== existing.trigger) patch.trigger = trigger

  if (incoming.notes && !(existing.notes ?? '').includes(incoming.notes)) {
    patch.notes = existing.notes ? `${existing.notes}\n${incoming.notes}` : incoming.notes
  }

  if (existing.owner_kind === 'unknown') {
    const kind = ownerKindFor({
      full_name: patch.full_name ?? existing.full_name,
      company: patch.company ?? existing.company,
    })
    if (kind !== 'unknown') patch.owner_kind = kind
  }
  return patch
}

/** What the leads table shows when there is no proper name. */
export function displayNameFor(lead: {
  full_name?: string | null
  company?: string | null
  email?: string | null
  mailing_street?: string | null
}): string {
  if (lead.full_name) return lead.full_name
  if (lead.company) return lead.company
  if (lead.email) return lead.email
  if (lead.mailing_street) return `Owner at ${titleCase(lead.mailing_street)}`
  return 'Unknown owner'
}
