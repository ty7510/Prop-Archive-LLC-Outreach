// 2026-10-16: the printout Theo mails in a folder with his card and the email he sends from Gmail.
// The app writes both for each person, Theo proofs and edits them, and the app never sends either.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRINTOUT_BIO,
  DEFAULT_PRINTOUT_CLOSING,
  DEFAULT_PRINTOUT_OVERVIEW,
  PRINTOUT_LIMITS,
} from '../../shared/printout.ts'
import { messages } from '../db/schema.ts'
import { hasEmDash } from '../lib/text.ts'
import { copyProblems, ruleProblems } from './copyRules.ts'
import type { Llm } from './deps.ts'
import {
  EMAIL_WORDS,
  emailProblems,
  fallbackEmail,
  FOLLOW_UP_WORDS,
  writeHandEmail,
  type HandEmail,
} from './handEmail.ts'
import {
  companyName,
  FALLBACK_PRINTOUT,
  personFirstName,
  PRINTOUT_WORDS,
  printoutHeading,
  writePrintout,
} from './printout.ts'
import {
  actOnQueueItem,
  editStepText,
  printoutDoc,
  printPage,
  saveLinkedInProfile,
} from './queue.ts'
import { insertLead, setSettings, setup } from './testFixtures.ts'
import { clearStepProfile, fillTodo, listTodo, todoKey, upgradeOpenCards } from './todo.ts'
import { getSettings } from '../lib/settings.ts'

const TUESDAY_10AM = new Date('2026-10-13T14:00:00.000Z')

async function todoSetup() {
  const fx = await setup({ now: () => TUESDAY_10AM })
  await setSettings(fx.db, {
    sequences_on: false,
    people_per_day: 5,
    channels: { email: false, linkedin: true, mail: true, call: true },
    physical_address: '1500 Market St, Philadelphia, PA 19102',
  })
  return fx
}

/** A fake Claude: these answers in turn, for text and for structured calls. */
function fakeLlm(
  texts: string[],
  emails: HandEmail[] = [],
): Llm & { prompts: string[]; systems: string[] } {
  const prompts: string[] = []
  const systems: string[] = []
  return {
    prompts,
    systems,
    async text(prompt, opts) {
      prompts.push(prompt)
      systems.push(opts.system ?? '')
      return texts.shift() ?? null
    },
    async structured<T>(prompt: string, _schema: unknown, opts: { system?: string }) {
      prompts.push(prompt)
      systems.push(opts.system ?? '')
      return (emails.shift() ?? null) as T | null
    },
  }
}

const GOOD_PART = [
  'Keeping a few rentals running on top of a day job means the repair texts show up at the worst times, and the lease you need is never in the folder you look in first.',
  "With Prop Archive, Fairmount Rentals gets one place for all of it. Tenants send repairs through their own portal instead of your phone, and every lease is a search away when you need it. It's meant to give you your evenings back.",
].join('\n\n')

const GOOD_EMAIL: HandEmail = {
  subject: 'Repairs and leases in one place',
  body: [
    'Hi Dana,',
    'When repair texts and leases live in different places, the week gets eaten by keeping it all straight.',
    'Prop Archive keeps them in one place, with a portal each for tenants, owners and contractors.',
    'This is my second company, and I grew up around landlords and property managers. I mailed you a one-page overview and my card too.',
    "It's free while we're in beta, beta members get six months free at launch, and there's nothing to sign. Worth a 15-minute look?",
    'If you\'d like to look around first, the "Join the beta" button and the link to proparchive.app are both in my signature below.',
    'Theo',
  ].join('\n\n'),
}

const lead = { persona: 'maya' as const, owner_kind: 'person' as const, enrichment: {} }

