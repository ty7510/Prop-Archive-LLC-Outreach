// Never-spam guard. One person often owns several LLCs, so one person is often several lead rows
// (Potter's First, Second and Fifth Few Units LLCs all at 4253 Regent Sq). Email and postcards are
// paced per real recipient (same email address, or same mailing street and zip), never per lead
// row, and the autopilot puts one person into a sequence once.
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import type { Channel, MessageStatus } from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import { enrollments, leads, messages, type Lead } from '../db/schema.ts'
import { normaliseEmail, normaliseZip5 } from '../lib/text.ts'
import { addDays } from '../lib/time.ts'
import { addressKey } from './suppression.ts'

type PersonFields = Pick<Lead, 'id' | 'email' | 'mailing_street' | 'mailing_zip'>

/** The keys that make two lead rows one person: lower-cased email, normalised street with zip5. */
export function personKeys(lead: Omit<PersonFields, 'id'>): string[] {
  const out: string[] = []
  const email = normaliseEmail(lead.email)
  if (email) out.push(`email:${email}`)
  // A street without a zip is not safe to match: "100 Main St" exists in many towns.
  if (normaliseZip5(lead.mailing_zip)) {
    const addr = addressKey(lead.mailing_street, lead.mailing_zip)
    if (addr) out.push(`address:${addr}`)
  }
  return out
}

/** Every lead row of this person, the lead itself first. */
export async function samePersonLeadIds(db: Db, lead: PersonFields): Promise<string[]> {
  const email = normaliseEmail(lead.email)
  const zip = normaliseZip5(lead.mailing_zip)
  const keys = personKeys(lead)
  const addr = keys.find((k) => k.startsWith('address:'))
  const conds = []
  if (email) conds.push(sql`lower(${leads.email}) = ${email}`)
  if (addr) conds.push(sql`substr(${leads.mailing_zip}, 1, 5) = ${zip}`)
  if (conds.length === 0) return [lead.id]

  // The database narrows by email and zip; the street is matched normalised, in code.
  const rows = await db
    .select({
      id: leads.id,
      email: leads.email,
      mailing_street: leads.mailing_street,
      mailing_zip: leads.mailing_zip,
    })
    .from(leads)
    .where(or(...conds))
  const ids = new Set([lead.id])
  for (const r of rows) {
    if (r.id === lead.id) continue
    const theirs = personKeys(r)
    if (theirs.some((k) => keys.includes(k))) ids.add(r.id)
  }
  return [...ids]
}

/** True when another lead row of this person already has an enrollment: the person is in. */
export async function personAlreadyEnrolled(db: Db, lead: PersonFields): Promise<boolean> {
  const others = (await samePersonLeadIds(db, lead)).filter((id) => id !== lead.id)
  if (others.length === 0) return false
  const rows = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(inArray(enrollments.lead_id, others))
    .limit(1)
  return rows.length > 0
}

export type RecipientBlock =
  | { kind: 'email_too_soon'; last_at: string; days: number }
  | { kind: 'postcard_already_sent'; last_at: string; days: number }

/** Statuses that mean the message reached the recipient or is on its way (a print task is on its way). */
const REACHED: readonly MessageStatus[] = ['sent', 'sending', 'ready_for_human']

/**
 * Why this email or postcard must not go to this person right now, or null when it may.
 * Email: nothing to the same person inside `min_days_between_emails`, counting every lead row of
 * theirs. Mail: one postcard per mailing address in `days_between_postcards`. Dry-run rows count
 * only in dry run, so the pacing shows there too but never holds a real email back once Live is on.
 */
export async function recipientBlocker(
  db: Db,
  settings: Settings,
  lead: PersonFields,
  channel: Channel,
  now: Date,
): Promise<RecipientBlock | null> {
  if (channel !== 'email' && channel !== 'mail') return null
  const days =
    channel === 'email' ? settings.min_days_between_emails : settings.days_between_postcards
  if (days <= 0) return null
  const ids = await samePersonLeadIds(db, lead)
  const since = addDays(now, -days).toISOString()
  const statuses: MessageStatus[] = settings.live_mode ? [...REACHED] : [...REACHED, 'dry_run']
  const reachedAt = sql<string>`coalesce(${messages.sent_at}, ${messages.created_at})`
  const rows = await db
    .select({ at: reachedAt })
    .from(messages)
    .where(
      and(
        inArray(messages.lead_id, ids),
        eq(messages.channel, channel),
        eq(messages.direction, 'out'),
        inArray(messages.status, statuses),
        sql`${reachedAt} > ${since}`, // exactly `days` ago is far enough
      ),
    )
  if (rows.length === 0) return null
  const last_at = rows
    .map((r) => r.at)
    .sort()
    .at(-1)!
  return channel === 'email'
    ? { kind: 'email_too_soon', last_at, days }
    : { kind: 'postcard_already_sent', last_at, days }
}
