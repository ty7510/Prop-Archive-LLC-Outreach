// sendDue: due steps -> render -> live send, dry run row, or human queue (spec sections 10 and 11.4).
// At-most-once: a `queued` message row claims the idempotency key before any provider is called.
import { and, asc, eq, lte } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
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
import { logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { isWithinSendWindow } from '../lib/sendWindow.ts'
import { getSettings } from '../lib/settings.ts'
import type { OutreachDeps } from './deps.ts'
import { sendEmail } from './email.ts'
import { contactBlocker, stopLead } from './enroll.ts'
import { postalAddressFor, sendViaLob } from './mail.ts'
import { countTodayByChannel, nextSendAt, remainingToday } from './scheduler.ts'
import { renderStepForLead } from './templates.ts'

export interface SendDueResult {
  sent: number
  dryRun: number
  queued: number
  skipped: number
}

export function idempotencyKey(enrollmentId: string, stepIndex: number): string {
  return `${enrollmentId}:${stepIndex}`
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

/** Move the enrollment to the next step or mark it done; stamp the lead as contacted. */
async function advance(
  deps: OutreachDeps,
  settings: Settings,
  row: DueRow,
  steps: SequenceStep[],
  outcome: 'sent' | 'queued' | 'dry_run',
): Promise<void> {
  const { db } = deps
  const now = deps.now()
  const nextIndex = row.enrollment.current_step + 1
  const next = steps.find((s) => s.step_index === nextIndex)
  if (next) {
    const at = nextSendAt(settings, now, next.delay_days, deps.random)
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
  if (outcome !== 'dry_run') {
    patch.last_contacted_at = now.toISOString()
    if (['new', 'enriching', 'enriched', 'enrolled'].includes(row.lead.status)) {
      patch.status = 'contacted'
    }
  }
  await db.update(leads).set(patch).where(eq(leads.id, row.lead.id))
  if (outcome !== 'dry_run') {
    await db.insert(events).values({
      id: newId(),
      lead_id: row.lead.id,
      kind: outcome,
      detail: {
        sequence: row.sequence.name,
        channel: row.sequence.channel,
        step: row.enrollment.current_step,
      },
      at: now.toISOString(),
    })
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

/** POST a ready message to Theo's own webhook once. Errors are logged, never thrown. */
export async function notifyHumanQueueWebhook(
  deps: OutreachDeps,
  settings: Settings,
  message: Message,
  lead: Lead,
): Promise<void> {
  if (!settings.human_queue_webhook_url) return
  try {
    const res = await deps.fetch(settings.human_queue_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-outreach-secret': settings.webhook_secret },
      body: JSON.stringify({
        message_id: message.id,
        lead_id: lead.id,
        channel: message.channel,
        person: lead.full_name ?? lead.company ?? '',
        to_address: message.to_address,
        subject: message.subject,
        body: message.body,
      }),
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

/**
 * Send everything that is due. Outside the send window nothing happens.
 * Live email and Lob mail go out only when live_mode is on; otherwise a dry_run row is written.
 * Human channels and print mail become ready_for_human whatever the mode.
 * Running twice never sends twice: the message row with the idempotency key is written first.
 */
export async function sendDue(deps: OutreachDeps): Promise<SendDueResult> {
  const { db } = deps
  const result: SendDueResult = { sent: 0, dryRun: 0, queued: 0, skipped: 0 }
  const settings = await getSettings(db)
  const now = deps.now()
  if (!isWithinSendWindow(settings, now)) return result

  const due = await loadDue(deps, now.toISOString())
  if (due.length === 0) return result
  const remaining = remainingToday(settings, await countTodayByChannel(db, settings, now))
  const stepsCache = new Map<string, SequenceStep[]>()

  for (const row of due) {
    const channel = row.sequence.channel
    try {
      const blocker = await contactBlocker(db, row.lead)
      if (blocker) {
        await stopLead(deps, row.lead.id, blocker)
        result.skipped++
        continue
      }
      if (!row.sequence.active || !settings.channels[channel]) {
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

      const key = idempotencyKey(row.enrollment.id, step.step_index)
      const existing = (
        await db.select().from(messages).where(eq(messages.idempotency_key, key)).limit(1)
      )[0]
      if (existing && !['queued', 'failed'].includes(existing.status)) {
        // Already handled (a crash after the send but before the advance). Just move on.
        await advance(
          deps,
          settings,
          row,
          steps,
          existing.status === 'dry_run' ? 'dry_run' : 'sent',
        )
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
            ? JSON.stringify(postalAddressFor(row.lead))
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

      if (channel === 'email') {
        if (!settings.physical_address.trim()) {
          await logActivity(
            'error',
            'email_refused_no_address',
            { reason: 'Add your physical mailing address in Settings before live email' },
            row.lead.id,
            db,
          )
          result.skipped++
          continue // message stays queued
        }
        if (!row.lead.email) {
          await finish('failed', { error: 'lead has no email' })
          result.skipped++
          continue
        }
        const unsubscribeUrl = `${deps.baseUrl}/u/${row.lead.unsubscribe_token}`
        try {
          const sent = await sendEmail(deps, settings, {
            to: row.lead.email,
            subject: rendered.subject ?? '',
            text: rendered.body,
            unsubscribeUrl,
          })
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
          await logActivity('error', 'email_send_failed', { error }, row.lead.id, db)
          result.skipped++
        }
        continue
      }

      // channel === 'mail' with Lob
      const postal = postalAddressFor(row.lead)
      if (!postal) {
        await finish('failed', { error: 'lead has no mailing address' })
        result.skipped++
        continue
      }
      try {
        const lob = await sendViaLob(deps, settings, postal, rendered.body, key)
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
        await logActivity('error', 'mail_send_failed', { error }, row.lead.id, db)
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
    await logActivity('info', 'send', result, null, db)
  }
  return result
}
