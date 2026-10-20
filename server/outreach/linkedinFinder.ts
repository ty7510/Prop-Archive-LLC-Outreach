// Finds a person's LinkedIn profile with Claude's web search, limited to linkedin.com, so Theo does
// not have to look people up by hand. The app never opens, logs in to or fetches LinkedIn: it only
// reads search results (their link and title). A profile is saved only when a search result shows
// the person's full name and Claude picked it as this person; anything less stays "not found".
import Anthropic from '@anthropic-ai/sdk'
import { eq } from 'drizzle-orm'
import { events, leads, type Lead } from '../db/schema.ts'
import { creditsUsed, monthRange, recordUsage } from '../enrich/usage.ts'
import { computeChannels } from '../enrich/channels.ts'
import { linkedInNameMatches } from '../enrich/linkedinName.ts'
import { logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { isLlc } from '../lib/text.ts'
import { getSettings } from '../lib/settings.ts'
import type { OutreachDeps } from './deps.ts'

export const FINDER_MODEL = 'claude-haiku-5-5'
/** Searches per person. Each costs a cent; three is enough for name, name + city, name + company. */
export const FINDER_MAX_SEARCHES = 3
const FINDER_MAX_TURNS = 3
/** A person the finder could not find is tried again after this many days. */
export const FINDER_RETRY_DAYS = 30
/** Where the finder keeps what it tried, in leads.enrichment. */
export const FINDER_KEY = 'linkedin_find'
/** The provider_usage name its calls are counted under, for the monthly cap. */
export const FINDER_USAGE = 'linkedin_find'

export type FinderParams = Anthropic.Messages.MessageCreateParamsNonStreaming
export interface FinderMessage {
  stop_reason: Anthropic.Messages.StopReason | null
  content: Anthropic.Messages.ContentBlock[]
}
/** The one Claude call the finder makes. Tests pass a fake. */
export type LinkedInSearch = (params: FinderParams) => Promise<FinderMessage>

export function anthropicLinkedInSearch(apiKey: string, workspaceId?: string): LinkedInSearch {
  const client = new Anthropic({
    apiKey,
    timeout: 120_000,
    maxRetries: 2,
    // An organization-level key is refused without this header.
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  })
  return async (params) => {
    const res = await client.messages.create(params)
    return { stop_reason: res.stop_reason, content: res.content }
  }
}

export const FINDER_SYSTEM = [
  'You find one Philadelphia landlord or property manager on LinkedIn.',
  'Search linkedin.com for their own personal profile, for example "First Last" Philadelphia,',
  '"First Last" real estate, "First Last" and their company name.',
  'Answer with only the profile link (linkedin.com/in/...) of the result that is clearly this person:',
  'the result shows their full name and something that fits them, such as the Philadelphia area,',
  'real estate, rentals, property management or their company. If no result is clearly them, answer NONE.',
  'Never guess and never build a link yourself. A wrong person is worse than none.',
].join(' ')

export interface FinderPerson {
  first: string
  last: string
  company: string | null
}

/** First and last name of the person behind a lead, or null when it is only a company. */
export function personFor(
  lead: Pick<Lead, 'first_name' | 'last_name' | 'full_name' | 'company'>,
): FinderPerson | null {
  let first = (lead.first_name ?? '').trim()
  let last = (lead.last_name ?? '').trim()
  if ((!first || !last) && lead.full_name && !isLlc(lead.full_name)) {
    const words = lead.full_name.trim().split(/\s+/)
    if (words.length >= 2) {
      first = words[0]!
      last = words[words.length - 1]!
    }
  }
  if (first.length < 2 || last.length < 2 || isLlc(`${first} ${last}`)) return null
  const company = (lead.company ?? '').trim()
  const fullName = `${first} ${last}`.toLowerCase()
  return {
    first,
    last,
    company: company && company.toLowerCase() !== fullName ? company : null,
  }
}

export function buildFinderPrompt(
  person: FinderPerson,
  lead: Pick<Lead, 'property_count' | 'mailing_city'>,
): string {
  const lines = [`Person: ${person.first} ${person.last}`]
  if (person.company) lines.push(`Company: ${person.company}`)
  lines.push(
    lead.property_count > 0
      ? `Owns about ${lead.property_count} rental properties in Philadelphia.`
      : 'Owns rental property in Philadelphia.',
  )
  if (lead.mailing_city) lines.push(`Mailing address city: ${lead.mailing_city}`)
  lines.push('Find their LinkedIn profile.')
  return lines.join('\n')
}

export function finderParams(messages: Anthropic.Messages.MessageParam[]): FinderParams {
  return {
    model: FINDER_MODEL,
    max_tokens: 2000,
    system: FINDER_SYSTEM,
    messages,
    tools: [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: FINDER_MAX_SEARCHES,
        allowed_domains: ['linkedin.com'],
      },
    ],
    output_config: { effort: 'low' },
  }
}

