// The human queue: ready_for_human messages, done / skip / bring back, and the print page for letters.
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm'
import {
  PRINTOUT_CSS,
  PRINTOUT_FIT_SCRIPT,
  PRINTOUT_FONT_LINK,
  PRINTOUT_LIMITS,
  printoutSection,
} from '../../shared/printout.ts'
import type { Settings } from '../../shared/settings.ts'
import {
  CHANNELS,
  type EditStepBody,
  type EditStepResult,
  type LinkedInNote,
  type LinkedInProfileResult,
  type LinkedInWanted,
  type PrintoutDoc,
  type Queue,
  type QueueActionResult,
  type QueueItem,
  type TodoStepKind,
} from '../../shared/types.ts'
import {
  enrollments,
  events,
  leads,
  messages,
  sequenceSteps,
  sequences,
  type Lead,
  type Message,
} from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { badRequest, notFound } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import { startOfDayInTz } from '../lib/time.ts'
import type { OutreachDeps } from './deps.ts'
import { computeChannels } from '../enrich/channels.ts'
import { BLOCKED_LEAD_STATUSES, contactBlocker } from './enroll.ts'
import { parsePostal, POSTCARD_MAX_CHARS, type PostalAddress } from './mail.ts'
import { writePersonalNote } from './linkedinNote.ts'
import { printoutParts } from './printout.ts'
import { buildVars, renderTemplate, type TemplateVars } from './templates.ts'
import { profileKey, sendDue } from './send.ts'
import {
  addLinkedInStepToOpenCard,
  fillTodo,
  parseTodoKey,
  stepProblems,
  TODO_KEY_PREFIX,
} from './todo.ts'

/**
 * A waiting LinkedIn note's lead and the step's text rendered for them (Theo's own note), or null
 * when the note is not waiting, has no step, or the step writes its own opener ({{ai_opener}}).
 */
async function linkedInTemplate(
  deps: OutreachDeps,
  message: Message,
): Promise<{ lead: Lead; vars: TemplateVars; text: string } | null> {
  if (
    message.channel !== 'linkedin' ||
    message.status !== 'ready_for_human' ||
    !message.enrollment_id
  ) {
    return null
  }
  const [context] = await deps.db
    .select({ lead: leads, sequence: sequences })
    .from(enrollments)
    .innerJoin(leads, eq(leads.id, enrollments.lead_id))
    .innerJoin(sequences, eq(sequences.id, enrollments.sequence_id))
    .where(eq(enrollments.id, message.enrollment_id))
  if (!context) return null
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
  if (!step || step.body.includes('{{ai_opener}}')) return null
  const settings = await getSettings(deps.db)
  const vars = buildVars(context.lead, settings, {
    baseUrl: deps.baseUrl,
    channel: 'linkedin',
    sequenceName: context.sequence.name,
  })
  return { lead: context.lead, vars, text: renderTemplate(step.body, vars).text }
}

/** The note written for this person, and the text of Theo's note it was written from. */
interface PersonalNoteMark {
  template: string
  at: string
}

function personalNoteMark(raw: unknown): PersonalNoteMark | null {
  const mark = (raw as { personal_note?: unknown } | null)?.personal_note as
    Partial<PersonalNoteMark> | undefined
  return typeof mark?.template === 'string' && typeof mark.at === 'string'
    ? { template: mark.template, at: mark.at }
    : null
}

/**
 * What a waiting LinkedIn note says now: the note written for this person while Theo's note is
 * unchanged, otherwise Theo's note as the step reads today. Completed history stays a snapshot.
 */
async function currentLinkedInBody(
  deps: OutreachDeps,
  message: Message,
): Promise<{ body: string; personal: boolean }> {
  const template = await linkedInTemplate(deps, message)
  if (!template) return { body: message.body, personal: false }
  if (personalNoteMark(message.raw)?.template === template.text) {
    return { body: message.body, personal: true }
  }
  return { body: template.text, personal: false }
}

/** One note written at a time per message, however many requests ask for it. */
const writing = new Map<string, Promise<LinkedInNote>>()

/**
 * The note for one waiting LinkedIn message, written for that person and their company and saved
 * on the message, so it is written once. Theo's own note when there is no model or it fails.
 */
