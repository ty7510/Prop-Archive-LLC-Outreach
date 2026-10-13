// Warmed sending inboxes (settings.sending_inboxes): rotation under each inbox's daily limit,
// per-inbox counts, and the password mask the settings API puts on every response.
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq, gte, like, or } from 'drizzle-orm'
import { SECRET_MASK, type SendingInbox, type Settings } from '../../shared/settings.ts'
import type { InboxTestResult } from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import { messages } from '../db/schema.ts'
import { isPrivateAddress } from '../lib/net.ts'
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

/** Least time between two emails from one inbox, so a batch never goes out in one burst. */
export const MIN_GAP_MS = 4 * 60_000
/** After the server refuses a login, the same password is tried again after this long. */
export const LOGIN_RETRY_MS = 60 * 60_000

const LOGIN_REFUSED_RE =
  /invalid login|username and password not accepted|badcredentials|application-specific password required|authenticationfailed|invalid credentials|\b53[45][- ]5\.7\.\d/i

/** The mail server refused the login. Nothing was handed over, so trying again later is safe. */
export function isLoginRefused(err: unknown): boolean {
  if (err === null || err === undefined) return false
  if (typeof err === 'object') {
    const e = err as { code?: unknown; responseCode?: unknown; authenticationFailed?: unknown }
    if (e.authenticationFailed === true || e.code === 'EAUTH') return true
    if (e.responseCode === 534 || e.responseCode === 535) return true
  }
  return LOGIN_REFUSED_RE.test(mailErrorText(err))
}

/** What Theo does when Gmail refuses the password. Shown on Go and in Activity. */
export function loginFix(email: string): string {
  return `Gmail refused the password for ${email}. Make a new app password at myaccount.google.com/apppasswords (2-Step Verification must be on), paste it under Sending inboxes in Settings and press Test. The waiting emails then go out by themselves.`
}

interface LoginProblem {
  at: number
  fingerprint: string
  error: string
}

// One server process sends, so memory is enough: a restart only means one more try.
const loginProblems = new Map<string, LoginProblem>()

function fingerprint(inbox: SendingInbox): string {
  return createHash('sha256')
    .update([inbox.smtp_host, inbox.smtp_port, inbox.smtp_user, inbox.smtp_pass].join('\n'))
    .digest('hex')
}

/** For tests: forget every refused login. */
export function resetLoginProblems(): void {
  loginProblems.clear()
}

/** The last refused login for this inbox's current password, or null. A new password clears it. */
export function loginProblem(inbox: SendingInbox): LoginProblem | null {
  const p = loginProblems.get(inbox.id)
  if (!p) return null
  if (p.fingerprint !== fingerprint(inbox)) {
    loginProblems.delete(inbox.id)
    return null
  }
  return p
}

/** True while the same password was refused less than LOGIN_RETRY_MS ago: do not ask again yet. */
export function loginBlocked(inbox: SendingInbox, now: Date): boolean {
  const p = loginProblem(inbox)
  return p !== null && now.getTime() - p.at < LOGIN_RETRY_MS
}

/** Remember a refused login. True when this is news (log it once, not once per email). */
export function noteLoginRefused(inbox: SendingInbox, now: Date, error: string): boolean {
  const known = loginProblem(inbox) !== null
  loginProblems.set(inbox.id, { at: now.getTime(), fingerprint: fingerprint(inbox), error })
  return !known
}

export function noteLoginWorked(inbox: SendingInbox): void {
  loginProblems.delete(inbox.id)
}

// The last reply check of each inbox that failed, by its last-sync key. Follow-up emails wait
// while a reply may be sitting unread, so nobody who answered gets another email.
const replySyncProblems = new Map<string, { label: string; at: number; error: string }>()

export function noteReplySyncFailed(key: string, label: string, now: Date, error: string): void {
  replySyncProblems.set(key, { label, at: now.getTime(), error })
}

export function noteReplySyncWorked(key: string): void {
  replySyncProblems.delete(key)
}

export function replySyncFailures(): { label: string; at: number; error: string }[] {
  return [...replySyncProblems.values()]
}

/** Drop failures of inboxes that are no longer read (removed, or IMAP cleared). */
export function keepReplySyncProblems(keys: readonly string[]): void {
  for (const key of [...replySyncProblems.keys()]) {
    if (!keys.includes(key)) replySyncProblems.delete(key)
  }
}

/** For tests: forget every failed reply check. */
export function resetReplySyncProblems(): void {
  replySyncProblems.clear()
}

