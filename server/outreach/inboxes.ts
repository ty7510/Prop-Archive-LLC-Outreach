// Warmed sending inboxes (settings.sending_inboxes): rotation under each inbox's daily limit,
// per-inbox counts, and the password mask the settings API puts on every response.
import { isIP } from 'node:net'
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

/** Where a stored password gets sent. Change any of these and the password must be typed again. */
const CONNECTION_FIELDS = ['smtp_host', 'smtp_port', 'smtp_user', 'imap_host', 'imap_port'] as const

/**
 * A PUT (or a Test) carries inboxes as the API showed them. A masked or blank password means
 * "keep the one stored for this inbox id", but only while the servers and login are unchanged:
 * otherwise the stored password could be sent to a server it was never meant for.
 */
export function restoreInboxSecrets(current: readonly SendingInbox[], incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming
  const stored = new Map(current.map((i) => [i.id, i]))
  return incoming.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return item
    const inbox = item as Record<string, unknown>
    const pass = inbox.smtp_pass
    if (pass !== SECRET_MASK && pass !== '' && pass !== undefined) return inbox
    const prev = typeof inbox.id === 'string' ? stored.get(inbox.id) : undefined
    const sameServers =
      prev !== undefined &&
      CONNECTION_FIELDS.every(
        (f) =>
          String(inbox[f] ?? '')
            .trim()
            .toLowerCase() === String(prev[f]).toLowerCase(),
      )
    return { ...inbox, smtp_pass: sameServers ? prev.smtp_pass : '' }
  })
}

/** Loopback, private, link-local, carrier-grade NAT and multicast addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase()
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7))
  if (isIP(v) === 4) {
    const [a = 0, b = 0] = v.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  return (
    v === '::' ||
    v === '::1' ||
    v.startsWith('fc') ||
    v.startsWith('fd') ||
    v.startsWith('fe8') ||
    v.startsWith('fe9') ||
    v.startsWith('fea') ||
    v.startsWith('feb') ||
    v.startsWith('ff')
  )
}

/**
 * Why the app must not connect to this mail server, or null when it may: the name must resolve,
 * and only to public addresses, so an inbox can never point the server into a private network.
 */
export async function mailHostProblem(deps: OutreachDeps, host: string): Promise<string | null> {
  if (!host) return 'No server set'
  if (isIP(host)) return 'Use the mail server name, not an IP address'
  let addresses: string[]
  try {
    addresses = await deps.lookupHost(host)
  } catch {
    return `${host} was not found. Check the server name`
  }
  if (addresses.length === 0) return `${host} was not found. Check the server name`
  if (addresses.some(isPrivateAddress)) return `${host} points at a private network address`
  return null
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
  const smtpProblem = inbox.smtp_host ? await mailHostProblem(deps, inbox.smtp_host) : null
  if (!inbox.smtp_host || !inbox.smtp_user || !inbox.smtp_pass) {
    result.smtp.message = 'Fill in the SMTP server, login and app password'
  } else if (smtpProblem) {
    result.smtp.message = smtpProblem
  } else {
    try {
      const mailer = deps.smtpForInbox(inbox)
      if (mailer.verify) await mailer.verify()
      result.smtp = { ok: true, message: `Sending works from ${inbox.email}` }
    } catch (err) {
      result.smtp.message = errorText(err)
    }
  }
  const imapProblem = canRead(inbox) ? await mailHostProblem(deps, inbox.imap_host) : null
  if (imapProblem) {
    result.imap = { ok: false, message: imapProblem }
  } else if (canRead(inbox)) {
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
