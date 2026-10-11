// The human queue: ready_for_human messages, done / skip, and the print page for letters.
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Queue, QueueActionResult, QueueItem } from '../../shared/types.ts'
import { events, leads, messages, sequenceSteps, sequences } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { badRequest, notFound } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import type { OutreachDeps } from './deps.ts'
import type { PostalAddress } from './mail.ts'

function personOf(lead: { full_name: string | null; company: string | null }): string {
  return lead.full_name?.trim() || lead.company?.trim() || 'Unknown owner'
}

/** Every ready_for_human message, oldest first, grouped by channel. */
export async function listQueue(deps: OutreachDeps): Promise<Queue> {
  const rows = await deps.db
    .select({
      message: messages,
      lead_name: leads.full_name,
      lead_company: leads.company,
      sequence_name: sequences.name,
      step_index: sequenceSteps.step_index,
    })
    .from(messages)
    .innerJoin(leads, eq(leads.id, messages.lead_id))
    .leftJoin(sequenceSteps, eq(sequenceSteps.id, messages.step_id))
    .leftJoin(sequences, eq(sequences.id, sequenceSteps.sequence_id))
    .where(and(eq(messages.status, 'ready_for_human'), eq(messages.direction, 'out')))
    .orderBy(asc(messages.created_at))
    .limit(500)

  const groups: Queue['groups'] = { email: [], mail: [], linkedin: [], instagram: [], call: [] }
  for (const r of rows) {
    const item: QueueItem = {
      message_id: r.message.id,
      lead_id: r.message.lead_id,
      channel: r.message.channel,
      person: personOf({ full_name: r.lead_name, company: r.lead_company }),
      company: r.lead_company,
      to_address: r.message.to_address,
      subject: r.message.subject,
      body: r.message.body,
      sequence_name: r.sequence_name ?? null,
      step_index: r.step_index ?? null,
      scheduled_at: r.message.scheduled_at,
      created_at: r.message.created_at,
    }
    groups[r.message.channel].push(item)
  }
  return { groups, total: rows.length }
}

/** Theo did it (done) or will not (skip). Only ready_for_human rows can be acted on. */
export async function actOnQueueItem(
  deps: OutreachDeps,
  messageId: string,
  action: 'done' | 'skip',
  note?: string,
): Promise<QueueActionResult> {
  const { db } = deps
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
  const msg = rows[0]
  if (!msg) throw notFound('Message not found', 'MESSAGE_NOT_FOUND')
  if (msg.status !== 'ready_for_human') {
    throw badRequest(`This item is already marked ${msg.status.replace(/_/g, ' ')}`, 'NOT_IN_QUEUE')
  }
  const now = deps.now().toISOString()
  const status = action === 'done' ? 'sent' : 'skipped'
  await db
    .update(messages)
    .set({
      status,
      provider: 'human',
      sent_at: action === 'done' ? now : null,
      ...(note ? { error: null, raw: { note } } : {}),
    })
    .where(eq(messages.id, messageId))
  if (action === 'done') {
    await db
      .update(leads)
      .set({ last_contacted_at: now, updated_at: now })
      .where(eq(leads.id, msg.lead_id))
  }
  await db.insert(events).values({
    id: newId(),
    lead_id: msg.lead_id,
    kind: action === 'done' ? 'sent' : 'note',
    detail: { channel: msg.channel, queue: action, ...(note ? { note } : {}) },
    at: now,
  })
  await logActivity('info', `queue_${action}`, { channel: msg.channel }, msg.lead_id, db)
  return { message_id: messageId, status }
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parsePostal(to: string | null): PostalAddress | null {
  if (!to) return null
  try {
    const v = JSON.parse(to) as Partial<PostalAddress> | null
    if (v && typeof v === 'object' && typeof v.street === 'string') {
      return {
        name: v.name ?? '',
        ...(v.company ? { company: v.company } : {}),
        street: v.street,
        city: v.city ?? '',
        state: v.state ?? '',
        zip: v.zip ?? '',
      }
    }
  } catch {
    // not JSON
  }
  return null
}

/** A print-ready page: one letter per sheet with the address block, body and a hand-sign line. */
export async function printPage(deps: OutreachDeps, ids: string[]): Promise<string> {
  const settings = await getSettings(deps.db)
  const rows =
    ids.length === 0
      ? []
      : await deps.db
          .select({ message: messages, lead_name: leads.full_name, lead_company: leads.company })
          .from(messages)
          .innerJoin(leads, eq(leads.id, messages.lead_id))
          .where(and(inArray(messages.id, ids), eq(messages.channel, 'mail')))
  const letters = rows
    .map((r) => {
      const to = parsePostal(r.message.to_address)
      const name = to?.name || personOf({ full_name: r.lead_name, company: r.lead_company })
      const addr = to
        ? [name, to.company, to.street, `${to.city}, ${to.state} ${to.zip}`.trim()].filter(Boolean)
        : [name]
      return `<section class="letter">
  <header>
    <div class="from">${esc(settings.owner_name)}<br>Prop Archive LLC<br>${esc(settings.physical_address).replace(/,\s*/g, '<br>')}</div>
    <div class="to">${addr.map((l) => esc(l)).join('<br>')}</div>
  </header>
  <article>${esc(r.message.body)}</article>
  <footer><span class="sign">Signed</span><span class="line"></span></footer>
</section>`
    })
    .join('\n')
  const empty = `<p class="empty">Nothing to print. Pick letters in the queue first.</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Letters to print</title>
<style>
  body { margin: 0; font-family: Georgia, 'Times New Roman', serif; color: #111; background: #eee; }
  .toolbar { position: sticky; top: 0; background: #fff; padding: 12px 16px; border-bottom: 1px solid #ccc; font-family: Arial, sans-serif; }
  .toolbar button { font-size: 18px; padding: 10px 18px; min-height: 44px; cursor: pointer; }
  .letter { background: #fff; width: 8.5in; min-height: 11in; margin: 16px auto; padding: 1in; box-sizing: border-box; page-break-after: always; display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; gap: 2rem; font-size: 14px; line-height: 1.4; margin-bottom: 2rem; }
  article { white-space: pre-wrap; font-size: 15px; line-height: 1.6; flex: 1; }
  footer { margin-top: 3rem; display: flex; align-items: flex-end; gap: 1rem; font-size: 14px; }
  footer .line { flex: 0 0 3in; border-bottom: 1px solid #111; }
  .empty { font-family: Arial, sans-serif; text-align: center; padding: 3rem; font-size: 18px; }
  @media print { .toolbar { display: none; } body { background: #fff; } .letter { margin: 0; box-shadow: none; } }
  @media (max-width: 700px) { .letter { width: auto; min-height: 0; padding: 1rem; } }
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">Print these letters</button> <span>${rows.length} ${rows.length === 1 ? 'letter' : 'letters'}</span></div>
${letters || empty}
</body>
</html>`
}
