// Small pure text helpers shared by sources, enrich and outreach. Owned by the scaffold.

const SUFFIXES: Record<string, string> = {
  STREET: 'ST',
  STR: 'ST',
  AVENUE: 'AVE',
  AV: 'AVE',
  ROAD: 'RD',
  BOULEVARD: 'BLVD',
  BLV: 'BLVD',
  DRIVE: 'DR',
  LANE: 'LN',
  PLACE: 'PL',
  COURT: 'CT',
  TERRACE: 'TER',
  TERR: 'TER',
  PARKWAY: 'PKWY',
  HIGHWAY: 'HWY',
  CIRCLE: 'CIR',
  SQUARE: 'SQ',
  WAY: 'WAY',
  ALLEY: 'ALY',
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
  APARTMENT: 'UNIT',
  APT: 'UNIT',
  SUITE: 'UNIT',
  STE: 'UNIT',
  FLOOR: 'FL',
  FLR: 'FL',
  PO: 'PO',
}

/**
 * One canonical form for a street line so the same owner address always dedupes:
 * upper case, punctuation removed, "#" becomes UNIT, suffixes abbreviated, spaces collapsed.
 * normaliseStreet('1234 N. Broad Street, Apt 2') === '1234 N BROAD ST UNIT 2'
 */
export function normaliseStreet(input: string | null | undefined): string {
  if (!input) return ''
  const upper = input
    .toUpperCase()
    .replace(/#/g, ' UNIT ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!upper) return ''
  return upper
    .split(' ')
    .map((w) => SUFFIXES[w] ?? w)
    .join(' ')
}

/** First five digits of a zip, or '' when there are not five. normaliseZip5('19104-2301') === '19104' */
export function normaliseZip5(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return ''
  const digits = String(input).replace(/\D/g, '')
  if (digits.length < 5) return digits.length > 0 ? digits.padStart(5, '0') : ''
  return digits.slice(0, 5)
}

const KEEP_UPPER = new Set(['LLC', 'LP', 'LLP', 'INC', 'II', 'III', 'IV', 'PA', 'PC', 'LTD', 'CO'])

/** Title Case for names. Keeps LLC, INC and roman numerals upper. Handles O'Brien and Smith-Jones. */
export function titleCase(input: string | null | undefined): string {
  if (!input) return ''
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => {
      const bare = word.replace(/[.,]/g, '')
      if (KEEP_UPPER.has(bare.toUpperCase())) return bare.toUpperCase()
      return word
        .toLowerCase()
        .split(/([-'])/)
        .map((part) => (part === '-' || part === "'" ? part : capitalise(part)))
        .join('')
    })
    .join(' ')
}

function capitalise(part: string): string {
  if (!part) return part
  if (/^mc[a-z]/.test(part)) return 'Mc' + part.charAt(2).toUpperCase() + part.slice(3)
  return part.charAt(0).toUpperCase() + part.slice(1)
}

const LLC_RE =
  /\b(L\.?L\.?C\.?|L\.?P\.?|L\.?L\.?P\.?|INC\.?|INCORPORATED|CORP\.?|CORPORATION|LTD\.?|LIMITED|CO\.?|COMPANY|TRUST|TR|PARTNERSHIP|PARTNERS|HOLDINGS?|PROPERTIES|REALTY|GROUP|ASSOCIATES|ASSOC|INVESTMENTS?|ENTERPRISES?|MANAGEMENT|MGMT|VENTURES?|CAPITAL|DEVELOPMENT|ESTATES?|HOMES|HOUSING|RENTALS?)\b/i

/** True when a name reads as a company (LLC, LP, Inc, Trust, Properties ...) rather than a person. */
export function isLlc(name: string | null | undefined): boolean {
  if (!name) return false
  return LLC_RE.test(name.replace(/,/g, ' '))
}

/** The one character that may never appear in UI text. */
export function hasEmDash(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes('—')
}

/** Lower-case, hyphen separated, ascii only. slug('Point Breeze / Grad Hospital') === 'point-breeze-grad-hospital' */
export function slug(input: string | null | undefined): string {
  if (!input) return ''
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Lower-cased, trimmed email or '' when it does not look like one. */
export function normaliseEmail(input: string | null | undefined): string {
  if (!input) return ''
  const e = input.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : ''
}

/** Digits only, with a leading US country code dropped. '(215) 555-0100' -> '2155550100' */
export function normalisePhone(input: string | null | undefined): string {
  if (!input) return ''
  let digits = String(input).replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  return digits
}

/** Split "LAST FIRST" or "First Last" style owner names into parts. Best effort. */
export function splitName(full: string | null | undefined): {
  first_name: string
  last_name: string
} {
  const clean = titleCase(full)
  if (!clean) return { first_name: '', last_name: '' }
  const parts = clean.split(' ').filter(Boolean)
  if (parts.length === 1) return { first_name: parts[0] ?? '', last_name: '' }
  return { first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') }
}
