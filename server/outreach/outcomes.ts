// Outcomes that stop outreach: demo booked, beta joined, not interested, replied (webhook, lead
// panel, Go page).
import { eq } from 'drizzle-orm'
import type { Channel, LeadStatus, OutcomeKind } from '../../shared/types.ts'
import { events, leads, messages, type Lead } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { notFound } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { normaliseEmail } from '../lib/text.ts'
import type { OutreachDeps } from './deps.ts'
import { stopLead } from './enroll.ts'

export function statusForOutcome(kind: OutcomeKind): LeadStatus {
  switch (kind) {
    case 'demo_booked':
      return 'booked'
    case 'beta_joined':
      return 'joined'
    case 'not_interested':
      return 'not_interested'
    case 'replied':
      return 'replied'
  }
}

/** A reply never undoes a better outcome already on the lead. */
const AFTER_A_REPLY: LeadStatus[] = ['booked', 'joined']

/** Find a lead by id, else by email. */
export async function findLeadByIdOrEmail(
  deps: OutreachDeps,
  ref: { lead_id?: string | undefined; email?: string | undefined },
): Promise<Lead | null> {
  if (ref.lead_id) {
    const rows = await deps.db.select().from(leads).where(eq(leads.id, ref.lead_id)).limit(1)
    if (rows[0]) return rows[0]
  }
  const email = normaliseEmail(ref.email)
  if (email) {
    const rows = await deps.db.select().from(leads).where(eq(leads.email, email)).limit(1)
    if (rows[0]) return rows[0]
  }
  return null
}

/** Record an outcome: stop all enrollments, set the lead status, write an event. Returns the lead. */
export async function recordOutcome(
  deps: OutreachDeps,
  leadId: string,
  kind: OutcomeKind,
  source: 'webhook' | 'manual' = 'manual',
  reply: { channel?: Channel | undefined; note?: string | undefined } = {},
): Promise<Lead> {
  const { db } = deps
  const now = deps.now().toISOString()
  const rows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  const lead = rows[0]
  if (!lead) throw notFound('Lead not found', 'LEAD_NOT_FOUND')
  await stopLead(deps, leadId, kind)
  if (kind === 'replied') {
    const channel = reply.channel ?? 'linkedin'
    const note = reply.note?.trim() || null
    // Their answer goes on the lead's timeline like an email reply read from the inbox.
    const id = newId()
    await db.insert(messages).values({
      id,
      lead_id: leadId,
      channel,
      direction: 'in',
      status: 'received',
      idempotency_key: `reply-by-hand:${id}`,
      body: note ?? '',
      provider: 'human',
      sent_at: now,
      classification: 'other',
      created_at: now,
    })
    await db
      .update(leads)
      .set({
        ...(AFTER_A_REPLY.includes(lead.status) ? {} : { status: 'replied' as const }),
        last_replied_at: now,
        updated_at: now,
        next_action_at: null,
      })
      .where(eq(leads.id, leadId))
    await db.insert(events).values({
      id: newId(),
      lead_id: leadId,
      kind: 'reply',
      detail: { outcome: kind, source, channel, ...(note ? { note } : {}) },
      at: now,
    })
    await logActivity('info', 'replied', { source, channel }, leadId, db)
  } else {
    await db
      .update(leads)
      .set({ status: statusForOutcome(kind), updated_at: now, next_action_at: null })
      .where(eq(leads.id, leadId))
    const eventKind = kind === 'not_interested' ? 'status_change' : kind
    await db.insert(events).values({
      id: newId(),
      lead_id: leadId,
      kind: eventKind,
      detail: { outcome: kind, source },
      at: now,
    })
    await logActivity('info', kind, { source }, leadId, db)
  }
  const after = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  return after[0] ?? lead
}
