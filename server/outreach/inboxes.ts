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

/** IPv4 ranges that are not the public internet (IANA special-purpose registry). */
const IPV4_BLOCKED: [number, number][] = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, cloud metadata
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // 6to4 relay
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 3], // multicast, reserved, broadcast (224.0.0.0 and up)
]

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0)
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
export function ipv6Groups(address: string): number[] | null {
  let a = address.toLowerCase()
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  // A dotted IPv4 tail (::ffff:10.0.0.1) becomes two hex groups.
  const lastColon = a.lastIndexOf(':')
  const tail = a.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null
    const n = ipv4ToInt(tail)
    a = `${a.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

/**
 * True for every address the app must not connect to. Fails closed: anything that does not parse,
 * and every IPv6 address outside global unicast (2000::/3), is blocked. That covers loopback,
 * private, link-local and site-local, unique-local, multicast, IPv4-mapped and NAT64 forms, plus
 * 6to4, Teredo and documentation ranges, which can carry or stand in for a private address.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const n = ipv4ToInt(ip)
    return IPV4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return (n & mask) >>> 0 === base
    })
  }
  if (kind !== 6) return true
  const g = ipv6Groups(ip)
  if (!g) return true
  const [g0 = 0, g1 = 0] = g
  if ((g0 & 0xe000) !== 0x2000) return true // not global unicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true // documentation
  if (g0 === 0x2001 && g1 === 0x0000) return true // Teredo
  if (g0 === 0x2002) return true // 6to4 carries an IPv4 address
  return false
}

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
  return { ok: true, address: addresses[0]! }
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
      } catch (err) {
        result.smtp.message = errorText(err)
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
