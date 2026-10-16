// sendDue: due steps -> render -> live send, dry run row, or human queue (spec sections 10 and 11.4).
// At-most-once: a message row claims the idempotency key before any provider is called, and the
// row is marked `sending` right before the provider call. A row left in `sending` (the process died
// mid-send) is never resent by the machine: its outcome is unknown and only Theo can check.
import { createHmac } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { isGoogleMailHost, type SendingInbox, type Settings } from '../../shared/settings.ts'
import { HUMAN_CHANNELS, type Channel, type MessageStatus } from '../../shared/types.ts'
import {
  enrollments,
  events,
  leads,
  messages,
  sequenceSteps,
  sequences,
  type Enrollment,
  type Lead,
  type Message,
  type Sequence,
  type SequenceStep,
} from '../db/schema.ts'
import { awaitsResearch } from '../enrich/pending.ts'
import { logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { isWithinSendWindow } from '../lib/sendWindow.ts'
import { getSettings } from '../lib/settings.ts'
import type { OutreachDeps } from './deps.ts'
import { sendEmail } from './email.ts'
import { contactBlocker, stopLead } from './enroll.ts'
import { postalAddressFor, sendViaLob } from './mail.ts'
import { recipientBlocker } from './recipients.ts'
import { countTodayByChannel, nextSendAt, remainingToday } from './scheduler.ts'
import {
  canSend,
  inboxDay,
  inboxForNow,
  inboxProvider,
  isLoginRefused,
  loginFix,
  mailErrorText,
  noteLoginRefused,
  noteLoginWorked,
  refreshGoogleAccount,
  replySyncFailures,
  type InboxDay,
} from './inboxes.ts'
import { renderStepForLead } from './templates.ts'

export interface SendDueResult {
  sent: number
  dryRun: number
  queued: number
  skipped: number
}

/** How many times a provider may be asked to carry one message before Theo has to look. */
export const MAX_SEND_ATTEMPTS = 2

/** Errors after which we cannot tell whether the provider accepted the message. Never retried. */
const AMBIGUOUS_ERROR_RE = /timed? ?out|timeout|abort|ETIMEDOUT|ESOCKET|ECONNRESET|outcome unknown/i

export const OUTCOME_UNKNOWN_ERROR =
  'Send outcome unknown: the process stopped mid-send. Check your Sent folder; if it did not go out, stop and start the sequence again'

/**
 * `enrollment_id:step_index` for the first run of an enrollment (as the spec says). Every later run
 * of the same enrollment (a re-enrol after done or stopped) adds `r<run>` so keys never collide
 * with the rows of an earlier run.
 */
export function idempotencyKey(enrollmentId: string, stepIndex: number, run = 0): string {
  return run > 0 ? `${enrollmentId}:r${run}:${stepIndex}` : `${enrollmentId}:${stepIndex}`
}

/** May a failed row be handed to the provider again? Bounded, and never after an ambiguous error. */
export function canRetry(message: Pick<Message, 'status' | 'attempts' | 'error'>): boolean {
  if (message.status !== 'failed') return false
  // The server refused the login before anything was handed over: the email goes once it works.
  if (isLoginRefused(message.error ?? '')) return true
  if (message.attempts >= MAX_SEND_ATTEMPTS) return false
  return !AMBIGUOUS_ERROR_RE.test(message.error ?? '')
}

function isHuman(channel: Channel): boolean {
  return (HUMAN_CHANNELS as readonly string[]).includes(channel)
}

interface DueRow {
  enrollment: Enrollment
  lead: Lead
  sequence: Sequence
}

async function loadDue(deps: OutreachDeps, nowIso: string): Promise<DueRow[]> {
  const rows = await deps.db
    .select({ enrollment: enrollments, lead: leads, sequence: sequences })
    .from(enrollments)
    .innerJoin(leads, eq(leads.id, enrollments.lead_id))
    .innerJoin(sequences, eq(sequences.id, enrollments.sequence_id))
    .where(and(eq(enrollments.status, 'active'), lte(enrollments.next_send_at, nowIso)))
    .orderBy(asc(enrollments.next_send_at))
    .limit(500)
  return rows
}

/**
 * Theo's LinkedIn goal is the LinkedIn daily cap. While he is under it, the next LinkedIn notes
 * come up now instead of on their day: enrollments whose next step is their sequence's first
 * LinkedIn step (after the email before it) and whose profile research found, soonest first.
 */
async function loadUpcomingLinkedIn(
  deps: OutreachDeps,
  nowIso: string,
  limit: number,
): Promise<DueRow[]> {
  if (limit <= 0) return []
  const rows = await deps.db
    .select({ enrollment: enrollments, lead: leads, sequence: sequences })
    .from(enrollments)
    .innerJoin(leads, eq(leads.id, enrollments.lead_id))
    .innerJoin(sequences, eq(sequences.id, enrollments.sequence_id))
    .innerJoin(
      sequenceSteps,
      and(
        eq(sequenceSteps.sequence_id, enrollments.sequence_id),
        eq(sequenceSteps.step_index, enrollments.current_step),
      ),
    )
    .where(
      and(
        eq(enrollments.status, 'active'),
        gt(enrollments.next_send_at, nowIso),
        // Never a first step: an enrollment started for a later date keeps that date.
        gt(enrollments.current_step, 0),
        eq(sequenceSteps.channel, 'linkedin'),
        eq(sequences.active, true),
        sql`trim(coalesce(${leads.linkedin_url}, '')) <> ''`,
      ),
    )
    .orderBy(asc(enrollments.next_send_at))
    .limit(limit * 4)
  const firstLinkedIn = new Map<string, number | undefined>()
  const out: DueRow[] = []
  for (const row of rows) {
    if (!firstLinkedIn.has(row.sequence.id)) {
      const steps = await stepsFor(deps, row.sequence.id)
      firstLinkedIn.set(row.sequence.id, steps.find((s) => s.channel === 'linkedin')?.step_index)
    }
    // A second LinkedIn step (a message after the connection) keeps its wait.
    if (firstLinkedIn.get(row.sequence.id) !== row.enrollment.current_step) continue
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

/** One LinkedIn profile, however the link was written. */
export function profileKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?#]/)[0]!
    .replace(/\/+$/, '')
}

/** Who already has a LinkedIn note: waiting, sent, or skipped by Theo. One note per person. */
interface LinkedInTaken {
  leads: Set<string>
  profiles: Set<string>
}

function isTaken(taken: LinkedInTaken, lead: Pick<Lead, 'id' | 'linkedin_url'>): boolean {
  const profile = lead.linkedin_url?.trim()
  return taken.leads.has(lead.id) || (!!profile && taken.profiles.has(profileKey(profile)))
}

function markTaken(taken: LinkedInTaken, lead: Pick<Lead, 'id' | 'linkedin_url'>): void {
  taken.leads.add(lead.id)
  const profile = lead.linkedin_url?.trim()
  if (profile) taken.profiles.add(profileKey(profile))
}

async function loadLinkedInTaken(deps: OutreachDeps): Promise<LinkedInTaken> {
  const taken: LinkedInTaken = { leads: new Set(), profiles: new Set() }
  const rows = await deps.db
    .select({ lead_id: messages.lead_id, to_address: messages.to_address })
    .from(messages)
    .where(
      and(
        eq(messages.channel, 'linkedin'),
        eq(messages.direction, 'out'),
        or(
          inArray(messages.status, ['ready_for_human', 'sent']),
          and(eq(messages.status, 'skipped'), isNull(messages.error)),
        ),
      ),
    )
  for (const m of rows) markTaken(taken, { id: m.lead_id, linkedin_url: m.to_address })
  return taken
}

export const DUPLICATE_LINKEDIN_ERROR = 'this person already has a LinkedIn note'
/** An email step passed by while the email channel is off. */
export const EMAILS_OFF_ERROR = 'emails are off'

/**
 * One waiting LinkedIn task per person (by lead and by profile link): an old task brought back
 * next to a newer one, or two lead rows with one profile. The newest stays; the rest are skipped.
 */
async function skipDuplicateLinkedInTasks(deps: OutreachDeps): Promise<void> {
  const waiting = await deps.db
    .select({ id: messages.id, lead_id: messages.lead_id, to_address: messages.to_address })
    .from(messages)
    .where(
      and(
        eq(messages.status, 'ready_for_human'),
        eq(messages.channel, 'linkedin'),
        eq(messages.direction, 'out'),
      ),
    )
    .orderBy(desc(messages.created_at), desc(messages.id))
  const seen: LinkedInTaken = { leads: new Set(), profiles: new Set() }
  const extra: string[] = []
  for (const m of waiting) {
    const lead = { id: m.lead_id, linkedin_url: m.to_address }
    if (isTaken(seen, lead)) extra.push(m.id)
    else markTaken(seen, lead)
  }
  if (extra.length === 0) return
  await deps.db
    .update(messages)
    .set({ status: 'skipped', error: DUPLICATE_LINKEDIN_ERROR })
    .where(inArray(messages.id, extra))
}

/**
 * Leads already past their sequence's first LinkedIn step that never got the note (research found
 * the profile after the step was skipped) get it now, while Theo is under his LinkedIn goal. One
 * note per person: a lead or profile with a LinkedIn task already (done, waiting, or skipped by
 * Theo) is left alone. The enrollment does not move, so the emails and the postcard keep their
 * dates. Returns how many tasks it queued.
 */
async function catchUpLinkedIn(
  deps: OutreachDeps,
  settings: Settings,
  taken: LinkedInTaken,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0
  const { db } = deps
  const rows = await db
    .select({ enrollment: enrollments, lead: leads, sequence: sequences, step: sequenceSteps })
    .from(enrollments)
    .innerJoin(leads, eq(leads.id, enrollments.lead_id))
    .innerJoin(sequences, eq(sequences.id, enrollments.sequence_id))
    .innerJoin(sequenceSteps, eq(sequenceSteps.sequence_id, enrollments.sequence_id))
    .where(
      and(
        eq(enrollments.status, 'active'),
        eq(sequences.active, true),
        eq(sequenceSteps.channel, 'linkedin'),
        lt(sequenceSteps.step_index, enrollments.current_step),
        sql`trim(coalesce(${leads.linkedin_url}, '')) <> ''`,
      ),
    )
    .orderBy(desc(leads.icp_score), asc(enrollments.started_at))
    .limit(500)
  if (rows.length === 0) return 0

  const neverReached = (m: Pick<Message, 'status' | 'error'>) =>
    (m.status === 'skipped' || m.status === 'failed') &&
    NEVER_REACHED_ERRORS.includes(m.error ?? '')

  const stepsCache = new Map<string, SequenceStep[]>()
  const now = deps.now().toISOString()
  let queued = 0
  for (const { enrollment, lead, sequence, step } of rows) {
    if (queued >= limit) break
    const profile = lead.linkedin_url!.trim()
    if (isTaken(taken, lead)) continue
    let steps = stepsCache.get(sequence.id)
    if (!steps) {
      steps = await stepsFor(deps, sequence.id)
      stepsCache.set(sequence.id, steps)
    }
    if (steps.find((s) => s.channel === 'linkedin')?.step_index !== step.step_index) continue
    if (await contactBlocker(db, lead)) continue
    const key = idempotencyKey(enrollment.id, step.step_index, enrollment.run)
    const existing = (
      await db.select().from(messages).where(eq(messages.idempotency_key, key)).limit(1)
    )[0]
    if (existing && !neverReached(existing)) continue

    const rendered = await renderStepForLead(
      step,
      lead,
      settings,
      { baseUrl: deps.baseUrl, channel: 'linkedin', sequenceName: sequence.name },
      deps.llm,
    )
    const task = {
      subject: null,
      body: rendered.body,
      to_address: profile,
      status: 'ready_for_human' as const,
      provider: 'human',
      error: null,
    }
    let message: Message
    if (existing) {
      await db.update(messages).set(task).where(eq(messages.id, existing.id))
      message = { ...existing, ...task }
    } else {
      message = {
        id: newId(),
        lead_id: lead.id,
        enrollment_id: enrollment.id,
        step_id: step.id,
        channel: 'linkedin',
        direction: 'out',
        idempotency_key: key,
        provider_message_id: null,
        scheduled_at: now,
        sent_at: null,
        attempts: 0,
        classification: null,
        raw: null,
        created_at: now,
        ...task,
      }
      try {
        await db.insert(messages).values(message)
      } catch {
        continue // another run took this key first
      }
    }
    markTaken(taken, lead)
    await db.insert(events).values({
      id: newId(),
      lead_id: lead.id,
      kind: 'queued',
      detail: { sequence: sequence.name, channel: 'linkedin', step: step.step_index },
      at: now,
    })
    await notifyHumanQueueWebhook(deps, settings, message, lead)
    queued++
  }
  return queued
}

async function stepsFor(deps: OutreachDeps, sequenceId: string): Promise<SequenceStep[]> {
  return deps.db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequence_id, sequenceId))
    .orderBy(asc(sequenceSteps.step_index))
}

