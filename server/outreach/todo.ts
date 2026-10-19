// The to-do list (Theo, 2026-10-16: "kill the automatic sequence, just give me instructions",
// "when every step is complete put them in the complete section and recycle them 30 days later if
// no replies"). Each send day up to settings.people_per_day people go on the list with every step
// at once, in the order Theo does them (2026-10-16: "a linkedin message then a printout i will mail
// in a folder with my business card then a email; all hand sent by me but not written by me"):
// their LinkedIn note (the app finds the profile and writes the note for them), a one-page
// printout about their company, and an email he sends from Gmail. He proofs and can edit each one
// first. Steps are ready_for_human messages keyed todo:<lead>:<round>:<kind>, so Done, Skip and the
// print page work as before. When no step is waiting the person is complete; once
// recycle_after_days pass since their last step with no reply, they come back as a new round.
import { and, asc, desc, eq, gte, inArray, like, notInArray, sql } from 'drizzle-orm'
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
import { ruleProblems } from './copyRules.ts'
import { emailFooter, fallbackEmail, subjectProblems, writeHandEmail } from './handEmail.ts'
import { personFor } from './linkedinFinder.ts'
import { LINKEDIN_NOTE_MAX, writePersonalNote } from './linkedinNote.ts'
import { postalAddressFor, type PostalAddress } from './mail.ts'
import { linkedInFoundByEnrich, readyToContact, readyToContactSql } from './readyToContact.ts'
import { checkOwnership, needsOwnershipCheck } from './ownership.ts'
import { fallbackPrintout, printoutHeading, writePrintout } from './printout.ts'
import { recipientBlocker } from './recipients.ts'
import { buildVars, renderTemplate, type TemplateVars } from './templates.ts'

export const TODO_KEY_PREFIX = 'todo:'
const DAY_MS = 24 * 60 * 60 * 1000

/** Steps on a card, in the order Theo does them. */
export const STEP_ORDER: readonly TodoStepKind[] = [
  'linkedin_connect',
  'linkedin_follow_up',
  'postcard',
  'email',
  'call',
]

export const STEP_LABEL: Record<TodoStepKind, string> = {
  linkedin_connect: 'LinkedIn note',
  linkedin_follow_up: 'LinkedIn message',
  postcard: 'Printout',
  email: 'Email',
  call: 'Call',
}

/** Theo's connection note when the main sequence has no LinkedIn step. Under 200 characters. */
export const DEFAULT_CONNECT_NOTE =
  "Hi {{first_name}}, I'm building Prop Archive here in Philly: leases, repairs and rent for small landlords in one place. Would be glad to connect."

/** Someone who already got a connection note (an earlier round): a short message instead. */
export const FOLLOW_UP_NOTE =
  "Hi {{first_name}}, thanks for connecting. What's the biggest headache with your rentals right now? If it's repairs or rent spread across texts, I'd be glad to show you Prop Archive. 15 minutes?"

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
  channel: 'linkedin',
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

/**
 * Today's goal is people Theo sent to (Theo, 2026-10-19: "keep refreshing with new people until I
 * sent 20"). `sent`: people with a step he marked sent today. `waiting`: everyone else still on the
 * list with a step to do. Someone he skipped is in neither, so a new person takes their place.
 */
async function goalProgress(
  deps: OutreachDeps,
  since: string,
): Promise<{ sent: number; waiting: number }> {
  const todo = sql`m.idempotency_key like ${`${TODO_KEY_PREFIX}%`} and m.direction = 'out'`
  const sentToday = sql`select m.lead_id from ${messages} m where ${todo} and m.status = 'sent' and m.sent_at >= ${since}`
  const rows = await deps.db.execute<{ sent: number; waiting: number }>(sql`
    select
      (select count(distinct x.lead_id) from (${sentToday}) x) as sent,
      (select count(distinct m.lead_id) from ${messages} m
        where ${todo} and m.status = 'ready_for_human' and m.lead_id not in (${sentToday})) as waiting
  `)
  const row = rows.rows[0]
  return { sent: Number(row?.sent ?? 0), waiting: Number(row?.waiting ?? 0) }
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
        // Only people with an email, a mailing address and a LinkedIn that Enrich found.
        readyToContactSql(),
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

/** Whether anything went to this person on this channel before (a note, an email). */
async function sentBefore(
  deps: OutreachDeps,
  leadId: string,
  channel: Message['channel'],
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.lead_id, leadId),
        eq(messages.channel, channel),
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
  /** The email's subject or the printout's heading. */
  subject?: string | null
  body: string
  to_address: string | null
  raw: Record<string, unknown>
}