/** A LinkedIn person page as https://www.linkedin.com/in/<slug>/, or null for anything else. */
export function profileUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
  } catch {
    return null
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null
  const slug = u.pathname.match(/^\/in\/([^/]+)/i)?.[1]
  return slug ? `https://www.linkedin.com/in/${slug.toLowerCase()}/` : null
}

export interface Candidate {
  url: string
  title: string
}

/** Every LinkedIn person page the searches returned, with its title. */
export function searchCandidates(content: Anthropic.Messages.ContentBlock[]): Candidate[] {
  const out = new Map<string, Candidate>()
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const r of block.content) {
      const url = profileUrl(r.url)
      if (url && !out.has(url)) out.set(url, { url, title: r.title ?? '' })
    }
  }
  return [...out.values()]
}

/** The profile link Claude answered with, or null for NONE / no link. */
export function answerUrl(content: Anthropic.Messages.ContentBlock[]): string | null {
  const text = content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
  const m = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s)"'<>\]]+/i)
  return m ? profileUrl(m[0]) : null
}

function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Does the search result name this person: first and last name in its title or its link? */
export function namesPerson(c: Candidate, person: FinderPerson): boolean {
  const name = {
    full_name: `${person.first} ${person.last}`,
    first_name: person.first,
    last_name: person.last,
    company: null,
  }
  return linkedInNameMatches(name, c.url, [c.title])
}

const TIE_WORDS =
  /philadelphia|philly|\bpa\b|pennsylvania|real estate|realty|realtor|propert|landlord|rental|housing|investor|investments|homes\b/

const GENERIC_COMPANY_WORDS = new Set([
  'llc',
  'inc',
  'corp',
  'company',
  'group',
  'properties',
  'property',
  'management',
  'holdings',
  'investments',
  'realty',
  'real',
  'estate',
  'homes',
  'philadelphia',
  'partners',
  'associates',
  'the',
  'and',
])

/** Does the title also show something that fits this landlord (place, trade or company)? */
export function hasTie(c: Candidate, person: FinderPerson): boolean {
  const title = fold(c.title)
  if (TIE_WORDS.test(title)) return true
  const companyWords = fold(person.company ?? '')
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !GENERIC_COMPANY_WORDS.has(w))
  return companyWords.some((w) => title.includes(w))
}

export interface FinderVerdict {
  url: string | null
  title: string | null
  /** Plain words: why this profile, or why none. */
  reason: string
}

/**
 * The profile to save, or none. Claude's pick must be a real search result that names the person;
 * when several results carry the same name, the pick must also show the place, trade or company.
 */
export function judge(
  candidates: Candidate[],
  pick: string | null,
  person: FinderPerson,
  rejected: string[] = [],
): FinderVerdict {
  const named = candidates.filter((c) => namesPerson(c, person) && !rejected.includes(c.url))
  if (named.length === 0)
    return { url: null, title: null, reason: 'no LinkedIn result had their name' }
  if (!pick) return { url: null, title: null, reason: 'no result was clearly them' }
  const chosen = named.find((c) => c.url === pick)
  if (!chosen) {
    return { url: null, title: null, reason: 'the pick was not a search result with their name' }
  }
  if (named.length > 1 && !hasTie(chosen, person)) {
    return {
      url: null,
      title: null,
      reason: `${named.length} people with that name and nothing ties one to Philadelphia rentals`,
    }
  }
  return { url: chosen.url, title: chosen.title, reason: 'search result shows their name' }
}

interface FinderRecord {
  url: string | null
  title: string | null
  reason: string
  tried_at: string
  rejected: string[]
}

export function finderRecord(lead: Pick<Lead, 'enrichment'>): FinderRecord | null {
  const data = lead.enrichment?.[FINDER_KEY]?.data as Partial<FinderRecord> | undefined
  if (!data || typeof data !== 'object') return null
  return {
    url: typeof data.url === 'string' ? data.url : null,
    title: typeof data.title === 'string' ? data.title : null,
    reason: typeof data.reason === 'string' ? data.reason : '',
    tried_at: typeof data.tried_at === 'string' ? data.tried_at : '',
    rejected: Array.isArray(data.rejected)
      ? data.rejected.filter((r) => typeof r === 'string')
      : [],
  }
}

/** Search for one person. Throws when Claude cannot be reached (no credits, outage). */
export async function searchProfile(
  search: LinkedInSearch,
  person: FinderPerson,
  lead: Pick<Lead, 'property_count' | 'mailing_city'>,
  rejected: string[],
): Promise<FinderVerdict> {
  let msgs: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: buildFinderPrompt(person, lead) },
  ]
  const seen: Anthropic.Messages.ContentBlock[] = []
  for (let turn = 0; turn < FINDER_MAX_TURNS; turn++) {
    const res = await search(finderParams(msgs))
    seen.push(...res.content)
    if (res.stop_reason === 'pause_turn') {
      msgs = [...msgs, { role: 'assistant', content: res.content }]
      continue
    }
    if (res.stop_reason === 'refusal') return { url: null, title: null, reason: 'search declined' }
    return judge(searchCandidates(seen), answerUrl(res.content), person, rejected)
  }
  return judge(searchCandidates(seen), null, person, rejected)
}