/**
 * True while an earlier step of this enrollment on the same channel still sits in Theo's queue
 * (a LinkedIn message waits for his connection note). His tasks never hold up another channel:
 * the emails go out on time whether or not the LinkedIn note or the postcard is done yet.
 */
async function hasItemWaiting(
  deps: OutreachDeps,
  enrollmentId: string,
  channel: Channel,
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.enrollment_id, enrollmentId),
        eq(messages.status, 'ready_for_human'),
        eq(messages.channel, channel),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** The enrollment will never go anywhere (no address for the channel): end it without a stop event. */
async function endEnrollment(deps: OutreachDeps, enrollmentId: string): Promise<void> {
  await deps.db
    .update(enrollments)
    .set({ status: 'stopped_manual', ended_at: deps.now().toISOString(), next_send_at: null })
    .where(eq(enrollments.id, enrollmentId))
}

/** 'unreachable': the lead cannot get this step's channel (no email, address or profile): skip it. */
type AdvanceOutcome = 'sent' | 'queued' | 'dry_run' | 'skipped' | 'unreachable'

/**
 * Move the enrollment to the next step or mark it done. Only a real send stamps the lead as
 * contacted; a queued human item is stamped when Theo marks it done (queue.ts).
 */
async function advance(
  deps: OutreachDeps,
  settings: Settings,
  row: DueRow,
  steps: SequenceStep[],
  outcome: AdvanceOutcome,
): Promise<void> {
  const { db } = deps
  const now = deps.now()
  const channel =
    steps.find((s) => s.step_index === row.enrollment.current_step)?.channel ?? row.sequence.channel
  const nextIndex = row.enrollment.current_step + 1
  const next = steps.find((s) => s.step_index === nextIndex)
  if (next) {
    // Skipping the very first step starts the next one now; skipping a later step (no LinkedIn
    // profile) keeps the schedule, so two emails never land days early, close together.
    const delay =
      outcome === 'unreachable' && row.enrollment.current_step === 0 ? 0 : next.delay_days
    // A LinkedIn note pulled ahead of its day (Theo is under his daily goal) leaves the steps
    // after it on their own dates: count from the day it was due, not from now.
    const dueAt = row.enrollment.next_send_at ? new Date(row.enrollment.next_send_at) : now
    const at = nextSendAt(settings, dueAt > now ? dueAt : now, delay, deps.random)
    await db
      .update(enrollments)
      .set({ current_step: nextIndex, next_send_at: at ? at.toISOString() : null })
      .where(eq(enrollments.id, row.enrollment.id))
  } else {
    await db
      .update(enrollments)
      .set({
        current_step: nextIndex,
        next_send_at: null,
        status: 'done',
        ended_at: now.toISOString(),
      })
      .where(eq(enrollments.id, row.enrollment.id))
  }
  const patch: Partial<Lead> = { updated_at: now.toISOString() }
  if (outcome === 'sent') {
    patch.last_contacted_at = now.toISOString()
    if (['new', 'enriching', 'enriched', 'enrolled'].includes(row.lead.status)) {
      patch.status = 'contacted'
    }
  }
  await db.update(leads).set(patch).where(eq(leads.id, row.lead.id))
  if (outcome === 'sent' || outcome === 'queued') {
    await db.insert(events).values({
      id: newId(),
      lead_id: row.lead.id,
      kind: outcome,
      detail: {
        sequence: row.sequence.name,
        channel,
        step: row.enrollment.current_step,
      },
      at: now.toISOString(),
    })
  }
}

