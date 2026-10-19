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
import { clearStepProfile, fillTodo, findLinkedInNow, listTodo } from './todo.ts'
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
    expect(list.today).toEqual({ added: 2, goal: 2 })
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

  it('finds the LinkedIn profile first, so the note is on the card', async () => {
    const search = fakeSearch(
      [
        {
          url: 'https://www.linkedin.com/in/jane-doe-1a2b',
          title: 'Jane Doe - Owner - Doe Homes | LinkedIn',
        },
      ],
      'https://www.linkedin.com/in/jane-doe-1a2b',
    )
    const { db, deps } = await todoSetup({ linkedInSearch: search })
    const lead = await insertLead(db, {
      full_name: 'Jane Doe',
      first_name: 'Jane',
      last_name: 'Doe',
      linkedin_url: null,
    })
    await fillTodo(deps)
    const card = (await listTodo(deps)).people[0]!
    expect(card.steps[0]).toMatchObject({
      kind: 'linkedin_connect',
      to_address: 'https://www.linkedin.com/in/jane-doe-1a2b/',
      found_by_app: true,
    })
    const saved = (await db.select().from(leads).where(eq(leads.id, lead.id)))[0]!
    expect(saved.linkedin_url).toBe('https://www.linkedin.com/in/jane-doe-1a2b/')

    // Wrong person: the profile goes, and never comes back from the finder.
    await rejectLinkedInProfile(deps, lead.id)
    await actOnQueueItem(deps, card.steps[0]!.message_id, 'skip')
    const after = (await db.select().from(leads).where(eq(leads.id, lead.id)))[0]!
    expect(after.linkedin_url).toBeNull()
    expect((after.enrichment.linkedin_find?.data as { rejected: string[] }).rejected).toEqual([
      'https://www.linkedin.com/in/jane-doe-1a2b/',
    ])
    const rest = (await listTodo(deps)).people[0]!
    expect(rest.linkedin_missing).toBe('not_found')
  })

  it('no profile found: no LinkedIn note; "Find their LinkedIn" looks again and adds it', async () => {
    const { db, deps } = await todoSetup({ linkedInSearch: fakeSearch([], 'NONE') })
    const lead = await insertLead(db, {
      full_name: 'Pat Lee',
      first_name: 'Pat',
      last_name: 'Lee',
      linkedin_url: null,
    })
    await fillTodo(deps)
    let card = (await listTodo(deps)).people[0]!
    // Theo only sends a note he can open the exact profile for: no note without one.
    expect(card.steps.map((s) => s.kind)).toEqual(['postcard', 'email'])
    expect(card.linkedin_missing).toBe('not_found')

    // Still nobody: nothing changes.
    expect(await findLinkedInNow(deps, lead.id)).toMatchObject({
      status: 'not_found',
      linkedin_url: null,
      queued: false,
    })
    expect((await listTodo(deps)).people[0]!.steps).toHaveLength(2)

    // The app finds them on the next look: their note joins the card with that exact profile.
    deps.linkedInSearch = fakeSearch(
      [
        {
          url: 'https://www.linkedin.com/in/pat-lee-9',
          title: 'Pat Lee - Landlord - Philadelphia',
        },
      ],
      'https://www.linkedin.com/in/pat-lee-9',
    )
    expect(await findLinkedInNow(deps, lead.id)).toMatchObject({
      status: 'found',
      linkedin_url: 'https://www.linkedin.com/in/pat-lee-9/',
      queued: true,
    })
    card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['linkedin_connect', 'postcard', 'email'])
    expect(card.steps[0]).toMatchObject({
      to_address: 'https://www.linkedin.com/in/pat-lee-9/',
      found_by_app: true,
    })
    expect(card.steps[0]!.body).toContain('Hi Pat')
    expect(card.linkedin_missing).toBeNull()
  })

  it('a wrong profile on a waiting note: "Find their LinkedIn" puts the right one on that note', async () => {
    const { db, deps } = await todoSetup({
      linkedInSearch: fakeSearch(
        [
          {
            url: 'https://www.linkedin.com/in/sam-roe-1',
            title: 'Sam Roe - Realtor - Philadelphia',
          },
        ],
        'https://www.linkedin.com/in/sam-roe-1',
      ),
    })
    const lead = await insertLead(db, {
      full_name: 'Sam Roe',
      first_name: 'Sam',
      last_name: 'Roe',
      linkedin_url: null,
    })
    await fillTodo(deps)
    const noteId = (await listTodo(deps)).people[0]!.steps[0]!.message_id
    await rejectLinkedInProfile(deps, lead.id)
    await clearStepProfile(deps, noteId)
    expect((await listTodo(deps)).people[0]!.steps[0]!.to_address).toBeNull()

    deps.linkedInSearch = fakeSearch(
      [{ url: 'https://www.linkedin.com/in/sam-roe-2', title: 'Sam Roe - Owner - Roe Rentals' }],
      'https://www.linkedin.com/in/sam-roe-2',
    )
    expect(await findLinkedInNow(deps, lead.id)).toMatchObject({ status: 'found', queued: true })
    const card = (await listTodo(deps)).people[0]!
    expect(card.steps.filter((s) => s.channel === 'linkedin')).toHaveLength(1)
    expect(card.steps[0]).toMatchObject({
      message_id: noteId,
      to_address: 'https://www.linkedin.com/in/sam-roe-2/',
      found_by_app: true,
    })
  })

  it('no name and no profile: no LinkedIn step, the printout and email still come', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db, {
      full_name: 'Fairmount Rentals LLC',
      first_name: null,
      last_name: null,
      company: 'Fairmount Rentals LLC',
      owner_kind: 'llc',
      linkedin_url: null,
    })
    await fillTodo(deps)
    const card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['postcard', 'email'])
    expect(card.linkedin_missing).toBe('no_name')
    expect(card.steps[0]!.subject).toBe('How Prop Archive can help Fairmount Rentals LLC')
    expect(card.steps[1]!.body).toMatch(/^Hi,/)
  })

  it('no email, or a bad one: no email step', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db, { email: null })
    await insertLead(db, { email_status: 'invalid' })
    await fillTodo(deps)
    const people = (await listTodo(deps)).people
    expect(people).toHaveLength(2)
    for (const p of people)
      expect(p.steps.map((s) => s.kind)).toEqual(['linkedin_connect', 'postcard'])
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
