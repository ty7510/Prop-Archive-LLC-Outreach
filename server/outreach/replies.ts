// Inbox sync and reply handling (spec section 10, Replies). The system never auto-replies.
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import type { Settings } from '../../shared/settings.ts'
import {
  REPLY_CLASSIFICATIONS,
  type LeadStatus,
  type ReplyClassification,
} from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import { events, leads, messages, settings as settingsTable, type Lead } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import { normaliseEmail } from '../lib/text.ts'
import type { ImapMessage, Llm, OutreachDeps } from './deps.ts'
import { sendEmail, pickEmailProvider } from './email.ts'
import { stopLead } from './enroll.ts'
import { addSuppression } from './suppression.ts'

const LAST_SYNC_KEY = '_replies_synced_at'

// ---------- classification ----------

const UNSUB_RE =
  /\b(unsubscribe|opt[\s-]?out|remove me|take me off|stop (emailing|contacting|sending)|do not (email|contact)|no more emails?)\b|^\s*stop\s*$/im
const BOUNCE_RE =
  /mailer-daemon|postmaster|undeliverable|delivery (status notification|failure|has failed)|could not be delivered|address not found|mailbox (unavailable|full|not found)|user unknown|returned mail/i
const BOOKED_RE =
  /\b(booked|scheduled|see you (on|at)|confirmed (the|our|my) (call|demo|meeting)|just signed up|joined the beta)\b/i