/** What an already-recorded row at this step means for the enrollment. */
function outcomeForExisting(status: MessageStatus): AdvanceOutcome {
  switch (status) {
    case 'sent':
      return 'sent'
    case 'ready_for_human':
      return 'queued'
    case 'dry_run':
      return 'dry_run'
    default:
      return 'skipped'
  }
}

function humanAddress(lead: Lead, channel: Channel): string | null {
  switch (channel) {
    case 'linkedin':
      return lead.linkedin_url
    case 'instagram':
      return lead.instagram_url
    case 'call':
      return lead.phone
    default:
      return null
  }
}

/**
 * Can this step's channel reach the lead at all? LinkedIn and Instagram need the profile research
 * found: Theo is never handed a task to go and search for someone himself.
 */
function reachable(lead: Lead, channel: Channel): boolean {
  if (channel === 'email') return Boolean(lead.email) && lead.email_status !== 'invalid'
  if (channel === 'mail') return postalAddressFor(lead) !== null
  if (channel === 'linkedin') return Boolean(lead.linkedin_url?.trim())
  if (channel === 'instagram') return Boolean(lead.instagram_url?.trim())
  return true
}

/**
 * An enrollment that has not reached the lead yet (every step so far was skipped: no email, no
 * profile) starts over as a new run once a way in turns up, so the lead gets the first email
 * instead of joining at a follow-up. Returns how many were restarted.
 */