/**
 * The LinkedIn note. With no profile on file the step still comes, so Theo has the note to copy:
 * the card then gives him a LinkedIn search for them and a box to paste the profile. Nobody to
 * search for (no person's name and no profile) means no LinkedIn step.
 */
async function linkedInStep(
  deps: OutreachDeps,
  settings: Settings,
  lead: Lead,
): Promise<NewStep | null> {
  const profile = (lead.linkedin_url ?? '').trim()
  if (!settings.channels.linkedin) return null
  // Theo sends a note only to a profile Enrich found (2026-10-19): not one from an imported list,
  // pasted by hand, or from the separate LinkedIn lookup.
  if (!profile || !linkedInFoundByEnrich(lead)) return null
  const kind = (await sentBefore(deps, lead.id, 'linkedin'))
    ? 'linkedin_follow_up'
    : 'linkedin_connect'
  const note = await linkedInBody(deps, settings, lead, kind)
  return {
    kind,
    channel: 'linkedin',
    body: note.body,
    to_address: profile || null,
    raw: { todo: kind, found_by_app: true, ...(note.personal ? { personal: true } : {}) },
  }
}

/** The part of the printout about them: written for them, else Theo's words for their kind. */
async function printoutText(
  deps: OutreachDeps,
  lead: Lead,
  vars: TemplateVars,
): Promise<{ heading: string; body: string; personal: boolean }> {
  const written = await writePrintout(lead, vars, deps.llm).catch(() => null)
  return {
    heading: printoutHeading(vars),
    body: written ?? fallbackPrintout(lead),
    personal: Boolean(written),
  }
}

/** The printout (one letter page) Theo mails in a folder with his business card. */
async function printoutStep(
  deps: OutreachDeps,
  lead: Lead,
  vars: TemplateVars,
  postal: PostalAddress,
): Promise<NewStep> {
  const text = await printoutText(deps, lead, vars)
  return {
    kind: 'postcard',
    channel: 'mail',
    subject: text.heading,
    body: text.body,
    to_address: JSON.stringify(postal),
    raw: { todo: 'postcard', printout: true, ...(text.personal ? { personal: true } : {}) },
  }
}

/**
 * The email Theo sends himself from Gmail. Only to an address that is not known to be bad and has
 * not had an email lately (min_days_between_emails); `mailed` says the printout is on its way. Someone
 * who had an email on an earlier round gets a short follow-up instead of the first email again.
 */
async function emailStep(
  deps: OutreachDeps,
  settings: Settings,
  lead: Lead,
  vars: TemplateVars,
  mailed: boolean,
): Promise<NewStep | null> {
  const address = (lead.email ?? '').trim()
  if (!address || lead.email_status === 'invalid') return null
  if (await recipientBlocker(deps.db, settings, lead, 'email', deps.now())) return null
  const context = { mailed, followUp: await sentBefore(deps, lead.id, 'email') }
  const written = await writeHandEmail(lead, vars, context, deps.llm).catch(() => null)
  const email = written ?? fallbackEmail(vars, context)
  return {
    kind: 'email',
    channel: 'email',
    subject: email.subject,
    body: email.body,
    to_address: address,
    raw: {
      todo: 'email',
      ...(context.followUp ? { follow_up: true } : {}),
      ...(written ? { personal: true } : {}),
    },
  }
}

