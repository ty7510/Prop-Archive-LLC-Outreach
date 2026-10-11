// Small pure helpers for labels and dates. No React in here so they are easy to test.
import type { Channel, LeadPersona, LeadStatus, SequencePersona } from '@shared/types'
import type { Lead } from '../types.ts'

/** Zip to neighbourhood (spec section 10). Unknown zips fall back to the zip itself. */
export const NEIGHBOURHOODS: Record<string, string> = {
  '19104': 'University City',
  '19121': 'Brewerytown / North Philly',
  '19122': 'Temple area',
  '19139': 'West Philly',
  '19143': 'Southwest Philly',
  '19146': 'Point Breeze / Graduate Hospital',
  '19125': 'Fishtown / Kensington',
}

export function neighbourhood(zip: string | null | undefined): string {
  if (!zip) return ''
  const five = zip.slice(0, 5)
  return NEIGHBOURHOODS[five] ?? five
}

/** First known neighbourhood for a lead: its property zips first, then the mailing zip. */
export function leadNeighbourhood(lead: Pick<Lead, 'zips' | 'mailing_zip'>): string {
  const first = lead.zips.find((z) => Boolean(z))
  if (first) return neighbourhood(first)
  return neighbourhood(lead.mailing_zip)
}

export const PERSONA_LABEL: Record<LeadPersona | 'any', string> = {
  maya: 'Maya (3 to 6)',
  ray: 'Ray (7 to 14)',
  denise: 'Denise (15 to 20)',
  unknown: 'Unknown',
  any: 'Any persona',
}

export function personaLabel(p: LeadPersona | SequencePersona): string {
  return PERSONA_LABEL[p]
}

export const PERSONA_SHORT: Record<LeadPersona | 'any', string> = {
  maya: 'Maya',
  ray: 'Ray',
  denise: 'Denise',
  unknown: 'Unknown',
  any: 'Any',
}

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'Not enriched',
  enriching: 'Enriching',
  enriched: 'Enriched',
  enrolled: 'In sequence',
  contacted: 'Contacted',
  replied: 'Replied',
  booked: 'Booked a demo',
  joined: 'Joined the beta',
  not_interested: 'Not interested',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  disqualified: 'Disqualified',
}

export function statusLabel(s: LeadStatus | string): string {
  return (STATUS_LABEL as Record<string, string>)[s] ?? humanise(s)
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  email: 'Email',
  mail: 'Mail',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  call: 'Call',
}

export const TRIGGER_LABEL: Record<string, string> = {
  new_license: 'New rental license',
  recent_sale: 'Recent sale',
  csv: 'From your CSV',
  none: 'No trigger',
  any: 'Any trigger',
}

export function triggerLabel(t: string): string {
  return TRIGGER_LABEL[t] ?? humanise(t)
}

/** snake_case or kebab-case to a plain sentence start. */
export function humanise(s: string): string {
  const words = s.replace(/[_-]+/g, ' ').trim()
  if (!words) return ''
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Display name: full name, else company, else first and last, else a fallback. */
export function leadName(
  lead: Pick<Lead, 'full_name' | 'company' | 'first_name' | 'last_name'>,
  fallback = 'Unnamed lead',
): string {
  if (lead.full_name && lead.full_name.trim()) return lead.full_name.trim()
  if (lead.company && lead.company.trim()) return lead.company.trim()
  const joined = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
  return joined || fallback
}

export function mailingAddress(
  lead: Pick<Lead, 'mailing_street' | 'mailing_city' | 'mailing_state' | 'mailing_zip'>,
): string {
  const line2 = [lead.mailing_city, lead.mailing_state].filter(Boolean).join(', ')
  return [lead.mailing_street, [line2, lead.mailing_zip].filter(Boolean).join(' ')]
    .filter((s) => s && s.trim())
    .join(', ')
}

/** "3 min ago", "in 2 h", "yesterday", or a short date. `now` is injectable for tests. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '–'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '–'
  const diff = t - now.getTime()
  const abs = Math.abs(diff)
  const future = diff > 0
  const sec = Math.round(abs / 1000)
  const min = Math.round(abs / 60_000)
  const hr = Math.round(abs / 3_600_000)
  const day = Math.round(abs / 86_400_000)
  let core: string
  if (sec < 45) core = 'just now'
  else if (min < 60) core = `${min} min`
  else if (hr < 24) core = `${hr} h`
  else if (day === 1) return future ? 'tomorrow' : 'yesterday'
  else if (day < 14) core = `${day} days`
  else return shortDate(iso)
  if (core === 'just now') return core
  return future ? `in ${core}` : `${core} ago`
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–'
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

/** Empty cells show an en dash, never nothing. */
export function orDash(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '–'
  const s = String(v).trim()
  return s === '' ? '–' : s
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Phone number into a tel: link, keeping digits and a leading plus. */
export function telHref(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, '')
  return `tel:${cleaned}`
}

/** Make sure a profile url has a scheme so it opens in a new tab. */
export function ensureHttp(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return `https://${url.replace(/^\/+/, '')}`
}
