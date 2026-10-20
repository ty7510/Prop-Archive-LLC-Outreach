// apollo: people/match. Best for management companies (Denise). Personal emails are never requested.
import type { EmailStatus, PhoneType } from '../../../shared/types.ts'
import type { Lead } from '../../db/schema.ts'
import type { Env } from '../../env.ts'
import { domainOf, fetchJson, type HttpDeps } from '../http.ts'
import { clean, emptyResult, type EnrichProvider, type ProviderResult } from '../types.ts'

export const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match'

export interface ApolloPhone {
  raw_number?: string | null
  sanitized_number?: string | null
  type?: string | null
}

export interface ApolloPerson {
  id?: string
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  linkedin_url?: string | null
  title?: string | null
  email?: string | null
  email_status?: string | null
  phone_numbers?: ApolloPhone[] | null
  organization?: {
    name?: string | null
    website_url?: string | null
    primary_domain?: string | null
    phone?: string | null
  } | null
}

export interface ApolloMatchResponse {
  person?: ApolloPerson | null
  error?: string
  message?: string
}

export interface ApolloMatchBody {
  first_name?: string
  last_name?: string
  organization_name?: string
  domain?: string
  reveal_personal_emails: false
}

/** The request body for one lead, or null when Apollo has nothing to match on. Pure. */
export function buildApolloBody(
  lead: Pick<Lead, 'first_name' | 'last_name' | 'company' | 'website'>,
): ApolloMatchBody | null {
  const body: ApolloMatchBody = { reveal_personal_emails: false }
  const first = clean(lead.first_name)
  const last = clean(lead.last_name)
  const company = clean(lead.company)
  const domain = domainOf(lead.website)
  if (first) body.first_name = first
  if (last) body.last_name = last
  if (company) body.organization_name = company
  if (domain) body.domain = domain
  // Apollo needs a person; a company alone comes back empty or wrong.
  if (!(first && last)) return null
  return body
}

export function mapApolloEmailStatus(status: string | null | undefined): EmailStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'verified':
      return 'valid'
    case 'likely to engage':
    case 'guessed':
    case 'extrapolated':
      return 'risky'
    case 'unavailable':
    case 'invalid':
      return 'invalid'
    default:
      return 'unknown'
  }
}

export function mapApolloPhoneType(type: string | null | undefined): PhoneType {
  switch ((type ?? '').toLowerCase()) {
    case 'mobile':
      return 'mobile'
    case 'work_direct':
    case 'work_hq':
    case 'home':
      return 'landline'
    default:
      return 'unknown'
  }
}

/** Map an Apollo person onto lead fields. Pure, unit tested. */
export function mapApolloPerson(
  person: ApolloPerson | null | undefined,
  raw: unknown,
): ProviderResult {
  if (!person) return emptyResult(raw, 1)
  const result: ProviderResult = { raw, confidence: 0.7, credits_used: 1 }
  const first = clean(person.first_name)
  const last = clean(person.last_name)
  const name = clean(person.name)
  if (first) result.first_name = first
  if (last) result.last_name = last
  if (name) result.full_name = name
  const linkedin = clean(person.linkedin_url)
  if (linkedin) {
    result.linkedin_url = linkedin
    const shown = name ?? [first, last].filter(Boolean).join(' ')
    if (shown) result.linkedin_names = [shown]
  }
  const email = clean(person.email)
  const status = mapApolloEmailStatus(person.email_status)
  if (email && status !== 'invalid') {
    result.email = email
    result.email_status = status
  }
  const phones = person.phone_numbers ?? []
  const mobile = phones.find((p) => mapApolloPhoneType(p.type) === 'mobile')
  const phone = mobile ?? phones[0]
  const number = clean(phone?.sanitized_number) ?? clean(phone?.raw_number)
  if (number) {
    result.phone = number
    result.phone_type = mapApolloPhoneType(phone?.type)
  }
  const org = person.organization
  const company = clean(org?.name)
  if (company) result.company = company
  const website = clean(org?.website_url) ?? clean(org?.primary_domain)
  if (website) result.website = website
  if (first || last || name) result.owner_kind = 'person'
  return result
}

export function createApolloProvider(deps: HttpDeps = {}): EnrichProvider {
  return {
    id: 'apollo',
    costPerCall: 1,
    isConfigured: (env: Env) => Boolean(env.APOLLO_API_KEY),
    applies: (lead) => buildApolloBody(lead) !== null,
    async enrich(lead, ctx) {
      const apiKey = ctx.env.APOLLO_API_KEY
      if (!apiKey) throw new Error('apollo: APOLLO_API_KEY is missing')
      const body = buildApolloBody(lead)
      if (!body) return emptyResult(null, 0)
      const res = await fetchJson<ApolloMatchResponse>(
        'apollo',
        APOLLO_MATCH_URL,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(body),
        },
        deps,
      )
      if (res.status === 404) return emptyResult(res.data, 1)
      if (res.status !== 200) {
        const detail = res.data?.error ?? res.data?.message ?? res.text.slice(0, 200)
        throw new Error(`apollo: HTTP ${res.status} ${detail}`.trim())
      }
      return mapApolloPerson(res.data?.person, res.data)
    },
  }
}
