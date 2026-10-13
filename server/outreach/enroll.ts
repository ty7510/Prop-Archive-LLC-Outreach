// Enrolling leads into sequences and stopping them (spec sections 10 and 11 step 3).
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import {
  CHANNELS,
  type Channel,
  type EnrollmentStatus,
  type LeadStatus,
  type Persona,
} from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import {
  enrollments,
  events,
  leads,
  messages,
  sequences,
  type Lead,
  type Sequence,
  sequenceSteps,
} from '../db/schema.ts'
import { awaitsResearch } from '../enrich/pending.ts'
import { logActivity } from '../lib/activity.ts'
import { badRequest, conflict, notFound } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import { addDays } from '../lib/time.ts'
import type { OutreachDeps } from './deps.ts'
import { isSuppressed } from './suppression.ts'

/** Lead statuses we never contact again until Theo changes them by hand. */
export const BLOCKED_LEAD_STATUSES: readonly LeadStatus[] = [
  'replied',
  'booked',
  'joined',
  'not_interested',
  'unsubscribed',
  'bounced',
  'disqualified',
]

/** Statuses the autopilot may pick up for a first enrollment. */
const ENROLLABLE_STATUSES: readonly LeadStatus[] = ['enriched']

export type StopReason =
  | 'replied'
  | 'unsubscribed'
  | 'bounced'
  | 'manual'
  | 'do_not_contact'
  | 'suppressed'
  | 'booked'
  | 'joined'
  | 'not_interested'
  | string

export function stopStatusFor(reason: StopReason): EnrollmentStatus {
  const r = reason.toLowerCase()
  if (r.startsWith('repl')) return 'stopped_replied'
  if (r.startsWith('unsub')) return 'stopped_unsubscribed'
  if (r.startsWith('bounce')) return 'stopped_bounced'
  return 'stopped_manual'
}

/** Why a lead may not be contacted right now, or null when it is fine. */
export async function contactBlocker(db: Db, lead: Lead): Promise<string | null> {
  if (lead.do_not_contact) return 'do_not_contact'
  if (BLOCKED_LEAD_STATUSES.includes(lead.status)) return lead.status
  if (await isSuppressed(db, lead)) return 'suppressed'
  return null
}

async function loadLead(db: Db, leadId: string): Promise<Lead> {
  const rows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  const lead = rows[0]
  if (!lead) throw notFound('Lead not found', 'LEAD_NOT_FOUND')
  return lead
}

async function loadSequence(db: Db, sequenceId: string): Promise<Sequence> {
  const rows = await db.select().from(sequences).where(eq(sequences.id, sequenceId)).limit(1)
  const seq = rows[0]
  if (!seq) throw notFound('Sequence not found', 'SEQUENCE_NOT_FOUND')
  return seq
}

export interface EnrollOptions {
  /** When the first step may go. Defaults to now. */
  startAt?: Date
  /** Autopilot passes true: inactive sequences and blocked leads are skipped quietly. */
  quiet?: boolean
}

/**
 * Put one lead into one sequence. next_send_at is "now" (or startAt) so the first step goes in the
 * next send window. Throws 4xx for a human caller; returns false when `quiet` and nothing was done.
 */
