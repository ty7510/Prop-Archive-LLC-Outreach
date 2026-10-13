// Contact verification for web research. Pure. Every phone, email and profile the research returns
// must come with its source page and the exact words that show it. Nothing is taken on trust:
// - the quote must show the value and tie it to THIS owner (a rental address, their mailing
//   address, a verified phone, or their full name or company);
// - the source page itself, opened by the server (pageCheck.ts), must show the value and the tie
//   too; a page that does not is a contradiction and the contact is rejected;
// - "verified" also needs proof the contact is the owner's own: their mailing address, a verified
//   phone, or a rental address together with their name. A listing phone next to a rental address
//   alone is often the leasing agent's, so it is only "likely".
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
  /**
   * The exact words from the same source that tie it to the owner (their name, company, mailing or
   * rental address), when those are not in `quote`. Often further down the same page.
   */
  tie_quote?: string | null
}

/** What the server saw when it opened the source page. */
export type PageResult = 'confirmed' | 'contradicted' | 'unreachable'

export interface CheckedContact extends ContactEvidence {
  verdict: Verdict
  /** Plain words: what tied it to the owner, or why it was rejected. */
  reason: string
  /** unreachable when the page was blocked or not opened. */
  page: PageResult
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

/** Does this text (a quote or a whole page) really show this value? */
function textShows(field: ContactField, value: string, text: string, sourceUrl: string): boolean {
  const q = text.toLowerCase()
  if (field === 'phone') return q.replace(/\D/g, '').includes(value)
  if (field === 'email') return q.includes(value.toLowerCase())
  // Profiles and sites: the handle or host is in the text, or the source is the page itself.
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

type TieKind = 'property' | 'mailing' | 'phone' | 'name' | 'company'

interface Tie {
  kind: TieKind
  reason: string
  /** The owner's full name or company is in the text too. */
  named: boolean
}

function namedIn(text: string, facts: OwnerFacts): 'name' | 'company' | null {
  const upper = text.toUpperCase()
  const last = (facts.last_name ?? '').trim().toUpperCase()
  const first = (facts.first_name ?? '').trim().toUpperCase()
  if (last.length >= 2 && first.length >= 2 && upper.includes(last) && upper.includes(first)) {
    return 'name'
  }
  const tokens = companyTokens(facts.company ?? '')
  if (tokens.some((t) => t.length >= 4) && tokens.every((t) => upper.includes(t))) return 'company'
  return null
}

/** What ties a text to this owner, strongest first. null when nothing does. */
function tieIn(text: string, facts: OwnerFacts, verifiedPhones: ReadonlySet<string>): Tie | null {
  const named = namedIn(text, facts)
  const keys = streetKeysIn(text)
  const mailingKey = streetKey(facts.mailing_street)
  if (mailingKey && keys.has(mailingKey)) {
    return {
      kind: 'mailing',
      reason: `the source shows their mailing address ${facts.mailing_street}`,
      named: named !== null,
    }
  }
  const digits = text.replace(/\D/g, '')
  for (const phone of verifiedPhones) {
    if (digits.includes(phone)) {
      return {
        kind: 'phone',
        reason: 'the source shows their verified phone',
        named: named !== null,
      }
    }
  }
  for (const address of facts.property_addresses) {
    const key = streetKey(address)
    if (key && keys.has(key)) {
      return {
        kind: 'property',
        reason: `the source names their property at ${address}`,
        named: named !== null,
      }
    }
  }
  if (named === 'name') {
    return { kind: 'name', reason: `the source names ${facts.full_name ?? 'them'}`, named: true }
  }
  if (named === 'company') {
    return { kind: 'company', reason: `the source names ${facts.company}`, named: true }
  }
  return null
}

/** Social profile hosts: their public pages are a login wall, so the server never opens them. */
export const LOGIN_WALLED = /(^|\.)(linkedin|instagram|facebook|fb|x|twitter|tiktok)\.com$/

export function isLoginWalled(url: string): boolean {
  const host = hostOf(url)
  return host !== null && LOGIN_WALLED.test(host)
}

/**
 * A profile link that carries the owner's first and last name, like linkedin.com/in/jonathan-potter-1a2b.
 * It names them (so "likely" at best), it never proves the profile is the owner's own.
 */
function profileNameTie(field: ContactField, value: string, facts: OwnerFacts): Tie | null {
  if (field !== 'linkedin_url' && field !== 'instagram_url' && field !== 'facebook_url') return null
  const handle = (
    value
      .replace(/^https?:\/\/[^/]+/i, '')
      .split(/[?#]/)[0]!
      .replace(/\/+$/, '')
      .split('/')
      .pop() ?? ''
  ).toLowerCase()
  const first = (facts.first_name ?? '').trim().toLowerCase()
  const last = (facts.last_name ?? '').trim().toLowerCase()
  if (first.length < 3 || last.length < 3) return null
  if (!handle.includes(first) || !handle.includes(last)) return null
  return {
    kind: 'name',
    reason: `the profile link carries the name ${facts.full_name ?? `${facts.first_name} ${facts.last_name}`}`,
    named: true,
  }
}

/** Is this contact proven to be the owner's own (not a manager or agent at their property)? */
function provesOwner(tie: Tie): boolean {
  return tie.kind === 'mailing' || tie.kind === 'phone' || (tie.kind === 'property' && tie.named)
}

/**
 * Check every contact. `pages` holds the text of each source page the server opened (null when it
 * was blocked or failed); without it every page counts as unreachable, so nothing is verified.
 * Phones are decided first, so a site or email shown next to a verified phone can be verified too.
 */
export function checkContacts(
  evidence: ContactEvidence[],
  facts: OwnerFacts,
  pages: ReadonlyMap<string, string | null> = new Map(),
): CheckedContact[] {
  const verifiedPhones = new Set<string>()
  const ordered = [...evidence].sort(
    (a, b) => Number(b.field === 'phone') - Number(a.field === 'phone'),
  )
  const out: CheckedContact[] = []
  for (const e of ordered) {
    const reject = (reason: string, value = e.value, page: PageResult = 'unreachable') =>
      out.push({ ...e, value, verdict: 'rejected', reason, page })
    const norm = normaliseContact(e.field, e.value ?? '')
    if ('problem' in norm) {
      reject(norm.problem)
      continue
    }
    const value = norm.value
    const quote = e.quote ?? ''
    // The value and the tie may sit in separate quotes from the same source.
    const quotes = `${quote} ${e.tie_quote ?? ''}`
    if (!/^https?:\/\//i.test(e.source_url ?? '')) {
      reject('no source link', value)
      continue
    }
    const pageText = pages.get(e.source_url) ?? null
    const valueOnPage = pageText !== null && textShows(e.field, value, pageText, e.source_url)
    if (!textShows(e.field, value, quotes, e.source_url) && !valueOnPage) {
      reject('the quoted words do not show it', value)
      continue
    }
    if (pageText !== null && !valueOnPage) {
      reject('the source page does not show it', value, 'contradicted')
      continue
    }
    const quoteTie = tieIn(quotes, facts, verifiedPhones)
    // An opened page is the authority: the tie may be anywhere on it. A blocked page leaves the quotes.
    const pageTie = pageText !== null ? tieIn(pageText, facts, verifiedPhones) : null
    const slugTie = profileNameTie(e.field, value, facts)
    const tie = (pageText !== null ? pageTie : quoteTie) ?? slugTie
    if (!tie) {
      if (pageText !== null && quoteTie) {
        reject('the source page does not show it', value, 'contradicted')
      } else reject('nothing ties the source to this owner', value)
      continue
    }
    const page: PageResult = pageText !== null ? 'confirmed' : 'unreachable'
    // Verified: the page confirms it, and for the owner's own fields, it is proven to be theirs.
    const proven = e.role === 'owner' ? provesOwner(tie) : true
    const verdict: Verdict = page === 'confirmed' && proven ? 'verified' : 'likely'
    if (e.field === 'phone' && verdict === 'verified') verifiedPhones.add(value)
    const why =
      page === 'confirmed'
        ? proven
          ? tie.reason
          : `${tie.reason}, but not that it is the owner's own`
        : `${tie.reason}; the page could not be opened to confirm it`
    out.push({ ...e, value, verdict, reason: why, page })
  }
  return out
}
