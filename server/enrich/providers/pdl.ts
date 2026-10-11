// pdl: People Data Labs person enrich. A 404 means "no match" and costs nothing.
import type { Lead } from '../../db/schema.ts'
import type { Env } from '../../env.ts'
import { fetchJson, qs, type HttpDeps } from '../http.ts'
import { clean, emptyResult, type EnrichProvider, type ProviderResult } from '../types.ts'

export const PDL_ENRICH_URL = 'https://api.peopledatalabs.com/v5/person/enrich'
export const PDL_LOCATION = 'Philadelphia'

export interface PdlPerson {
  full_name?: string | null
  first_name?: string | null
  last_name?: string | null
  linkedin_url?: string | null
  work_email?: string | null
  emails?: { address?: string | null; type?: string | null }[] | null
  mobile_phone?: string | null
  phone_numbers?: string[] | null
  job_company_name?: string | null
  job_company_website?: string | null
  job_title?: string | null
}

export interface PdlResponse {
  status?: number
  likelihood?: number
  data?: PdlPerson | null
  error?: { type?: string; message?: string } | null
}

export function pdlName(lead: Pick<Lead, 'full_name' | 'first_name' | 'last_name'>): string | null {
  const full = clean(lead.full_name)
  if (full) return full
  const first = clean(lead.first_name)
  const last = clean(lead.last_name)
  if (first && last) return `${first} ${last}`
  return null
}

export function pdlUrl(name: string, company: string | null): string {
  return `${PDL_ENRICH_URL}?${qs({ name, company, location: PDL_LOCATION, min_likelihood: 6 })}`
}

function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

/** Map a PDL person onto lead fields. Pure, unit tested. */
export function mapPdlResponse(res: PdlResponse): ProviderResult {
  const person = res.data
  if (!person) return emptyResult(res, 1)
  const likelihood = typeof res.likelihood === 'number' ? res.likelihood : 5
  const result: ProviderResult = {
    raw: res,
    confidence: Math.min(1, Math.max(0, likelihood / 10)),
    credits_used: 1,
  }
  const full = clean(person.full_name)
  const first = clean(person.first_name)
  const last = clean(person.last_name)
  if (full) result.full_name = full
  if (first) result.first_name = first
  if (last) result.last_name = last
  const linkedin = clean(person.linkedin_url)
  if (linkedin) result.linkedin_url = withScheme(linkedin)
  const work = clean(person.work_email)
  const anyEmail = person.emails?.find((e) => clean(e.address))?.address ?? null
  const email = work ?? clean(anyEmail)
  if (email) {
    result.email = email
    result.email_status = 'unknown'
  }
  const mobile = clean(person.mobile_phone)
  const other = person.phone_numbers?.find((p) => clean(p)) ?? null
  if (mobile) {
    result.phone = mobile
    result.phone_type = 'mobile'
  } else if (other) {
    result.phone = other
    result.phone_type = 'unknown'
  }
  const company = clean(person.job_company_name)
  if (company) result.company = company
  const website = clean(person.job_company_website)
  if (website) result.website = withScheme(website)
  if (full || first || last) result.owner_kind = 'person'
  return result
}

export function createPdlProvider(deps: HttpDeps = {}): EnrichProvider {
  return {
    id: 'pdl',
    costPerCall: 1,
    isConfigured: (env: Env) => Boolean(env.PDL_API_KEY),
    applies: (lead) => pdlName(lead) !== null,
    async enrich(lead, ctx) {
      const apiKey = ctx.env.PDL_API_KEY
      if (!apiKey) throw new Error('pdl: PDL_API_KEY is missing')
      const name = pdlName(lead)
      if (!name) return emptyResult(null, 0)
      const res = await fetchJson<PdlResponse>(
        'pdl',
        pdlUrl(name, clean(lead.company)),
        { method: 'GET', headers: { accept: 'application/json', 'X-Api-Key': apiKey } },
        deps,
      )
      // PDL answers 404 for "no match" and does not bill it.
      if (res.status === 404) return emptyResult(res.data ?? { status: 404 }, 0)
      if (res.status !== 200 || !res.data) {
        const detail = res.data?.error?.message ?? res.text.slice(0, 200)
        throw new Error(`pdl: HTTP ${res.status} ${detail}`.trim())
      }
      return mapPdlResponse(res.data)
    },
  }
}
