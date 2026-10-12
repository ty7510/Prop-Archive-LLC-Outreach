// claude_research: Claude with the web search server tool finds a landlord's public business presence.
// Structured output through output_config.format (zodOutputFormat + messages.parse), effort high:
// it searches every channel (email, phone, LinkedIn, Instagram, Facebook, site, address, portfolio).
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type { Lead } from '../../db/schema.ts'
import type { Env } from '../../env.ts'
import { isLlc } from '../../lib/text.ts'
import { clean, emptyResult, type EnrichProvider, type ProviderResult } from '../types.ts'

export const RESEARCH_MODEL = 'claude-opus-5-5'
export const RESEARCH_MAX_TOKENS = 16000
export const RESEARCH_MAX_WEB_SEARCHES = 20
export const RESEARCH_MAX_WEB_FETCHES = 12
/** A web search turn needs longer than the 10 s the plain HTTP providers get. */
export const RESEARCH_TIMEOUT_MS = 300_000
/** pause_turn resumes allowed before we give up on one lead. */
export const RESEARCH_MAX_TURNS = 8

export const ResearchSchema = z.object({
  full_name: z.string().nullable(),
  company: z.string().nullable(),
  website: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  instagram_url: z.string().nullable(),
  facebook_url: z.string().nullable(),
  mailing_street: z.string().nullable(),
  mailing_city: z.string().nullable(),
  mailing_state: z.string().nullable(),
  mailing_zip: z.string().nullable(),
  property_count: z.number().nullable(),
  unit_count: z.number().nullable(),
  property_details: z.array(z.string()),
  business_email: z.string().nullable(),
  business_phone: z.string().nullable(),
  confidence: z.number(),
  sources: z.array(z.string()),
})
export type ResearchResult = z.infer<typeof ResearchSchema>

export const RESEARCH_SYSTEM = [
  'You research the public business presence of small Philadelphia landlords and property owners',
  'so a software company can reach them through legitimate business channels.',
  'Rules: only return facts a source you found states. Put every source URL in sources.',
  'Never guess or construct an email address. If no source states an email, business_email is null.',
  'Only return a LinkedIn, Instagram or Facebook URL that clearly belongs to this owner or their company.',
  'Try very hard: run many searches before giving up on any field. Search the owner name and the LLC name',
  'separately, with and without "Philadelphia", "landlord", "property management", "rentals" and the mailing address.',
  'Check PA Department of State business filings and OpenCorporates for the LLC principal and registered address,',
  'Google Business / Yelp / BBB listings, the company website contact page, LinkedIn, Instagram, Facebook pages,',
  'rental listings (Zillow, Apartments.com, Craigslist, Facebook Marketplace) that name the landlord and a phone,',
  'Philadelphia property records (OPA, L&I rental licenses) for the portfolio, and news or court mentions.',
  'property_details: one short line per rental property you can confirm (address, units, type, notable facts).',
  'property_count and unit_count: totals a source supports, else null.',
  'For a company (LLC), full_name is the owner, managing member or principal named by a source, else null.',
  'confidence is 0 to 1: how sure you are the presence you found is this exact owner.',
  'Return nulls freely. Wrong data is worse than no data.',
  'What works for these owners (measured): plain web search rarely finds them and "corrects" rare surnames to famous',
  'people, so check every hit against the mailing address or LLC name before using it. The OpenCorporates officer',
  'search links in the prompt name LLC principals and their other LLCs; fetch them first, then follow company pages.',
  'A licence "agent" or managing agent is not the owner unless a filing says so.',
].join(' ')

