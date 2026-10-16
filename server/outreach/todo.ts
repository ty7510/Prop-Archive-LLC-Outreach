// The to-do list (Theo, 2026-10-16: "kill the automatic sequence, just give me instructions",
// "when every step is complete put them in the complete section and recycle them 30 days later if
// no replies"). Each send day up to settings.people_per_day people go on the list with every step
// at once: their LinkedIn note (the app finds the profile and writes the note for them), their
// postcard and a call. Steps are ready_for_human messages keyed todo:<lead>:<round>:<kind>, so Done,
// Skip and the print page work as before. When no step is waiting the person is complete; once
// recycle_after_days pass since their last step with no reply, they come back as a new round.
import { and, desc, eq, gte, inArray, like, notInArray, sql } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import type {
  CompletePerson,
  RepliedPerson,
  TodoList,
  TodoPerson,
  TodoStep,
  TodoStepKind,
} from '../../shared/types.ts'
import { events, leads, messages, sequenceSteps, type Lead, type Message } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import { startOfDayInTz, zonedParts } from '../lib/time.ts'
import type { OutreachDeps } from './deps.ts'
import { BLOCKED_LEAD_STATUSES, contactBlocker } from './enroll.ts'
import { FINDER_RETRY_DAYS, finderRecord, findLinkedInFor, personFor } from './linkedinFinder.ts'
import { writePersonalNote } from './linkedinNote.ts'
import { postalAddressFor } from './mail.ts'
import { recipientBlocker } from './recipients.ts'
import { buildVars, renderTemplate } from './templates.ts'

export const TODO_KEY_PREFIX = 'todo:'
const DAY_MS = 24 * 60 * 60 * 1000

/** Steps on a card, in the order Theo does them. */
export const STEP_ORDER: readonly TodoStepKind[] = [
  'linkedin_connect',
  'linkedin_follow_up',
  'postcard',
  'call',
]

export const STEP_LABEL: Record<TodoStepKind, string> = {
  linkedin_connect: 'LinkedIn note',
  linkedin_follow_up: 'LinkedIn message',
  postcard: 'Postcard',
  call: 'Call',
}

/** Theo's connection note when the main sequence has no LinkedIn step. Under 200 characters. */
export const DEFAULT_CONNECT_NOTE =
  "Hi {{first_name}}, I'm building Prop Archive here in Philly: leases, repairs and rent for small landlords in one place. Would be glad to connect."

/** Someone who already got a connection note (an earlier round): a short message instead. */
export const FOLLOW_UP_NOTE =
  "Hi {{first_name}}, thanks for connecting. What's the biggest headache with your rentals right now? If it's repairs or rent spread across texts, I'd be glad to show you Prop Archive. 15 minutes?"

export const DEFAULT_POSTCARD =
  "Hi {{first_name}}, I'm Theo. I built Prop Archive for Philly landlords: leases, repairs and rent in one place, so nothing lives in old texts. See it at {{site_link}}"

/** What to say on the call: the problem first, then one question. */
export const CALL_SCRIPT = [
  "Hi {{first_name}}, it's Theo from Prop Archive here in Philly. Most owners I talk to lose hours chasing repairs and rent across texts and spreadsheets. Is that a headache for you too?",
  '',
  'If yes: ask how they handle it today, then offer 15 minutes to show them.',
  'No answer: leave your name, Prop Archive and your number, once.',
].join('\n')

export function todoKey(leadId: string, round: number, kind: TodoStepKind | 'none'): string {
  return `${TODO_KEY_PREFIX}${leadId}:${round}:${kind}`
}

export function parseTodoKey(key: string): { round: number; kind: string } | null {
  const m = key.match(/^todo:.+:(\d+):([a-z_]+)$/)
  return m ? { round: Number(m[1]), kind: m[2]! } : null
}

function personOf(lead: Pick<Lead, 'full_name' | 'company'>): string {
  return lead.full_name?.trim() || lead.company?.trim() || 'Unknown owner'
}

/** The first step of this channel in the main sequence: Theo's own words, edited on Sequences. */
async function mainStepText(
  deps: OutreachDeps,
  settings: Settings,
  channel: 'linkedin' | 'mail',
): Promise<string | null> {
  if (!settings.main_sequence_id) return null
  const rows = await deps.db
    .select({ body: sequenceSteps.body, step_index: sequenceSteps.step_index })
    .from(sequenceSteps)
    .where(
      and(
        eq(sequenceSteps.sequence_id, settings.main_sequence_id),
        eq(sequenceSteps.channel, channel),
      ),
    )
  const first = rows.sort((a, b) => a.step_index - b.step_index)[0]
  const body = first?.body.trim()
  return body && !body.includes('{{ai_opener}}') ? body : null
}

