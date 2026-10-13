// sendDue: due steps -> render -> live send, dry run row, or human queue (spec sections 10 and 11.4).
// At-most-once: a message row claims the idempotency key before any provider is called, and the
// row is marked `sending` right before the provider call. A row left in `sending` (the process died
// mid-send) is never resent by the machine: its outcome is unknown and only Theo can check.
import { createHmac } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNull, lte, notInArray, or } from 'drizzle-orm'
import type { SendingInbox, Settings } from '../../shared/settings.ts'
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
import { countTodayByChannel, nextSendAt, remainingToday } from './scheduler.ts'
import { canSend, inboxProvider, pickInbox, sentTodayByInbox } from './inboxes.ts'
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
    const at = nextSendAt(settings, now, delay, deps.random)
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
  const rows = await db
    .select({ enrollment: enrollments, lead: leads })
    .from(enrollments)
    .innerJoin(leads, eq(leads.id, enrollments.lead_id))
    .where(and(eq(enrollments.status, 'active'), gt(enrollments.current_step, 0)))
    .limit(2000)
  if (rows.length === 0) return 0
  const touched = new Set(
    (
      await db
        .select({ id: messages.enrollment_id })
        .from(messages)
        .where(
          and(
            inArray(
              messages.enrollment_id,
              rows.map((r) => r.enrollment.id),
            ),
            eq(messages.direction, 'out'),
            notInArray(messages.status, ['skipped']),
          ),
        )
    ).map((m) => m.id),
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
    const wayIn = steps.some(
      (s) =>
        s.step_index < enrollment.current_step &&
        settings.channels[s.channel] &&
        reachable(lead, s.channel),
    )
    if (!wayIn) continue
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
export async function sendDue(deps: OutreachDeps): Promise<SendDueResult> {
  const { db } = deps
  const result: SendDueResult = { sent: 0, dryRun: 0, queued: 0, skipped: 0 }
  const settings = await getSettings(db)
  const now = deps.now()
  if (!isWithinSendWindow(settings, now)) return result

  await skipProfilelessTasks(deps)
  const restarted = await restartUntouched(deps, settings)
  let waitingForResearch = 0
  const due = await loadDue(deps, now.toISOString())
  if (due.length === 0) return result
  const remaining = remainingToday(settings, await countTodayByChannel(db, settings, now))
  const stepsCache = new Map<string, SequenceStep[]>()
  const refusedNoAddress = new Set<Channel>()
  let sentByInbox: Map<string, number> | null = null

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

  for (const row of due) {
    let channel: Channel = row.sequence.channel
    try {
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

      if (remaining[channel] <= 0) {
        result.skipped++
        continue
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
        sentByInbox ??= await sentTodayByInbox(db, settings, now)
        inbox = pickInbox(settings.sending_inboxes, sentByInbox)
        if (!inbox && settings.sending_inboxes.some(canSend)) {
          result.skipped++ // every inbox hit its limit today; the message stays queued
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
          if (inbox && sentByInbox) {
            const k = inboxProvider(inbox)
            sentByInbox.set(k, (sentByInbox.get(k) ?? 0) + 1)
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
          const error = err instanceof Error ? err.message : String(err)
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

  if (result.sent + result.dryRun + result.queued + result.skipped > 0) {
    await logActivity(
      'info',
      'send',
      {
        ...result,
        ...(waitingForResearch > 0 ? { waiting_for_research: waitingForResearch } : {}),
        ...(restarted > 0 ? { restarted } : {}),
      },
      null,
      db,
    )
  }
  return result
}