describe('the words', () => {
  it("Theo's fallback printouts and emails pass the house rules", () => {
    for (const text of Object.values(FALLBACK_PRINTOUT)) {
      expect(copyProblems(text, PRINTOUT_WORDS)).toEqual([])
    }
    const vars = { first_name: 'Dana', full_name: 'Dana Smith', company: 'Fairmount Rentals' }
    for (const mailed of [true, false]) {
      expect(emailProblems(fallbackEmail(vars, { mailed, followUp: false }), EMAIL_WORDS)).toEqual(
        [],
      )
      expect(
        emailProblems(fallbackEmail(vars, { mailed, followUp: true }), FOLLOW_UP_WORDS),
      ).toEqual([])
    }
    for (const text of [
      DEFAULT_PRINTOUT_OVERVIEW,
      DEFAULT_PRINTOUT_BIO,
      DEFAULT_PRINTOUT_CLOSING,
    ]) {
      expect(hasEmDash(text)).toBe(false)
    }
    // The same offer as the website and its terms: six months free at launch (Theo, 2026-10-16).
    expect(DEFAULT_PRINTOUT_OVERVIEW).toContain('six months free at launch')
    expect(fallbackEmail(vars, { mailed: true, followUp: false }).body).toContain(
      'six months free at launch',
    )
    expect(
      `${DEFAULT_PRINTOUT_OVERVIEW} ${fallbackEmail(vars, { mailed: true, followUp: false }).body}`,
    ).not.toMatch(/two months/i)
    expect(DEFAULT_PRINTOUT_OVERVIEW.length).toBeLessThanOrEqual(PRINTOUT_LIMITS.overview)
    expect(DEFAULT_PRINTOUT_BIO.length).toBeLessThanOrEqual(PRINTOUT_LIMITS.bio)
    expect(DEFAULT_PRINTOUT_CLOSING.length).toBeLessThanOrEqual(PRINTOUT_LIMITS.closing)
  })

  it('names a company owner by the company, never by a made-up first name', () => {
    const llc = { first_name: 'Fairmount', full_name: 'FAIRMOUNT RENTALS LLC', company: '' }
    expect(personFirstName(llc)).toBe('')
    expect(companyName(llc)).toBe('Fairmount Rentals LLC')
    expect(printoutHeading(llc)).toBe('How Prop Archive can help Fairmount Rentals LLC')
    const person = { first_name: 'Dana', full_name: 'Dana Smith', company: 'Dana Smith' }
    expect(companyName(person)).toBe('')
    expect(printoutHeading(person)).toBe('Dana, here is how Prop Archive can help')
    expect(printoutHeading({ first_name: 'there', full_name: '', company: '' })).toBe(
      'How Prop Archive can help with your rentals',
    )
    // A real contact person on a company owner keeps their name.
    expect(personFirstName({ first_name: 'John', full_name: 'Fairmount Rentals LLC' })).toBe('John')
  })

  it('the rule hints catch links, numbers, exclamation marks and em-dashes', () => {
    expect(ruleProblems('See www.example.com')).toContain('it has a link')
    expect(ruleProblems('Your 12 units!')).toEqual(
      expect.arrayContaining(['it has a number', 'it has an exclamation mark']),
    )
    expect(ruleProblems('Look around at proparchive.app, 15 minutes is enough.')).toEqual([])
    expect(ruleProblems('One place — for all of it')).toContain('it has an em-dash')
  })
})

describe('Claude writes them for each person', () => {
  const vars = {
    first_name: 'Dana',
    full_name: 'Dana Smith',
    company: 'Fairmount Rentals',
    property_count: '4',
  }

  it('writes the part of the printout about them, and tries again once when a rule breaks', async () => {
    const llm = fakeLlm([`${GOOD_PART} Call 215-555-0100 today!`, GOOD_PART])
    expect(await writePrintout(lead, vars, llm)).toBe(GOOD_PART)
    expect(llm.prompts[0]).toContain('company: Fairmount Rentals')
    expect(llm.prompts[1]).toContain('broke the rules')
    expect(await writePrintout(lead, vars, fakeLlm(['Too short!', 'Still short!']))).toBeNull()
    expect(await writePrintout(lead, vars, null)).toBeNull()
  })

  it('never tells Claude a company is a first name', async () => {
    const llm = fakeLlm([GOOD_PART])
    await writePrintout(
      lead,
      { first_name: 'Fairmount', full_name: 'Fairmount Rentals LLC', company: '' },
      llm,
    )
    expect(llm.prompts[0]).not.toContain('first name: Fairmount')
    expect(llm.prompts[0]).toContain('company: Fairmount Rentals LLC')
  })

  it('writes the email, and a follow-up is its own shorter email', async () => {
    const llm = fakeLlm([], [GOOD_EMAIL])
    expect(await writeHandEmail(lead, vars, { mailed: true, followUp: false }, llm)).toEqual(
      GOOD_EMAIL,
    )
    expect(llm.systems[0]).toContain('mailed them a one-page overview')
    const again = fakeLlm([], [])
    await writeHandEmail(lead, vars, { mailed: false, followUp: true }, again)
    expect(again.systems[0]).toContain('follow-up')
    expect(again.systems[0]).not.toContain('mailed them a one-page overview')
  })
})

