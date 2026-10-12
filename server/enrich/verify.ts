// Contact verification for web research. Pure. Every phone, email and profile the research returns
// must come with the exact words from its source and something that ties those words to THIS
// owner. A value is only "verified" when the source also shows one of the owner's own addresses
// (a rental listing at their property, their mailing address) or a phone already verified; a
// name or company match alone is "likely"; anything else is rejected and never saved.
import { normaliseEmail, normalisePhone, normaliseStreet } from '../lib/text.ts'

export const CONTACT_FIELDS = [
  'email',
  'phone',
  'linkedin_url',
  'instagram_url',
  'facebook_url',
  'website',
] as const
export type ContactField = (typeof CONTACT_FIELDS)[number]

/** Whose contact it is: the owner, or a property manager / leasing agent who handles their rentals. */
export type ContactRole = 'owner' | 'manager' | 'agent'
export type Verdict = 'verified' | 'likely' | 'rejected'

export interface ContactEvidence {
  field: ContactField
  value: string
  role: ContactRole
  source_url: string
  /** The exact words from the source that show the value. */
  quote: string
}

export interface CheckedContact extends ContactEvidence {
  verdict: Verdict
  /** Plain words: what tied it to the owner, or why it was rejected. */
  reason: string
}

export interface OwnerFacts {
  full_name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  mailing_street: string | null
  /** Street addresses of the owner's rental properties. */
  property_addresses: string[]
}

const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST'])

/** "1022 PINE" from "1022 Pine Street #202" or "1022 S. Pine St": house number and street name. */
export function streetKey(address: string | null | undefined): string | null {
  const words = normaliseStreet(address).split(' ').filter(Boolean)
  const num = words[0]
  if (!num || !/^\d{1,6}[A-Z]?$/.test(num)) return null
  let i = 1
  while (i < words.length && DIRECTIONS.has(words[i]!)) i++
  const name = words[i]
  return name ? `${num} ${name}` : null
}

/** Every "number street" key mentioned anywhere in a text. */
export function streetKeysIn(text: string): Set<string> {
  const words = normaliseStreet(text).split(' ').filter(Boolean)
  const keys = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    if (!/^\d{1,6}[A-Z]?$/.test(words[i]!)) continue
    let j = i + 1
    while (j < words.length && DIRECTIONS.has(words[j]!)) j++
    if (words[j] && !/^\d+$/.test(words[j]!)) keys.add(`${words[i]} ${words[j]}`)
  }
  return keys
}

/** Hosts that list or index people and properties: never an owner's own website. */
const NOT_A_WEBSITE =
  /(^|\.)(zillow|trulia|hotpads|redfin|realtor|apartments|apartmentlist|apartmentguide|rent|zumper|padmapper|renthop|craigslist|facebook|instagram|linkedin|twitter|x|elementix|opencorporates|bizapedia|zoominfo|rocketreach|yelp|bbb|mapquest|manta|buzzfile|dnb|google|bing|yahoo|youtube|tiktok|gosection8|affordablehousing|appfolio)\.[a-z.]+$/