export function personalLinkedInNote(deps: OutreachDeps, messageId: string): Promise<LinkedInNote> {
  const inFlight = writing.get(messageId)
  if (inFlight) return inFlight
  const job = (async (): Promise<LinkedInNote> => {
    const [msg] = await deps.db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!msg) throw notFound('Message not found', 'MESSAGE_NOT_FOUND')
    const current = await currentLinkedInBody(deps, msg)
    if (current.personal) return { message_id: msg.id, ...current }
    const template = await linkedInTemplate(deps, msg)
    if (!template) return { message_id: msg.id, ...current }
    const note = await writePersonalNote(template.lead, template.vars, template.text, deps.llm)
    if (!note) return { message_id: msg.id, body: template.text, personal: false }
    const mark: PersonalNoteMark = { template: template.text, at: deps.now().toISOString() }
    const saved = await deps.db
      .update(messages)
      .set({ body: note, raw: { personal_note: mark } })
      .where(and(eq(messages.id, msg.id), eq(messages.status, 'ready_for_human')))
      .returning({ id: messages.id })
    if (saved.length === 0) return { message_id: msg.id, body: msg.body, personal: false }
    return { message_id: msg.id, body: note, personal: true }
  })().finally(() => writing.delete(messageId))
  writing.set(messageId, job)
  return job
}

/** Write the missing notes in the background, two at a time; the next queue load shows them. */
function writeMissingNotes(deps: OutreachDeps, messageIds: string[]): void {
  if (!deps.llm || messageIds.length === 0) return
  const todo = messageIds.filter((id) => !writing.has(id))
  const next = async (): Promise<void> => {
    const id = todo.shift()
    if (!id) return
    await personalLinkedInNote(deps, id).catch(() => undefined)
    await next()
  }
  void Promise.all([next(), next()])
}

function personOf(lead: { full_name: string | null; company: string | null }): string {
  return lead.full_name?.trim() || lead.company?.trim() || 'Unknown owner'
}

