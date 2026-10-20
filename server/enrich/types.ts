// Enrichment contracts (spec section 9). Owned by the enrich builder.
import type { EnrichProviderId, Settings } from '../../shared/settings.ts'
import type { ActivityLevel } from '../../shared/types.ts'
import type { Lead, Property } from '../db/schema.ts'
import type { Env } from '../env.ts'

/** The lead columns a provider may fill. The orchestrator decides what actually gets written. */
export type LeadContactFields = Pick<
  Lead,
  | 'full_name'
  | 'first_name'
  | 'last_name'
  | 'company'
  | 'email'
  | 'email_status'
  | 'phone'
  | 'phone_type'
  | 'linkedin_url'
  | 'instagram_url'
  | 'facebook_url'
  | 'website'
  | 'mailing_street'
  | 'mailing_city'
  | 'mailing_state'
  | 'mailing_zip'
  | 'mailing_verified'
  | 'unit_count'
  | 'owner_kind'
>

/** Per-property facts a provider learned (li_license knows unit counts and license dates). */
export interface PropertyUpdate {
  opa_account: string
  units?: number | null
  license_num?: string | null
  license_issue_date?: string | null
  license_expiry?: string | null
}

export interface ProviderResult extends Partial<LeadContactFields> {
  /** The provider payload as received, stored under leads.enrichment[provider].data. */
  raw: unknown
  /** 0..1, how much the provider trusts what it returned. */
  confidence: number
  /** Credits actually consumed. Defaults to provider.costPerCall when omitted. */
  credits_used?: number
  property_updates?: PropertyUpdate[]
  /**
   * The name a source showed for linkedin_url: search result titles, or the person a lookup API
   * matched. merge.ts keeps the link only when this or the link itself carries the lead's name.
   */
  linkedin_names?: string[]
}

export interface EnrichContext {
  env: Env
  settings: Settings
  /** The lead's properties, for providers that join on public records. */
  properties: Property[]
  now: Date
  /** Write one activity line. Never throws. */
  log: (level: ActivityLevel, event: string, detail?: unknown) => Promise<void>
}

export interface EnrichProvider {
  id: EnrichProviderId
  /** Credits one call costs against settings.enrichment.monthly_credit_cap. 0 = free. */
  costPerCall: number
  isConfigured(env: Env): boolean
  /** False when the lead lacks what this provider needs (a domain, a name). Saves credits. */
  applies(lead: Lead, ctx: EnrichContext): boolean
  enrich(lead: Lead, ctx: EnrichContext): Promise<ProviderResult>
}

/** An empty result: nothing learned, nothing to merge. */
export function emptyResult(raw: unknown = null, credits_used?: number): ProviderResult {
  const r: ProviderResult = { raw, confidence: 0 }
  if (credits_used !== undefined) r.credits_used = credits_used
  return r
}

/** Trim and drop empty strings so merge logic only sees real values. */
export function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v ? v : null
}