export type FindOutcome =
  | { status: 'found'; linkedin_url: string }
  | { status: 'not_found'; reason: string }
  | { status: 'skipped'; reason: string }

/** Is the finder allowed to spend one more search this month? */
async function underCap(deps: OutreachDeps): Promise<boolean> {
  const settings = await getSettings(deps.db)
  const range = monthRange(deps.now(), settings.send_window.tz)
  const { calls } = await creditsUsed(FINDER_USAGE, range, deps.db)
  return calls < settings.enrichment.linkedin_find_cap
}

/** Save what the finder learned about one lead, and the profile itself when it found one. */
async function saveVerdict(
  deps: OutreachDeps,
  lead: Lead,
  verdict: FinderVerdict,
  rejected: string[],
): Promise<void> {
  const now = deps.now().toISOString()
  const record: FinderRecord = { ...verdict, tried_at: now, rejected }
  const enrichment = { ...lead.enrichment, [FINDER_KEY]: { fetched_at: now, data: record } }
  const found = verdict.url && !(lead.linkedin_url ?? '').trim() ? verdict.url : null
  await deps.db
    .update(leads)
    .set({
      enrichment,
      ...(found
        ? {
            linkedin_url: found,
            channels: computeChannels({ ...lead, linkedin_url: found }),
          }
        : {}),
      updated_at: now,
    })
    .where(eq(leads.id, lead.id))
  if (found) {
    await deps.db.insert(events).values({
      id: newId(),
      lead_id: lead.id,
      kind: 'note',
      detail: { linkedin_url: found, by: 'finder', title: verdict.title },
      at: now,
    })
  }
  await logActivity(
    'info',
    found ? 'linkedin_profile_found' : 'linkedin_profile_not_found',
    found ? { title: verdict.title } : { reason: verdict.reason },
    lead.id,
    deps.db,
  )
}

/** Look one lead up now. Counts against the monthly cap; saves the profile when found. */
export async function findLinkedInFor(deps: OutreachDeps, leadId: string): Promise<FindOutcome> {
  const lead = (await deps.db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]
  if (!lead) return { status: 'skipped', reason: 'lead not found' }
  if ((lead.linkedin_url ?? '').trim()) {
    return { status: 'found', linkedin_url: lead.linkedin_url! }
  }
  if (!deps.linkedInSearch) return { status: 'skipped', reason: 'no Claude key' }
  const person = personFor(lead)
  if (!person) return { status: 'skipped', reason: 'no person name, only a company' }
  if (!(await underCap(deps))) return { status: 'skipped', reason: 'monthly finder limit reached' }
  const rejected = finderRecord(lead)?.rejected ?? []
  await recordUsage(FINDER_USAGE, 1, lead.id, deps.now(), deps.db)
  const verdict = await searchProfile(deps.linkedInSearch, person, lead, rejected)
  await saveVerdict(deps, lead, verdict, rejected)
  return verdict.url
    ? { status: 'found', linkedin_url: verdict.url }
    : { status: 'not_found', reason: verdict.reason }
}

/**
 * Theo opened the profile and it is someone else: forget it, never pick it again, and skip their
 * waiting note. A later round may still find the right person.
 */
export async function rejectLinkedInProfile(deps: OutreachDeps, leadId: string): Promise<void> {
  const lead = (await deps.db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]
  if (!lead) return
  const url = profileUrl(lead.linkedin_url ?? '') ?? (lead.linkedin_url ?? '').trim()
  const prior = finderRecord(lead)
  const rejected = [...new Set([...(prior?.rejected ?? []), ...(url ? [url] : [])])]
  const now = deps.now().toISOString()
  const record: FinderRecord = {
    url: null,
    title: null,
    reason: 'Theo said the profile was someone else',
    tried_at: prior?.tried_at || now,
    rejected,
  }
  await deps.db
    .update(leads)
    .set({
      linkedin_url: null,
      channels: computeChannels({ ...lead, linkedin_url: null }),
      enrichment: { ...lead.enrichment, [FINDER_KEY]: { fetched_at: now, data: record } },
      updated_at: now,
    })
    .where(eq(leads.id, leadId))
  await deps.db.insert(events).values({
    id: newId(),
    lead_id: leadId,
    kind: 'note',
    detail: { linkedin_url: url, by: 'hand', wrong_person: true },
    at: now,
  })
  await logActivity('info', 'linkedin_profile_rejected', { url }, leadId, deps.db)
}
