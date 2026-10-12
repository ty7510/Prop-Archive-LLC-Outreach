// Warmed sending inboxes (settings.sending_inboxes): rotation under each inbox's daily limit,
// per-inbox counts, and the password mask the settings API puts on every response.
import { and, eq, gte, like, or } from 'drizzle-orm'
import { SECRET_MASK, type SendingInbox, type Settings } from '../../shared/settings.ts'
import type { InboxTestResult } from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import { messages } from '../db/schema.ts'
import { startOfDayInTz } from '../lib/time.ts'
import type { OutreachDeps } from './deps.ts'

/** messages.provider for mail that went out through one inbox, so each inbox's count is exact. */
export function inboxProvider(inbox: Pick<SendingInbox, 'email'>): string {
  return `smtp:${inbox.email.toLowerCase()}`
}

/** An inbox that can send: switched on, with a server, a login and a password. */
export function canSend(inbox: SendingInbox): boolean {
  return Boolean(inbox.active && inbox.smtp_host && inbox.smtp_user && inbox.smtp_pass)
}

/** An inbox whose replies the app can read. */
export function canRead(inbox: SendingInbox): boolean {
  return Boolean(inbox.imap_host && inbox.smtp_user && inbox.smtp_pass)
}

/** Emails each inbox has sent (or is sending) today, keyed by inboxProvider(). */
export async function sentTodayByInbox(
  db: Db,
  settings: Settings,
  now: Date,
): Promise<Map<string, number>> {
  const dayStart = startOfDayInTz(now, settings.send_window.tz).toISOString()
  const rows = await db
    .select({ provider: messages.provider })
    .from(messages)
    .where(
      and(
        eq(messages.direction, 'out'),
        eq(messages.channel, 'email'),
        like(messages.provider, 'smtp:%'),
        or(gte(messages.sent_at, dayStart), gte(messages.created_at, dayStart)),
      ),
    )
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.provider) counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1)
  }
  return counts
}

/**
 * The inbox the next email goes from: the usable inbox with the fewest sends today, still under
 * its daily limit. null when there are inboxes but every one is full or unusable.
 */
export function pickInbox(
  inboxes: readonly SendingInbox[],
  sentToday: ReadonlyMap<string, number>,
): SendingInbox | null {
  let best: SendingInbox | null = null
  let bestCount = Infinity
  for (const inbox of inboxes) {
    if (!canSend(inbox)) continue
    const count = sentToday.get(inboxProvider(inbox)) ?? 0
    if (count >= inbox.daily_limit) continue
    if (count < bestCount) {
      best = inbox
      bestCount = count
    }
  }
  return best
}

/** Settings as the API shows them: inbox passwords replaced by SECRET_MASK (or '' when unset). */
export function maskSettings(settings: Settings): Settings {
  return {
    ...settings,
    sending_inboxes: settings.sending_inboxes.map((i) => ({
      ...i,
      smtp_pass: i.smtp_pass ? SECRET_MASK : '',
    })),
  }
}

/**
 * A PUT carries inboxes as the API showed them. A masked or blank password means "keep the one
 * stored for this inbox id"; anything else replaces it.
 */
export function restoreInboxSecrets(current: readonly SendingInbox[], incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming
  const stored = new Map(current.map((i) => [i.id, i.smtp_pass]))
  return incoming.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return item
    const inbox = item as Record<string, unknown>
    const pass = inbox.smtp_pass
    if (
      (pass === SECRET_MASK || pass === '' || pass === undefined) &&
      typeof inbox.id === 'string'
    ) {
      return { ...inbox, smtp_pass: stored.get(inbox.id) ?? '' }
    }
    return inbox
  })
}

function errorText(err: unknown): string {
  // imapflow puts the server's own words in responseText ("Command failed" is all the message says).
  const detail = err as { responseText?: unknown; authenticationFailed?: unknown }
  const base = err instanceof Error ? err.message : String(err)
  const msg =
    typeof detail.responseText === 'string' && detail.responseText ? detail.responseText : base
  if (detail.authenticationFailed === true || /auth|credential|password|535|534|login/i.test(msg)) {
    return `Login refused: ${msg}. Use an app password, not your normal password.`
  }
  return msg
}

/** Log in to the inbox's SMTP and IMAP servers without sending anything. */
export async function testInbox(deps: OutreachDeps, inbox: SendingInbox): Promise<InboxTestResult> {
  const result: InboxTestResult = {
    smtp: { ok: false, message: '' },
    imap: { ok: false, message: 'No IMAP server, so replies to this inbox are not read' },
  }
  if (!inbox.smtp_host || !inbox.smtp_user || !inbox.smtp_pass) {
    result.smtp.message = 'Fill in the SMTP server, login and app password'
  } else {
    try {
      const mailer = deps.smtpForInbox(inbox)
      if (mailer.verify) await mailer.verify()
      result.smtp = { ok: true, message: `Sending works from ${inbox.email}` }
    } catch (err) {
      result.smtp.message = errorText(err)
    }
  }
  if (canRead(inbox)) {
    const client = deps.imapForInbox(inbox)
    try {
      await client.connect()
      await client.mailboxOpen('INBOX')
      result.imap = { ok: true, message: 'Replies will be read from this inbox' }
    } catch (err) {
      result.imap = { ok: false, message: errorText(err) }
    } finally {
      await client.logout().catch(() => undefined)
    }
  }
  return result
}
