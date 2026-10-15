// The human queue: ready_for_human messages, done / skip / bring back, and the print page for letters.
import { and, asc, eq, gte, inArray, isNull, type SQL } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import { CHANNELS, type Queue, type QueueActionResult, type QueueItem } from '../../shared/types.ts'
import {
  enrollments,
  events,
  leads,
  messages,
  sequenceSteps,
  sequences,
  type Message,
} from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { badRequest, notFound } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import { startOfDayInTz } from '../lib/time.ts'
import type { OutreachDeps } from './deps.ts'
import { contactBlocker } from './enroll.ts'
import { POSTCARD_MAX_CHARS, type PostalAddress } from './mail.ts'
import { buildVars, renderTemplate } from './templates.ts'
import { profileKey, sendDue } from './send.ts'

/** Pending LinkedIn notes follow the template; completed history remains a snapshot. */
async function currentLinkedInBody(deps: OutreachDeps, message: Message): Promise<string> {
  if (
    message.channel !== 'linkedin' ||
    message.status !== 'ready_for_human' ||
    !message.enrollment_id
  ) {
    return message.body
  }
  const [context] = await deps.db
    .select({ lead: leads, sequence: sequences })
    .from(enrollments)
    .innerJoin(leads, eq(leads.id, enrollments.lead_id))
    .innerJoin(sequences, eq(sequences.id, enrollments.sequence_id))
    .where(eq(enrollments.id, message.enrollment_id))
  if (!context) return message.body
  const steps = await deps.db
    .select()
    .from(sequenceSteps)
    .where(
      and(
        eq(sequenceSteps.sequence_id, context.sequence.id),
        eq(sequenceSteps.channel, 'linkedin'),
      ),
    )
  // Older edits deleted step IDs. Recover only when there is one unambiguous LinkedIn step.
  const step =
    steps.find((s) => s.id === message.step_id) ?? (steps.length === 1 ? steps[0] : undefined)
  if (!step || step.body.includes('{{ai_opener}}')) return message.body
  const settings = await getSettings(deps.db)
  return renderTemplate(
    step.body,
    buildVars(context.lead, settings, {
      baseUrl: deps.baseUrl,
      channel: 'linkedin',
      sequenceName: context.sequence.name,
    }),
  ).text
}

function personOf(lead: { full_name: string | null; company: string | null }): string {
  return lead.full_name?.trim() || lead.company?.trim() || 'Unknown owner'
}

/** Queue messages matching `where`, oldest first, with the person and the step they belong to. */
async function queueRows(deps: OutreachDeps, where: SQL | undefined) {
  return deps.db
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
    .where(and(eq(messages.direction, 'out'), where))
    .orderBy(asc(messages.created_at))
    .limit(500)
}

function toItem(r: Awaited<ReturnType<typeof queueRows>>[number], body: string): QueueItem {
  return {
    message_id: r.message.id,
    lead_id: r.message.lead_id,
    channel: r.message.channel,
    person: personOf({ full_name: r.lead_name, company: r.lead_company }),
    company: r.lead_company,
    to_address: r.message.to_address,
    subject: r.message.subject,
    body,
    sequence_name: r.sequence_name ?? null,
    step_index: r.step_index ?? null,
    scheduled_at: r.message.scheduled_at,
    created_at: r.message.created_at,
  }
}

/**
 * Does someone already have a LinkedIn note waiting or sent from another sequence or lead row?
 * Notes of the message's own enrollment (a message after they connect) do not count.
 */
