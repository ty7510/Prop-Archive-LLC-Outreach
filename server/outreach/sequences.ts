// Sequence CRUD, preview and test send (spec section 6, Sequences).
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { RenderedStep, SequenceCreate, SequenceUpdate } from '../../shared/types.ts'
import {
  enrollments,
  leads,
  sequenceSteps,
  sequences,
  type Lead,
  type Sequence,
  type SequenceStep,
} from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { badRequest, notFound } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import type { OutreachDeps } from './deps.ts'
import { EMAIL_KEYS_HINT, pickEmailProvider, sendEmail } from './email.ts'
import { canSend, refreshGoogleAccount } from './inboxes.ts'
import { isGoogleMailHost } from '../../shared/settings.ts'
import { assertNoEmDash, renderStepForLead, sampleLead } from './templates.ts'

export interface SequenceWithSteps extends Sequence {
  steps: SequenceStep[]
  /** Leads currently active or paused in this sequence. */
  enrolled_count: number
}

async function stepsByIds(deps: OutreachDeps, ids: string[]): Promise<Map<string, SequenceStep[]>> {
  const out = new Map<string, SequenceStep[]>()
  if (ids.length === 0) return out
  const rows = await deps.db
    .select()
    .from(sequenceSteps)
    .where(inArray(sequenceSteps.sequence_id, ids))
    .orderBy(asc(sequenceSteps.step_index))
  for (const r of rows)
    (out.get(r.sequence_id) ?? out.set(r.sequence_id, []).get(r.sequence_id))?.push(r)
  return out
}

async function enrolledCounts(deps: OutreachDeps, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const rows = await deps.db
    .select({ sequence_id: enrollments.sequence_id, n: sql<number>`count(*)` })
    .from(enrollments)
    .where(
      and(inArray(enrollments.sequence_id, ids), inArray(enrollments.status, ['active', 'paused'])),
    )
    .groupBy(enrollments.sequence_id)
  for (const r of rows) out.set(r.sequence_id, Number(r.n))
  return out
}

export async function listSequences(deps: OutreachDeps): Promise<SequenceWithSteps[]> {
  const rows = await deps.db
    .select()
    .from(sequences)
    .orderBy(asc(sequences.channel), asc(sequences.name))
  const ids = rows.map((r) => r.id)
  const [steps, counts] = await Promise.all([stepsByIds(deps, ids), enrolledCounts(deps, ids)])
  return rows.map((r) => ({
    ...r,
    steps: steps.get(r.id) ?? [],
    enrolled_count: counts.get(r.id) ?? 0,
  }))
}

export async function getSequence(deps: OutreachDeps, id: string): Promise<SequenceWithSteps> {
  const rows = await deps.db.select().from(sequences).where(eq(sequences.id, id)).limit(1)
  const seq = rows[0]
  if (!seq) throw notFound('Sequence not found', 'SEQUENCE_NOT_FOUND')
  const [steps, counts] = await Promise.all([stepsByIds(deps, [id]), enrolledCounts(deps, [id])])
  return { ...seq, steps: steps.get(id) ?? [], enrolled_count: counts.get(id) ?? 0 }
}

type StepInput = SequenceCreate['steps'][number]

function stepRows(
  sequenceId: string,
  channel: Sequence['channel'],
  steps: StepInput[],
): SequenceStep[] {
  return steps.map((s, i) => {
    const stepChannel = s.channel ?? channel
    return {
      id: newId(),
      sequence_id: sequenceId,
      step_index: i,
      delay_days: s.delay_days,
      subject: stepChannel === 'email' ? (s.subject ?? null) : null,
      body: s.body,
      channel: stepChannel,
      notes: s.notes ?? null,
    }
  })
}

function validateSteps(channel: Sequence['channel'], steps: StepInput[]): void {
  steps.forEach((s, i) => {
    if ((s.channel ?? channel) === 'email' && (!s.subject || !s.subject.trim())) {
      throw badRequest(`Step ${i + 1} needs a subject line`, 'VALIDATION')
    }
  })
}