async function restartUntouched(deps: OutreachDeps, settings: Settings): Promise<number> {
  const { db } = deps
  if (!settings.channels.email) return 0
  const rows = (
    await db
      .select({ enrollment: enrollments, lead: leads })
      .from(enrollments)
      .innerJoin(leads, eq(leads.id, enrollments.lead_id))
      .where(and(eq(enrollments.status, 'active'), gt(enrollments.current_step, 0)))
      .limit(2000)
  ).filter((r) => reachable(r.lead, 'email'))
  if (rows.length === 0) return 0
  // Anything that reached the lead or Theo (a sent email, a LinkedIn task he did or skipped, a
  // postcard) counts. Only the rows the app wrote for a step with nowhere to go do not.
  const touched = new Set(
    (
      await db
        .select({ id: messages.enrollment_id, status: messages.status, error: messages.error })
        .from(messages)
        .where(
          and(
            inArray(
              messages.enrollment_id,
              rows.map((r) => r.enrollment.id),
            ),
            eq(messages.direction, 'out'),
          ),
        )
    )
      .filter(
        (m) =>
          !(
            (m.status === 'skipped' || m.status === 'failed') &&
            NEVER_REACHED_ERRORS.includes(m.error ?? '')
          ),
      )
      .map((m) => m.id),
  )
  const stepsCache = new Map<string, SequenceStep[]>()
  const now = deps.now().toISOString()
  let restarted = 0
  for (const { enrollment, lead } of rows) {
    if (touched.has(enrollment.id)) continue
    let steps = stepsCache.get(enrollment.sequence_id)
    if (!steps) {
      steps = await stepsFor(deps, enrollment.sequence_id)
      stepsCache.set(enrollment.sequence_id, steps)
    }
    // Only a newly found email restarts, so the lead gets email 1 instead of a follow-up. Once
    // email 1 is written the enrollment is touched, so a lead never restarts twice.
    const missedAnEmail = steps.some(
      (s) => s.step_index < enrollment.current_step && s.channel === 'email',
    )
    if (!missedAnEmail) continue
    await db
      .update(enrollments)
      .set({ current_step: 0, next_send_at: now, started_at: now, run: enrollment.run + 1 })
      .where(eq(enrollments.id, enrollment.id))
    await db
      .update(leads)
      .set({ next_action_at: now, updated_at: now })
      .where(eq(leads.id, lead.id))
    await logActivity(
      'info',
      'enrollment_restarted',
      { reason: 'a way to reach them was found, so the sequence starts again from step 1' },
      lead.id,
      db,
    )
    restarted++
  }
  return restarted
}

