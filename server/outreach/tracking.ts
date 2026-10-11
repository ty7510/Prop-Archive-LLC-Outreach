// Unsubscribe and tracked redirects (spec section 6, Public). No auth; used from emails.
import { and, desc, eq, gte } from 'drizzle-orm'
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

/** Repeat clicks on the same link inside this window are one click. */
export const CLICK_DEDUPE_MS = 10 * 60_000
export type RedirectDest = (typeof REDIRECT_DESTS)[number]

export function isRedirectDest(v: string): v is RedirectDest {
  return (REDIRECT_DESTS as readonly string[]).includes(v)
}

/** The one-click unsubscribe page, found; true when the lead is already unsubscribed. */
export async function unsubscribeState(
  deps: OutreachDeps,
  token: string,
): Promise<'unknown' | 'pending' | 'done'> {
  const lead = await leadByToken(deps, token)
  if (!lead) return 'unknown'
  return lead.status === 'unsubscribed' ? 'done' : 'pending'
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
  // One click per lead and destination per CLICK_DEDUPE_MS: a replayed link does not pile up rows.
  const since = new Date(deps.now().getTime() - CLICK_DEDUPE_MS).toISOString()
  const recent = await deps.db
    .select({ id: events.id, detail: events.detail })
    .from(events)
    .where(and(eq(events.lead_id, lead.id), eq(events.kind, 'click'), gte(events.at, since)))
  const duplicate = recent.some((e) => (e.detail as { dest?: string } | null)?.dest === input.dest)
  if (!duplicate) {
    await deps.db.insert(events).values({
      id: newId(),
      lead_id: lead.id,
      kind: 'click',
      detail: { dest: input.dest, channel, sequence },
      at: deps.now().toISOString(),
    })
  }
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type UnsubscribePageKind = 'confirm' | 'done' | 'not_found'

/**
 * The small public page. `confirm` (a GET from a person or a link scanner) only shows one button
 * that POSTs back; `done` is shown after the POST; `not_found` for an unknown token.
 * Plain words, big text, no scripts.
 */
export function unsubscribePage(kind: UnsubscribePageKind | boolean, siteUrl: string): string {
  const k: UnsubscribePageKind = kind === true ? 'done' : kind === false ? 'not_found' : kind
  const title =
    k === 'done'
      ? 'You are unsubscribed'
      : k === 'confirm'
        ? 'Stop emails from Prop Archive?'
        : 'This link is not valid'
  const body =
    k === 'done'
      ? 'You will not get more email from us. Sorry for the bother.'
      : k === 'confirm'
        ? 'Press the button and we will not email you again.'
        : 'We could not find who this link belongs to. If you want to stop getting email, reply to the message you got and say so.'
  const form =
    k === 'confirm'
      ? `\n  <form method="post"><button type="submit">Stop emails to me</button></form>`
      : ''
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
  button { font: inherit; font-size: 1.125rem; padding: 0.875rem 1.25rem; min-height: 3rem; border: 0; border-radius: 10px; background: #1d4ed8; color: #fff; margin: 0 0 1rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>${form}
  <p><a href="${escapeHtml(siteUrl)}">Prop Archive</a></p>
</main>
</body>
</html>`
}
