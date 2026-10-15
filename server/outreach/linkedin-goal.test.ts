import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { enrollments, leads, messages } from '../db/schema.ts'
import { enrollLead } from './enroll.ts'
import { actOnQueueItem, listQueue, restoreQueueItem } from './queue.ts'
import { sendDue } from './send.ts'
import { updateSequence } from './sequences.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

const TUESDAY_10AM = new Date('2026-10-13T14:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

// Like the main sequence: email 1, the LinkedIn note two days later, then email 2.
const MAIN_LIKE = [
  { delay_days: 0, channel: 'email' as const, subject: 'Hi {{first_name}}', body: 'Email one' },
  { delay_days: 2, channel: 'linkedin' as const, body: 'Hi {{first_name}}, old words.' },
  { delay_days: 2, channel: 'email' as const, subject: 'Again', body: 'Email two' },
]

async function goalSetup(linkedInGoal: number) {
  const at = { now: TUESDAY_10AM }
  const fx = await setup({ now: () => at.now })
  await setSettings(fx.db, {
    channels: { email: true, linkedin: true, mail: true },
    daily_caps: { linkedin: linkedInGoal },
  })
  const { sequence } = await insertSequence(fx.db, { name: 'Main like' }, MAIN_LIKE)
  return { ...fx, at, sequence }
}

const linkedInTasks = async (db: Awaited<ReturnType<typeof setup>>['db']) =>
  (await db.select().from(messages)).filter((m) => m.channel === 'linkedin')

describe("LinkedIn notes keep coming up until today's goal", () => {
  it('pulls the next notes forward while under the goal, and the email after keeps its date', async () => {
    const { db, deps, sequence } = await goalSetup(2)
    const people = [await insertLead(db), await insertLead(db), await insertLead(db)]
    for (const p of people) await enrollLead(deps, p.id, sequence.id)
    expect(await sendDue(deps)).toMatchObject({ dryRun: 3 }) // email 1 for all three
    const linkedInDay = (await db.select().from(enrollments))[0]!.next_send_at!
    expect(new Date(linkedInDay).getTime()).toBeGreaterThan(TUESDAY_10AM.getTime() + DAY)

    // Nothing is due yet, but two notes (the goal) come up now instead of on Thursday.
    expect(await sendDue(deps)).toMatchObject({ queued: 2 })
    const tasks = await linkedInTasks(db)
    expect(tasks.map((t) => t.status)).toEqual(['ready_for_human', 'ready_for_human'])
    const first = (await db.select().from(enrollments)).find(
      (e) => e.lead_id === tasks[0]!.lead_id,
    )!
    expect(first.current_step).toBe(2)
    // Email 2 still counts its two days from Thursday, not from today.
    expect(new Date(first.next_send_at!).getTime()).toBeGreaterThan(
      new Date(linkedInDay).getTime() + DAY,
    )

    // The goal is met: the third waits. A skip frees a slot and the third comes up.
    expect(await sendDue(deps)).toMatchObject({ queued: 0 })
    await actOnQueueItem(deps, tasks[0]!.id, 'skip')
    const after = await linkedInTasks(db)
    expect(after.filter((t) => t.status === 'ready_for_human')).toHaveLength(2)
    expect(new Set(after.map((t) => t.lead_id))).toEqual(new Set(people.map((p) => p.id)))
  })

  it('never pulls forward a lead without a profile, nor a second LinkedIn step', async () => {
    const { db, deps, sequence } = await goalSetup(15)
    const noProfile = await insertLead(db, { linkedin_url: null })
    await enrollLead(deps, noProfile.id, sequence.id)
    const { sequence: twoNotes } = await insertSequence(db, { name: 'Two notes' }, [
      { delay_days: 0, channel: 'email', subject: 'Hi', body: 'Email' },
      { delay_days: 1, channel: 'linkedin', body: 'Connect note' },
      { delay_days: 3, channel: 'linkedin', body: 'Thanks for connecting' },
    ])
    const connected = await insertLead(db)
    await enrollLead(deps, connected.id, twoNotes.id)
    await sendDue(deps) // both emails
    await sendDue(deps) // the connect note comes up early; the profileless lead waits
    const note = (await linkedInTasks(db)).find((t) => t.lead_id === connected.id)!
    expect((await linkedInTasks(db)).map((t) => t.lead_id)).toEqual([connected.id])
    await actOnQueueItem(deps, note.id, 'done')
    expect(await sendDue(deps)).toMatchObject({ queued: 0 }) // the follow-up keeps its wait
    const profileless = (await db.select().from(enrollments)).find(
      (e) => e.lead_id === noProfile.id,
    )!
    expect(profileless.current_step).toBe(1)
  })

  it('gives the note to a lead whose profile turned up after the step was skipped', async () => {
    const { db, deps, at, sequence } = await goalSetup(15)
    const late = await insertLead(db, { linkedin_url: null })
    await enrollLead(deps, late.id, sequence.id)
    await sendDue(deps) // email 1
    at.now = new Date('2026-10-16T14:00:00.000Z') // Friday: the step is skipped, no profile
    await sendDue(deps)
    const before = (await db.select().from(enrollments))[0]!
    expect(before.current_step).toBe(2)
    expect(await linkedInTasks(db)).toHaveLength(0)

    const profile = 'https://www.linkedin.com/in/late-owner'
    await db.update(leads).set({ linkedin_url: profile }).where(eq(leads.id, late.id))
    expect(await sendDue(deps)).toMatchObject({ queued: 1 })
    const [task] = await linkedInTasks(db)
    expect(task).toMatchObject({ status: 'ready_for_human', to_address: profile })
    expect(task!.idempotency_key).toBe(`${before.id}:1`)
    // The enrollment does not move: email 2 keeps its date.
    expect((await db.select().from(enrollments))[0]).toMatchObject({
      current_step: 2,
      next_send_at: before.next_send_at,
    })
    expect(await sendDue(deps)).toMatchObject({ queued: 0 }) // once
  })

  it('one note per person: a skipped lead or a profile someone already has is not caught up', async () => {
    const { db, deps, at, sequence } = await goalSetup(15)
    const shared = 'https://www.linkedin.com/in/same-person/'
    const skipped = await insertLead(db)
    const twin = await insertLead(db, { linkedin_url: null })
    const twinOf = await insertLead(db, { linkedin_url: null })
    for (const p of [skipped, twin, twinOf]) await enrollLead(deps, p.id, sequence.id)
    await sendDue(deps) // email 1 for all
    await sendDue(deps) // the skipped lead's note comes up early
    const [note] = await linkedInTasks(db)
    await actOnQueueItem(deps, note!.id, 'skip')
    at.now = new Date('2026-10-16T14:00:00.000Z')
    await sendDue(deps) // the two without a profile skip their LinkedIn step

    await db.update(leads).set({ linkedin_url: shared }).where(eq(leads.id, twin.id))
    await db
      .update(leads)
      .set({ linkedin_url: 'https://linkedin.com/in/Same-Person' })
      .where(eq(leads.id, twinOf.id))
    expect(await sendDue(deps)).toMatchObject({ queued: 1 })
    const waiting = (await linkedInTasks(db)).filter((t) => t.status === 'ready_for_human')
    expect(waiting).toHaveLength(1)
    expect([twin.id, twinOf.id]).toContain(waiting[0]!.lead_id)
  })
})

describe('Bring back a task skipped by mistake', () => {
  it('lists recent skips, brings one back with the words the step has now, and counts done', async () => {
    const { db, deps, sequence } = await goalSetup(15)
    const lead = await insertLead(db, { first_name: 'Jay M' })
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps)
    await sendDue(deps)
    const [task] = await linkedInTasks(db)
    expect(task!.body).toBe('Hi Jay, old words.') // no middle initial in the greeting
    await actOnQueueItem(deps, task!.id, 'skip')

    await updateSequence(deps, sequence.id, {
      steps: MAIN_LIKE.map((s) =>
        s.channel === 'linkedin' ? { ...s, body: 'Hi {{first_name}}, new words.' } : s,
      ),
    })
    let queue = await listQueue(deps)
    expect(queue.total).toBe(0)
    expect(queue.skipped_recently.map((i) => i.message_id)).toEqual([task!.id])
    expect(queue.today.linkedin).toEqual({ done: 0, goal: 15 })

    expect(await restoreQueueItem(deps, task!.id)).toMatchObject({ status: 'ready_for_human' })
    queue = await listQueue(deps)
    expect(queue.skipped_recently).toHaveLength(0)
    expect(queue.groups.linkedin!.map((i) => i.body)).toEqual(['Hi Jay, new words.'])

    await actOnQueueItem(deps, task!.id, 'done')
    queue = await listQueue(deps)
    expect(queue.today.linkedin).toEqual({ done: 1, goal: 15 })
    const saved = (await db.select().from(messages)).find((m) => m.id === task!.id)!
    expect(saved).toMatchObject({ status: 'sent', body: 'Hi Jay, new words.' })
  })

  it('a skip can still be brought back for a week, not after', async () => {
    const { db, deps, at, sequence } = await goalSetup(15)
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps)
    await sendDue(deps)
    const [task] = await linkedInTasks(db)
    await actOnQueueItem(deps, task!.id, 'skip')
    at.now = new Date(TUESDAY_10AM.getTime() + 3 * DAY)
    expect((await listQueue(deps)).skipped_recently.map((i) => i.message_id)).toEqual([task!.id])
    at.now = new Date(TUESDAY_10AM.getTime() + 8 * DAY)
    expect((await listQueue(deps)).skipped_recently).toHaveLength(0)
  })

  it('never brings back an app skip, a task not skipped, or a person who replied', async () => {
    const { db, deps, sequence } = await goalSetup(15)
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps)
    await sendDue(deps)
    const [task] = await linkedInTasks(db)
    await expect(restoreQueueItem(deps, task!.id)).rejects.toMatchObject({
      code: 'NOT_SKIPPED_BY_YOU',
    })
    await actOnQueueItem(deps, task!.id, 'skip')
    await db.update(leads).set({ status: 'replied' }).where(eq(leads.id, lead.id))
    await expect(restoreQueueItem(deps, task!.id)).rejects.toMatchObject({ code: 'LEAD_BLOCKED' })

    await db.update(leads).set({ status: 'enrolled' }).where(eq(leads.id, lead.id))
    await db.update(messages).set({ error: 'stopped: replied' }).where(eq(messages.id, task!.id))
    await expect(restoreQueueItem(deps, task!.id)).rejects.toMatchObject({
      code: 'NOT_SKIPPED_BY_YOU',
    })
    expect((await listQueue(deps)).skipped_recently).toHaveLength(0)
  })
})