export async function enrollLead(
  deps: OutreachDeps,
  leadId: string,
  sequenceId: string,
  opts: EnrollOptions = {},
): Promise<boolean> {
  const { db } = deps
  const now = deps.now()
  const lead = await loadLead(db, leadId)
  const seq = await loadSequence(db, sequenceId)

  const blocker = await contactBlocker(db, lead)
  // A human may re-enrol a lead who replied or said not now; the autopilot never does.
  const hardBlock =
    blocker === 'do_not_contact' ||
    blocker === 'suppressed' ||
    blocker === 'unsubscribed' ||
    blocker === 'bounced'
  if (blocker && (hardBlock || opts.quiet)) {
    if (opts.quiet) return false
    throw badRequest(blockerMessage(blocker), 'LEAD_BLOCKED')
  }
  if (!seq.active) {
    if (opts.quiet) return false
    throw badRequest('This sequence is turned off. Turn it on first', 'SEQUENCE_INACTIVE')
  }

  const existing = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.lead_id, leadId), eq(enrollments.sequence_id, sequenceId)))
    .limit(1)
  const startAt = (opts.startAt ?? now).toISOString()
  const row = existing[0]
  if (row) {
    if (row.status === 'active' || row.status === 'paused') {
      if (opts.quiet) return false
      throw conflict('This lead is already in that sequence', 'ALREADY_ENROLLED')
    }
    // A new run: the step keys of the old run must not be found again (see send.ts idempotencyKey).
    await db
      .update(enrollments)
      .set({
        status: 'active',
        current_step: 0,
        next_send_at: startAt,
        started_at: now.toISOString(),
        ended_at: null,
        run: row.run + 1,
      })
      .where(eq(enrollments.id, row.id))
  } else {
    await db.insert(enrollments).values({
      id: newId(),
      lead_id: leadId,
      sequence_id: sequenceId,
      status: 'active',
      current_step: 0,
      next_send_at: startAt,
      started_at: now.toISOString(),
    })
  }

  const patch: Partial<Lead> = { updated_at: now.toISOString(), next_action_at: startAt }
  if (['new', 'enriching', 'enriched'].includes(lead.status)) patch.status = 'enrolled'
  await db.update(leads).set(patch).where(eq(leads.id, leadId))
  await db.insert(events).values({
    id: newId(),
    lead_id: leadId,
    kind: 'enrolled',
    detail: { sequence_id: seq.id, sequence: seq.name, channel: seq.channel },
    at: now.toISOString(),
  })
  await logActivity(
    'info',
    'enrolled',
    { sequence: seq.name, channel: seq.channel, lead: lead.full_name ?? lead.company },
    leadId,
    db,
  )
  return true
}

function blockerMessage(blocker: string): string {
  switch (blocker) {
    case 'do_not_contact':
      return 'This lead is marked do not contact'
    case 'suppressed':
      return 'This lead is on the suppression list'
    case 'unsubscribed':
      return 'This lead unsubscribed. Nothing more goes to them'
    case 'bounced':
      return 'Email to this lead bounced. Fix the address first'
    default:
      return `This lead is marked ${blocker.replace(/_/g, ' ')}`
  }
}

/**
 * When Live mode is switched on, every enrollment that only ever produced dry_run rows starts over
 * from step 0 as a new run, so the first live round really sends step 0 instead of silently
 * walking past the dry-run rows. Enrollments with a real send or a queued human item are left alone.
 * Returns how many were restarted.
 */
export async function restartDryRunEnrollments(deps: OutreachDeps): Promise<number> {
  const { db } = deps
  const now = deps.now().toISOString()
  const candidates = await db
    .select()
    .from(enrollments)
    .where(inArray(enrollments.status, ['active', 'done']))
  let restarted = 0
  for (const e of candidates) {
    const rows = await db
      .select({ status: messages.status })
      .from(messages)
      .where(and(eq(messages.enrollment_id, e.id), eq(messages.direction, 'out')))
    if (rows.length === 0 || !rows.every((m) => m.status === 'dry_run')) continue
    await db
      .update(enrollments)
      .set({
        status: 'active',
        current_step: 0,
        next_send_at: now,
        started_at: now,
        ended_at: null,
        run: e.run + 1,
      })
      .where(eq(enrollments.id, e.id))
    await db
      .update(leads)
      .set({ next_action_at: now, updated_at: now })
      .where(eq(leads.id, e.lead_id))
    restarted++
  }
  if (restarted > 0) {
    await logActivity(
      'info',
      'dry_run_enrollments_restarted',
      { restarted, reason: 'Live mode turned on: dry-run sequences start over from step 1' },
      null,
      db,
    )
  }
  return restarted
}

/**
 * Stop every active or paused enrollment for a lead. The reason picks the enrollment status
 * (replied, unsubscribed, bounced, otherwise manual). Returns how many were stopped.
 */
export async function stopLead(
  deps: OutreachDeps,
  leadId: string,
  reason: StopReason = 'manual',
): Promise<number> {
  const { db } = deps
  const now = deps.now().toISOString()
  const open = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.lead_id, leadId), inArray(enrollments.status, ['active', 'paused'])))
  if (open.length === 0) return 0
  await db
    .update(enrollments)
    .set({ status: stopStatusFor(reason), ended_at: now, next_send_at: null })
    .where(
      inArray(
        enrollments.id,
        open.map((o) => o.id),
      ),
    )
  // Nothing already written for this lead may still go out or sit in Theo's queue.
  await db
    .update(messages)
    .set({ status: 'skipped', error: `stopped: ${reason}` })
    .where(
      and(
        eq(messages.lead_id, leadId),
        eq(messages.direction, 'out'),
        inArray(messages.status, ['queued', 'ready_for_human']),
      ),
    )
  await db.update(leads).set({ next_action_at: null, updated_at: now }).where(eq(leads.id, leadId))
  await db.insert(events).values({
    id: newId(),
    lead_id: leadId,
    kind: 'stopped',
    detail: { reason, count: open.length },
    at: now,
  })
  await logActivity('info', 'outreach_stopped', { reason, count: open.length }, leadId, db)
  return open.length
}