function hostOf(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The value in its saved form, or null with the reason it is not a usable value at all. */
export function normaliseContact(
  field: ContactField,
  raw: string,
): { value: string } | { problem: string } {
  const v = raw.trim()
  switch (field) {
    case 'phone': {
      const digits = normalisePhone(v)
      return digits.length === 10
        ? { value: digits }
        : { problem: 'not a 10 digit US phone number' }
    }
    case 'email': {
      const email = normaliseEmail(v)
      return email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)
        ? { value: email }
        : { problem: 'not an email address' }
    }
    case 'linkedin_url':
      return /linkedin\.com\/(in|company)\/[^/?#\s]+/i.test(v)
        ? { value: v }
        : { problem: 'not a LinkedIn profile or company page' }
    case 'instagram_url':
      return /instagram\.com\/(?!p\/|explore\/|reel\/)[A-Za-z0-9_.]+/i.test(v)
        ? { value: v }
        : { problem: 'not an Instagram account' }
    case 'facebook_url':
      return /(facebook|fb)\.com\/(?!search|sharer|share\b|groups\/)[^?#\s]+/i.test(v)
        ? { value: v }
        : { problem: 'not a Facebook page or profile' }
    case 'website': {
      const host = hostOf(v)
      if (!host || !host.includes('.')) return { problem: 'not a website address' }
      if (NOT_A_WEBSITE.test(host)) return { problem: `${host} is a listing or directory site` }
      return { value: /^https?:\/\//i.test(v) ? v : `https://${v}` }
    }
  }
}

/** Does the quote really show this value? */
function quoteShows(field: ContactField, value: string, quote: string, sourceUrl: string): boolean {
  const q = quote.toLowerCase()
  if (field === 'phone')
    return normalisePhone(quote).includes(value) || q.replace(/\D/g, '').includes(value)
  if (field === 'email') return q.includes(value.toLowerCase())
  // Profiles and sites: the handle or host is in the quote, or the source is the page itself.
  const host = hostOf(value)
  const path = value
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
  const handle = path.split('/').filter(Boolean).pop() ?? ''
  if (handle && q.includes(handle)) return true
  if (field === 'website' && host && q.includes(host)) return true
  const src = sourceUrl.toLowerCase().replace(/\/+$/, '')
  return Boolean(handle) && src.endsWith(path)
}

const COMPANY_NOISE = new Set([
  'LLC',
  'L',
  'C',
  'INC',
  'CO',
  'CORP',
  'LP',
  'LTD',
  'THE',
  'AND',
  'OF',
])

function companyTokens(company: string): string[] {
  return company
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !COMPANY_NOISE.has(t))
}

/** What ties the quote to this owner, strongest first. null when nothing does. */
function tieFor(
  quote: string,
  facts: OwnerFacts,
  verifiedPhones: ReadonlySet<string>,
): { strength: 'strong' | 'weak'; reason: string } | null {
  const keys = streetKeysIn(quote)
  for (const address of facts.property_addresses) {
    const key = streetKey(address)
    if (key && keys.has(key))
      return { strength: 'strong', reason: `the source names their property at ${address}` }
  }
  const mailingKey = streetKey(facts.mailing_street)
  if (mailingKey && keys.has(mailingKey)) {
    return {
      strength: 'strong',
      reason: `the source shows their mailing address ${facts.mailing_street}`,
    }
  }
  const digits = quote.replace(/\D/g, '')
  for (const phone of verifiedPhones) {
    if (digits.includes(phone))
      return { strength: 'strong', reason: 'the source shows their verified phone' }
  }
  const upper = quote.toUpperCase()
  const last = (facts.last_name ?? '').trim().toUpperCase()
  const first = (facts.first_name ?? '').trim().toUpperCase()
  if (last.length >= 2 && first.length >= 2 && upper.includes(last) && upper.includes(first)) {
    return { strength: 'weak', reason: `the source names ${facts.full_name ?? `${first} ${last}`}` }
  }
  const tokens = companyTokens(facts.company ?? '')
  if (tokens.some((t) => t.length >= 4) && tokens.every((t) => upper.includes(t))) {
    return { strength: 'weak', reason: `the source names ${facts.company}` }
  }
  return null
}

/**
 * Check every contact the research returned. Phones are checked first, so a site or email that a
 * source ties to a verified phone counts as verified too.
 */
export function checkContacts(evidence: ContactEvidence[], facts: OwnerFacts): CheckedContact[] {
  const verifiedPhones = new Set<string>()
  const ordered = [...evidence].sort(
    (a, b) => Number(b.field === 'phone') - Number(a.field === 'phone'),
  )
  const out: CheckedContact[] = []
  for (const e of ordered) {
    const norm = normaliseContact(e.field, e.value ?? '')
    if ('problem' in norm) {
      out.push({ ...e, verdict: 'rejected', reason: norm.problem })
      continue
    }
    const value = norm.value
    if (!/^https?:\/\//i.test(e.source_url ?? '')) {
      out.push({ ...e, value, verdict: 'rejected', reason: 'no source link' })
      continue
    }
    if (!quoteShows(e.field, value, e.quote ?? '', e.source_url)) {
      out.push({ ...e, value, verdict: 'rejected', reason: 'the quoted words do not show it' })
      continue
    }
    const tie = tieFor(e.quote ?? '', facts, verifiedPhones)
    if (!tie) {
      out.push({
        ...e,
        value,
        verdict: 'rejected',
        reason: 'nothing ties the source to this owner',
      })
      continue
    }
    const verdict: Verdict = tie.strength === 'strong' ? 'verified' : 'likely'
    if (e.field === 'phone' && verdict === 'verified') verifiedPhones.add(value)
    out.push({ ...e, value, verdict, reason: tie.reason })
  }
  return out
}