export async function createSequence(
  deps: OutreachDeps,
  input: SequenceCreate,
): Promise<SequenceWithSteps> {
  assertNoEmDash(input.steps, input.name, input.description)
  validateSteps(input.channel, input.steps)
  const now = deps.now().toISOString()
  const id = newId()
  await deps.db.insert(sequences).values({
    id,
    name: input.name,
    channel: input.channel,
    persona: input.persona,
    trigger: input.trigger,
    active: input.active,
    description: input.description ?? null,
    created_at: now,
    updated_at: now,
  })
  await deps.db.insert(sequenceSteps).values(stepRows(id, input.channel, input.steps))
  await logActivity(
    'info',
    'sequence_created',
    { name: input.name, channel: input.channel },
    null,
    deps.db,
  )
  return getSequence(deps, id)
}

export async function updateSequence(
  deps: OutreachDeps,
  id: string,
  input: SequenceUpdate,
): Promise<SequenceWithSteps> {
  const current = await getSequence(deps, id)
  const channel = input.channel ?? current.channel
  assertNoEmDash(input.steps ?? [], input.name ?? null, input.description ?? null)
  if (input.steps) validateSteps(channel, input.steps)
  else if (input.channel && input.channel !== current.channel) {
    throw badRequest('Changing the channel needs the steps sent along too', 'VALIDATION')
  }
  const now = deps.now().toISOString()
  await deps.db
    .update(sequences)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      updated_at: now,
    })
    .where(eq(sequences.id, id))
  if (input.steps) {
    // Preserve identity for text edits so pending messages still identify their exact step.
    const replacements = stepRows(id, channel, input.steps)
    const removed = current.steps
      .filter(
        (old) =>
          !replacements.some((s) => s.step_index === old.step_index && s.channel === old.channel),
      )
      .map((s) => s.id)
    if (removed.length)
      await deps.db.delete(sequenceSteps).where(inArray(sequenceSteps.id, removed))
    for (const replacement of replacements) {
      const old = current.steps.find(
        (s) => s.step_index === replacement.step_index && s.channel === replacement.channel,
      )
      if (old) {
        await deps.db
          .update(sequenceSteps)
          .set({ ...replacement, id: old.id })
          .where(eq(sequenceSteps.id, old.id))
      } else {
        await deps.db.insert(sequenceSteps).values(replacement)
      }
    }
  }
  await logActivity(
    'info',
    'sequence_updated',
    { id, name: input.name ?? current.name },
    null,
    deps.db,
  )
  return getSequence(deps, id)
}

export async function deleteSequence(deps: OutreachDeps, id: string): Promise<void> {
  const seq = await getSequence(deps, id)
  if (seq.enrolled_count > 0) {
    throw badRequest(
      `${seq.enrolled_count} ${seq.enrolled_count === 1 ? 'lead is' : 'leads are'} still in this sequence. Stop them first`,
      'SEQUENCE_IN_USE',
    )
  }
  await deps.db.delete(sequences).where(eq(sequences.id, id))
  await logActivity('info', 'sequence_deleted', { id, name: seq.name }, null, deps.db)
}

async function leadForPreview(deps: OutreachDeps, leadId: string | undefined): Promise<Lead> {
  if (!leadId) return sampleLead(deps.now())
  const rows = await deps.db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  const lead = rows[0]
  if (!lead) throw notFound('Lead not found', 'LEAD_NOT_FOUND')
  return lead
}

