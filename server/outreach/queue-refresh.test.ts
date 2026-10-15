import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { messages } from '../db/schema.ts'
import { enrollLead } from './enroll.ts'
import { actOnQueueItem, listQueue } from './queue.ts'
import { sendDue } from './send.ts'
import { updateSequence } from './sequences.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

describe('LinkedIn queue edits and replacement tasks', () => {
  it('refreshes existing notes, recovers old detached steps, and preserves completed history', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db, { first_name: 'Lev' })
    const { sequence, steps } = await insertSequence(db, { channel: 'linkedin' }, [
      { delay_days: 0, body: 'Old {{first_name}}' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps)
    const item = (await listQueue(deps)).groups.linkedin[0]!
    expect(item.body).toBe('Old Lev')
    await updateSequence(deps, sequence.id, {
      steps: [{ delay_days: 0, channel: 'linkedin', body: 'New {{first_name}}' }],
    })
    expect((await db.select().from(messages))[0]!.step_id).toBe(steps[0]!.id)
    expect((await listQueue(deps)).groups.linkedin[0]!.body).toBe('New Lev')
    await db.update(messages).set({ step_id: null }).where(eq(messages.id, item.message_id))
    expect((await listQueue(deps)).groups.linkedin[0]!.body).toBe('New Lev')
    await actOnQueueItem(deps, item.message_id, 'done')
    await updateSequence(deps, sequence.id, {
      steps: [{ delay_days: 0, channel: 'linkedin', body: 'Newest {{first_name}}' }],
    })
    const saved = (await db.select().from(messages))[0]!
    expect(saved.status).toBe('sent')
    expect(saved.body).toBe('New Lev')
  })

  it('replaces repeated skips until done reaches the goal, without sending an email', async () => {
    const { db, deps, outbox } = await setup()
    await setSettings(db, { daily_caps: { linkedin: 1 } })
    const { sequence } = await insertSequence(db, { channel: 'linkedin' }, [
      { delay_days: 0, body: 'Hi {{first_name}}' },
    ])
    for (let i = 0; i < 4; i++) {
      const lead = await insertLead(db)
      await enrollLead(deps, lead.id, sequence.id)
    }
    await sendDue(deps)
    const email = await insertSequence(db, { channel: 'email' }, [
      { delay_days: 0, subject: 'Email', body: 'No surprise sends' },
    ])
    await enrollLead(deps, (await insertLead(db)).id, email.sequence.id)
    for (let i = 0; i < 2; i++) {
      const queue = await listQueue(deps)
      expect(queue.groups.linkedin).toHaveLength(1)
      await actOnQueueItem(deps, queue.groups.linkedin[0]!.message_id, 'skip')
    }
    const replacement = (await listQueue(deps)).groups.linkedin[0]!
    await actOnQueueItem(deps, replacement.message_id, 'done')
    await sendDue(deps, { onlyLinkedIn: true })
    expect((await listQueue(deps)).groups.linkedin).toHaveLength(0)
    expect(outbox).toHaveLength(0)
    const rows = await db.select().from(messages)
    expect(rows.filter((m) => m.status === 'skipped')).toHaveLength(2)
    expect(rows.filter((m) => m.status === 'sent')).toHaveLength(1)
    expect(rows.some((m) => m.channel === 'email')).toBe(false)
  })

  it('saves a step whose channel changed and a removed middle step, keeping the untouched ids', async () => {
    const { db, deps } = await setup()
    const { sequence, steps } = await insertSequence(db, { channel: 'email' }, [
      { delay_days: 0, channel: 'email', subject: 'S', body: 'One' },
      { delay_days: 2, channel: 'linkedin', body: 'Two' },
      { delay_days: 4, channel: 'mail', body: 'Three' },
    ])
    const changed = await updateSequence(deps, sequence.id, {
      steps: [
        { delay_days: 0, channel: 'email', subject: 'S', body: 'One edited' },
        { delay_days: 2, channel: 'email', subject: 'S2', body: 'Two' },
        { delay_days: 4, channel: 'mail', body: 'Three' },
      ],
    })
    expect(changed.steps.map((s) => s.channel)).toEqual(['email', 'email', 'mail'])
    expect(changed.steps[0]!.id).toBe(steps[0]!.id)
    expect(changed.steps[2]!.id).toBe(steps[2]!.id)
    const shorter = await updateSequence(deps, sequence.id, {
      steps: [
        { delay_days: 0, channel: 'email', subject: 'S', body: 'One edited' },
        { delay_days: 4, channel: 'mail', body: 'Three' },
      ],
    })
    expect(shorter.steps.map((s) => s.channel)).toEqual(['email', 'mail'])
    expect(shorter.steps[0]!.id).toBe(steps[0]!.id)
  })
})
