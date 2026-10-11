// ICP score and persona (spec section 5). Pure functions, no database.
// Owned by the sources builder.
import type { LeadPersona, LeadTrigger } from '../../shared/types.ts'
import { normaliseZip5 } from '../lib/text.ts'
import { daysBetween } from '../lib/time.ts'

export interface ScoreInput {
  property_count: number | null | undefined
  /** Zips of the lead's properties. */
  zips: string[] | null | undefined
  trigger: LeadTrigger | null | undefined
  /** OPA category_code_description per property. */
  categories?: (string | null | undefined)[] | null
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
}

export interface ScoreSettings {
  target_zips: string[]
}

export const NEW_LICENSE_WINDOW_DAYS = 60
export const RECENT_SALE_WINDOW_DAYS = 90

const MULTI_CATEGORY_RE = /MULTI\s*FAMILY|MIXED\s*USE|APARTMENTS/i

/** Points for the property count bucket. */
export function propertyCountPoints(count: number | null | undefined): number {
  const n = Math.max(0, Math.floor(count ?? 0))
  if (n === 0) return 15
  if (n <= 2) return 5
  if (n <= 14) return 40
  if (n <= 20) return 35
  return 10
}

/** Points for overlap with the target zips: any +20, all of them +25. */
export function zipPoints(zips: string[] | null | undefined, targetZips: string[]): number {
  const targets = new Set(targetZips.map((z) => normaliseZip5(z)).filter(Boolean))
  const own = new Set((zips ?? []).map((z) => normaliseZip5(z)).filter(Boolean))
  if (own.size === 0 || targets.size === 0) return 0
  let hits = 0
  for (const z of own) if (targets.has(z)) hits++
  if (hits === 0) return 0
  return hits === own.size ? 25 : 20
}

/** Points for a fresh trigger. The window is counted back from `now`. */
export function triggerPoints(trigger: LeadTrigger | null | undefined, now = new Date()): number {
  if (!trigger || trigger.type === 'none' || trigger.type === 'csv') return 0
  if (!trigger.date) return 0
  const at = new Date(trigger.date)
  if (Number.isNaN(at.getTime())) return 0
  const age = daysBetween(at, now)
  if (age < -1) return 0
  if (trigger.type === 'new_license') return age <= NEW_LICENSE_WINDOW_DAYS ? 20 : 0
  if (trigger.type === 'recent_sale') return age <= RECENT_SALE_WINDOW_DAYS ? 20 : 0
  return 0
}

/** +10 when any property is multi family, mixed use or apartments. */
export function categoryPoints(
  categories: (string | null | undefined)[] | null | undefined,
): number {
  for (const c of categories ?? []) {
    if (c && MULTI_CATEGORY_RE.test(c)) return 10
  }
  return 0
}

/** True when the mailing address reads as inside Philadelphia (city name or a 191xx zip). */
export function isPhiladelphiaAddress(input: {
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
}): boolean {
  const zip = normaliseZip5(input.mailing_zip)
  if (zip.startsWith('191')) return true
  const city = (input.mailing_city ?? '').trim().toUpperCase().replace(/\.$/, '')
  const state = (input.mailing_state ?? '').trim().toUpperCase()
  if (city === 'PHILADELPHIA' || city === 'PHILA') return state === '' || state === 'PA'
  return false
}

/** Local owner +5. Out of state and the rest of Pennsylvania both score 0. */
export function localOwnerPoints(input: {
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
}): number {
  return isPhiladelphiaAddress(input) ? 5 : 0
}

/** The 0-100 ICP score. */
export function scoreLead(input: ScoreInput, settings: ScoreSettings, now = new Date()): number {
  const total =
    propertyCountPoints(input.property_count) +
    zipPoints(input.zips, settings.target_zips) +
    triggerPoints(input.trigger, now) +
    categoryPoints(input.categories) +
    localOwnerPoints(input)
  return Math.max(0, Math.min(100, total))
}

/** Persona from the property count. 'unknown' when we have no count. Over 20 still reads as Denise. */
export function personaFor(count: number | null | undefined): LeadPersona {
  const n = Math.floor(count ?? 0)
  if (n <= 0) return 'unknown'
  if (n <= 6) return 'maya'
  if (n <= 14) return 'ray'
  return 'denise'
}