export interface InboxDay {
  /** Emails each inbox has sent (or is sending) today, keyed by inboxProvider(). */
  counts: Map<string, number>
  /** When each inbox sent its latest email, in ms, keyed by inboxProvider(). */
  lastSentAt: Map<string, number>
}

/** Today's sends per inbox: how many, and when the latest went. */
export async function inboxDay(db: Db, settings: Settings, now: Date): Promise<InboxDay> {
  const dayStart = startOfDayInTz(now, settings.send_window.tz).toISOString()
  const rows = await db
    .select({ provider: messages.provider, sent_at: messages.sent_at })
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
  const lastSentAt = new Map<string, number>()
  for (const r of rows) {
    if (!r.provider) continue
    counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1)
    const at = r.sent_at ? Date.parse(r.sent_at) : NaN
    if (Number.isFinite(at) && at > (lastSentAt.get(r.provider) ?? 0))
      lastSentAt.set(r.provider, at)
  }
  return { counts, lastSentAt }
}

/** Emails each inbox has sent (or is sending) today, keyed by inboxProvider(). */
export async function sentTodayByInbox(
  db: Db,
  settings: Settings,
  now: Date,
): Promise<Map<string, number>> {
  return (await inboxDay(db, settings, now)).counts
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

/**
 * The inbox that may send an email right now: usable, its login not refused lately, under its
 * daily limit, and MIN_GAP_MS past its last email. null when none may send at this moment.
 */
export function inboxForNow(
  inboxes: readonly SendingInbox[],
  day: InboxDay,
  now: Date,
): SendingInbox | null {
  const ready = inboxes.filter(
    (i) =>
      canSend(i) &&
      !loginBlocked(i, now) &&
      now.getTime() - (day.lastSentAt.get(inboxProvider(i)) ?? 0) >= MIN_GAP_MS,
  )
  return pickInbox(ready, day.counts)
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

// The public-address check is shared with the research page opener.
export { ipv6Groups, isPrivateAddress } from '../lib/net.ts'

export type MailHostCheck = { ok: true; address: string } | { ok: false; problem: string }

/**
 * Resolve a mail server name and check every address it has. The caller connects to the address
 * returned here (never to the name again), so a DNS answer cannot change between the check and the
 * connection. Only names that resolve to public addresses only pass.
 */
export async function resolveMailHost(deps: OutreachDeps, host: string): Promise<MailHostCheck> {
  if (!host) return { ok: false, problem: 'No server set' }
  if (isIP(host)) return { ok: false, problem: 'Use the mail server name, not an IP address' }
  let addresses: string[]
  try {
    addresses = await deps.lookupHost(host)
  } catch {
    return { ok: false, problem: `${host} was not found. Check the server name` }
  }
  if (addresses.length === 0) {
    return { ok: false, problem: `${host} was not found. Check the server name` }
  }
  if (addresses.some(isPrivateAddress)) {
    return { ok: false, problem: `${host} points at a private network address` }
  }
  // Replit has no IPv6 route (connecting over IPv6 fails with EAFNOSUPPORT), so take IPv4 when there is one.
  return { ok: true, address: addresses.find((a) => isIP(a) === 4) ?? addresses[0]! }
}

/** A mail server error in the server's own words: imapflow keeps them in responseText. */
export function mailErrorText(err: unknown): string {
  const detail = (typeof err === 'object' && err !== null ? err : {}) as { responseText?: unknown }
  const base = err instanceof Error ? err.message : String(err)
  return typeof detail.responseText === 'string' && detail.responseText
    ? `${base}: ${detail.responseText}`
    : base
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
    const smtp = await resolveMailHost(deps, inbox.smtp_host)
    if (!smtp.ok) result.smtp.message = smtp.problem
    else
      try {
        const mailer = deps.smtpForInbox(inbox, smtp.address)
        if (mailer.verify) await mailer.verify()
        result.smtp = { ok: true, message: `Sending works from ${inbox.email}` }
        noteLoginWorked(inbox) // waiting emails go on the next round, no restart needed
      } catch (err) {
        result.smtp.message = errorText(err)
        if (isLoginRefused(err)) noteLoginRefused(inbox, deps.now(), mailErrorText(err))
      }
  }
  if (!canRead(inbox)) return result
  const imap = await resolveMailHost(deps, inbox.imap_host)
  if (!imap.ok) {
    result.imap = { ok: false, message: imap.problem }
  } else {
    const client = deps.imapForInbox(inbox, imap.address)
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