async function linkedInNoteHolders(deps: OutreachDeps, exceptId?: string) {
  const rows = (
    await deps.db
      .select({
        id: messages.id,
        lead_id: messages.lead_id,
        enrollment_id: messages.enrollment_id,
        to_address: messages.to_address,
      })
      .from(messages)
      .where(
        and(
          eq(messages.channel, 'linkedin'),
          eq(messages.direction, 'out'),
          inArray(messages.status, ['ready_for_human', 'sent']),
        ),
      )
  ).filter((r) => r.id !== exceptId)
  return (m: Pick<Message, 'lead_id' | 'enrollment_id' | 'to_address'>) => {
    const profile = m.to_address?.trim() ? profileKey(m.to_address) : null
    return rows.some(
      (r) =>
        (!m.enrollment_id || r.enrollment_id !== m.enrollment_id) &&
        (r.lead_id === m.lead_id ||
          (profile !== null && !!r.to_address?.trim() && profileKey(r.to_address) === profile)),
    )
  }
}

/** A LinkedIn or Instagram task with no profile to open cannot be done. */
function noProfile(m: Pick<Message, 'channel' | 'to_address'>): boolean {
  return (m.channel === 'linkedin' || m.channel === 'instagram') && !m.to_address?.trim()
}

/** How far back a skip can still be undone. */
const BRING_BACK_DAYS = 7

/**
 * Tasks Theo skipped in the last week, so a skip made by mistake can come back. His skip leaves
 * no error; the app's own skips (stopped, no profile) always carry one, so they never show here.
 */