/** The user prompt for one lead. Pure, unit tested. */
export function buildResearchPrompt(
  lead: Pick<
    Lead,
    | 'full_name'
    | 'company'
    | 'mailing_street'
    | 'mailing_city'
    | 'mailing_state'
    | 'mailing_zip'
    | 'property_count'
    | 'zips'
    | 'owner_kind'
    | 'last_name'
  >,
): string {
  const who = clean(lead.company) ?? clean(lead.full_name) ?? 'this owner'
  const also =
    lead.company && lead.full_name && lead.company !== lead.full_name ? lead.full_name : ''
  const mailing = [lead.mailing_street, lead.mailing_city, lead.mailing_state, lead.mailing_zip]
    .filter(Boolean)
    .join(', ')
  const lines = [
    `Find the public business presence of "${who} Philadelphia landlord/property owner".`,
  ]
  if (also) lines.push(`The person on the property records is ${also}.`)
  if (lead.owner_kind === 'llc' || isLlc(who)) {
    lines.push('This is an LLC. Find the person who runs it if a public source names them.')
  }
  if (lead.property_count) {
    lines.push(`They own about ${lead.property_count} rental properties in Philadelphia.`)
  }
  if (lead.zips.length) lines.push(`Property zip codes: ${lead.zips.join(', ')}.`)
  if (mailing) lines.push(`Owner mailing address from public records: ${mailing}.`)
  const links = researchLinks(lead)
  if (links.length) {
    lines.push('Fetch these public registry searches first:', ...links.map((u) => `- ${u}`))
  }
  lines.push(
    'Find every one of these that a source states: business email, phone number, LinkedIn profile, Instagram page,',
    'Facebook page or profile, company website, the owner full name, mailing address, how many properties and',
    'units they own, and details about each property. Search hard and from several angles before returning null.',
  )
  return lines.join('\n')
}

const OC = 'https://opencorporates.com'

/** Registry search URLs for this owner. web_fetch only opens URLs that appear in the conversation. */
export function researchLinks(lead: Pick<Lead, 'full_name' | 'company' | 'last_name'>): string[] {
  const q = (s: string) => encodeURIComponent(s.replace(/\s+/g, ' ').trim())
  const links: string[] = []
  const company = clean(lead.company)
  if (company && isLlc(company)) {
    links.push(`${OC}/companies/us_pa?q=${q(company)}`)
  }
  const person = clean(lead.full_name)
  if (person && !isLlc(person)) {
    links.push(`${OC}/officers?q=${q(person)}&jurisdiction_code=us_pa`)
  } else if (clean(lead.last_name)) {
    links.push(`${OC}/officers?q=${q(lead.last_name!)}&jurisdiction_code=us_pa`)
  }
  return links
}

/** What a parsed response looks like to this provider: the slice of the SDK message we read. */
export interface ResearchMessage {
  stop_reason: Anthropic.Messages.StopReason | null
  content: Anthropic.Messages.ContentBlock[]
  parsed_output: ResearchResult | null
}

export type ResearchParams = Anthropic.Messages.MessageCreateParamsNonStreaming

export interface ResearchClient {
  parse(params: ResearchParams): Promise<ResearchMessage>
}

export type ResearchClientFactory = (apiKey: string, workspaceId?: string) => ResearchClient

/** The real SDK client. Tests inject a fake through createClaudeResearchProvider({ clientFactory }). */
export const defaultClientFactory: ResearchClientFactory = (apiKey, workspaceId) => {
  const client = new Anthropic({
    apiKey,
    timeout: RESEARCH_TIMEOUT_MS,
    maxRetries: 2,
    // An organization-level key is rejected without this header.
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  })
  return {
    async parse(params) {
      const message = await client.messages.parse({
        ...params,
        output_config: { ...params.output_config, format: zodOutputFormat(ResearchSchema) },
      })
      return {
        stop_reason: message.stop_reason,
        content: message.content,
        parsed_output: message.parsed_output,
      }
    },
  }
}

export function buildResearchParams(
  prompt: string,
  messages?: Anthropic.Messages.MessageParam[],
): ResearchParams {
  return {
    model: RESEARCH_MODEL,
    max_tokens: RESEARCH_MAX_TOKENS,
    system: RESEARCH_SYSTEM,
    messages: messages ?? [{ role: 'user', content: prompt }],
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: RESEARCH_MAX_WEB_SEARCHES },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: RESEARCH_MAX_WEB_FETCHES },
    ],
    output_config: { effort: 'high', format: zodOutputFormat(ResearchSchema) },
  }
}