describe('proofing and editing on the to-do list', () => {
  it('saves Theo’s words on a waiting step and hands back the rule hints', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db)
    await fillTodo(deps)
    const card = (await listTodo(deps)).people[0]!
    const email = card.steps.find((s) => s.kind === 'email')!
    const r = await editStepText(deps, email.message_id, {
      subject: 'A note from Theo',
      body: 'Hi Lead,\r\n\r\nShort and sweet!\r\n\r\nTheo  ',
    })
    expect(r).toMatchObject({
      subject: 'A note from Theo',
      body: 'Hi Lead,\n\nShort and sweet!\n\nTheo',
    })
    expect(r.problems).toContain('it has an exclamation mark')
    const saved = (await db.select().from(messages).where(eq(messages.id, email.message_id)))[0]!
    expect(saved.body).toBe('Hi Lead,\n\nShort and sweet!\n\nTheo')
    expect(saved.subject).toBe('A note from Theo')

    const printout = card.steps.find((s) => s.kind === 'postcard')!
    await editStepText(deps, printout.message_id, { subject: 'For Lead', body: GOOD_PART })
    const doc = await printoutDoc(deps, printout.message_id)
    expect(doc.parts).toMatchObject({ heading: 'For Lead', body: GOOD_PART })

    const note = card.steps.find((s) => s.channel === 'linkedin')!
    await expect(
      editStepText(deps, note.message_id, { body: 'x'.repeat(301) }),
    ).rejects.toMatchObject({ code: 'TOO_LONG' })
    await expect(editStepText(deps, note.message_id, { body: '   ' })).rejects.toMatchObject({
      code: 'EMPTY_TEXT',
    })
    await expect(
      editStepText(deps, email.message_id, { subject: '', body: 'Hi' }),
    ).rejects.toMatchObject({ code: 'EMPTY_SUBJECT' })

    // Once it is sent, it stays as sent.
    await actOnQueueItem(deps, note.message_id, 'done')
    await expect(editStepText(deps, note.message_id, { body: 'Hi' })).rejects.toMatchObject({
      code: 'NOT_IN_QUEUE',
    })
  })

  it('never edits a message that is not on the to-do list', async () => {
    const { db, deps } = await todoSetup()
    const lead = await insertLead(db)
    const id = 'not-todo'
    await db.insert(messages).values({
      id,
      lead_id: lead.id,
      channel: 'linkedin',
      direction: 'out',
      status: 'ready_for_human',
      idempotency_key: 'seq:abc:1',
      body: 'Hi',
      provider: 'human',
      created_at: TUESDAY_10AM.toISOString(),
    })
    await expect(editStepText(deps, id, { body: 'Hello' })).rejects.toMatchObject({
      code: 'NOT_TODO',
    })
  })

  it('a printout to proof: this person’s part with the Settings parts and the address', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db, { full_name: 'Dana Smith', first_name: 'Dana', last_name: 'Smith' })
    await setSettings(db, { printout_bio: 'I run Prop Archive from Philadelphia.' })
    await fillTodo(deps)
    const printout = (await listTodo(deps)).people[0]!.steps.find((s) => s.kind === 'postcard')!
    const doc = await printoutDoc(deps, printout.message_id)
    expect(doc).toMatchObject({ person: 'Dana Smith', status: 'ready_for_human', problems: [] })
    expect(doc.address).toContain('Example St')
    expect(doc.parts.bio).toBe('I run Prop Archive from Philadelphia.')
    expect(doc.parts.overview).toBe((await getSettings(db)).printout_overview)
    expect(doc.parts.preparedFor).toEqual(['Dana Smith'])
    expect(doc.parts.date).toBe('October 13, 2026')
    expect(doc.parts).not.toHaveProperty('editHref')
  })

  it('"Not them" keeps the note on the card and drops only the profile', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db, { full_name: 'Pat Lee', first_name: 'Pat', last_name: 'Lee' })
    await fillTodo(deps)
    const note = (await listTodo(deps)).people[0]!.steps[0]!
    expect(await clearStepProfile(deps, note.message_id)).toBe(true)
    const card = (await listTodo(deps)).people[0]!
    expect(card.steps[0]).toMatchObject({
      message_id: note.message_id,
      status: 'waiting',
      to_address: null,
    })
    expect(card.linkedin_missing).toBe('not_found')
  })

  it('a pasted profile replaces a wrong one on the waiting note', async () => {
    const { db, deps } = await todoSetup()
    const lead = await insertLead(db, { full_name: 'Pat Lee', first_name: 'Pat', last_name: 'Lee' })
    await fillTodo(deps)
    const note = (await listTodo(deps)).people[0]!.steps[0]!
    await saveLinkedInProfile(deps, lead.id, 'https://www.linkedin.com/in/the-right-pat-lee')
    const card = (await listTodo(deps)).people[0]!
    expect(card.steps[0]).toMatchObject({
      message_id: note.message_id,
      to_address: 'https://www.linkedin.com/in/the-right-pat-lee/',
    })
    expect(card.steps.filter((s) => s.channel === 'linkedin')).toHaveLength(1)
  })

  it('someone with only an email address still goes on the list, with their email', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db, {
      full_name: 'Fairmount Rentals LLC',
      first_name: null,
      last_name: null,
      company: 'Fairmount Rentals LLC',
      phone: null,
      linkedin_url: null,
      mailing_street: null,
    })
    expect((await fillTodo(deps)).added).toBe(1)
    const card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['email'])
    // No printout on its way, so the email does not say one is.
    expect(card.steps[0]!.body).not.toContain('mailed you')
  })

  it('the app never sends the email: Sent it only writes it down', async () => {
    const fx = await todoSetup()
    await insertLead(fx.db)
    await fillTodo(fx.deps)
    const email = (await listTodo(fx.deps)).people[0]!.steps.find((s) => s.kind === 'email')!
    await actOnQueueItem(fx.deps, email.message_id, 'done')
    expect(fx.outbox).toHaveLength(0)
    const saved = (await fx.db.select().from(messages).where(eq(messages.id, email.message_id)))[0]!
    expect(saved).toMatchObject({ status: 'sent', provider: 'human' })
  })
})