/** Errors the app writes on a step that never reached anyone (there was nothing to send it to). */
const NEVER_REACHED_ERRORS = [
  'no profile on file',
  'lead has no email',
  'lead has no mailing address',
  'no LinkedIn profile on file',
  'no Instagram profile on file',
]

/** Has this lead had an email from us before? Then the next one is a follow-up. */
async function emailedBefore(deps: OutreachDeps, leadId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.lead_id, leadId),
        eq(messages.channel, 'email'),
        eq(messages.direction, 'out'),
        eq(messages.status, 'sent'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** LinkedIn and Instagram tasks from before profiles were required, with no profile to open. */
async function skipProfilelessTasks(deps: OutreachDeps): Promise<void> {
  await deps.db
    .update(messages)
    .set({ status: 'skipped', error: 'no profile on file' })
    .where(
      and(
        eq(messages.status, 'ready_for_human'),
        inArray(messages.channel, ['linkedin', 'instagram']),
        or(isNull(messages.to_address), eq(messages.to_address, '')),
      ),
    )
}

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i

/** Only a public https address may receive lead data. Returns the reason when it may not. */
export function webhookUrlProblem(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'not a valid URL'
  }
  if (parsed.protocol !== 'https:') return 'must start with https://'
  if (!parsed.hostname) return 'has no host'
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return 'points at a private or local address'
  return null
}

/** `sha256=<hmac of the body>` with the webhook secret. The secret itself never leaves the app. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** POST a ready message to Theo's own webhook once. Errors are logged, never thrown. */
export async function notifyHumanQueueWebhook(
  deps: OutreachDeps,
  settings: Settings,
  message: Message,
  lead: Lead,
): Promise<void> {
  if (!settings.human_queue_webhook_url) return
  const problem = webhookUrlProblem(settings.human_queue_webhook_url)
  if (problem) {
    await logActivity(
      'warn',
      'human_queue_webhook_refused',
      { reason: `The human queue webhook URL ${problem}. Fix it in Settings` },
      lead.id,
      deps.db,
    )
    return
  }
  try {
    const body = JSON.stringify({
      message_id: message.id,
      lead_id: lead.id,
      channel: message.channel,
      person: lead.full_name ?? lead.company ?? '',
      to_address: message.to_address,
      subject: message.subject,
      body: message.body,
    })
    const res = await deps.fetch(settings.human_queue_webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-outreach-signature': signWebhookBody(settings.webhook_secret, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`webhook ${res.status}`)
  } catch (err) {
    await logActivity(
      'warn',
      'human_queue_webhook_failed',
      { error: err instanceof Error ? err.message : String(err) },
      lead.id,
      deps.db,
    )
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || 'outreach.local'
  } catch {
    return 'outreach.local'
  }
}

/**
 * Send everything that is due. Outside the send window nothing happens.
 * Live email and Lob mail go out only when live_mode is on; otherwise a dry_run row is written.
 * Human channels and print mail become ready_for_human whatever the mode, and the next step of
 * such a sequence waits until Theo has dealt with the one in the queue.
 * Running twice never sends twice: the message row with the idempotency key is written first,
 * flipped to `sending` before the provider call, and never handed to a provider again once
 * the outcome is unknown.
 */
const sendRuns = new WeakMap<OutreachDeps['db'], Promise<unknown>>()

/** Serialize manual queue refills with scheduled sends in this server process. */
export async function sendDue(
  deps: OutreachDeps,
  options: { onlyLinkedIn?: boolean } = {},
): Promise<SendDueResult> {
  const previous = sendRuns.get(deps.db) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => sendDueUnlocked(deps, options))
  sendRuns.set(deps.db, run)
  try {
    return await run
  } finally {
    if (sendRuns.get(deps.db) === run) sendRuns.delete(deps.db)
  }
}