function clamp01(n: unknown): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, x))
}

/** Map a parsed research result onto lead fields. Pure, unit tested. */
export function mapResearchResult(
  parsed: ResearchResult,
  lead: Pick<Lead, 'owner_kind'>,
  credits_used: number,
): ProviderResult {
  const result: ProviderResult = {
    raw: parsed,
    confidence: clamp01(parsed.confidence),
    credits_used,
  }
  const fullName = clean(parsed.full_name)
  if (fullName && !isLlc(fullName)) {
    result.full_name = fullName
    if (lead.owner_kind !== 'person') result.owner_kind = 'person'
  }
  const company = clean(parsed.company)
  if (company) result.company = company
  const website = clean(parsed.website)
  if (website) result.website = website
  const linkedin = clean(parsed.linkedin_url)
  if (linkedin && /linkedin\.com\//i.test(linkedin)) result.linkedin_url = linkedin
  const instagram = clean(parsed.instagram_url)
  if (instagram && /instagram\.com\//i.test(instagram)) result.instagram_url = instagram
  const facebook = clean(parsed.facebook_url)
  if (facebook && /(facebook|fb)\.com\//i.test(facebook)) result.facebook_url = facebook
  for (const f of ['mailing_street', 'mailing_city', 'mailing_state', 'mailing_zip'] as const) {
    const v = clean(parsed[f])
    if (v) result[f] = v
  }
  if (typeof parsed.unit_count === 'number' && parsed.unit_count > 0) {
    result.unit_count = Math.round(parsed.unit_count)
  }
  const email = clean(parsed.business_email)
  if (email) {
    // Research never verifies deliverability; a verified address always wins over this one.
    result.email = email
    result.email_status = 'unknown'
  }
  const phone = clean(parsed.business_phone)
  if (phone) {
    result.phone = phone
    result.phone_type = 'unknown'
  }
  return result
}

export interface ClaudeResearchDeps {
  clientFactory?: ResearchClientFactory
}

export function createClaudeResearchProvider(deps: ClaudeResearchDeps = {}): EnrichProvider {
  const factory = deps.clientFactory ?? defaultClientFactory
  return {
    id: 'claude_research',
    costPerCall: 1,
    isConfigured: (env: Env) => Boolean(env.ANTHROPIC_API_KEY),
    applies: (lead) => Boolean(clean(lead.full_name) || clean(lead.company)),
    async enrich(lead, ctx) {
      const apiKey = ctx.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('claude_research: ANTHROPIC_API_KEY is missing')
      const client = factory(apiKey, ctx.env.ANTHROPIC_WORKSPACE_ID)
      const prompt = buildResearchPrompt(lead)
      let messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: prompt }]
      let calls = 0
      for (let turn = 0; turn < RESEARCH_MAX_TURNS; turn++) {
        calls++
        const message = await client.parse(buildResearchParams(prompt, messages))
        // Always look at stop_reason before trusting content.
        if (message.stop_reason === 'pause_turn') {
          // The server tool loop paused; hand the assistant turn back and let it finish.
          messages = [...messages, { role: 'assistant', content: message.content }]
          continue
        }
        if (message.stop_reason === 'refusal') {
          await ctx.log('warn', 'enrich.research_refused', { lead_id: lead.id })
          return emptyResult({ stop_reason: 'refusal' }, calls)
        }
        if (message.stop_reason === 'max_tokens') {
          await ctx.log('warn', 'enrich.research_truncated', { lead_id: lead.id })
          return emptyResult({ stop_reason: 'max_tokens' }, calls)
        }
        if (!message.parsed_output) {
          return emptyResult({ stop_reason: message.stop_reason, parsed_output: null }, calls)
        }
        return mapResearchResult(message.parsed_output, lead, calls)
      }
      await ctx.log('warn', 'enrich.research_paused_too_long', { lead_id: lead.id })
      return emptyResult({ stop_reason: 'pause_turn' }, calls)
    },
  }
}