describe('the print page', () => {
  it('prints each printout on one letter page with a proof link, and envelope labels', async () => {
    const { db, deps } = await todoSetup()
    await insertLead(db, { full_name: 'Dana Smith', first_name: 'Dana', last_name: 'Smith' })
    await insertLead(db, { full_name: 'Sam Ortiz', first_name: 'Sam', last_name: 'Ortiz' })
    await fillTodo(deps)
    const ids = (await listTodo(deps)).people.map(
      (p) => p.steps.find((s) => s.kind === 'postcard')!.message_id,
    )
    const html = await printPage(deps, ids)
    expect(html.match(/<section class="onepager">/g)).toHaveLength(2)
    expect(html).toContain('Dana, here is how Prop Archive can help')
    expect(html).toContain(`href="/printout/${ids[0]}"`)
    expect(html).toContain('@page printout { size: 8.5in 11in')
    expect(html).toContain('printout-fit')
    expect(html).toContain('2 printouts')
    // In the order Theo picked them.
    expect(html.indexOf('Sam')).toBeGreaterThan(html.indexOf('Dana, here'))
    expect(html.indexOf(`/printout/${ids[1]}`)).toBeGreaterThan(html.indexOf(`/printout/${ids[0]}`))
    expect(hasEmDash(html)).toBe(false)

    const labels = await printPage(deps, [...ids].reverse(), { labels: true })
    expect(labels.match(/<div class="label">/g)).toHaveLength(2)
    expect(labels).toContain('labels-sheet')
    expect(labels).toContain('Avery 5163')
    expect(labels.indexOf('Sam Ortiz')).toBeLessThan(labels.indexOf('Dana Smith'))
    expect(labels).toContain('Philadelphia, PA 19146')
    expect(labels).toContain('1500 Market St')
  })
})

describe('cards made before printouts', () => {
  it('turn their waiting postcard into a printout and get their email', async () => {
    const { db, deps } = await todoSetup()
    const lead = await insertLead(db)
    const now = TUESDAY_10AM.toISOString()
    await db.insert(messages).values([
      {
        id: 'old-li',
        lead_id: lead.id,
        channel: 'linkedin',
        direction: 'out',
        status: 'ready_for_human',
        idempotency_key: todoKey(lead.id, 1, 'linkedin_connect'),
        body: 'Hi Lead, glad to connect.',
        to_address: lead.linkedin_url,
        provider: 'human',
        raw: { todo: 'linkedin_connect' },
        created_at: now,
      },
      {
        id: 'old-card',
        lead_id: lead.id,
        channel: 'mail',
        direction: 'out',
        status: 'ready_for_human',
        idempotency_key: todoKey(lead.id, 1, 'postcard'),
        body: "Hi Lead, I'm Theo. See it at proparchive.app",
        to_address: JSON.stringify({
          name: 'Lead',
          street: '1 A St',
          city: 'Philadelphia',
          state: 'PA',
          zip: '19146',
        }),
        provider: 'human',
        raw: { todo: 'postcard' },
        created_at: now,
      },
    ])
    let card = (await listTodo(deps)).people[0]!
    expect(card.steps.find((s) => s.kind === 'postcard')!.printout).toBe(false)

    expect(await upgradeOpenCards(deps, await getSettings(db))).toBe(1)
    card = (await listTodo(deps)).people[0]!
    expect(card.steps.map((s) => s.kind)).toEqual(['linkedin_connect', 'postcard', 'email'])
    const printout = card.steps[1]!
    expect(printout).toMatchObject({ message_id: 'old-card', printout: true })
    expect(printout.subject).toBe('Lead, here is how Prop Archive can help')
    expect(card.steps[2]!.body).toContain('I mailed you a one-page overview')
    // Once is enough.
    expect(await upgradeOpenCards(deps, await getSettings(db))).toBe(0)
  })
})