/** Queue messages matching `where`, oldest first, with the person and the step they belong to. */
async function queueRows(deps: OutreachDeps, where: SQL | undefined, limit = 500) {
  return deps.db
    .select({
      message: messages,
      lead_name: leads.full_name,
      lead_company: leads.company,
      lead_phone: leads.phone,
      lead_email: leads.email,
      sequence_name: sequences.name,
      step_index: sequenceSteps.step_index,
    })
    .from(messages)
    .innerJoin(leads, eq(leads.id, messages.lead_id))
    .leftJoin(sequenceSteps, eq(sequenceSteps.id, messages.step_id))
    .leftJoin(sequences, eq(sequences.id, sequenceSteps.sequence_id))
    .where(and(eq(messages.direction, 'out'), where))
    .orderBy(asc(messages.created_at))
    .limit(limit)
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
    sent_at: r.message.sent_at,
    phone: r.lead_phone,
    email: r.lead_email,
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

/** How far back "did they write back?" looks. */
const CONTACTED_DAYS = 30

/**
 * People Theo reached by hand (LinkedIn note, postcard, call) in the last month who have not
 * answered, newest first, each person once: where he logs a reply when one comes in.
 */
async function contactedRecently(deps: OutreachDeps): Promise<QueueItem[]> {
  const since = new Date(deps.now().getTime() - CONTACTED_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rows = await queueRows(
    deps,
    and(
      eq(messages.status, 'sent'),
      eq(messages.provider, 'human'),
      gte(messages.sent_at, since),
      notInArray(leads.status, [...BLOCKED_LEAD_STATUSES]),
    ),
    1000,
  )
  const seen = new Set<string>()
  const items: QueueItem[] = []
  for (const r of [...rows].sort((a, b) =>
    (b.message.sent_at ?? '').localeCompare(a.message.sent_at ?? ''),
  )) {
    if (seen.has(r.message.lead_id)) continue
    seen.add(r.message.lead_id)
    items.push(toItem(r, r.message.body))
  }
  return items.slice(0, 100)
}

/**
 * People in a running sequence with no LinkedIn profile and no note yet, best fit first. Theo can
 * look them up himself and paste the profile; the note then comes up (send.ts catch-up).
 */
async function linkedInWanted(deps: OutreachDeps, limit = 15): Promise<LinkedInWanted[]> {
  const rows = await deps.db
    .selectDistinct({
      lead_id: leads.id,
      full_name: leads.full_name,
      company: leads.company,
      city: leads.mailing_city,
      icp_score: leads.icp_score,
    })
    .from(leads)
    .innerJoin(enrollments, eq(enrollments.lead_id, leads.id))
    .innerJoin(sequences, eq(sequences.id, enrollments.sequence_id))
    .where(
      and(
        eq(enrollments.status, 'active'),
        eq(sequences.active, true),
        eq(leads.do_not_contact, false),
        notInArray(leads.status, [...BLOCKED_LEAD_STATUSES]),
        sql`trim(coalesce(${leads.linkedin_url}, '')) = ''`,
        sql`not exists (select 1 from ${messages} m where m.lead_id = ${leads.id} and m.channel = 'linkedin' and m.direction = 'out' and m.status in ('ready_for_human', 'sent'))`,
      ),
    )
    .orderBy(desc(leads.icp_score))
    .limit(limit)
  return rows.map((r) => ({
    lead_id: r.lead_id,
    person: personOf({ full_name: r.full_name, company: r.company }),
    company: r.company,
    city: r.city,
  }))
}

/** Every ready_for_human message, oldest first, grouped by channel; recent skips; today's goals. */
export async function listQueue(deps: OutreachDeps): Promise<Queue> {
  const rows = await queueRows(deps, eq(messages.status, 'ready_for_human'))
  const groups: Queue['groups'] = { email: [], mail: [], linkedin: [], instagram: [], call: [] }
  const unwritten: string[] = []
  for (const r of rows) {
    const current = await currentLinkedInBody(deps, r.message)
    if (r.message.channel === 'linkedin' && !current.personal) unwritten.push(r.message.id)
    groups[r.message.channel].push({ ...toItem(r, current.body), personal_note: current.personal })
  }
  writeMissingNotes(deps, unwritten)
  const settings = await getSettings(deps.db)
  const dayStart = startOfDayInTz(deps.now(), settings.send_window.tz).toISOString()
  return {
    groups,
    total: rows.length,
    skipped_recently: await skippedRecently(deps),
    contacted_recently: await contactedRecently(deps),
    linkedin_wanted: settings.channels.linkedin ? await linkedInWanted(deps) : [],
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
  const { body } = await currentLinkedInBody(deps, msg)
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
  if (
    action === 'skip' &&
    msg.channel === 'linkedin' &&
    (msg.idempotency_key ?? '').startsWith(TODO_KEY_PREFIX)
  ) {
    // A skipped LinkedIn note frees a spot in today's goal: the next person comes now, not on the
    // next round a minute later (Theo, 2026-10-19).
    try {
      await fillTodo(deps, { limit: 1, quick: true })
    } catch (error) {
      await logActivity(
        'error',
        'todo_refill_failed',
        { error: error instanceof Error ? error.message : String(error) },
        msg.lead_id,
        db,
      )
    }
  }
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

/** A LinkedIn person page however it was pasted, as https://www.linkedin.com/in/<slug>/, or null. */
export function normaliseLinkedInProfile(raw: string): string | null {
  const text = raw.trim()
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null
  const slug = u.pathname.match(/^\/in\/([^/]+)/i)?.[1]
  return slug ? `https://www.linkedin.com/in/${slug}/` : null
}

/**
 * Theo found someone on LinkedIn himself: save the profile, and if he is under today's goal their
 * connection note comes up on the Go page right away (send.ts catch-up, one note per person).
 */
export async function saveLinkedInProfile(
  deps: OutreachDeps,
  leadId: string,
  raw: string,
): Promise<LinkedInProfileResult> {
  const { db } = deps
  const url = normaliseLinkedInProfile(raw)
  if (!url) {
    throw badRequest(
      'Paste the link to their LinkedIn profile, like linkedin.com/in/their-name',
      'NOT_A_PROFILE',
    )
  }
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]
  if (!lead) throw notFound('Lead not found', 'LEAD_NOT_FOUND')
  const now = deps.now().toISOString()
  await db
    .update(leads)
    .set({
      linkedin_url: url,
      channels: computeChannels({ ...lead, linkedin_url: url }),
      updated_at: now,
    })
    .where(eq(leads.id, leadId))
  await db.insert(events).values({
    id: newId(),
    lead_id: leadId,
    kind: 'note',
    detail: { linkedin_url: url, by: 'hand' },
    at: now,
  })
  await logActivity('info', 'linkedin_profile_saved', { by: 'hand' }, leadId, db)
  if (!(await getSettings(db)).sequences_on) {
    return { linkedin_url: url, queued: await addLinkedInStepToOpenCard(deps, leadId) }
  }
  try {
    await sendDue(deps, { onlyLinkedIn: true })
  } catch (error) {
    // The profile is saved; the next round queues the note.
    await logActivity(
      'error',
      'queue_refill_failed',
      { channel: 'linkedin', error: error instanceof Error ? error.message : String(error) },
      leadId,
      db,
    )
  }
  const waiting = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.lead_id, leadId),
        eq(messages.channel, 'linkedin'),
        eq(messages.status, 'ready_for_human'),
      ),
    )
    .limit(1)
  return { linkedin_url: url, queued: waiting.length > 0 }
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The address lines for an envelope or label. */
function addressLines(to: PostalAddress | null, fallbackName: string): string[] {
  const name = to?.name || fallbackName
  return to
    ? [name, to.company, to.street, `${to.city}, ${to.state} ${to.zip}`.trim()].filter(
        (l): l is string => Boolean(l),
      )
    : [name]
}

/**
 * The print page. To-do printouts are one US Letter sheet each (shared/printout.ts), with a link to
 * proof and edit each one; older sequence mail prints as a 4x6 postcard or a letter. With
 * `labels`, the same people as address labels for the envelopes (Avery 5163, 10 a sheet).
 */
export async function printPage(
  deps: OutreachDeps,
  ids: string[],
  opts: { labels?: boolean } = {},
): Promise<string> {
  const settings = await getSettings(deps.db)
  const now = deps.now()
  const rows =
    ids.length === 0
      ? []
      : await deps.db
          .select({
            message: messages,
            lead_name: leads.full_name,
            lead_first: leads.first_name,
            lead_company: leads.company,
          })
          .from(messages)
          .innerJoin(leads, eq(leads.id, messages.lead_id))
          .where(and(inArray(messages.id, ids), eq(messages.channel, 'mail')))
  // The order Theo picked them in.
  rows.sort((a, b) => ids.indexOf(a.message.id) - ids.indexOf(b.message.id))
  const fromLine = [
    settings.owner_name,
    'Prop Archive LLC',
    settings.physical_address.trim(),
  ].filter(Boolean)
  const fromHtml = `${esc(settings.owner_name)}<br>Prop Archive LLC<br>${esc(settings.physical_address).replace(/,\s*/, '<br>')}`

  if (opts.labels) {
    const labels = rows.map((r) => {
      const lines = addressLines(
        parsePostal(r.message.to_address),
        personOf({ full_name: r.lead_name, company: r.lead_company }),
      )
      return `<div class="label"><div class="from">${fromLine.map(esc).join(', ')}</div><div class="to">${lines.map(esc).join('<br>')}</div></div>`
    })
    const sheets: string[] = []
    for (let i = 0; i < labels.length; i += 10) {
      sheets.push(`<section class="labels-sheet">${labels.slice(i, i + 10).join('')}</section>`)
    }
    return printDocument(
      'Envelope labels',
      `${labels.length} ${labels.length === 1 ? 'label' : 'labels'} for Avery 5163 or 8163 sheets (2 x 4 in, 10 a sheet). In the print box pick Letter, Margins None and Scale 100. Print one on plain paper first and hold it over a label sheet to check it lines up.`,
      sheets.join('\n'),
    )
  }

  const isPrintout = isPrintoutMessage
  const pieces = rows
    .map((r) => {
      if (isPrintout(r.message)) {
        return printoutSection(
          printoutParts(
            settings,
            r.message,
            { full_name: r.lead_name, company: r.lead_company, first_name: r.lead_first },
            now,
          ),
        )
      }
      const to = parsePostal(r.message.to_address)
      const name = to?.name || personOf({ full_name: r.lead_name, company: r.lead_company })
      const toHtml = addressLines(to, name)
        .map((l) => esc(l))
        .join('<br>')
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
  const printouts = rows.filter((r) => isPrintout(r.message)).length
  const cards = rows.filter(
    (r) => !isPrintout(r.message) && r.message.body.length <= POSTCARD_MAX_CHARS,
  ).length
  const letters = rows.length - printouts - cards
  const counted = [
    printouts ? `${printouts} ${printouts === 1 ? 'printout' : 'printouts'}` : '',
    cards ? `${cards} ${cards === 1 ? 'postcard' : 'postcards'}` : '',
    letters ? `${letters} ${letters === 1 ? 'letter' : 'letters'}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const how = [
    printouts
      ? 'Read each page first: Proof and edit (top right of a page, not printed) changes it. Each printout is one US Letter sheet: in the print box pick Letter, Margins None and Scale 100. Put each in a folder with your business card.'
      : '',
    cards
      ? 'Load 4x6 postcard stock and print double-sided (flip on the short edge), then sign, stamp and mail.'
      : '',
    'To download instead, pick "Save as PDF" as the printer.',
  ]
    .filter(Boolean)
    .join(' ')
  const labelsLink = printouts
    ? `<a class="tool-link" href="/api/queue/print?ids=${rows
        .filter((r) => isPrintout(r.message))
        .map((r) => encodeURIComponent(r.message.id))
        .join(',')}&labels=1" target="_blank" rel="noreferrer">Envelope labels</a>`
    : ''
  return printDocument(
    printouts ? 'Printouts to print' : 'Postcards to print',
    `${counted || 'Nothing selected'}. ${how}`,
    pieces || '<p class="empty">Nothing to print. Pick printouts on your list first.</p>',
    labelsLink,
  )
}

function printDocument(title: string, help: string, body: string, extra = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${PRINTOUT_FONT_LINK}
<style>
  @page { margin: 0; }
  @page card { size: 6in 4in; margin: 0; }
  @page letter { size: letter; margin: 0; }
  @page labels { size: 8.5in 11in; margin: 0; }
  body { margin: 0; font-family: Georgia, 'Times New Roman', serif; color: #111; background: #eee; }
  .toolbar { position: sticky; top: 0; z-index: 2; background: #fff; padding: 12px 16px; border-bottom: 1px solid #ccc; font-family: Arial, sans-serif; font-size: 15px; line-height: 1.5; }
  .toolbar button, .toolbar .tool-link { font-size: 18px; padding: 10px 18px; min-height: 44px; cursor: pointer; margin-right: 12px; display: inline-block; box-sizing: border-box; border: 1px solid #888; border-radius: 6px; background: #f5f5f4; color: #111; text-decoration: none; font-family: Arial, sans-serif; }
  .toolbar .fit-note { display: block; color: #b91c1c; font-weight: 700; }
  .toolbar .fit-note:empty { display: none; }
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
  .labels-sheet { page: labels; box-sizing: border-box; width: 8.5in; height: 10.98in; margin: 16px auto; padding: 0.5in 0.15625in 0; background: #fff; display: grid; grid-template-columns: 4in 4in; column-gap: 0.1875in; grid-auto-rows: 2in; align-content: start; break-after: page; page-break-after: always; }
  .labels-sheet:last-of-type { break-after: auto; page-break-after: auto; }
  .label { box-sizing: border-box; padding: 0.2in 0.3in; overflow: hidden; font-family: Arial, Helvetica, sans-serif; outline: 1px dashed #ccc; outline-offset: -1px; }
  .label .from { font-size: 7.5pt; line-height: 1.3; color: #333; }
  .label .to { margin: 0.16in 0 0 0.6in; font-size: 11pt; line-height: 1.35; }
  .empty { font-family: Arial, sans-serif; text-align: center; padding: 3rem; font-size: 18px; }
  ${PRINTOUT_CSS}
  @media print { .toolbar { display: none; } body { background: #fff; } .card, .letter, .labels-sheet { margin: 0; } .label { outline: none; } }
  @media (max-width: 700px) { .letter { width: auto; min-height: 0; padding: 1rem; } }
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">Print or save as PDF</button>${extra}<span>${esc(help)}</span><span id="fit-note" class="fit-note"></span></div>
${body}
<script>${PRINTOUT_FIT_SCRIPT}</script>
</body>
</html>`
}

/** A to-do printout (one letter page), as opposed to an old 4x6 postcard or sequence mail. */
export function isPrintoutMessage(
  m: Pick<Message, 'channel' | 'raw' | 'idempotency_key'>,
): boolean {
  return (
    m.channel === 'mail' &&
    m.idempotency_key.startsWith(TODO_KEY_PREFIX) &&
    (m.raw as { printout?: unknown } | null)?.printout === true
  )
}

/** One printout with everything its page shows, so Theo can proof and edit it. */
export async function printoutDoc(deps: OutreachDeps, messageId: string): Promise<PrintoutDoc> {
  const row = (
    await deps.db
      .select({ message: messages, lead: leads })
      .from(messages)
      .innerJoin(leads, eq(leads.id, messages.lead_id))
      .where(eq(messages.id, messageId))
      .limit(1)
  )[0]
  if (!row) throw notFound('Printout not found', 'MESSAGE_NOT_FOUND')
  if (!isPrintoutMessage(row.message)) throw badRequest('This is not a printout', 'NOT_A_PRINTOUT')
  const settings = await getSettings(deps.db)
  const { editHref: _edit, ...parts } = printoutParts(settings, row.message, row.lead, deps.now())
  const to = parsePostal(row.message.to_address)
  return {
    message_id: row.message.id,
    lead_id: row.lead.id,
    status: row.message.status,
    person: personOf(row.lead),
    address: to ? addressLines(to, personOf(row.lead)).join(', ') : '',
    parts,
    problems: stepProblems('postcard', {
      subject: row.message.subject,
      body: row.message.body,
      printout: true,
    }),
  }
}

/** The longest Theo's words may be on each kind of step. */
const EDIT_LIMITS = {
  /** LinkedIn allows 200 characters on a free account and 300 with Premium. */
  linkedin: 300,
  printout: PRINTOUT_LIMITS.body,
  heading: PRINTOUT_LIMITS.heading,
  postcard: 1_400,
  email: 6_000,
  subject: 200,
} as const

/**
 * Theo's own words on a waiting to-do step: a LinkedIn note, a printout's heading and part about
 * them, or an email's subject and body. Saved as he wrote them; the house-rule checks come back as
 * hints, never as a refusal.
 */
export async function editStepText(
  deps: OutreachDeps,
  messageId: string,
  input: EditStepBody,
): Promise<EditStepResult> {
  const msg = (await deps.db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]
  if (!msg) throw notFound('Message not found', 'MESSAGE_NOT_FOUND')
  const parsed = parseTodoKey(msg.idempotency_key)
  if (!parsed || !msg.idempotency_key.startsWith(TODO_KEY_PREFIX)) {
    throw badRequest('Only steps on your to-do list can be edited here', 'NOT_TODO')
  }
  if (msg.status !== 'ready_for_human') {
    throw badRequest(`This step is already marked ${msg.status.replace(/_/g, ' ')}`, 'NOT_IN_QUEUE')
  }
  const kind = parsed.kind as TodoStepKind
  const body = input.body.replace(/\r\n?/g, '\n').trim()
  if (!body) throw badRequest('Write something first', 'EMPTY_TEXT')
  const printout = isPrintoutMessage(msg)
  const tooLong = (limit: number, what: string) => {
    throw badRequest(`The ${what} is too long: keep it under ${limit} characters`, 'TOO_LONG')
  }
  let subject = msg.subject
  if (kind === 'linkedin_connect' || kind === 'linkedin_follow_up') {
    if (body.length > EDIT_LIMITS.linkedin) tooLong(EDIT_LIMITS.linkedin, 'note')
  } else if (kind === 'postcard') {
    if (printout) {
      if (body.length > EDIT_LIMITS.printout) tooLong(EDIT_LIMITS.printout, 'part about them')
      if (input.subject !== undefined) {
        if (input.subject.length > EDIT_LIMITS.heading) tooLong(EDIT_LIMITS.heading, 'heading')
        subject = input.subject || null
      }
    } else if (body.length > EDIT_LIMITS.postcard) {
      tooLong(EDIT_LIMITS.postcard, 'postcard')
    }
  } else if (kind === 'email') {
    if (body.length > EDIT_LIMITS.email) tooLong(EDIT_LIMITS.email, 'email')
    if (input.subject !== undefined) {
      if (!input.subject) throw badRequest('The email needs a subject', 'EMPTY_SUBJECT')
      subject = input.subject
    }
  } else {
    throw badRequest('This step has no words to edit', 'NOT_EDITABLE')
  }
  const raw = (msg.raw ?? {}) as Record<string, unknown>
  const saved = await deps.db
    .update(messages)
    .set({ body, subject, raw: { ...raw, edited_at: deps.now().toISOString() } })
    .where(and(eq(messages.id, msg.id), eq(messages.status, 'ready_for_human')))
    .returning({ id: messages.id })
  if (saved.length === 0) {
    throw badRequest('This step was just marked done or skipped', 'NOT_IN_QUEUE')
  }
  await logActivity('info', 'todo_text_edited', { kind }, msg.lead_id, deps.db)
  return {
    message_id: msg.id,
    subject,
    body,
    problems: stepProblems(kind, { subject, body, printout }),
  }
}
