// Unsubscribe and tracked redirects (spec section 6, Public). No auth; used from emails.
import { desc, eq } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import { CHANNELS, type Channel } from '../../shared/types.ts'
import { events, leads, messages, type Lead } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import { slug } from '../lib/text.ts'
import type { OutreachDeps } from './deps.ts'
import { stopLead } from './enroll.ts'
import { addSuppression } from './suppression.ts'

export const REDIRECT_DESTS = ['demo', 'beta', 'site'] as const
export type RedirectDest = (typeof REDIRECT_DESTS)[number]

export function isRedirectDest(v: string): v is RedirectDest {
  return (REDIRECT_DESTS as readonly string[]).includes(v)
}

export async function leadByToken(deps: OutreachDeps, token: string): Promise<Lead | null> {
  if (!token || token.length > 64) return null
  const rows = await deps.db.select().from(leads).where(eq(leads.unsubscribe_token, token)).limit(1)
  return rows[0] ?? null
}

/**
 * One-click unsubscribe: suppression row for the email (and the mailing address when there is no
 * email), stop every enrollment, lead status unsubscribed, an event. Idempotent.
 * Returns false for an unknown token.
 */
export async function unsubscribeByToken(deps: OutreachDeps, token: string): Promise<boolean> {
  const lead = await leadByToken(deps, token)
  if (!lead) return false
  const { db } = deps
  const now = deps.now().toISOString()
  if (lead.email) await addSuppression(db, 'email', lead.email, 'unsubscribe link')
  else if (lead.mailing_street) {
    await addSuppression(
      db,
      'address',
      `${lead.mailing_street}|${lead.mailing_zip ?? ''}`,
      'unsubscribe link',
    )
  }
  await stopLead(deps, lead.id, 'unsubscribed')
  if (lead.status !== 'unsubscribed') {
    await db
      .update(leads)
      .set({ status: 'unsubscribed', updated_at: now, next_action_at: null })
      .where(eq(leads.id, lead.id))
    await db.insert(events).values({
      id: newId(),
      lead_id: lead.id,
      kind: 'unsubscribe',
      detail: { via: 'link' },
      at: now,
    })
    await logActivity('info', 'unsubscribe', { via: 'link', email: lead.email }, lead.id, db)
  }
  return true
}

export interface RedirectInput {
  token: string
  dest: string
  /** From the link's ?c= and ?s= query, when present. */
  channel?: string | undefined
  sequence?: string | undefined
}

/** Where a tracked link goes: the destination with utm tags, plus the lead id when known. */
export async function resolveRedirect(
  deps: OutreachDeps,
  input: RedirectInput,
): Promise<{ url: string; tracked: boolean } | null> {
  if (!isRedirectDest(input.dest)) return null
  const settings = await getSettings(deps.db)
  const lead = await leadByToken(deps, input.token)
  const target = destUrl(settings, input.dest)
  if (!lead) {
    return {
      url: withUtm(target, { channel: 'email', sequence: '', leadId: null }),
      tracked: false,
    }
  }
  let channel: Channel = (CHANNELS as readonly string[]).includes(input.channel ?? '')
    ? (input.channel as Channel)
    : 'email'
  let sequence = input.sequence ? slug(input.sequence) : ''
  if (!input.channel || !input.sequence) {
    const last = await deps.db
      .select({ channel: messages.channel })
      .from(messages)
      .where(eq(messages.lead_id, lead.id))
      .orderBy(desc(messages.created_at))
      .limit(1)
    if (last[0] && !input.channel) channel = last[0].channel
    if (!sequence) sequence = 'outreach'
  }
  await deps.db.insert(events).values({
    id: newId(),
    lead_id: lead.id,
    kind: 'click',
    detail: { dest: input.dest, channel, sequence },
    at: deps.now().toISOString(),
  })
  return { url: withUtm(target, { channel, sequence, leadId: lead.id }), tracked: true }
}

export function destUrl(settings: Settings, dest: RedirectDest): string {
  switch (dest) {
    case 'demo':
      return settings.demo_url
    case 'beta':
      return settings.beta_url || settings.site_url
    case 'site':
      return settings.site_url
  }
}

export function withUtm(
  base: string,
  tags: { channel: string; sequence: string; leadId: string | null },
): string {
  const url = new URL(base)
  url.searchParams.set('utm_source', 'outreach')
  url.searchParams.set('utm_medium', tags.channel)
  url.searchParams.set('utm_campaign', tags.sequence || 'outreach')
  if (tags.leadId) url.searchParams.set('ref', tags.leadId)
  return url.toString()
}

/** The small page shown after unsubscribing. Plain words, big text, no scripts. */
export function unsubscribePage(ok: boolean, siteUrl: string): string {
  const title = ok ? 'You are unsubscribed' : 'This link is not valid'
  const body = ok
    ? 'You will not get more email from us. Sorry for the bother.'
    : 'We could not find who this link belongs to. If you want to stop getting email, reply to the message you got and say so.'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: #f7f7f5; color: #222; }
  main { max-width: 32rem; margin: 10vh auto; padding: 2rem 1.25rem; background: #fff; border-radius: 12px; }
  h1 { font-size: 1.75rem; margin: 0 0 0.75rem; }
  p { font-size: 1.125rem; line-height: 1.5; margin: 0 0 1rem; }
  a { color: #1d4ed8; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${body}</p>
  <p><a href="${siteUrl}">Prop Archive</a></p>
</main>
</body>
</html>`
}