/**
 * settings.main_sequence_id when it names an active sequence, with the channels its steps use.
 * null means the per-channel sequence_by_persona choice applies.
 */
export async function mainSequence(
  db: Db,
  settings: Settings,
): Promise<{ id: string; channels: Channel[] } | null> {
  if (!settings.main_sequence_id) return null
  const rows = await db
    .select({ id: sequences.id, active: sequences.active })
    .from(sequences)
    .where(eq(sequences.id, settings.main_sequence_id))
    .limit(1)
  const seq = rows[0]
  if (!seq?.active) return null
  const steps = await db
    .select({ channel: sequenceSteps.channel })
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequence_id, seq.id))
  return { id: seq.id, channels: [...new Set(steps.map((s) => s.channel))] }
}

/** Channels the autopilot would enrol this lead in, in order, given the settings. */
export function pickChannels(lead: Lead, settings: Settings): Channel[] {
  const out: Channel[] = []
  const on = (c: Channel) => settings.channels[c] && lead.channels[c]
  if (on('email') && lead.email) out.push('email')
  else if (on('mail') && lead.mailing_street) out.push('mail')
  for (const c of ['linkedin', 'instagram', 'call'] as const) if (on(c)) out.push(c)
  return out
}

/**
 * Spec 11 step 3: enriched leads with no enrollment at all, persona in settings, score at or above
 * the minimum, not blocked. Email first (mail when there is no email); human channels in parallel,
 * offset by one day. Returns the number of leads that got at least one enrollment.
 */
export async function enrollEligible(deps: OutreachDeps): Promise<{ enrolled: number }> {
  const { db } = deps
  const settings = await getSettings(db)
  const now = deps.now()
  const personas = settings.personas as readonly string[]
  if (personas.length === 0) return { enrolled: 0 }

  const enrolledLeadIds = db.select({ id: enrollments.lead_id }).from(enrollments)
  const candidates = await db
    .select()
    .from(leads)
    .where(
      and(
        inArray(leads.status, [...ENROLLABLE_STATUSES]),
        eq(leads.do_not_contact, false),
        inArray(leads.persona, [...settings.personas]),
        notInArray(leads.id, enrolledLeadIds),
        isNull(leads.last_replied_at),
      ),
    )
    .limit(200)

  const main = await mainSequence(db, settings)

  let enrolled = 0
  for (const lead of candidates) {
    if (lead.icp_score < settings.min_icp_score) continue
    if (lead.persona === 'unknown') continue
    if (await contactBlocker(db, lead)) continue
    // Research finds the email and the profiles. Until it has looked, the lead waits: put in now,
    // the email steps would be skipped for good and the lead would only ever get a postcard.
    if (awaitsResearch(lead, settings, deps.env)) continue
    if (main) {
      // One sequence for everyone: email, then LinkedIn, then mail. Steps a lead cannot get are
      // skipped when they come due (send.ts), so anyone reachable on one switched-on channel goes in.
      if (!main.channels.some((c) => settings.channels[c] && lead.channels[c])) continue
      try {
        if (await enrollLead(deps, lead.id, main.id, { startAt: now, quiet: true })) enrolled++
      } catch (err) {
        await logActivity(
          'warn',
          'enroll_failed',
          { sequence: main.id, error: err instanceof Error ? err.message : String(err) },
          lead.id,
          db,
        )
      }
      continue
    }
    const byChannel = settings.sequence_by_persona[lead.persona as Persona]
    let count = 0
    for (const channel of pickChannels(lead, settings)) {
      const sequenceId = byChannel[channel]
      if (!sequenceId) continue
      const startAt = channel === 'email' || channel === 'mail' ? now : addDays(now, 1)
      try {
        if (await enrollLead(deps, lead.id, sequenceId, { startAt, quiet: true })) count++
      } catch (err) {
        await logActivity(
          'warn',
          'enroll_failed',
          { channel, error: err instanceof Error ? err.message : String(err) },
          lead.id,
          db,
        )
      }
    }
    if (count > 0) enrolled++
  }
  if (enrolled > 0) await logActivity('info', 'enroll', { enrolled }, null, db)
  return { enrolled }
}

export const ALL_CHANNELS = CHANNELS