async function sendDueUnlocked(
  deps: OutreachDeps,
  options: { onlyLinkedIn?: boolean },
): Promise<SendDueResult> {
  const { db } = deps
  const result: SendDueResult = { sent: 0, dryRun: 0, queued: 0, skipped: 0 }
  const settings = await getSettings(db)
  const now = deps.now()
  // Timed sequences off: the to-do list (todo.ts) puts every step up at once instead.
  if (!settings.sequences_on) return result
  if (!isWithinSendWindow(settings, now)) return result

  await skipProfilelessTasks(deps)
  await skipDuplicateLinkedInTasks(deps)
  // Inboxes on Google's servers may send through Sign in with Google: learn (cached a minute)
  // whether it is connected before deciding which inbox may send.
  if (
    !options.onlyLinkedIn &&
    settings.sending_inboxes.some((i) => i.active && isGoogleMailHost(i.smtp_host))
  ) {
    await refreshGoogleAccount(deps)
  }
  const restarted = options.onlyLinkedIn ? 0 : await restartUntouched(deps, settings)
  let waitingForResearch = 0
  let waitingForReplies = 0
  let waitingForGap = 0
  const due = await loadDue(deps, now.toISOString())
  const remaining = remainingToday(settings, await countTodayByChannel(db, settings, now))
  const linkedInRoom = () => (settings.channels.linkedin ? remaining.linkedin : 0)
  const early = new Set(await loadUpcomingLinkedIn(deps, now.toISOString(), linkedInRoom()))
  const taken = await loadLinkedInTaken(deps)
  if (due.length === 0 && early.size === 0 && linkedInRoom() === 0) return result
  const stepsCache = new Map<string, SequenceStep[]>()
  const refusedNoAddress = new Set<Channel>()
  let day: InboxDay | null = null
  const repliesUnread = replySyncFailures().length > 0

  const refuseNoAddress = async (channel: Channel, leadId: string) => {
    if (refusedNoAddress.has(channel)) return
    refusedNoAddress.add(channel)
    await logActivity(
      'error',
      channel === 'email' ? 'email_refused_no_address' : 'mail_refused_no_address',
      {
        reason: `Add your physical mailing address in Settings before live ${channel}`,
        channel,
      },
      leadId,
      db,
    )
  }

  for (const row of [...due, ...early]) {
    // Notes pulled ahead of their day only fill what is left of today's LinkedIn goal.
    if (early.has(row) && linkedInRoom() <= 0) break
    let channel: Channel = row.sequence.channel
    try {
      if (options.onlyLinkedIn) {
        const steps = stepsCache.get(row.sequence.id) ?? (await stepsFor(deps, row.sequence.id))
        stepsCache.set(row.sequence.id, steps)
        if (steps.find((s) => s.step_index === row.enrollment.current_step)?.channel !== 'linkedin')
          continue
      }
      const blocker = await contactBlocker(db, row.lead)
      if (blocker) {
        await stopLead(deps, row.lead.id, blocker)
        result.skipped++
        continue
      }
      if (!row.sequence.active) {
        result.skipped++
        continue
      }
      let steps = stepsCache.get(row.sequence.id)
      if (!steps) {
        steps = await stepsFor(deps, row.sequence.id)
        stepsCache.set(row.sequence.id, steps)
      }
      const step = steps.find((s) => s.step_index === row.enrollment.current_step)
      if (!step) {
        await db
          .update(enrollments)
          .set({ status: 'done', ended_at: now.toISOString(), next_send_at: null })
          .where(eq(enrollments.id, row.enrollment.id))
        result.skipped++
        continue
      }
      // Each step carries its own channel, so one sequence can email, then LinkedIn, then mail.
      channel = step.channel
      if (await hasItemWaiting(deps, row.enrollment.id, channel)) continue // his last one is open
      if (channel === 'email' && !settings.channels.email) {
        // The app sends no email (Theo writes to people himself): the step is skipped, not held,
        // so the LinkedIn note and the postcard after it still come up.
        await db
          .update(messages)
          .set({ status: 'skipped', error: EMAILS_OFF_ERROR })
          .where(
            and(
              eq(
                messages.idempotency_key,
                idempotencyKey(row.enrollment.id, step.step_index, row.enrollment.run),
              ),
              inArray(messages.status, ['queued', 'failed']),
            ),
          )
        await advance(deps, settings, row, steps, 'unreachable')
        result.skipped++
        continue
      }
      if (!settings.channels[channel]) {
        result.skipped++ // the channel is switched off: the step waits until it is back on
        continue
      }

      const key = idempotencyKey(row.enrollment.id, step.step_index, row.enrollment.run)
      const existing = (
        await db.select().from(messages).where(eq(messages.idempotency_key, key)).limit(1)
      )[0]
      if (existing) {
        if (existing.status === 'sending') {
          // The process died between the provider call and the `sent` write. Only Theo can tell.
          await db
            .update(messages)
            .set({ status: 'failed', error: OUTCOME_UNKNOWN_ERROR })
            .where(eq(messages.id, existing.id))
          await logActivity(
            'error',
            'send_outcome_unknown',
            { channel, message_id: existing.id, reason: OUTCOME_UNKNOWN_ERROR },
            row.lead.id,
            db,
          )
          result.skipped++
          continue
        }
        if (existing.status === 'failed') {
          if (!canRetry(existing)) {
            result.skipped++
            continue
          }
        } else if (existing.status !== 'queued') {
          // Already handled (a crash after the send but before the advance). Just move on.
          await advance(deps, settings, row, steps, outcomeForExisting(existing.status))
          result.skipped++
          continue
        }
      }

      const postal = channel === 'mail' ? postalAddressFor(row.lead) : null
      const noWayToReach =
        (channel === 'email' && !row.lead.email) ||
        (channel === 'mail' && !postal) ||
        ((channel === 'linkedin' || channel === 'instagram') && !reachable(row.lead, channel))
      if (noWayToReach) {
        // Research may still find the address or the profile: the step waits for its answer.
        if (channel !== 'mail' && awaitsResearch(row.lead, settings, deps.env)) {
          result.skipped++
          waitingForResearch++
          continue
        }
        const error =
          channel === 'email'
            ? 'lead has no email'
            : channel === 'mail'
              ? 'lead has no mailing address'
              : `no ${channel === 'linkedin' ? 'LinkedIn' : 'Instagram'} profile on file`
        if (existing) {
          await db
            .update(messages)
            .set({ status: 'failed', error })
            .where(eq(messages.id, existing.id))
        }
        // A later step on another channel can still reach them (no email: LinkedIn, then mail).
        const laterReachable = steps.some(
          (s) => s.step_index > step.step_index && reachable(row.lead, s.channel),
        )
        if (laterReachable) {
          await advance(deps, settings, row, steps, 'unreachable')
          await logActivity('info', 'send_step_skipped', { channel, error }, row.lead.id, db)
        } else {
          await endEnrollment(deps, row.enrollment.id)
          await logActivity('warn', 'send_step_impossible', { channel, error }, row.lead.id, db)
        }
        result.skipped++
        continue
      }

      // One connection note per person: another lead row or an older task already has them. A
      // later LinkedIn step (a message after they connect) follows its own enrollment.
      const firstLinkedIn = steps.find((s) => s.channel === 'linkedin')?.step_index
      if (channel === 'linkedin' && step.step_index === firstLinkedIn && isTaken(taken, row.lead)) {
        if (existing) {
          await db
            .update(messages)
            .set({ status: 'skipped', error: DUPLICATE_LINKEDIN_ERROR })
            .where(eq(messages.id, existing.id))
        }
        await advance(deps, settings, row, steps, 'skipped')
        await logActivity(
          'info',
          'send_step_skipped',
          { channel, error: DUPLICATE_LINKEDIN_ERROR },
          row.lead.id,
          db,
        )
        result.skipped++
        continue
      }

      // Never spam: one person, not one lead row. No second email to them inside the gap (the step
      // waits); one postcard per mailing address (the step is skipped).
      const block = await recipientBlocker(db, settings, row.lead, channel, now)
      if (block?.kind === 'email_too_soon') {
        result.skipped++
        waitingForGap++
        continue
      }
      if (block?.kind === 'postcard_already_sent') {
        const error = `a postcard already went to this mailing address on ${block.last_at.slice(0, 10)} (one per ${block.days} days)`
        if (existing) {
          await db
            .update(messages)
            .set({ status: 'skipped', error })
            .where(eq(messages.id, existing.id))
        }
        await advance(deps, settings, row, steps, 'skipped')
        await logActivity('info', 'send_step_skipped', { channel, error }, row.lead.id, db)
        result.skipped++
        continue
      }

      if (remaining[channel] <= 0) {
        result.skipped++
        continue
      }

      if (channel === 'email' && settings.live_mode) {
        // A reply may be sitting unread while the reply check fails: no follow-up until it works.
        if (repliesUnread && (await emailedBefore(deps, row.lead.id))) {
          result.skipped++
          waitingForReplies++
          continue
        }
        // Wait, unrendered and unclaimed, until an inbox may send: its login works, it is under
        // its daily limit, and its last email went MIN_GAP_MS ago. It goes on a later round.
        if (settings.sending_inboxes.some(canSend)) {
          day ??= await inboxDay(db, settings, now)
          if (!inboxForNow(settings.sending_inboxes, day, deps.now())) {
            result.skipped++
            continue
          }
        }
      }

      const rendered = await renderStepForLead(
        step,
        row.lead,
        settings,
        { baseUrl: deps.baseUrl, channel, sequenceName: row.sequence.name },
        deps.llm,
      )

      const human = isHuman(channel) || (channel === 'mail' && settings.mail_provider === 'print')
      const toAddress =
        channel === 'email'
          ? row.lead.email
          : channel === 'mail'
            ? JSON.stringify(postal)
            : humanAddress(row.lead, channel)

      let message: Message
      if (existing) {
        message = existing
        await db
          .update(messages)
          .set({
            subject: rendered.subject,
            body: rendered.body,
            to_address: toAddress,
            error: null,
          })
          .where(eq(messages.id, existing.id))
      } else {
        message = {
          id: newId(),
          lead_id: row.lead.id,
          enrollment_id: row.enrollment.id,
          step_id: step.id,
          channel,
          direction: 'out',
          status: 'queued',
          idempotency_key: key,
          subject: rendered.subject,
          body: rendered.body,
          to_address: toAddress,
          provider: null,
          provider_message_id: null,
          scheduled_at: row.enrollment.next_send_at,
          sent_at: null,
          error: null,
          attempts: 0,
          classification: null,
          raw: null,
          created_at: now.toISOString(),
        }
        try {
          await db.insert(messages).values(message)
        } catch {
          // Another run claimed this key first. Nothing to do.
          result.skipped++
          continue
        }
      }

      const finish = async (status: MessageStatus, patch: Partial<Message> = {}) => {
        await db
          .update(messages)
          .set({ status, ...patch })
          .where(eq(messages.id, message.id))
        message = { ...message, status, ...patch }
      }

      if (human) {
        await finish('ready_for_human', { provider: 'human' })
        if (channel === 'linkedin') markTaken(taken, row.lead)
        remaining[channel]--
        result.queued++
        await advance(deps, settings, row, steps, 'queued')
        await notifyHumanQueueWebhook(deps, settings, message, row.lead)
        continue
      }

      if (!settings.live_mode) {
        await finish('dry_run', { provider: 'dry_run' })
        remaining[channel]--
        result.dryRun++
        await advance(deps, settings, row, steps, 'dry_run')
        continue
      }

      // Live email and live Lob mail both need the CAN-SPAM / return address.
      if (!settings.physical_address.trim()) {
        await refuseNoAddress(channel, row.lead.id)
        result.skipped++
        continue // message stays queued, nothing was asked of a provider
      }

      // Warmed inboxes take turns, each under its own daily limit. With none usable, the .env
      // sender (if any) carries the mail as before.
      let inbox: SendingInbox | null = null
      if (channel === 'email') {
        day ??= await inboxDay(db, settings, now)
        inbox = inboxForNow(settings.sending_inboxes, day, deps.now())
        if (!inbox && settings.sending_inboxes.some(canSend)) {
          result.skipped++ // no inbox may send right now; the message stays queued
          continue
        }
      }

      // Claim the attempt before the provider is called, so a crash leaves a `sending` row.
      await finish('sending', { attempts: message.attempts + 1 })

      if (channel === 'email') {
        const unsubscribeUrl = `${deps.baseUrl}/u/${row.lead.unsubscribe_token}`
        try {
          const sent = await sendEmail(
            deps,
            settings,
            {
              to: row.lead.email ?? '',
              subject: rendered.subject ?? '',
              text: rendered.body,
              unsubscribeUrl,
              messageId: `<${key}@${hostOf(deps.baseUrl)}>`,
            },
            inbox,
          )
          if (inbox && day) {
            const k = inboxProvider(inbox)
            day.counts.set(k, (day.counts.get(k) ?? 0) + 1)
            day.lastSentAt.set(k, deps.now().getTime())
            noteLoginWorked(inbox)
          }
          await finish('sent', {
            provider: sent.provider,
            provider_message_id: sent.providerMessageId,
            sent_at: deps.now().toISOString(),
          })
          remaining[channel]--
          result.sent++
          await advance(deps, settings, row, steps, 'sent')
        } catch (err) {
          const error = mailErrorText(err)
          if (inbox && isLoginRefused(err)) {
            // Refused at login, before anything was handed over. The email waits and goes by
            // itself once the login works (a new password, or the hourly retry): no attempt used.
            await finish('failed', { error, attempts: Math.max(0, message.attempts - 1) })
            if (noteLoginRefused(inbox, deps.now(), error)) {
              await logActivity(
                'error',
                'inbox_login_refused',
                { inbox: inbox.email, error, fix: loginFix(inbox) },
                null,
                db,
              )
            }
            result.skipped++
            continue
          }
          await finish('failed', { error })
          await logActivity(
            'error',
            'email_send_failed',
            { error, attempts: message.attempts, retry: canRetry(message) },
            row.lead.id,
            db,
          )
          result.skipped++
        }
        continue
      }

      // channel === 'mail' with Lob
      try {
        const lob = await sendViaLob(deps, settings, postal!, rendered.body, key)
        await finish('sent', {
          provider: `lob_${lob.kind}`,
          provider_message_id: lob.id,
          sent_at: deps.now().toISOString(),
        })
        remaining[channel]--
        result.sent++
        await advance(deps, settings, row, steps, 'sent')
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        await finish('failed', { error })
        await logActivity(
          'error',
          'mail_send_failed',
          { error, attempts: message.attempts, retry: canRetry(message) },
          row.lead.id,
          db,
        )
        result.skipped++
      }
    } catch (err) {
      result.skipped++
      await logActivity(
        'error',
        'send_step_failed',
        { error: err instanceof Error ? err.message : String(err), channel },
        row.lead.id,
        db,
      )
    }
  }

  const caughtUp = await catchUpLinkedIn(deps, settings, taken, linkedInRoom())
  remaining.linkedin -= caughtUp
  result.queued += caughtUp

  if (result.sent + result.dryRun + result.queued + result.skipped > 0) {
    await logActivity(
      'info',
      'send',
      {
        ...result,
        ...(waitingForResearch > 0 ? { waiting_for_research: waitingForResearch } : {}),
        ...(waitingForReplies > 0 ? { waiting_for_reply_check: waitingForReplies } : {}),
        ...(waitingForGap > 0 ? { waiting_for_recipient_gap: waitingForGap } : {}),
        ...(restarted > 0 ? { restarted } : {}),
        ...(caughtUp > 0 ? { linkedin_caught_up: caughtUp } : {}),
      },
      null,
      db,
    )
  }
  return result
}
