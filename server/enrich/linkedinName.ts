// Does a LinkedIn link belong to this lead? The name on the profile must be the lead's name
// (Theo, 2026-10-20: "make sure it matches the name of the linkedin with the name on the profile").
// The app never opens LinkedIn, so the profile's name comes from what a source showed for it: a
// search result title ("John Smith - Owner | LinkedIn"), the name a lookup API returned for it, or
// the link itself (linkedin.com/in/john-smith-1a2b). A wrong person is worse than none.
import type { Lead } from '../db/schema.ts'
import { NAME_NOISE, companyTokens, nameForm, nameWords } from './verify.ts'

export type NameFields = Pick<Lead, 'full_name' | 'first_name' | 'last_name' | 'company'>

/** "in/<slug>" or "company/<slug>", lower case, or null when it is not a LinkedIn profile or page. */
export function linkedInKey(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null
  const m = /^\/(in|company)\/([^/?#]+)/i.exec(u.pathname)
  if (!m) return null
  let slug = m[2]!
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // keep it as written
  }
  return `${m[1]!.toLowerCase()}/${slug.toLowerCase()}`
}

/** The words of a name as letters only, initials and titles dropped; hyphenated parts split. */
function parts(text: string): string[] {
  return text
    .split(/\s+/)
    .flatMap((w) => nameForm(w).trim().split(' '))
    .filter((w) => w.length >= 2 && !NAME_NOISE.has(w))
}

/**
 * The name words of a profile's search title: the part before " - ", " | " or a comma.
 * "John A. Smith - Owner - Smith Homes | LinkedIn" gives JOHN, SMITH.
 */
export function profileNameWords(title: string): string[] {
  const head = (title.split(/\s[-|–—·:]\s|\|/)[0] ?? '').split(',')[0] ?? ''
  return parts(head)
}

/**
 * The lead's name as units: each word of their name, a hyphenated surname as one unit made of
 * its parts ("Buda-Levin" is BUDA + LEVIN). Initials and titles are dropped.
 */
function leadNameUnits(lead: NameFields): string[][] {
  return nameWords(lead).map((w) => w.split(' ').filter(Boolean))
}

/**
 * The profile names the person when it shows at least two of their name units in full (first and
 * last name, in any order, as whole words), one of them three letters or more.
 */
function wordsName(profile: string[], units: string[][]): boolean {
  const have = new Set(profile)
  const covered = units.filter((u) => u.every((p) => have.has(p)))
  return covered.length >= 2 && covered.some((u) => u.join('').length >= 3)
}

/** The link itself names them: john-smith-1a2b, johnsmith, smithjohn84. */
function slugNames(slug: string, units: string[][]): boolean {
  const segments = slug
    .toUpperCase()
    .replace(/\d+/g, ' ')
    .split(/[^A-Z]+/)
    .filter(Boolean)
  if (wordsName(parts(segments.join(' ')), units)) return true
  if (segments.length !== 1) return false
  const compact = segments[0]!
  const joined = units.map((u) => u.join(''))
  for (const a of joined) {
    for (const b of joined) {
      if (a !== b && a.length + b.length >= 5 && compact === a + b) return true
    }
  }
  return false
}

/** Company words that say nothing about which company it is. */
const GENERIC_COMPANY = new Set([
  'GROUP',
  'PROPERTIES',
  'PROPERTY',
  'MANAGEMENT',
  'MGMT',
  'HOLDINGS',
  'HOLDING',
  'INVESTMENTS',
  'INVESTMENT',
  'INVESTORS',
  'REALTY',
  'REAL',
  'ESTATE',
  'HOMES',
  'HOME',
  'HOUSING',
  'PHILADELPHIA',
  'PHILLY',
  'PA',
  'PARTNERS',
  'ASSOCIATES',
  'RENTALS',
  'RENTAL',
  'CAPITAL',
  'VENTURES',
  'ENTERPRISES',
  'DEVELOPMENT',
  'SERVICES',
  'TRUST',
  'COMPANY',
])

/** A company page shows every distinctive word of their company, in its link or its title. */
function companyPageMatches(slug: string, titles: string[], company: string | null): boolean {
  const words = companyTokens(company ?? '').filter(
    (t) => t.length >= 3 && !/\d/.test(t) && !GENERIC_COMPANY.has(t),
  )
  if (words.length === 0) return false
  const compact = slug.toUpperCase().replace(/[^A-Z]/g, '')
  if (words.every((w) => compact.includes(w))) return true
  return titles.some((t) => {
    const have = new Set(profileNameWords(t))
    return words.every((w) => have.has(w))
  })
}

/**
 * Does this LinkedIn link belong to the lead? `names` are what a source showed as the profile's
 * name: search result titles or a lookup API's name for the person. A personal profile needs the
 * lead's first and last name in one of them or in the link; a company page needs their company.
 */
export function linkedInNameMatches(lead: NameFields, url: string, names: string[]): boolean {
  const key = linkedInKey(url)
  if (!key) return false
  const [kind, slug] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)]
  const titles = names.map((n) => n.trim()).filter(Boolean)
  if (kind === 'company') return companyPageMatches(slug, titles, lead.company)
  const units = leadNameUnits(lead)
  if (units.length < 2) return false
  if (slugNames(slug, units)) return true
  return titles.some((t) => wordsName(profileNameWords(t), units))
}