const INTEREST_WORDS =
  /\b(book|demo|call|meeting|chat|talk|interested|sounds good|let'?s do it|sign me up|tell me more|how (much|does)|what does it cost|yes please|sure)\b/i
const NEGATIVE_WORDS =
  /\b(not interested|no thanks|no thank you|don'?t need|not (for|right for) (me|us)|already (have|use)|please don'?t|not looking|pass)\b/i
const NOT_NOW_RE =
  /\b(not (right )?now|later|next (month|quarter|year)|busy|circle back|reach out (in|again)|check back|maybe (later|in)|in a few (weeks|months))\b/i

/** Rule-based fallback classifier. Order matters: bounce, unsubscribe, booked, no, not now, interest. */
export function classifyByKeywords(
  subject: string | null | undefined,
  text: string | null | undefined,
  fromAddress?: string | null,
): ReplyClassification {
  const s = `${subject ?? ''}\n${text ?? ''}`
  if (BOUNCE_RE.test(s) || BOUNCE_RE.test(fromAddress ?? '')) return 'bounce'
  if (UNSUB_RE.test(s)) return 'unsubscribe'
  if (BOOKED_RE.test(s)) return 'booked'
  if (NEGATIVE_WORDS.test(s)) return 'not_interested'
  if (NOT_NOW_RE.test(s)) return 'not_now'
  if (INTEREST_WORDS.test(s)) return 'interested'
  return 'other'
}

const ClassificationSchema = z.object({
  classification: z.enum(REPLY_CLASSIFICATIONS),
})

const CLASSIFY_SYSTEM =
  'You sort replies to a cold email sent to Philadelphia landlords about Prop Archive, a tool that ' +
  'keeps their property paperwork in one place. Pick exactly one label: interested (wants a demo, ' +
  'a call, more info, or asks a question), booked (says they already booked or signed up), not_now ' +
  '(maybe later), not_interested (clear no), unsubscribe (asks to stop or be removed), bounce ' +
  '(an automatic delivery failure), other (anything else, including out of office).'

/** Claude first (structured output, low effort), keyword rules when there is no model or it fails. */
export async function classifyReply(
  llm: Llm | null,
  subject: string | null | undefined,
  text: string | null | undefined,
  fromAddress?: string | null,
): Promise<ReplyClassification> {
  const fallback = classifyByKeywords(subject, text, fromAddress)
  if (!llm) return fallback
  if (fallback === 'bounce') return fallback
  try {
    const out = await llm.structured(
      `Subject: ${subject ?? ''}\n\nReply:\n${(text ?? '').slice(0, 3000)}`,
      ClassificationSchema,
      { system: CLASSIFY_SYSTEM, maxTokens: 200 },
    )
    return out?.classification ?? fallback
  } catch {
    return fallback
  }
}

// ---------- parsing raw mail ----------

export interface ParsedMail {
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  from: string | null
  fromName: string | null
  subject: string | null
  text: string
  date: string | null
}

function headerValue(headers: string, name: string): string | null {
  const re = new RegExp(`^${name}:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, 'im')
  const m = re.exec(headers)
  return m ? (m[1] ?? '').replace(/\r?\n[ \t]+/g, ' ').trim() : null
}

function messageIds(value: string | null): string[] {
  if (!value) return []
  return [...value.matchAll(/<([^>]+)>/g)].map((m) => `<${m[1]}>`)
}

function parseAddress(value: string | null): { address: string | null; name: string | null } {
  if (!value) return { address: null, name: null }
  const m = /^(.*?)<([^>]+)>/.exec(value)
  if (m) {
    return {
      address: normaliseEmail(m[2]) || null,
      name: (m[1] ?? '').trim().replace(/^"|"$/g, '').trim() || null,
    }
  }
  return { address: normaliseEmail(value) || null, name: null }
}

/** Drop quoted history and signatures, keep the person's own words. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (/^\s*>/.test(line)) break
    if (/^On .{5,120} wrote:\s*$/.test(line)) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break
    if (/^From:\s.+/.test(line) && kept.length > 0) break
    if (/^--\s*$/.test(line)) break
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/** Very small MIME reader: headers, then the first text/plain-looking part or the whole body. */
export function parseRawMail(
  source: Buffer | string,
  envelope?: ImapMessage['envelope'],
): ParsedMail {
  const raw = typeof source === 'string' ? source : source.toString('utf8')
  const splitAt = raw.search(/\r?\n\r?\n/)
  const headers = splitAt >= 0 ? raw.slice(0, splitAt) : raw
  let body = splitAt >= 0 ? raw.slice(splitAt).replace(/^\r?\n\r?\n/, '') : ''

  const contentType = headerValue(headers, 'Content-Type') ?? ''
  const boundary = /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1]
  if (boundary) {
    const parts = body.split(new RegExp(`--${escapeRe(boundary)}(?:--)?\\r?\\n?`))
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p.slice(0, 500)))
    const chosen = plain ?? parts.find((p) => p.trim().length > 0) ?? ''
    const inner = chosen.search(/\r?\n\r?\n/)
    const innerHeaders = inner >= 0 ? chosen.slice(0, inner) : ''
    body = inner >= 0 ? chosen.slice(inner).replace(/^\r?\n\r?\n/, '') : chosen
    if (/quoted-printable/i.test(headerValue(innerHeaders, 'Content-Transfer-Encoding') ?? '')) {
      body = decodeQuotedPrintable(body)
    } else if (/base64/i.test(headerValue(innerHeaders, 'Content-Transfer-Encoding') ?? '')) {
      body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
    }
  } else if (/quoted-printable/i.test(headerValue(headers, 'Content-Transfer-Encoding') ?? '')) {
    body = decodeQuotedPrintable(body)
  }
  if (/text\/html/i.test(contentType) && !boundary) body = body.replace(/<[^>]+>/g, ' ')

  const from = parseAddress(headerValue(headers, 'From'))
  const envFrom = envelope?.from?.[0]
  const ids = messageIds(headerValue(headers, 'Message-ID'))
  return {
    messageId: ids[0] ?? envelope?.messageId ?? null,
    inReplyTo: messageIds(headerValue(headers, 'In-Reply-To'))[0] ?? envelope?.inReplyTo ?? null,
    references: messageIds(headerValue(headers, 'References')),
    from: from.address ?? normaliseEmail(envFrom?.address) ?? null,
    fromName: from.name ?? envFrom?.name ?? null,
    subject: headerValue(headers, 'Subject') ?? envelope?.subject ?? null,
    text: stripQuoted(body),
    date: headerValue(headers, 'Date') ?? (envelope?.date ? String(envelope.date) : null),
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

// ---------- matching and handling ----------

/** The lead a reply belongs to: by our provider message id in the thread, else by From address. */
export async function matchLead(db: Db, mail: ParsedMail): Promise<Lead | null> {
  const ids = [mail.inReplyTo, ...mail.references].filter((x): x is string => Boolean(x))
  const bare = ids.flatMap((id) => [id, id.replace(/^<|>$/g, '')])
  if (bare.length > 0) {
    const hit = await db
      .select({ lead_id: messages.lead_id })
      .from(messages)
      .where(and(eq(messages.direction, 'out'), inArray(messages.provider_message_id, bare)))
      .limit(1)
    if (hit[0]) {
      const lead = await db.select().from(leads).where(eq(leads.id, hit[0].lead_id)).limit(1)
      if (lead[0]) return lead[0]
    }
  }
  if (mail.from) {
    const byEmail = await db
      .select()
      .from(leads)
      .where(and(eq(leads.email, mail.from), isNotNull(leads.last_contacted_at)))
      .orderBy(desc(leads.last_contacted_at))
      .limit(1)
    if (byEmail[0]) return byEmail[0]
  }
  return null
}

export function leadStatusFor(c: ReplyClassification): LeadStatus {
  switch (c) {
    case 'booked':
      return 'booked'
    case 'not_interested':
      return 'not_interested'
    case 'unsubscribe':
      return 'unsubscribed'
    case 'bounce':
      return 'bounced'
    default:
      return 'replied'
  }
}

export interface InboundInput {
  lead: Lead
  classification: ReplyClassification
  subject: string | null
  text: string
  fromAddress: string | null
  fromName: string | null
  providerMessageId: string | null
  /** Unique per inbound mail; `in:<message-id>` or `in:uid:<uid>`. */
  idempotencyKey: string
  raw?: unknown
}

/**
 * Record one inbound reply: message row, stop enrollments, lead status, suppression for
 * unsubscribe and bounce, an event, and an owner notification. Returns false when already recorded.
 */
export async function handleInboundReply(
  deps: OutreachDeps,
  input: InboundInput,
): Promise<boolean> {
  const { db } = deps
  const now = deps.now().toISOString()
  const dup = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.idempotency_key, input.idempotencyKey))
    .limit(1)
  if (dup.length > 0) return false

  await db.insert(messages).values({
    id: newId(),
    lead_id: input.lead.id,
    channel: 'email',
    direction: 'in',
    status: 'received',
    idempotency_key: input.idempotencyKey,
    subject: input.subject,
    body: input.text,
    to_address: input.fromAddress,
    provider: 'imap',
    provider_message_id: input.providerMessageId,
    sent_at: now,
    classification: input.classification,
    raw: input.raw ?? null,
    created_at: now,
  })

  const reason =
    input.classification === 'bounce'
      ? 'bounced'
      : input.classification === 'unsubscribe'
        ? 'unsubscribed'
        : 'replied'
  await stopLead(deps, input.lead.id, reason)

  const status = leadStatusFor(input.classification)
  await db
    .update(leads)
    .set({
      status,
      last_replied_at: input.classification === 'bounce' ? input.lead.last_replied_at : now,
      updated_at: now,
    })
    .where(eq(leads.id, input.lead.id))

  if (input.classification === 'unsubscribe') {
    await addSuppression(db, 'email', input.lead.email ?? input.fromAddress, 'replied unsubscribe')
  } else if (input.classification === 'bounce') {
    await addSuppression(db, 'email', input.lead.email, 'bounced')
    if (input.lead.email) {
      await db.update(leads).set({ email_status: 'invalid' }).where(eq(leads.id, input.lead.id))
    }
  }

  const kind =
    input.classification === 'unsubscribe'
      ? 'unsubscribe'
      : input.classification === 'bounce'
        ? 'bounce'
        : 'reply'
  await db.insert(events).values({
    id: newId(),
    lead_id: input.lead.id,
    kind,
    detail: {
      classification: input.classification,
      subject: input.subject,
      snippet: input.text.slice(0, 200),
    },
    at: now,
  })
  await logActivity(
    'info',
    kind,
    { classification: input.classification, from: input.fromAddress, subject: input.subject },
    input.lead.id,
    db,
  )

  if (input.classification !== 'bounce') {
    await notifyOwner(deps, input)
  }
  return true
}

async function notifyOwner(deps: OutreachDeps, input: InboundInput): Promise<void> {
  const settings = await getSettings(deps.db)
  if (!settings.notify_owner_on_reply) return
  if (!pickEmailProvider(deps, settings)) return
  const name = input.lead.full_name ?? input.lead.company ?? input.fromAddress ?? 'a lead'
  const snippet = input.text.replace(/\s+/g, ' ').trim().slice(0, 200)
  try {
    await sendEmail(deps, settings, {
      to: settings.owner_email,
      subject: `Reply from ${name}: ${snippet.slice(0, 60)}`,
      text: `Reply from ${name} (${input.fromAddress ?? 'no address'}), sorted as ${input.classification}.\n\n${snippet}\n\nAnswer them yourself from your inbox. This system never replies for you.`,
      unsubscribeUrl: `${deps.baseUrl}/u/owner`,
    })
  } catch (err) {
    await logActivity(
      'warn',
      'owner_notify_failed',
      { error: err instanceof Error ? err.message : String(err) },
      input.lead.id,
      deps.db,
    )
  }
}

// ---------- IMAP sync ----------

async function readLastSync(db: Db): Promise<Date | null> {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, LAST_SYNC_KEY))
  const v = rows[0]?.value
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null
}

async function writeLastSync(db: Db, at: Date): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key: LAST_SYNC_KEY, value: at.toISOString() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: at.toISOString() } })
}

/** Turn one fetched IMAP message into a recorded reply. Exported for tests. Returns true when recorded. */
export async function processInboundMessage(
  deps: OutreachDeps,
  settings: Settings,
  msg: ImapMessage,
): Promise<boolean> {
  const mail = msg.source ? parseRawMail(msg.source, msg.envelope) : parseRawMail('', msg.envelope)
  const ownAddresses = new Set(
    [settings.from_email, settings.reply_to, settings.owner_email].map((a) => normaliseEmail(a)),
  )
  if (mail.from && ownAddresses.has(mail.from)) return false
  const lead = await matchLead(deps.db, mail)
  if (!lead) return false
  const classification = await classifyReply(deps.llm, mail.subject, mail.text, mail.from)
  return handleInboundReply(deps, {
    lead,
    classification,
    subject: mail.subject,
    text: mail.text,
    fromAddress: mail.from,
    fromName: mail.fromName,
    providerMessageId: mail.messageId,
    idempotencyKey: mail.messageId ? `in:${mail.messageId}` : `in:uid:${msg.uid}`,
    raw: { uid: msg.uid, date: mail.date },
  })
}

/** Search INBOX since the last sync (minus a day of slack), record each matched reply. */
export async function syncReplies(deps: OutreachDeps): Promise<{ received: number }> {
  if (!deps.imap) return { received: 0 }
  const { db } = deps
  const settings = await getSettings(db)
  const now = deps.now()
  const last = await readLastSync(db)
  const since = new Date((last ?? new Date(now.getTime() - 7 * 86_400_000)).getTime() - 86_400_000)

  const client = deps.imap()
  let received = 0
  try {
    await client.connect()
    await client.mailboxOpen('INBOX')
    const found = await client.search({ since }, { uid: true })
    const uids = Array.isArray(found)
      ? found
      : found && typeof found === 'object'
        ? (found.all ?? [])
        : []
    if (uids.length > 0) {
      const batch = uids.slice(-200)
      const fetched = await client.fetchAll(
        batch,
        { uid: true, envelope: true, source: true },
        { uid: true },
      )
      for (const msg of fetched) {
        try {
          if (await processInboundMessage(deps, settings, msg)) received++
        } catch (err) {
          await logActivity(
            'warn',
            'reply_process_failed',
            { uid: msg.uid, error: err instanceof Error ? err.message : String(err) },
            null,
            db,
          )
        }
      }
    }
    await writeLastSync(db, now)
  } catch (err) {
    await logActivity(
      'error',
      'reply_sync_failed',
      { error: err instanceof Error ? err.message : String(err) },
      null,
      db,
    )
  } finally {
    await client.logout().catch(() => undefined)
  }
  if (received > 0) await logActivity('info', 'sync_replies', { received }, null, db)
  return { received }
}