/** Today's start in the send window's zone, and whether today is a send day. */
function today(settings: Settings, now: Date): { start: string; sendDay: boolean } {
  const tz = settings.send_window.tz
  return {
    start: startOfDayInTz(now, tz).toISOString(),
    sendDay: settings.send_window.days.includes(zonedParts(now, tz).weekday),
  }
}

async function addedSince(deps: OutreachDeps, since: string): Promise<number> {
  const rows = await deps.db
    .select({ n: sql<number>`count(distinct ${messages.lead_id})` })
    .from(messages)
    .where(
      and(like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`), gte(messages.created_at, since)),
    )
  return Number(rows[0]?.n ?? 0)
}

/**
 * People who may go on the list now: not blocked, nothing waiting, nothing done for them by hand in
 * the last recycle_after_days days and no round started in that time. Never-reached people first.
 */
export async function todoCandidates(
  deps: OutreachDeps,
  settings: Settings,
  limit: number,
): Promise<Lead[]> {
  const since = new Date(deps.now().getTime() - settings.recycle_after_days * DAY_MS).toISOString()
  const reachedBefore = sql<boolean>`exists (select 1 from ${messages} r where r.lead_id = ${leads.id} and r.direction = 'out' and r.provider = 'human' and r.status = 'sent')`
  return deps.db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.do_not_contact, false),
        notInArray(leads.status, [...BLOCKED_LEAD_STATUSES]),
        sql`(trim(coalesce(${leads.mailing_street}, '')) <> '' or trim(coalesce(${leads.phone}, '')) <> '' or trim(coalesce(${leads.linkedin_url}, '')) <> '')`,
        sql`not exists (select 1 from ${messages} m where m.lead_id = ${leads.id} and m.direction = 'out' and (
          m.status = 'ready_for_human'
          or (m.status = 'sent' and m.provider = 'human' and m.sent_at > ${since})
          or (m.idempotency_key like ${`${TODO_KEY_PREFIX}%`} and m.created_at > ${since})
        ))`,
      ),
    )
    .orderBy(reachedBefore, desc(leads.icp_score), leads.created_at)
    .limit(limit)
}

async function lastRound(deps: OutreachDeps, leadId: string): Promise<number> {
  const rows = await deps.db
    .select({ key: messages.idempotency_key })
    .from(messages)
    .where(and(eq(messages.lead_id, leadId), like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`)))
  return Math.max(0, ...rows.map((r) => parseTodoKey(r.key)?.round ?? 0))
}

