// hunter: email finder + verifier. Only when the lead has a business website domain and a name.
import type { EmailStatus } from '../../../shared/types.ts'
import type { Lead } from '../../db/schema.ts'
import type { Env } from '../../env.ts'
import { domainOf, fetchJson, qs, type HttpDeps } from '../http.ts'
import { clean, emptyResult, type EnrichProvider, type ProviderResult } from '../types.ts'

export const HUNTER_BASE = 'https://api.hunter.io/v2'

export interface HunterFinderResponse {
  data?: {
    first_name?: string | null
    last_name?: string | null
    email?: string | null
    score?: number | null
    domain?: string | null
    position?: string | null
    linkedin_url?: string | null
    phone_number?: string | null
    verification?: { date?: string | null; status?: string | null } | null
    sources?: unknown[]
  }
  errors?: { id?: string; code?: number; details?: string }[]
}

export interface HunterVerifierResponse {
  data?: {
    status?: string | null
    result?: 'deliverable' | 'undeliverable' | 'risky' | string | null
    score?: number | null
    email?: string | null
  }
  errors?: { id?: string; code?: number; details?: string }[]
}

/** Hunter's verifier result -> our email_status. Pure. */
export function mapVerifierResult(result: string | null | undefined): EmailStatus {
  switch (result) {
    case 'deliverable':
      return 'valid'
    case 'undeliverable':
      return 'invalid'
    case 'risky':
      return 'risky'
    default:
      return 'unknown'
  }
}

export function hunterName(lead: Pick<Lead, 'first_name' | 'last_name' | 'full_name'>): {
  first_name: string
  last_name: string
} | null {
  const first = clean(lead.first_name)
  const last = clean(lead.last_name)
  if (first && last) return { first_name: first, last_name: last }
  return null
}

export function finderUrl(domain: string, first: string, last: string, apiKey: string): string {
  return `${HUNTER_BASE}/email-finder?${qs({ domain, first_name: first, last_name: last, api_key: apiKey })}`
}

export function verifierUrl(email: string, apiKey: string): string {
  return `${HUNTER_BASE}/email-verifier?${qs({ email, api_key: apiKey })}`
}

export function createHunterProvider(deps: HttpDeps = {}): EnrichProvider {
  return {
    id: 'hunter',
    // Finder plus verifier: two requests per lead at most, so the cap check reserves two.
    costPerCall: 2,
    isConfigured: (env: Env) => Boolean(env.HUNTER_API_KEY),
    applies: (lead) => Boolean(domainOf(lead.website)) && hunterName(lead) !== null,
    async enrich(lead, ctx) {
      const apiKey = ctx.env.HUNTER_API_KEY
      if (!apiKey) throw new Error('hunter: HUNTER_API_KEY is missing')
      const domain = domainOf(lead.website)
      const name = hunterName(lead)
      if (!domain || !name) return emptyResult(null, 0)

      const finder = await fetchJson<HunterFinderResponse>(
        'hunter',
        finderUrl(domain, name.first_name, name.last_name, apiKey),
        { method: 'GET', headers: { accept: 'application/json' } },
        deps,
      )
      if (finder.status !== 200) {
        const detail = finder.data?.errors?.[0]?.details ?? finder.text.slice(0, 200)
        throw new Error(`hunter: email-finder HTTP ${finder.status} ${detail}`.trim())
      }
      const found = clean(finder.data?.data?.email)
      const raw: Record<string, unknown> = { finder: finder.data }
      if (!found) return emptyResult(raw, 1)

      let email_status: EmailStatus = 'unknown'
      let calls = 1
      try {
        const verify = await fetchJson<HunterVerifierResponse>(
          'hunter',
          verifierUrl(found, apiKey),
          { method: 'GET', headers: { accept: 'application/json' } },
          deps,
        )
        calls++
        raw.verifier = verify.data
        if (verify.status === 200) email_status = mapVerifierResult(verify.data?.data?.result)
      } catch (err) {
        // The finder result is still worth keeping; just unverified.
        raw.verifier_error = err instanceof Error ? err.message : String(err)
      }

      const score = finder.data?.data?.score
      const result: ProviderResult = {
        raw,
        confidence: typeof score === 'number' ? Math.min(1, Math.max(0, score / 100)) : 0.5,
        credits_used: calls,
        email: found,
        email_status,
      }
      const linkedin = clean(finder.data?.data?.linkedin_url)
      if (linkedin) result.linkedin_url = linkedin
      const phone = clean(finder.data?.data?.phone_number)
      if (phone) {
        result.phone = phone
        result.phone_type = 'unknown'
      }
      return result
    },
  }
}
