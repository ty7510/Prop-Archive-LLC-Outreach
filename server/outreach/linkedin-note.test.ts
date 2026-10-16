import { describe, expect, it } from 'vitest'
import { messages } from '../db/schema.ts'
import type { Llm } from './deps.ts'
import { enrollLead } from './enroll.ts'
import {
  LINKEDIN_NOTE_MAX,
  cleanNote,
  noteFacts,
  noteProblems,
  writePersonalNote,
} from './linkedinNote.ts'
import { actOnQueueItem, listQueue, personalLinkedInNote } from './queue.ts'
import { sendDue } from './send.ts'
import { updateSequence } from './sequences.ts'
import { insertLead, insertSequence, setup } from './testFixtures.ts'

/** A model that answers from a list, and remembers what it was asked. */
function fakeLlm(answers: string[]): Llm & { prompts: string[]; systems: string[] } {
  const prompts: string[] = []
  const systems: string[] = []
  return {
    prompts,
    systems,
    async text(prompt, opts) {
      prompts.push(prompt)
      systems.push(opts.system ?? '')
      return answers.shift() ?? null
    },
    async structured() {
      return null
    },
  }
}

const GOOD =
  'Hi Lev, keeping leases and repair texts straight across Brick Row Rentals gets messy fast. ' +
  'I built Prop Archive to keep it in one place. Open to connecting?'

describe('the note rules', () => {
  it('passes a plain short note and names every broken rule', () => {
    expect(noteProblems(GOOD)).toEqual([])
    expect(noteProblems('x'.repeat(LINKEDIN_NOTE_MAX + 1))[0]).toMatch(/limit is 200/)
    expect(noteProblems('See proparchive.app')).toContain('it has a link')
    expect(noteProblems('Great to meet you!')).toContain('it has an exclamation mark')
    expect(noteProblems('Your 4 rentals on Pine St')).toContain('it has a number')
    expect(noteProblems('Worth a 15-minute look?')).toEqual([])
    expect(noteProblems('I wanted to reach out')).toContain('it says "reach out"')
  })

  it('strips quotes, a "Note:" label and em-dashes', () => {
    expect(cleanNote('"Note: Hi Lev — open to connecting?"')).toBe('Hi Lev, open to connecting?')
  })

  it('gives the company only when it is not just their name, and never an unknown owner kind', () => {
    const facts = noteFacts(
      { persona: 'ray', owner_kind: 'unknown', enrichment: {} },
      { first_name: 'Lev', full_name: 'Lev Stone', company: 'Lev Stone' },
    )
    expect(facts).toContain('first name: Lev')
    expect(facts.some((f) => f.startsWith('company'))).toBe(false)
    expect(facts.some((f) => f.startsWith('owner kind'))).toBe(false)
    expect(facts).toContain('kind of owner: rentals are their full-time work')
  })
})

describe('writePersonalNote', () => {
  const lead = { persona: 'maya' as const, owner_kind: 'llc' as const, enrichment: {} }
  const vars = { first_name: 'Lev', full_name: 'Lev Stone', company: 'Brick Row Rentals' }

  it("rewrites Theo's note for the person, with the rules in the system prompt", async () => {
    const llm = fakeLlm([GOOD])
    expect(await writePersonalNote(lead, vars, 'Hi {{first_name}}, open to connecting?', llm)).toBe(
      GOOD,
    )
    expect(llm.prompts[0]).toContain("Theo's note:")
    expect(llm.prompts[0]).toContain('company: Brick Row Rentals')
    expect(llm.systems[0]).toContain('At most 200 characters')
  })

  it('asks again once when a rule is broken, then gives up', async () => {
    const llm = fakeLlm(['Hi Lev! Your 4 units', GOOD])
    expect(await writePersonalNote(lead, vars, 'Hi', llm)).toBe(GOOD)
    expect(llm.prompts[1]).toContain('broke the rules')
    expect(await writePersonalNote(lead, vars, 'Hi', fakeLlm(['Hi!', 'Hi!']))).toBeNull()
    expect(await writePersonalNote(lead, vars, 'Hi', null)).toBeNull()
  })
})

describe('personal LinkedIn notes in the queue', () => {
  async function waitingNote(llm: Llm | null) {
    const { db, deps } = await setup({ llm })
    const lead = await insertLead(db, { first_name: 'Lev', company: 'Brick Row Rentals' })
    const { sequence } = await insertSequence(db, { channel: 'linkedin' }, [
      { delay_days: 0, body: 'Hi {{first_name}}, open to connecting?' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps, { onlyLinkedIn: true })
    const [msg] = await db.select().from(messages)
    return { db, deps, sequence, messageId: msg!.id }
  }

  it('writes the note once, saves it, and keeps it when Theo marks it sent', async () => {
    const llm = fakeLlm([GOOD])
    const { db, deps, messageId } = await waitingNote(null)
    deps.llm = llm
    expect(await personalLinkedInNote(deps, messageId)).toEqual({
      message_id: messageId,
      body: GOOD,
      personal: true,
    })
    // Written once: a second ask reads the saved note.
    expect((await personalLinkedInNote(deps, messageId)).body).toBe(GOOD)
    expect(llm.prompts).toHaveLength(1)
    const item = (await listQueue(deps)).groups.linkedin[0]!
    expect(item.body).toBe(GOOD)
    expect(item.personal_note).toBe(true)
    await actOnQueueItem(deps, messageId, 'done')
    expect((await db.select().from(messages))[0]!.body).toBe(GOOD)
  })

  it("keeps Theo's own note without a model, and writes again after he edits his note", async () => {
    const { deps, sequence, messageId } = await waitingNote(null)
    expect(await personalLinkedInNote(deps, messageId)).toEqual({
      message_id: messageId,
      body: 'Hi Lev, open to connecting?',
      personal: false,
    })
    deps.llm = fakeLlm([GOOD, `${GOOD.slice(0, 40)} Worth a look?`])
    await personalLinkedInNote(deps, messageId)
    await updateSequence(deps, sequence.id, {
      steps: [{ delay_days: 0, channel: 'linkedin', body: 'Hey {{first_name}}, worth a look?' }],
    })
    // Edited note: the queue shows his new note until a new one is written from it.
    const item = (await listQueue(deps)).groups.linkedin[0]!
    expect(item.body).toBe('Hey Lev, worth a look?')
    expect(item.personal_note).toBe(false)
    expect((await personalLinkedInNote(deps, messageId)).body).toBe(
      `${GOOD.slice(0, 40)} Worth a look?`,
    )
  })
})