async function linkedInNoteSent(deps: OutreachDeps, leadId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.lead_id, leadId),
        eq(messages.channel, 'linkedin'),
        eq(messages.direction, 'out'),
        eq(messages.status, 'sent'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** The LinkedIn note for this person: Theo's note rewritten for them, else his note as written. */
async function linkedInBody(
  deps: OutreachDeps,
  settings: Settings,
  lead: Lead,
  kind: 'linkedin_connect' | 'linkedin_follow_up',
): Promise<{ body: string; personal: boolean }> {
  const vars = buildVars(lead, settings, {
    baseUrl: deps.baseUrl,
    channel: 'linkedin',
    sequenceName: 'To do',
  })
  const source =
    kind === 'linkedin_connect'
      ? ((await mainStepText(deps, settings, 'linkedin')) ?? DEFAULT_CONNECT_NOTE)
      : FOLLOW_UP_NOTE
  const theos = renderTemplate(source, vars).text
  const personal = await writePersonalNote(lead, vars, theos, deps.llm).catch(() => null)
  return personal ? { body: personal, personal: true } : { body: theos, personal: false }
}

interface NewStep {
  kind: TodoStepKind
  channel: Message['channel']
  body: string
  to_address: string | null
  raw: Record<string, unknown>
}

async function linkedInStep(
  deps: OutreachDeps,
  settings: Settings,
  lead: Lead,
): Promise<NewStep | null> {
  const profile = (lead.linkedin_url ?? '').trim()
  if (!profile || !settings.channels.linkedin) return null
  const kind = (await linkedInNoteSent(deps, lead.id)) ? 'linkedin_follow_up' : 'linkedin_connect'
  const note = await linkedInBody(deps, settings, lead, kind)
  const found = finderRecord(lead)?.url === profile
  return {
    kind,
    channel: 'linkedin',
    body: note.body,
    to_address: profile,
    raw: { todo: kind, found_by_app: found, ...(note.personal ? { personal: true } : {}) },
  }
}

async function insertSteps(
  deps: OutreachDeps,
  lead: Lead,
  round: number,
  steps: NewStep[],
): Promise<number> {
  const now = deps.now().toISOString()
  let added = 0
  for (const step of steps) {
    try {
      await deps.db.insert(messages).values({
        id: newId(),
        lead_id: lead.id,
        channel: step.channel,
        direction: 'out',
        status: 'ready_for_human',
        idempotency_key: todoKey(lead.id, round, step.kind),
        body: step.body,
        to_address: step.to_address,
        provider: 'human',
        scheduled_at: now,
        raw: step.raw,
        created_at: now,
      })
      added++
    } catch {
      // Another run added this step first.
    }
  }
  return added
}

/** A round with no steps, so the person is not picked again every minute until it recycles. */
async function markEmptyRound(
  deps: OutreachDeps,
  leadId: string,
  round: number,
  why: string,
): Promise<void> {
  try {
    await deps.db.insert(messages).values({
      id: newId(),
      lead_id: leadId,
      channel: 'mail',
      direction: 'out',
      status: 'skipped',
      idempotency_key: todoKey(leadId, round, 'none'),
      error: why,
      provider: 'human',
      created_at: deps.now().toISOString(),
    })
  } catch {
    // Already marked.
  }
}

/** Put one person on the list with every step they can get. Returns the steps added. */
export async function addPerson(
  deps: OutreachDeps,
  settings: Settings,
  input: Lead,
): Promise<number> {
  const now = deps.now()
  const round = (await lastRound(deps, input.id)) + 1
  // Opted out (suppression list, do not contact, a reply): never on the list.
  const blocked = await contactBlocker(deps.db, input)
  if (blocked) {
    await markEmptyRound(deps, input.id, round, `not contacted: ${blocked}`)
    return 0
  }
  let lead = input
  // Find their LinkedIn first, so the card is whole when it shows up.
  const record = finderRecord(lead)
  const triedRecently =
    record?.tried_at && now.getTime() - Date.parse(record.tried_at) < FINDER_RETRY_DAYS * DAY_MS
  if (settings.channels.linkedin && !(lead.linkedin_url ?? '').trim() && !triedRecently) {
    try {
      const r = await findLinkedInFor(deps, lead.id)
      if (r.status === 'found') {
        lead = (await deps.db.select().from(leads).where(eq(leads.id, lead.id)).limit(1))[0] ?? lead
      }
    } catch (error) {
      await logActivity(
        'warn',
        'linkedin_find_failed',
        { error: error instanceof Error ? error.message : String(error) },
        lead.id,
        deps.db,
      )
    }
  }

  const vars = buildVars(lead, settings, {
    baseUrl: deps.baseUrl,
    channel: 'mail',
    sequenceName: 'To do',
  })
  const steps: NewStep[] = []
  const li = await linkedInStep(deps, settings, lead)
  if (li) steps.push(li)
  const postal = postalAddressFor(lead)
  if (postal && !(await recipientBlocker(deps.db, settings, lead, 'mail', now))) {
    const text = (await mainStepText(deps, settings, 'mail')) ?? DEFAULT_POSTCARD
    steps.push({
      kind: 'postcard',
      channel: 'mail',
      body: renderTemplate(text, vars).text,
      to_address: JSON.stringify(postal),
      raw: { todo: 'postcard' },
    })
  }
  if ((lead.phone ?? '').trim() && settings.channels.call) {
    const callVars = buildVars(lead, settings, {
      baseUrl: deps.baseUrl,
      channel: 'call',
      sequenceName: 'To do',
    })
    steps.push({
      kind: 'call',
      channel: 'call',
      body: renderTemplate(CALL_SCRIPT, callVars).text,
      to_address: lead.phone,
      raw: { todo: 'call' },
    })
  }

  if (steps.length === 0) {
    // Nothing to do this round (postcard sent lately, no phone, no profile).
    await markEmptyRound(deps, lead.id, round, 'nothing to do this round')
    return 0
  }
  const added = await insertSteps(deps, lead, round, steps)
  if (added > 0) {
    await deps.db.insert(events).values({
      id: newId(),
      lead_id: lead.id,
      kind: 'queued',
      detail: { todo: true, round, steps: steps.map((s) => s.kind) },
      at: now.toISOString(),
    })
    await logActivity('info', 'todo_added', { round, steps: steps.length }, lead.id, deps.db)
  }
  return added
}

/**
 * The autopilot's round: on a send day, put people on the list until today's number is reached.
 * At most `limit` people per round, so one round stays short (each may need a LinkedIn search).
 */
export async function fillTodo(
  deps: OutreachDeps,
  options: { limit?: number } = {},
): Promise<{ added: number; reason?: string }> {
  const settings = await getSettings(deps.db)
  if (settings.sequences_on) return { added: 0, reason: 'timed sequences are on' }
  const day = today(settings, deps.now())
  if (!day.sendDay) return { added: 0, reason: 'not a send day' }
  const room = Math.min(
    settings.people_per_day - (await addedSince(deps, day.start)),
    options.limit ?? 5,
  )
  if (room <= 0) return { added: 0 }
  let added = 0
  for (const lead of await todoCandidates(deps, settings, room * 2)) {
    if (added >= room) break
    if ((await addPerson(deps, settings, lead)) > 0) added++
  }
  return { added }
}

/**
 * Theo pasted a profile for someone on the list: their LinkedIn step joins their open card.
 * Returns true when a step was added.
 */
export async function addLinkedInStepToOpenCard(
  deps: OutreachDeps,
  leadId: string,
): Promise<boolean> {
  const settings = await getSettings(deps.db)
  const lead = (await deps.db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]
  if (!lead) return false
  const open = await deps.db
    .select({ key: messages.idempotency_key, channel: messages.channel })
    .from(messages)
    .where(
      and(
        eq(messages.lead_id, leadId),
        eq(messages.status, 'ready_for_human'),
        like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`),
      ),
    )
  const round = Math.max(0, ...open.map((m) => parseTodoKey(m.key)?.round ?? 0))
  if (round === 0) return false
  const step = await linkedInStep(deps, settings, lead)
  if (!step) return false
  return (await insertSteps(deps, lead, round, [step])) > 0
}

function stepStatus(status: Message['status']): TodoStep['status'] | null {
  if (status === 'ready_for_human') return 'waiting'
  if (status === 'sent') return 'done'
  if (status === 'skipped') return 'skipped'
  return null
}

async function openCards(deps: OutreachDeps): Promise<TodoPerson[]> {
  const waiting = await deps.db
    .selectDistinct({ lead_id: messages.lead_id })
    .from(messages)
    .innerJoin(leads, eq(leads.id, messages.lead_id))
    .where(
      and(
        eq(messages.status, 'ready_for_human'),
        like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`),
        notInArray(leads.status, [...BLOCKED_LEAD_STATUSES]),
      ),
    )
  const ids = waiting.map((w) => w.lead_id)
  if (ids.length === 0) return []
  const rows = await deps.db
    .select({ message: messages, lead: leads })
    .from(messages)
    .innerJoin(leads, eq(leads.id, messages.lead_id))
    .where(
      and(inArray(messages.lead_id, ids), like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`)),
    )
  const byLead = new Map<
    string,
    { lead: Lead; msgs: { m: Message; round: number; kind: string }[] }
  >()
  for (const r of rows) {
    const parsed = parseTodoKey(r.message.idempotency_key)
    if (!parsed) continue
    const entry = byLead.get(r.lead.id) ?? { lead: r.lead, msgs: [] }
    entry.msgs.push({ m: r.message, round: parsed.round, kind: parsed.kind })
    byLead.set(r.lead.id, entry)
  }
  const cards: TodoPerson[] = []
  for (const { lead, msgs } of byLead.values()) {
    const round = Math.max(
      ...msgs.filter((x) => x.m.status === 'ready_for_human').map((x) => x.round),
    )
    const current = msgs.filter(
      (x) => x.round === round && (STEP_ORDER as readonly string[]).includes(x.kind),
    )
    const steps: TodoStep[] = current
      .map((x) => {
        const status = stepStatus(x.m.status)
        if (!status) return null
        const raw = (x.m.raw ?? {}) as { found_by_app?: unknown }
        return {
          message_id: x.m.id,
          kind: x.kind as TodoStepKind,
          channel: x.m.channel,
          status,
          body: x.m.body,
          to_address: x.m.to_address,
          found_by_app: raw.found_by_app === true,
        }
      })
      .filter((s): s is TodoStep => s !== null)
      .sort((a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind))
    const hasLinkedIn = steps.some((s) => s.channel === 'linkedin' && s.status !== 'skipped')
    cards.push({
      lead_id: lead.id,
      person: personOf(lead),
      company: lead.company,
      property_count: lead.property_count,
      city: lead.mailing_city,
      phone: lead.phone,
      email: lead.email,
      round,
      steps,
      linkedin_missing: hasLinkedIn ? null : personFor(lead) ? 'not_found' : 'no_name',
      added_at: current.map((x) => x.m.created_at).sort()[0] ?? '',
    })
  }
  return cards.sort((a, b) => a.added_at.localeCompare(b.added_at))
}

const CHANNEL_DONE_LABEL: Partial<Record<Message['channel'], string>> = {
  linkedin: 'LinkedIn',
  mail: 'Postcard',
  call: 'Call',
  instagram: 'Instagram',
}

/** Everyone whose steps are all done, waiting for a reply until they come back on the list. */
async function completePeople(deps: OutreachDeps, settings: Settings): Promise<CompletePerson[]> {
  const since = new Date(deps.now().getTime() - settings.recycle_after_days * DAY_MS).toISOString()
  const rows = await deps.db
    .select({ message: messages, lead: leads })
    .from(messages)
    .innerJoin(leads, eq(leads.id, messages.lead_id))
    .where(
      and(
        eq(messages.direction, 'out'),
        eq(messages.status, 'sent'),
        eq(messages.provider, 'human'),
        gte(messages.sent_at, since),
        notInArray(leads.status, [...BLOCKED_LEAD_STATUSES]),
        sql`not exists (select 1 from ${messages} w where w.lead_id = ${leads.id} and w.direction = 'out' and w.status = 'ready_for_human')`,
      ),
    )
  const byLead = new Map<string, { lead: Lead; done: Set<string>; last: string }>()
  for (const r of rows) {
    const entry = byLead.get(r.lead.id) ?? { lead: r.lead, done: new Set<string>(), last: '' }
    entry.done.add(CHANNEL_DONE_LABEL[r.message.channel] ?? r.message.channel)
    if ((r.message.sent_at ?? '') > entry.last) entry.last = r.message.sent_at ?? ''
    byLead.set(r.lead.id, entry)
  }
  return [...byLead.values()]
    .map(({ lead, done, last }) => ({
      lead_id: lead.id,
      person: personOf(lead),
      company: lead.company,
      phone: lead.phone,
      email: lead.email,
      done: [...done],
      last_done_at: last,
      back_on: new Date(Date.parse(last) + settings.recycle_after_days * DAY_MS).toISOString(),
    }))
    .sort((a, b) => b.last_done_at.localeCompare(a.last_done_at))
}

const REPLIED_STATUSES = ['replied', 'booked', 'joined', 'not_interested'] as const

/** Everyone who answered, newest first, with what they said when it was written down. */
async function repliedPeople(deps: OutreachDeps): Promise<RepliedPerson[]> {
  const people = await deps.db
    .select()
    .from(leads)
    .where(inArray(leads.status, [...REPLIED_STATUSES]))
    .orderBy(desc(leads.last_replied_at), desc(leads.updated_at))
    .limit(200)
  if (people.length === 0) return []
  const inbound = await deps.db
    .select()
    .from(messages)
    .where(
      and(
        inArray(
          messages.lead_id,
          people.map((p) => p.id),
        ),
        eq(messages.direction, 'in'),
      ),
    )
    .orderBy(desc(messages.created_at))
  const latest = new Map<string, Message>()
  for (const m of inbound) if (!latest.has(m.lead_id)) latest.set(m.lead_id, m)
  return people.map((lead) => {
    const m = latest.get(lead.id)
    return {
      lead_id: lead.id,
      person: personOf(lead),
      company: lead.company,
      phone: lead.phone,
      email: lead.email,
      status: lead.status,
      channel: m?.channel ?? null,
      note: m?.body?.trim() || null,
      replied_at: lead.last_replied_at ?? m?.created_at ?? lead.updated_at,
    }
  })
}

export async function listTodo(deps: OutreachDeps): Promise<TodoList> {
  const settings = await getSettings(deps.db)
  const day = today(settings, deps.now())
  return {
    people: await openCards(deps),
    complete: await completePeople(deps, settings),
    replied: await repliedPeople(deps),
    today: { added: await addedSince(deps, day.start), goal: settings.people_per_day },
    recycle_after_days: settings.recycle_after_days,
  }
}
