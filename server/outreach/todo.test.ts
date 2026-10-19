// 2026-10-16: the to-do list replaces the timed sequence. Every step for a person at once, the
// person moves to Complete when every step is done, and comes back after 30 days with no reply.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { leads, messages } from '../db/schema.ts'
import { enrollEligible } from './enroll.ts'
import { judge, rejectLinkedInProfile, type LinkedInSearch } from './linkedinFinder.ts'
import { recordOutcome } from './outcomes.ts'
import { addSuppression } from './suppression.ts'
import { actOnQueueItem } from './queue.ts'
import { fillTodo, listTodo } from './todo.ts'
import { insertLead, setSettings, setup } from './testFixtures.ts'

const TUESDAY_10AM = new Date('2026-10-13T14:00:00.000Z')
const SUNDAY_10AM = new Date('2026-10-11T14:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

async function todoSetup(overrides: { linkedInSearch?: LinkedInSearch } = {}) {
  const at = { now: TUESDAY_10AM }
  const fx = await setup({ now: () => at.now, ...overrides })
  await setSettings(fx.db, {
    sequences_on: false,
    people_per_day: 2,
    channels: { email: false, linkedin: true, mail: true, call: true },
    physical_address: '1500 Market St, Philadelphia, PA 19102',
  })
  return { ...fx, at }
}

/** A fake Claude search: these results, then this answer. */
function fakeSearch(results: { url: string; title: string }[], answer: string): LinkedInSearch {
  return async () => ({
    stop_reason: 'end_turn',
    content: [
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: results.map((r) => ({
          type: 'web_search_result',
          url: r.url,
          title: r.title,
          encrypted_content: '',
          page_age: null,
        })),
      },
      { type: 'text', text: answer, citations: null },
    ] as unknown as Anthropic.Messages.ContentBlock[],
  })
}