async function skippedRecently(deps: OutreachDeps): Promise<QueueItem[]> {
  const since = new Date(deps.now().getTime() - BRING_BACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const skips = await deps.db
    .select({ lead_id: events.lead_id, detail: events.detail })
    .from(events)
    .where(and(eq(events.kind, 'note'), gte(events.at, since)))
  const keys = new Set<string>()
  for (const e of skips) {
    const d = e.detail as { queue?: unknown; channel?: unknown } | null
    if (e.lead_id && d?.queue === 'skip' && typeof d.channel === 'string') {
      keys.add(`${e.lead_id}:${d.channel}`)
    }
  }
  if (keys.size === 0) return []
  const rows = await queueRows(
    deps,
    and(
      eq(messages.status, 'skipped'),
      eq(messages.provider, 'human'),
      isNull(messages.error),
      inArray(messages.lead_id, [...new Set([...keys].map((k) => k.split(':')[0]!))]),
    ),
  )
  // Not one with no profile, not someone who has a note again, and each person once (newest).
  const hasNote = await linkedInNoteHolders(deps)
  const seen = new Set<string>()
  const items: QueueItem[] = []
  for (const r of [...rows].reverse()) {
    const m = r.message
    if (!keys.has(`${m.lead_id}:${m.channel}`) || noProfile(m)) continue
    if (m.channel === 'linkedin' && hasNote(m)) continue
    const person = `${m.channel}:${m.to_address?.trim() ? profileKey(m.to_address) : m.lead_id}`
    if (seen.has(person)) continue
    seen.add(person)
    items.push(toItem(r, m.body))
  }
  return items.reverse()
}

/** Per channel: tasks Theo marked done today, and his daily goal (the channel's daily cap). */
async function doneToday(
  deps: OutreachDeps,
  settings: Settings,
  dayStart: string,
): Promise<Queue['today']> {
  const done = await deps.db
    .select({ channel: messages.channel })
    .from(messages)
    .where(
      and(
        eq(messages.direction, 'out'),
        eq(messages.status, 'sent'),
        eq(messages.provider, 'human'),
        gte(messages.sent_at, dayStart),
      ),
    )
  const today = {} as Queue['today']
  for (const c of CHANNELS) today[c] = { done: 0, goal: settings.daily_caps[c] }
  for (const m of done) today[m.channel].done++
  return today
}

/** Every ready_for_human message, oldest first, grouped by channel; recent skips; today's goals. */
export async function listQueue(deps: OutreachDeps): Promise<Queue> {
  const rows = await queueRows(deps, eq(messages.status, 'ready_for_human'))
  const groups: Queue['groups'] = { email: [], mail: [], linkedin: [], instagram: [], call: [] }
  for (const r of rows) {
    groups[r.message.channel].push(toItem(r, await currentLinkedInBody(deps, r.message)))
  }
  const settings = await getSettings(deps.db)
  const dayStart = startOfDayInTz(deps.now(), settings.send_window.tz).toISOString()
  return {
    groups,
    total: rows.length,
    skipped_recently: await skippedRecently(deps),
    today: await doneToday(deps, settings, dayStart),
  }
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
  const body = await currentLinkedInBody(deps, msg)
  const status = action === 'done' ? 'sent' : 'skipped'
  await db
    .update(messages)
    .set({
      status,
      body,
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
  if (action === 'skip' && msg.channel === 'linkedin') {
    // Refill this human channel only. Never send email as a side effect of a skip.
    try {
      await sendDue(deps, { onlyLinkedIn: true })
    } catch (error) {
      // The skip already succeeded. Preserve that result; the scheduler can retry the refill.
      await logActivity(
        'error',
        'queue_refill_failed',
        {
          channel: msg.channel,
          error: error instanceof Error ? error.message : String(error),
        },
        msg.lead_id,
        db,
      )
    }
  }
  return { message_id: messageId, status }
}

/**
 * Theo skipped it by mistake: the task goes back in his queue (a LinkedIn note shows the words the
 * step has now). Never for a person who replied, opted out, bounced or was stopped since.
 */
export async function restoreQueueItem(
  deps: OutreachDeps,
  messageId: string,
): Promise<QueueActionResult> {
  const { db } = deps
  const msg = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]
  if (!msg) throw notFound('Message not found', 'MESSAGE_NOT_FOUND')
  if (msg.status !== 'skipped' || msg.provider !== 'human' || msg.error) {
    throw badRequest('Only a task you skipped can come back', 'NOT_SKIPPED_BY_YOU')
  }
  const lead = (await db.select().from(leads).where(eq(leads.id, msg.lead_id)).limit(1))[0]
  if (!lead) throw notFound('Lead not found', 'LEAD_NOT_FOUND')
  const enrollment = msg.enrollment_id
    ? (
        await db
          .select({ status: enrollments.status })
          .from(enrollments)
          .where(eq(enrollments.id, msg.enrollment_id))
          .limit(1)
      )[0]
    : undefined
  const blocker =
    (await contactBlocker(db, lead)) ??
    (enrollment?.status.startsWith('stopped') ? enrollment.status : null)
  if (blocker) {
    throw badRequest(
      `This person is not to be contacted now (${blocker.replace(/_/g, ' ')})`,
      'LEAD_BLOCKED',
    )
  }
  if (noProfile(msg)) throw badRequest('There is no profile to open for this person', 'NO_PROFILE')
  if (msg.channel === 'linkedin' && (await linkedInNoteHolders(deps, msg.id))(msg)) {
    throw badRequest('This person already has a LinkedIn note', 'ALREADY_HAS_NOTE')
  }
  const now = deps.now().toISOString()
  await db
    .update(messages)
    .set({ status: 'ready_for_human', sent_at: null })
    .where(and(eq(messages.id, messageId), eq(messages.status, 'skipped')))
  await db.insert(events).values({
    id: newId(),
    lead_id: msg.lead_id,
    kind: 'note',
    detail: { channel: msg.channel, queue: 'restore' },
    at: now,
  })
  await logActivity('info', 'queue_restore', { channel: msg.channel }, msg.lead_id, db)
  return { message_id: messageId, status: 'ready_for_human' }
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
  const pieces = rows
    .map((r) => {
      const to = parsePostal(r.message.to_address)
      const name = to?.name || personOf({ full_name: r.lead_name, company: r.lead_company })
      const addr = to
        ? [name, to.company, to.street, `${to.city}, ${to.state} ${to.zip}`.trim()].filter(Boolean)
        : [name]
      const toHtml = addr.map((l) => esc(l)).join('<br>')
      // "1500 Market St, Philadelphia, PA 19102": the street on one line, city, state and zip below.
      const fromHtml = `${esc(settings.owner_name)}<br>Prop Archive LLC<br>${esc(settings.physical_address).replace(/,\s*/, '<br>')}`
      if (r.message.body.length > POSTCARD_MAX_CHARS) {
        return `<section class="letter">
  <header>
    <div class="from">${fromHtml}</div>
    <div class="to">${toHtml}</div>
  </header>
  <article>${esc(r.message.body)}</article>
  <footer><span class="sign">Signed</span><span class="line"></span></footer>
</section>`
      }
      // A 4x6 postcard: the message side, then the address side (print double-sided).
      return `<section class="card message">
  <article>${esc(r.message.body)}</article>
</section>
<section class="card address">
  <div class="from">${fromHtml}</div>
  <div class="stamp">Stamp</div>
  <div class="to">${toHtml}</div>
</section>`
    })
    .join('\n')
  const cards = rows.filter((r) => r.message.body.length <= POSTCARD_MAX_CHARS).length
  const letters = rows.length - cards
  const counted = [
    cards ? `${cards} ${cards === 1 ? 'postcard' : 'postcards'}` : '',
    letters ? `${letters} ${letters === 1 ? 'letter' : 'letters'}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const empty = `<p class="empty">Nothing to print. Pick postcards in the queue first.</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Postcards to print</title>
<style>
  @page { margin: 0; }
  @page card { size: 6in 4in; margin: 0; }
  @page letter { size: letter; margin: 0; }
  body { margin: 0; font-family: Georgia, 'Times New Roman', serif; color: #111; background: #eee; }
  .toolbar { position: sticky; top: 0; background: #fff; padding: 12px 16px; border-bottom: 1px solid #ccc; font-family: Arial, sans-serif; font-size: 15px; line-height: 1.5; }
  .toolbar button { font-size: 18px; padding: 10px 18px; min-height: 44px; cursor: pointer; margin-right: 12px; }
  .card { page: card; background: #fff; width: 6in; height: 4in; margin: 16px auto; padding: 0.35in; box-sizing: border-box; page-break-after: always; break-after: page; overflow: hidden; position: relative; }
  .card.message article { white-space: pre-wrap; font-size: 16px; line-height: 1.5; }
  .card.address .from { font-size: 10px; line-height: 1.35; max-width: 2.6in; }
  .card.address .stamp { position: absolute; top: 0.3in; right: 0.3in; width: 0.85in; height: 1in; border: 1px dashed #888; font: 10px Arial, sans-serif; color: #888; display: flex; align-items: center; justify-content: center; }
  .card.address .to { position: absolute; left: 2.9in; top: 1.9in; font-size: 14px; line-height: 1.45; }
  .letter { page: letter; background: #fff; width: 8.5in; min-height: 11in; margin: 16px auto; padding: 1in; box-sizing: border-box; page-break-after: always; display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; gap: 2rem; font-size: 14px; line-height: 1.4; margin-bottom: 2rem; }
  .letter article { white-space: pre-wrap; font-size: 15px; line-height: 1.6; flex: 1; }
  footer { margin-top: 3rem; display: flex; align-items: flex-end; gap: 1rem; font-size: 14px; }
  footer .line { flex: 0 0 3in; border-bottom: 1px solid #111; }
  .empty { font-family: Arial, sans-serif; text-align: center; padding: 3rem; font-size: 18px; }
  @media print { .toolbar { display: none; } body { background: #fff; } .card, .letter { margin: 0; } }
  @media (max-width: 700px) { .letter { width: auto; min-height: 0; padding: 1rem; } }
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">Print or save as PDF</button><span>${counted || 'Nothing selected'}. Load 4x6 postcard stock and print double-sided (flip on the short edge). To download instead, pick "Save as PDF" as the printer. Then sign, stamp and mail.</span></div>
${pieces || empty}
</body>
</html>`
}