/** Every step rendered for a lead (or the sample lead). Links point at the tracked redirects. */
export async function previewSequence(
  deps: OutreachDeps,
  id: string,
  leadId?: string,
): Promise<RenderedStep[]> {
  const seq = await getSequence(deps, id)
  const lead = await leadForPreview(deps, leadId)
  const settings = await getSettings(deps.db)
  const out: RenderedStep[] = []
  for (const step of seq.steps) {
    const r = await renderStepForLead(
      step,
      lead,
      settings,
      { baseUrl: deps.baseUrl, channel: step.channel, sequenceName: seq.name },
      deps.llm,
      { logWarn: false },
    )
    out.push({
      step_id: step.id,
      step_index: step.step_index,
      delay_days: step.delay_days,
      channel: step.channel,
      subject: r.subject,
      body: r.body,
    })
  }
  return out
}

/** Render one step for a lead by ids. Backs OutreachModule.renderStep. */
export async function renderStep(
  deps: OutreachDeps,
  stepId: string,
  leadId: string,
): Promise<{ subject?: string; body: string }> {
  const rows = await deps.db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.id, stepId))
    .limit(1)
  const step = rows[0]
  if (!step) throw notFound('Step not found', 'STEP_NOT_FOUND')
  const seqRows = await deps.db
    .select()
    .from(sequences)
    .where(eq(sequences.id, step.sequence_id))
    .limit(1)
  const seq = seqRows[0]
  if (!seq) throw notFound('Sequence not found', 'SEQUENCE_NOT_FOUND')
  const lead = await leadForPreview(deps, leadId)
  const settings = await getSettings(deps.db)
  const r = await renderStepForLead(
    step,
    lead,
    settings,
    { baseUrl: deps.baseUrl, channel: step.channel, sequenceName: seq.name },
    deps.llm,
  )
  return r.subject === null ? { body: r.body } : { subject: r.subject, body: r.body }
}

/**
 * Email step 1 (rendered for the sample lead) to settings.owner_email. Goes out whatever live_mode
 * says, because it only reaches Theo. Needs an email provider and the physical address.
 */
export async function testSend(deps: OutreachDeps, id: string): Promise<{ ok: true; to: string }> {
  const seq = await getSequence(deps, id)
  // The test is an email to Theo, so it uses the first email step (or step 1 when there is none).
  const first = seq.steps.find((s) => s.channel === 'email') ?? seq.steps[0]
  if (!first) throw badRequest('This sequence has no steps yet', 'NO_STEPS')
  const settings = await getSettings(deps.db)
  if (settings.sending_inboxes.some((i) => isGoogleMailHost(i.smtp_host))) {
    await refreshGoogleAccount(deps) // Sign in with Google counts as a way to send
  }
  // A test goes out the way the sequence will: through the first warmed inbox when there is one.
  const inbox = settings.sending_inboxes.find(canSend) ?? null
  if (!inbox && !pickEmailProvider(deps, settings)) {
    throw badRequest(
      settings.sending_inboxes.length > 0
        ? 'No inbox can send: switch one on, sign in with Google, or type its app password again, under Settings > Sending inboxes'
        : `No sending inbox yet: ${EMAIL_KEYS_HINT}`,
      'NO_EMAIL_PROVIDER',
    )
  }
  if (!settings.physical_address.trim()) {
    throw badRequest('Add your physical mailing address in Settings first', 'NO_ADDRESS')
  }
  const lead = sampleLead(deps.now())
  const r = await renderStepForLead(
    first,
    lead,
    settings,
    { baseUrl: deps.baseUrl, channel: first.channel, sequenceName: seq.name },
    deps.llm,
    { withFooter: true, logWarn: false },
  )
  const subject = r.subject ?? `[Test] ${seq.name}, step ${first.step_index + 1} (${first.channel})`
  await sendEmail(
    deps,
    settings,
    {
      to: settings.owner_email,
      subject: `[Test] ${subject}`,
      text: r.body,
      unsubscribeUrl: `${deps.baseUrl}/u/${lead.unsubscribe_token}`,
    },
    inbox,
  )
  await logActivity(
    'info',
    'test_send',
    { sequence: seq.name, to: settings.owner_email },
    null,
    deps.db,
  )
  return { ok: true, to: settings.owner_email }
}