describe('to-do list', () => {
  it('puts every step up at once, up to the daily number, and nothing on a weekend', async () => {
    const { db, deps, at } = await todoSetup()
    await insertLead(db)
    await insertLead(db)
    await insertLead(db)

    at.now = SUNDAY_10AM
    expect(await fillTodo(deps)).toEqual({ added: 0, reason: 'not a send day' })

    at.now = TUESDAY_10AM
    expect((await fillTodo(deps)).added).toBe(2)
    expect((await fillTodo(deps)).added).toBe(0) // today's 2 are on the list

    const list = await listTodo(deps)
    expect(list.today).toEqual({ sent: 0, goal: 2 })
    expect(list.people).toHaveLength(2)
    // LinkedIn note, then the printout, then the email (2026-10-16). No call on new cards.
    expect(list.people[0]!.steps.map((s) => s.kind)).toEqual([
      'linkedin_connect',
      'postcard',
      'email',
    ])
    expect(list.people[0]!.steps.every((s) => s.status === 'waiting')).toBe(true)
    const [note, printout, email] = list.people[0]!.steps
    expect(note!.to_address).toContain('linkedin.com/in/')
    expect(note!.body).toContain('Hi Lead')
    // No model in tests: Theo's own words for their kind of owner, with a heading.
    expect(printout).toMatchObject({ channel: 'mail', printout: true, problems: [] })
    expect(printout!.subject).toBe('Lead, here is how Prop Archive can help')
    expect(printout!.body).toContain('Prop Archive')
    // The email goes to their address even with the app's own email off: Theo sends it himself.
    expect(email).toMatchObject({ channel: 'email', problems: [] })
    expect(email!.to_address).toMatch(/@example\.com$/)
    expect(email!.subject).toBeTruthy()
    expect(email!.body).toMatch(/^Hi Lead,/)
    expect(email!.body).toContain('I mailed you a one-page overview')
    expect(list.email_footer).toContain('Reply "stop"')
    expect(list.email_footer).toContain('1500 Market St')
  })

  it('a skipped person is replaced until the goal is people sent to today', async () => {
    const { db, deps } = await todoSetup()
    for (let i = 0; i < 5; i++) await insertLead(db)
    expect((await fillTodo(deps)).added).toBe(2)
    let people = (await listTodo(deps)).people
    const [kept, skipped] = people

    // Theo skips every step for one person: a new person takes their place.
    for (const step of skipped!.steps) await actOnQueueItem(deps, step.message_id, 'skip')
    expect((await fillTodo(deps)).added).toBe(0) // the skip already brought them in
    people = (await listTodo(deps)).people
    expect(people).toHaveLength(2)
    expect(people.map((p) => p.lead_id)).not.toContain(skipped!.lead_id)

    // Sent counts once he clicks Sent on a step, one per person.
    const kept2 = people.find((p) => p.lead_id === kept!.lead_id)!
    await actOnQueueItem(deps, kept2.steps[0]!.message_id, 'done')
    expect((await listTodo(deps)).today).toEqual({ sent: 1, goal: 2 })
    expect((await fillTodo(deps)).added).toBe(0) // one sent + one still waiting = 2

    // Both people sent to: today's goal is met, nobody new comes.
    const other = people.find((p) => p.lead_id !== kept!.lead_id)!
    await actOnQueueItem(deps, other.steps[0]!.message_id, 'done')
    for (const p of (await listTodo(deps)).people)
      for (const step of p.steps)
        if (step.status === 'waiting') await actOnQueueItem(deps, step.message_id, 'skip')
    expect((await listTodo(deps)).today).toEqual({ sent: 2, goal: 2 })
    expect((await fillTodo(deps)).added).toBe(0)
  })

  it('skipping only the LinkedIn note brings a new person; the goal is LinkedIn notes sent', async () => {
    const { db, deps } = await todoSetup()
    for (let i = 0; i < 5; i++) await insertLead(db)
    expect((await fillTodo(deps)).added).toBe(2)
    const [first, second] = (await listTodo(deps)).people
    const note = (p: typeof first) => p!.steps.find((s) => s.channel === 'linkedin')!

    // Theo skips one LinkedIn note. Their printout and email stay, and a new person comes.
    await actOnQueueItem(deps, note(first).message_id, 'skip')
    expect((await fillTodo(deps)).added).toBe(0) // the skip already brought them in
    const people = (await listTodo(deps)).people
    expect(people).toHaveLength(3)
    expect(
      people.find((p) => p.lead_id === first!.lead_id)!.steps.some((s) => s.status === 'waiting'),
    ).toBe(true)

    // Mailing a printout is not a LinkedIn note sent: the goal does not move.
    const printout = people
      .find((p) => p.lead_id === first!.lead_id)!
      .steps.find((s) => s.channel === 'mail' && s.status === 'waiting')!
    await actOnQueueItem(deps, printout.message_id, 'done')
    expect((await listTodo(deps)).today).toEqual({ sent: 0, goal: 2 })
    expect((await fillTodo(deps)).added).toBe(0) // two LinkedIn notes still waiting

    // Two LinkedIn notes sent: today's goal is met, nobody new comes.
    await actOnQueueItem(deps, note(second).message_id, 'done')
    const third = people.find((p) => p.lead_id !== first!.lead_id && p.lead_id !== second!.lead_id)!
    await actOnQueueItem(deps, note(third).message_id, 'done')
    expect((await listTodo(deps)).today).toEqual({ sent: 2, goal: 2 })
    expect((await fillTodo(deps)).added).toBe(0)
  })

  it('moves a person to Complete when every step is done, and back after 30 days', async () => {
    const { db, deps, at } = await todoSetup()
    const lead = await insertLead(db)
    await fillTodo(deps)
    const card = (await listTodo(deps)).people[0]!
    for (const step of card.steps) await actOnQueueItem(deps, step.message_id, 'done')

    const after = await listTodo(deps)
    expect(after.people).toHaveLength(0)
    expect(after.complete).toHaveLength(1)
    expect(after.complete[0]!.done.sort()).toEqual(['Email', 'LinkedIn', 'Printout'])
    expect(after.complete[0]!.back_on).toBe(
      new Date(TUESDAY_10AM.getTime() + 30 * DAY).toISOString(),
    )

    // Not before the 30 days are up.
    at.now = new Date(TUESDAY_10AM.getTime() + 21 * DAY) // a Tuesday
    expect((await fillTodo(deps)).added).toBe(0)

    // 30 days on (a Thursday), no reply: back as round 2. The note was sent, so now a message;
    // the printout waits for the 60 days between mailings; the email is a short follow-up.
    at.now = new Date(TUESDAY_10AM.getTime() + 30 * DAY)
    expect((await fillTodo(deps)).added).toBe(1)
    const back = (await listTodo(deps)).people[0]!
    expect(back.lead_id).toBe(lead.id)
    expect(back.round).toBe(2)
    expect(back.steps.map((s) => s.kind)).toEqual(['linkedin_follow_up', 'email'])
    const followUp = back.steps[1]!
    expect(followUp.body).toContain('Following up on my email from last month')
    expect(followUp.body).not.toContain('mailed you')
    expect(followUp.problems).toEqual([])
  })

  it('counts the LinkedIn notes, printouts and emails sent today', async () => {
    const { db, deps, at } = await todoSetup()
    await insertLead(db)
    await insertLead(db)
    await fillTodo(deps)
    let list = await listTodo(deps)
    expect(list.sent_today).toEqual({ linkedin: 0, mail: 0, email: 0 })

    const [first, second] = list.people
    for (const step of first!.steps) await actOnQueueItem(deps, step.message_id, 'done')
    const step = (ch: string) => second!.steps.find((s) => s.channel === ch)!.message_id
    await actOnQueueItem(deps, step('linkedin'), 'done')
    await actOnQueueItem(deps, step('mail'), 'skip') // a skip is not a send
    list = await listTodo(deps)
    expect(list.sent_today).toEqual({ linkedin: 2, mail: 1, email: 1 })

    // A new day starts at zero.
    at.now = new Date(TUESDAY_10AM.getTime() + DAY)
    expect((await listTodo(deps)).sent_today).toEqual({ linkedin: 0, mail: 0, email: 0 })
  })

  it('a reply drops the waiting steps, never recycles them, and lists them under Replied', async () => {
    const { db, deps, at } = await todoSetup()
    const lead = await insertLead(db)
    await fillTodo(deps)
    await recordOutcome(deps, lead.id, 'replied', 'manual', {
      channel: 'linkedin',
      note: 'Sure, send me times',
    })
    const list = await listTodo(deps)
    expect(list.people).toHaveLength(0)
    expect(list.replied).toHaveLength(1)
    expect(list.replied[0]).toMatchObject({
      lead_id: lead.id,
      status: 'replied',
      channel: 'linkedin',
      note: 'Sure, send me times',
    })
    at.now = new Date(TUESDAY_10AM.getTime() + 40 * DAY)
    expect((await fillTodo(deps)).added).toBe(0)
  })

  it('anyone with a LinkedIn Enrich found, an email or a mailing address goes on the list; LinkedIn first', async () => {
    const { db, deps } = await todoSetup()
    await setSettings(db, { people_per_day: 20 })
    const ready = await insertLead(db, { full_name: 'Ready Person' })
    // People Data Labs stores the link without https or www: it still counts.
    const fromPdl = await insertLead(db, {
      full_name: 'Pdl Person',
      linkedin_url: 'https://www.linkedin.com/in/pdl-person/',
      enrichment: {
        pdl: { fetched_at: 'x', data: { linkedin_url: 'linkedin.com/in/pdl-person' } },
      },
    })
    // Only the LinkedIn: on the list with just the note.
    const onlyLinkedIn = await insertLead(db, {
      full_name: 'Only LinkedIn',
      email: null,
      mailing_street: null,
    })
    // From an imported list: Enrich never found the link, so no note, but the printout and email.
    const imported = await insertLead(db, { full_name: 'Imported Link', enrichment: {} })
    // Found by the separate LinkedIn lookup, not by Enrich: no note either.
    const finder = await insertLead(db, {
      full_name: 'Finder Link',
      linkedin_url: 'https://www.linkedin.com/in/finder-link/',
      enrichment: {
        linkedin_find: {
          fetched_at: 'x',
          data: { url: 'https://www.linkedin.com/in/finder-link/' },
        },
      },
    })
    // Only an email.
    const onlyEmail = await insertLead(db, {
      full_name: 'Only Email',
      linkedin_url: null,
      mailing_street: null,
    })
    // Only a mailing address (a bad email does not count).
    const onlyMail = await insertLead(db, {
      full_name: 'Only Mail',
      linkedin_url: null,
      email_status: 'invalid',
    })
    // No way to reach them: never on the list.
    await insertLead(db, {
      full_name: 'Nothing',
      linkedin_url: null,
      email: null,
      mailing_street: null,
    })

    // A small round takes the LinkedIn people first.
    expect((await fillTodo(deps, { limit: 3 })).added).toBe(3)
    let people = (await listTodo(deps)).people
    expect(people.map((p) => p.lead_id).sort()).toEqual(
      [ready.id, fromPdl.id, onlyLinkedIn.id].sort(),
    )

    const second = await fillTodo(deps, { limit: 20 })
    people = (await listTodo(deps)).people
    expect(second.added).toBe(4)
    const kinds = new Map(people.map((p) => [p.lead_id, p.steps.map((s) => s.kind)]))
    expect(kinds.size).toBe(7)
    expect(kinds.get(ready.id)).toEqual(['linkedin_connect', 'postcard', 'email'])
    expect(kinds.get(fromPdl.id)).toEqual(['linkedin_connect', 'postcard', 'email'])
    expect(kinds.get(onlyLinkedIn.id)).toEqual(['linkedin_connect'])
    expect(kinds.get(imported.id)).toEqual(['postcard', 'email'])
    expect(kinds.get(finder.id)).toEqual(['postcard', 'email'])
    expect(kinds.get(onlyEmail.id)).toEqual(['email'])
    expect(kinds.get(onlyMail.id)).toEqual(['postcard'])
    for (const p of people)
      for (const s of p.steps) if (s.channel === 'linkedin') expect(s.found_by_app).toBe(true)
  })

  it('someone already on the list gets their LinkedIn note once Enrich finds their profile', async () => {
    const { db, deps } = await todoSetup()
    const lead = await insertLead(db, { linkedin_url: null })
    expect((await fillTodo(deps)).added).toBe(1)
    let card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['postcard', 'email'])

    // Enrich finds their LinkedIn while the printout is still waiting.
    const url = 'https://www.linkedin.com/in/late-find'
    await db
      .update(leads)
      .set({
        linkedin_url: url,
        enrichment: { claude_research: { fetched_at: 'x', data: { linkedin_url: url } } },
      })
      .where(eq(leads.id, lead.id))
    await fillTodo(deps)
    card = (await listTodo(deps)).people.find((p) => p.lead_id === lead.id)!
    expect(card.steps.map((s) => s.kind)).toEqual(['linkedin_connect', 'postcard', 'email'])
    expect(card.steps[0]!.to_address ?? url).toBe(url)
  })

  it('someone already on the list gets their email once Enrich finds it (Emails tab)', async () => {
    const { db, deps } = await todoSetup()
    const lead = await insertLead(db, { email: null })
    expect((await fillTodo(deps)).added).toBe(1)
    let card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['linkedin_connect', 'postcard'])

    await db
      .update(leads)
      .set({ email: 'found@example.com', email_status: 'valid' })
      .where(eq(leads.id, lead.id))
    await fillTodo(deps)
    card = (await listTodo(deps)).people.find((p) => p.lead_id === lead.id)!
    expect(card.steps.map((s) => s.kind)).toEqual(['linkedin_connect', 'postcard', 'email'])
    // Only once: the next round adds nothing more.
    await fillTodo(deps)
    card = (await listTodo(deps)).people.find((p) => p.lead_id === lead.id)!
    expect(card.steps).toHaveLength(3)
  })

  it('people with no LinkedIn are added at most the goal a day, however many notes are skipped', async () => {
    const { db, deps } = await todoSetup()
    for (let i = 0; i < 6; i++) await insertLead(db, { linkedin_url: null })
    expect((await fillTodo(deps)).added).toBe(2)
    for (const p of (await listTodo(deps)).people)
      for (const s of p.steps) await actOnQueueItem(deps, s.message_id, 'skip')
    expect((await fillTodo(deps)).added).toBe(0)
  })

  it('never looks people up on LinkedIn itself while it fills the list', async () => {
    let searched = 0
    const search: LinkedInSearch = async (...args) => {
      searched++
      return fakeSearch([], 'NONE')(...args)
    }
    const { db, deps } = await todoSetup({ linkedInSearch: search })
    await insertLead(db, {
      full_name: 'Pat Lee',
      first_name: 'Pat',
      last_name: 'Lee',
      linkedin_url: null,
    })
    await insertLead(db)
    // Pat has an email and a mailing address, so Pat comes on too, just with no LinkedIn note.
    expect((await fillTodo(deps)).added).toBe(2)
    expect(searched).toBe(0)
  })

  it('a wrong profile: it leaves the note and the finder never brings it back', async () => {
    const { db, deps } = await todoSetup()
    const lead = await insertLead(db, {
      full_name: 'Jane Doe',
      first_name: 'Jane',
      last_name: 'Doe',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe-1a2b/',
    })
    await fillTodo(deps)
    const card = (await listTodo(deps)).people[0]!
    expect(card.steps[0]).toMatchObject({
      kind: 'linkedin_connect',
      to_address: 'https://www.linkedin.com/in/jane-doe-1a2b/',
      found_by_app: true,
    })
    await rejectLinkedInProfile(deps, lead.id)
    await actOnQueueItem(deps, card.steps[0]!.message_id, 'skip')
    const after = (await db.select().from(leads).where(eq(leads.id, lead.id)))[0]!
    expect(after.linkedin_url).toBeNull()
    expect((after.enrichment.linkedin_find?.data as { rejected: string[] }).rejected).toEqual([
      'https://www.linkedin.com/in/jane-doe-1a2b/',
    ])
    expect((await listTodo(deps)).people[0]!.linkedin_missing).toBe('not_found')
  })

  it('never puts someone on the suppression list on it', async () => {
    const { db, deps } = await todoSetup()
    const lead = await insertLead(db)
    await addSuppression(db, 'email', lead.email, 'unsubscribed')
    expect((await fillTodo(deps)).added).toBe(0)
    expect((await listTodo(deps)).people).toHaveLength(0)
  })

  it('timed sequences off: nothing is enrolled; on: the to-do list stays empty', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db)
    expect(await enrollEligible(deps)).toEqual({ enrolled: 0 })
    await setSettings(db, { sequences_on: true })
    expect(await fillTodo(deps)).toEqual({ added: 0, reason: 'timed sequences are on' })
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})

describe('LinkedIn finder judge', () => {
  const person = { first: 'John', last: 'Smith', company: 'Fairmount Rentals LLC' }
  const a = {
    url: 'https://www.linkedin.com/in/john-smith-1/',
    title: 'John Smith - Nurse | LinkedIn',
  }
  const b = {
    url: 'https://www.linkedin.com/in/john-smith-2/',
    title: 'John Smith - Owner - Fairmount Rentals | LinkedIn',
  }

  it('takes a pick that is a search result with their name', () => {
    expect(judge([a], a.url, person).url).toBe(a.url)
  })

  it('refuses a pick that was not a search result, or no pick', () => {
    expect(judge([a], 'https://www.linkedin.com/in/made-up/', person).url).toBeNull()
    expect(judge([a], null, person).url).toBeNull()
  })

  it('with several people of that name, the pick must show the trade, place or company', () => {
    expect(judge([a, b], a.url, person).url).toBeNull()
    expect(judge([a, b], b.url, person).url).toBe(b.url)
  })

  it('never picks a profile Theo said was someone else', () => {
    expect(judge([b], b.url, person, [b.url]).url).toBeNull()
  })
})
