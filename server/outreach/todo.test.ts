// 2026-10-16: the to-do list replaces the timed sequence. Every step for a person at once, the
// person moves to Complete when every step is done, and comes back after 30 days with no reply.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { leads, messages } from '../db/schema.ts'
import { enrollEligible } from './enroll.ts'
import { judge, rejectLinkedInProfile, type LinkedInSearch } from './linkedinFinder.ts'
import { recordOutcome } from './outcomes.ts'
import { actOnQueueItem, saveLinkedInProfile } from './queue.ts'
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
    expect(list.today).toEqual({ added: 2, goal: 2 })
    expect(list.people).toHaveLength(2)
    expect(list.people[0]!.steps.map((s) => s.kind)).toEqual([
      'linkedin_connect',
      'postcard',
      'call',
    ])
    expect(list.people[0]!.steps.every((s) => s.status === 'waiting')).toBe(true)
    const note = list.people[0]!.steps[0]!
    expect(note.to_address).toContain('linkedin.com/in/')
    expect(note.body).toContain('Hi Lead')
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
    expect(after.complete[0]!.done.sort()).toEqual(['Call', 'LinkedIn', 'Postcard'])
    expect(after.complete[0]!.back_on).toBe(
      new Date(TUESDAY_10AM.getTime() + 30 * DAY).toISOString(),
    )

    // Not before the 30 days are up.
    at.now = new Date(TUESDAY_10AM.getTime() + 21 * DAY) // a Tuesday
    expect((await fillTodo(deps)).added).toBe(0)

    // 30 days on (a Thursday), no reply: back as round 2. The note was sent, so now a message;
    // the postcard waits for the 60 days between postcards.
    at.now = new Date(TUESDAY_10AM.getTime() + 30 * DAY)
    expect((await fillTodo(deps)).added).toBe(1)
    const back = (await listTodo(deps)).people[0]!
    expect(back.lead_id).toBe(lead.id)
    expect(back.round).toBe(2)
    expect(back.steps.map((s) => s.kind)).toEqual(['linkedin_follow_up', 'call'])
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

  it('no profile found: the card has the other steps, and a pasted profile joins it', async () => {
    const { db, deps } = await todoSetup({ linkedInSearch: fakeSearch([], 'NONE') })
    const lead = await insertLead(db, {
      full_name: 'Pat Lee',
      first_name: 'Pat',
      last_name: 'Lee',
      linkedin_url: null,
    })
    await fillTodo(deps)
    let card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['postcard', 'call'])
    expect(card.linkedin_missing).toBe('not_found')

    const r = await saveLinkedInProfile(deps, lead.id, 'linkedin.com/in/lead-person')
    expect(r.queued).toBe(true)
    card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['linkedin_connect', 'postcard', 'call'])
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