/** House-rule checks on a step's words as they are now, for Theo to proof. */
export function stepProblems(
  kind: TodoStepKind,
  step: { subject: string | null; body: string; printout: boolean },
): string[] {
  // A LinkedIn note is often Theo's own words as he wrote them: only the length is worth a word.
  if (kind === 'linkedin_connect' || kind === 'linkedin_follow_up') {
    if (!step.body.trim()) return ['it is empty']
    return step.body.length > LINKEDIN_NOTE_MAX
      ? [
          `it is ${step.body.length} characters; a free LinkedIn account allows ${LINKEDIN_NOTE_MAX}`,
        ]
      : []
  }
  if (kind === 'postcard') return step.printout ? ruleProblems(step.body) : []
  if (kind === 'email') {
    if (!step.body.trim()) return ['it is empty']
    return [...subjectProblems(step.subject ?? ''), ...ruleProblems(step.body)]
  }
  return []
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
        subject: step.subject ?? null,
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
  // Sold off their rentals lately (the city's property records): not a landlord to contact now.
  if (needsOwnershipCheck(lead, now)) {
    try {
      const own = await checkOwnership(deps, settings, lead)
      lead = own.lead
      if (own.status === 'sold_off') {
        await markEmptyRound(deps, input.id, round, 'not contacted: sold their properties')
        return 0
      }
    } catch (error) {
      await logActivity(
        'warn',
        'ownership_check_failed',
        { error: error instanceof Error ? error.message : String(error) },
        lead.id,
        deps.db,
      )
    }
  }
  // Checked again here: the ownership check above may have changed what is on file.
  if (!readyToContact(lead)) {
    await markEmptyRound(
      deps,
      input.id,
      round,
      'not contacted: needs email, mailing address and a LinkedIn Enrich found',
    )
    return 0
  }

  const vars = buildVars(lead, settings, {
    baseUrl: deps.baseUrl,
    channel: 'mail',
    sequenceName: 'To do',
  })
  // LinkedIn note, then the printout, then the email. The three are written at the same time.
  const postal = postalAddressFor(lead)
  const mailing =
    postal && !(await recipientBlocker(deps.db, settings, lead, 'mail', now)) ? postal : null
  const written = await Promise.all([
    linkedInStep(deps, settings, lead),
    mailing ? printoutStep(deps, lead, vars, mailing) : Promise.resolve(null),
    emailStep(deps, settings, lead, vars, Boolean(mailing)),
  ])
  const steps = written.filter((s): s is NewStep => s !== null)

  if (steps.length === 0) {
    // Nothing to do this round (printout mailed lately, no address, no email, nobody on LinkedIn).
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
  // Cards made before printouts get theirs, and people on the list are checked again for sales,
  // a few each round, whatever the day.
  try {
    await upgradeOpenCards(deps, settings)
    await recheckOpenCards(deps, settings)
  } catch (error) {
    await logActivity(
      'warn',
      'todo_upgrade_failed',
      { error: error instanceof Error ? error.message : String(error) },
      null,
      deps.db,
    )
  }
  const day = today(settings, deps.now())
  if (!day.sendDay) return { added: 0, reason: 'not a send day' }
  // Room for new people: the goal less people sent to today and people still waiting on the list.
  const progress = await goalProgress(deps, day.start)
  const room = Math.min(
    settings.people_per_day - progress.sent - progress.waiting,
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
    .select({
      id: messages.id,
      key: messages.idempotency_key,
      channel: messages.channel,
      to_address: messages.to_address,
      raw: messages.raw,
    })
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
  const profile = (lead.linkedin_url ?? '').trim()
  // Their note is already on the card: the pasted profile joins it (or replaces a wrong one).
  const waiting = open.find((m) => m.channel === 'linkedin')
  if (waiting && profile) {
    if (!linkedInFoundByEnrich(lead)) return false
    const raw = (waiting.raw ?? {}) as Record<string, unknown>
    const saved = await deps.db
      .update(messages)
      .set({ to_address: profile, raw: { ...raw, found_by_app: true } })
      .where(and(eq(messages.id, waiting.id), eq(messages.status, 'ready_for_human')))
      .returning({ id: messages.id })
    return saved.length > 0
  }
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
        const raw = (x.m.raw ?? {}) as { found_by_app?: unknown; printout?: unknown }
        const kind = x.kind as TodoStepKind
        const printout = x.m.channel === 'mail' && raw.printout === true
        return {
          message_id: x.m.id,
          kind,
          channel: x.m.channel,
          status,
          subject: x.m.subject,
          body: x.m.body,
          to_address: x.m.to_address,
          found_by_app: raw.found_by_app === true,
          printout,
          problems:
            status === 'waiting'
              ? stepProblems(kind, { subject: x.m.subject, body: x.m.body, printout })
              : [],
        }
      })
      .filter((s): s is TodoStep => s !== null)
      .sort((a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind))
    const hasLinkedIn = steps.some(
      (s) => s.channel === 'linkedin' && s.status !== 'skipped' && (s.to_address ?? '').trim(),
    )
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
  mail: 'Printout',
  email: 'Email',
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

/** Steps from the list marked sent since `since`, per channel, for the counts on each list. */
async function sentSince(deps: OutreachDeps, since: string): Promise<TodoList['sent_today']> {
  const rows = await deps.db
    .select({ channel: messages.channel, n: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`),
        eq(messages.status, 'sent'),
        gte(messages.sent_at, since),
      ),
    )
    .groupBy(messages.channel)
  const count = (channel: Message['channel']) =>
    Number(rows.find((r) => r.channel === channel)?.n ?? 0)
  return { linkedin: count('linkedin'), mail: count('mail'), email: count('email') }
}

export async function listTodo(deps: OutreachDeps): Promise<TodoList> {
  const settings = await getSettings(deps.db)
  const day = today(settings, deps.now())
  return {
    people: await openCards(deps),
    complete: await completePeople(deps, settings),
    replied: await repliedPeople(deps),
    today: { sent: (await goalProgress(deps, day.start)).sent, goal: settings.people_per_day },
    sent_today: await sentSince(deps, day.start),
    recycle_after_days: settings.recycle_after_days,
    email_footer: emailFooter(settings),
    gmail_user: (settings.reply_to || settings.owner_email).trim(),
  }
}

/**
 * "Not them" on a profile the app found: the profile leaves the step but the note stays, so Theo
 * can search LinkedIn himself and paste the right one. Returns false when it is not a waiting
 * LinkedIn step on the to-do list.
 */
export async function clearStepProfile(deps: OutreachDeps, messageId: string): Promise<boolean> {
  const msg = (await deps.db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]
  if (
    !msg ||
    msg.status !== 'ready_for_human' ||
    msg.channel !== 'linkedin' ||
    !msg.idempotency_key.startsWith(TODO_KEY_PREFIX)
  ) {
    return false
  }
  const raw = (msg.raw ?? {}) as Record<string, unknown>
  const saved = await deps.db
    .update(messages)
    .set({ to_address: null, raw: { ...raw, found_by_app: false } })
    .where(and(eq(messages.id, msg.id), eq(messages.status, 'ready_for_human')))
    .returning({ id: messages.id })
  return saved.length > 0
}

/**
 * Cards made before printouts (2026-10-16) still hold a 4x6 postcard and no email. A few at a time,
 * a waiting postcard becomes a printout written for them and their email joins the card.
 * Returns how many cards changed.
 */
export async function upgradeOpenCards(
  deps: OutreachDeps,
  settings: Settings,
  limit = 3,
): Promise<number> {
  const rows = await deps.db
    .select({ message: messages, lead: leads })
    .from(messages)
    .innerJoin(leads, eq(leads.id, messages.lead_id))
    .where(
      and(
        eq(messages.status, 'ready_for_human'),
        eq(messages.channel, 'mail'),
        like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`),
        sql`coalesce(${messages.raw} ->> 'printout', '') <> 'true'`,
        notInArray(leads.status, [...BLOCKED_LEAD_STATUSES]),
      ),
    )
    .orderBy(asc(messages.created_at))
    .limit(limit)
  let changed = 0
  for (const { message, lead } of rows) {
    const parsed = parseTodoKey(message.idempotency_key)
    if (!parsed || parsed.kind !== 'postcard') continue
    if (await contactBlocker(deps.db, lead)) continue
    const vars = buildVars(lead, settings, {
      baseUrl: deps.baseUrl,
      channel: 'mail',
      sequenceName: 'To do',
    })
    const [text, email] = await Promise.all([
      printoutText(deps, lead, vars),
      emailStep(deps, settings, lead, vars, true),
    ])
    const raw = (message.raw ?? {}) as Record<string, unknown>
    const saved = await deps.db
      .update(messages)
      .set({
        subject: text.heading,
        body: text.body,
        raw: {
          ...raw,
          printout: true,
          was_postcard: true,
          ...(text.personal ? { personal: true } : {}),
        },
      })
      .where(and(eq(messages.id, message.id), eq(messages.status, 'ready_for_human')))
      .returning({ id: messages.id })
    if (saved.length === 0) continue
    if (email) await insertSteps(deps, lead, parsed.round, [email])
    changed++
  }
  return changed
}

/**
 * People already on the list are checked again for sales every OWNERSHIP_RECHECK_DAYS, a few per
 * round. Anyone who sold off leaves the list: their waiting steps are dropped. Returns how many.
 */
export async function recheckOpenCards(
  deps: OutreachDeps,
  settings: Settings,
  limit = 10,
): Promise<number> {
  const open = await deps.db
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
  if (open.length === 0) return 0
  const people = await deps.db
    .select()
    .from(leads)
    .where(
      inArray(
        leads.id,
        open.map((o) => o.lead_id),
      ),
    )
  const now = deps.now()
  let checked = 0
  let removed = 0
  for (const lead of people) {
    if (checked >= limit) break
    if (!needsOwnershipCheck(lead, now)) continue
    checked++
    const own = await checkOwnership(deps, settings, lead)
    if (own.status !== 'sold_off') continue
    await deps.db
      .update(messages)
      .set({ status: 'skipped', error: 'stopped: sold their properties' })
      .where(
        and(
          eq(messages.lead_id, lead.id),
          eq(messages.status, 'ready_for_human'),
          like(messages.idempotency_key, `${TODO_KEY_PREFIX}%`),
        ),
      )
    removed++
  }
  return removed
}
