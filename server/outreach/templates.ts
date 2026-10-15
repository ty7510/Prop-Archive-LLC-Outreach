// Template rendering (spec section 10). Pure except for the optional AI opener and the warn log.
import type { Settings } from '../../shared/settings.ts'
import type { Channel, LeadTrigger } from '../../shared/types.ts'
import type { Lead, SequenceStep } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { badRequest } from '../lib/http.ts'
import { hasEmDash, slug, splitName } from '../lib/text.ts'
import type { Llm } from './deps.ts'

/** Zip to neighbourhood, the small map from the spec. */
export const NEIGHBORHOODS: Record<string, string> = {
  '19104': 'University City',
  '19121': 'Brewerytown/North Philly',
  '19122': 'Temple area',
  '19139': 'West Philly',
  '19143': 'Southwest Philly',
  '19146': 'Point Breeze/Graduate Hospital',
  '19125': 'Fishtown/Kensington',
}

/** Every variable a step body may use, in the order the UI lists them as chips. */
export const TEMPLATE_VARS = [
  'first_name',
  'full_name',
  'company',
  'property_count',
  'unit_count',
  'neighborhood',
  'trigger_line',
  'demo_link',
  'beta_link',
  'site_link',
  'sender_name',
  'unsubscribe_link',
  'ai_opener',
] as const
export type TemplateVar = (typeof TEMPLATE_VARS)[number]

export type TemplateVars = Record<string, string>

/** The neighbourhood for a lead: first known zip wins, else the city. */
export function neighborhoodFor(
  zips: string[] | null | undefined,
  mailingZip?: string | null,
): string {
  for (const z of zips ?? []) {
    const hit = NEIGHBORHOODS[z]
    if (hit) return hit
  }
  if (mailingZip && NEIGHBORHOODS[mailingZip]) return NEIGHBORHOODS[mailingZip] ?? ''
  return 'Philadelphia'
}

/** One plain sentence about the trigger, or '' when there is none. */
export function triggerLine(trigger: LeadTrigger | null | undefined): string {
  if (!trigger) return ''
  switch (trigger.type) {
    case 'new_license':
      return 'I saw a new rental license just went through for one of your places.'
    case 'recent_sale':
      return 'Congrats on the recent purchase.'
    default:
      return ''
  }
}

export interface LinkContext {
  baseUrl: string
  channel: Channel
  sequenceName: string
}

/** Channels where a person reads the link off paper or hears it: the plain address, nothing to track. */
export const PLAIN_LINK_CHANNELS: readonly Channel[] = ['mail', 'call']

/** The settings' own short addresses, for postcards and call scripts. */
export function plainLinks(settings: Pick<Settings, 'site_url' | 'demo_url' | 'beta_url'>): {
  demo_link: string
  beta_link: string
  site_link: string
} {
  // Read off paper or out loud: "proparchive.app/demo", without the https://.
  const bare = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return {
    demo_link: bare(settings.demo_url),
    beta_link: bare(settings.beta_url || settings.site_url),
    site_link: bare(settings.site_url),
  }
}

/** Tracked links for a lead. The channel and sequence ride along so the redirect can tag the click. */
export function trackedLinks(
  lead: Pick<Lead, 'unsubscribe_token'>,
  ctx: LinkContext,
): { demo_link: string; beta_link: string; site_link: string; unsubscribe_link: string } {
  const q = `?c=${encodeURIComponent(ctx.channel)}&s=${encodeURIComponent(slug(ctx.sequenceName))}`
  const base = `${ctx.baseUrl}/r/${lead.unsubscribe_token}`
  return {
    demo_link: `${base}/demo${q}`,
    beta_link: `${base}/beta${q}`,
    site_link: `${base}/site${q}`,
    unsubscribe_link: `${ctx.baseUrl}/u/${lead.unsubscribe_token}`,
  }
}

/** The variable values for one lead. Everything is a string; unknown facts are ''. */
export function buildVars(lead: Lead, settings: Settings, ctx: LinkContext): TemplateVars {
  const split = splitName(lead.full_name)
  // Records give "Jay M" or "Thomas M.": the greeting drops the middle initial.
  const first = ((lead.first_name ?? '').trim() || split.first_name).replace(/\s+[A-Za-z]\.?$/, '')
  const full = (lead.full_name ?? '').trim() || [first, lead.last_name ?? ''].join(' ').trim()
  return {
    first_name: first || 'there',
    full_name: full || lead.company || '',
    company: lead.company ?? '',
    property_count: lead.property_count > 0 ? String(lead.property_count) : '',
    unit_count: lead.unit_count > 0 ? String(lead.unit_count) : '',
    neighborhood: neighborhoodFor(lead.zips, lead.mailing_zip),
    trigger_line: triggerLine(lead.trigger),
    sender_name: settings.from_name,
    physical_address: settings.physical_address,
    ...trackedLinks(lead, ctx),
    ...(PLAIN_LINK_CHANNELS.includes(ctx.channel) ? plainLinks(settings) : {}),
  }
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export interface RenderResult {
  text: string
  /** Variable names that were not known. Rendered as '' and logged as a warn by the caller. */
  missing: string[]
}

/** Replace {{vars}}. Unknown names render empty and are reported. Tidies blank lines left behind. */
export function renderTemplate(template: string, vars: TemplateVars): RenderResult {
  const missing = new Set<string>()
  const text = template.replace(VAR_RE, (_m, name: string) => {
    if (name in vars) return vars[name] ?? ''
    missing.add(name)
    return ''
  })
  return { text: tidy(text), missing: [...missing] }
}

/** Collapse three or more newlines into two and trim trailing spaces per line. */
export function tidy(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** CAN-SPAM footer appended to every email. */
export function emailFooter(vars: TemplateVars): string {
  return `\n\n${vars.sender_name ?? ''}, Prop Archive LLC\n${vars.physical_address ?? ''}\nThis email is an offer from Prop Archive.\nNo more emails: ${vars.unsubscribe_link ?? ''}`
}

/** Throw a 400 when any step text holds an em-dash. Called before a sequence is saved. */
export function assertNoEmDash(
  steps: Array<{ subject?: string | null; body: string; notes?: string | null }>,
  name?: string | null,
  description?: string | null,
): void {
  if (hasEmDash(name) || hasEmDash(description)) {
    throw badRequest(
      'Please replace the em-dash (the long dash) with a comma or a hyphen',
      'EM_DASH',
    )
  }
  steps.forEach((s, i) => {
    if (hasEmDash(s.subject) || hasEmDash(s.body) || hasEmDash(s.notes)) {
      throw badRequest(
        `Step ${i + 1} has an em-dash (the long dash). Please use a comma or a hyphen instead`,
        'EM_DASH',
      )
    }
  })
}

const AI_OPENER_SYSTEM =
  'You write one short, plain, friendly opening sentence for a cold email to a Philadelphia landlord. ' +
  'Use only the facts given. Never invent names, numbers, places or events. The facts are for choosing ' +
  'a situation an owner like this runs into; never state them back as something you know about the ' +
  'reader (no counts, addresses, licenses, purchases). No greeting, no sign off, ' +
  'no exclamation marks, no em-dash character. Return the sentence only.'

/** One grounded sentence, or '' when there is no model or it fails. */
export async function aiOpener(vars: TemplateVars, llm: Llm | null): Promise<string> {
  if (!llm) return ''
  const facts = [
    vars.property_count ? `property count: ${vars.property_count}` : '',
    vars.unit_count ? `unit count: ${vars.unit_count}` : '',
    vars.neighborhood ? `neighborhood: ${vars.neighborhood}` : '',
    vars.trigger_line ? `recent event: ${vars.trigger_line}` : '',
    vars.company ? `company: ${vars.company}` : '',
  ].filter(Boolean)
  if (facts.length === 0) return ''
  try {
    const out = await llm.text(`Facts:\n${facts.join('\n')}\n\nWrite the sentence.`, {
      system: AI_OPENER_SYSTEM,
      maxTokens: 60,
    })
    if (!out) return ''
    const line = out.split('\n')[0]?.trim() ?? ''
    return hasEmDash(line) ? line.replace(/—/g, ',') : line
  } catch {
    return ''
  }
}

export interface RenderedBody {
  subject: string | null
  body: string
  missing: string[]
}

/**
 * Render one step for one lead. Resolves {{ai_opener}} when present (and a model exists),
 * appends the CAN-SPAM footer for email, and logs a warn for unknown variables.
 */
export async function renderStepForLead(
  step: Pick<SequenceStep, 'subject' | 'body' | 'channel'>,
  lead: Lead,
  settings: Settings,
  ctx: LinkContext,
  llm: Llm | null,
  opts: { withFooter?: boolean; logWarn?: boolean } = {},
): Promise<RenderedBody> {
  const vars = buildVars(lead, settings, ctx)
  if (step.body.includes('{{ai_opener}}')) vars.ai_opener = await aiOpener(vars, llm)
  else vars.ai_opener = ''

  const body = renderTemplate(step.body, vars)
  const subject = step.subject ? renderTemplate(step.subject, vars) : null
  const missing = [...new Set([...body.missing, ...(subject?.missing ?? [])])]
  if (missing.length > 0 && opts.logWarn !== false) {
    await logActivity('warn', 'template_missing_var', { vars: missing }, lead.id)
  }
  const withFooter = opts.withFooter ?? step.channel === 'email'
  return {
    subject: subject ? subject.text : null,
    body: withFooter ? body.text + emailFooter(vars) : body.text,
    missing,
  }
}

/** A made-up lead for previews when no real one is picked. Labelled as an example in the name. */
export function sampleLead(now: Date = new Date()): Lead {
  const iso = now.toISOString()
  return {
    id: 'sample-lead',
    created_at: iso,
    updated_at: iso,
    source: 'manual',
    status: 'enriched',
    persona: 'ray',
    icp_score: 80,
    owner_kind: 'person',
    full_name: 'Ray Example',
    first_name: 'Ray',
    last_name: 'Example',
    company: 'Example Properties LLC',
    email: 'ray@example.com',
    email_status: 'valid',
    phone: '2155550100',
    phone_type: 'mobile',
    linkedin_url: 'https://www.linkedin.com/in/example',
    instagram_url: null,
    facebook_url: null,
    website: null,
    mailing_street: '1234 Example St',
    mailing_city: 'Philadelphia',
    mailing_state: 'PA',
    mailing_zip: '19146',
    mailing_verified: false,
    property_count: 9,
    unit_count: 14,
    zips: ['19146', '19143'],
    trigger: { type: 'new_license', date: iso.slice(0, 10) },
    channels: { email: true, mail: true, linkedin: true, instagram: false, call: true },
    enrichment: {},
    tags: ['sample'],
    notes: null,
    do_not_contact: false,
    unsubscribe_token: 'sample-token',
    last_contacted_at: null,
    last_replied_at: null,
    next_action_at: null,
    dedupe_key: null,
  }
}
