import { count, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { PERSONAS } from '../../shared/types.ts'
import { createTestDb, type Db } from '../db/client.ts'
import { sequenceSteps, sequences } from '../db/schema.ts'
import { invalidateSettingsCache, loadSettings, updateSettings } from '../lib/settings.ts'
import { findSequenceByName, seed, SEEDED_CHANNELS } from './index.ts'

let db: Db

beforeEach(async () => {
  db = await createTestDb()
  invalidateSettingsCache()
})

async function counts(): Promise<{ sequences: number; steps: number }> {
  const [s] = await db.select({ n: count() }).from(sequences)
  const [t] = await db.select({ n: count() }).from(sequenceSteps)
  return { sequences: s?.n ?? 0, steps: t?.n ?? 0 }
}

describe('seed', () => {
  it('inserts every sequence file with its steps, all active', async () => {
    const result = await seed(db)
    expect(result.sequences).toBe(37)
    expect(result.sequences_skipped).toBe(0)
    expect(result.leads).toBe(0)
    expect(result.skipped).toBe(false)
    // 9 email x 3 + 9 mail x 1 + 9 linkedin x 2 + 9 call x 1
    expect(await counts()).toEqual({ sequences: 37, steps: 68 })

    const rows = await db.select().from(sequences)
    expect(rows.every((r) => r.active)).toBe(true)
    expect(new Set(rows.map((r) => r.trigger))).toEqual(
      new Set(['new_license', 'recent_sale', 'any']),
    )

    const maya = await findSequenceByName(db, 'Email, Maya, no trigger')
    expect(maya).not.toBeNull()
    const steps = await db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequence_id, maya!.id))
      .orderBy(sequenceSteps.step_index)
    expect(steps.map((s) => [s.step_index, s.delay_days])).toEqual([
      [0, 0],
      [1, 3],
      [2, 5],
    ])
    expect(steps[0]?.subject).toBe('Repair texts during your work day?')
    expect(steps[0]?.channel).toBe('email')
    expect(steps[0]?.body).toContain('{{demo_link}}')
  })

  it('fills settings.sequence_by_persona with the no-trigger sequence per persona and channel', async () => {
    const result = await seed(db)
    expect(result.settings_filled).toHaveLength(PERSONAS.length * SEEDED_CHANNELS.length)
    const settings = await loadSettings(db)
    for (const persona of PERSONAS) {
      for (const channel of SEEDED_CHANNELS) {
        const id = settings.sequence_by_persona[persona][channel]
        expect(id, `${persona}.${channel}`).toBeTruthy()
        const [row] = await db.select().from(sequences).where(eq(sequences.id, id!))
        expect(row?.persona).toBe(persona)
        expect(row?.channel).toBe(channel)
        expect(row?.trigger).toBe('any')
      }
      expect(settings.sequence_by_persona[persona].instagram).toBeNull()
    }
  })

  it('is idempotent: a second run inserts nothing and changes no settings', async () => {
    await seed(db)
    const before = await loadSettings(db)
    const again = await seed(db)
    expect(again.sequences).toBe(0)
    expect(again.sequences_skipped).toBe(37)
    expect(again.settings_filled).toEqual([])
    expect(again.skipped).toBe(true)
    expect(await counts()).toEqual({ sequences: 37, steps: 68 })
    expect((await loadSettings(db)).sequence_by_persona).toEqual(before.sequence_by_persona)
  })

  it('skips a sequence whose name already exists and keeps its steps', async () => {
    const now = new Date().toISOString()
    await db.insert(sequences).values({
      id: 'theo-edited-this',
      name: 'Email, Ray, no trigger',
      channel: 'email',
      persona: 'ray',
      trigger: 'any',
      active: false,
      created_at: now,
      updated_at: now,
    })
    const result = await seed(db)
    expect(result.sequences).toBe(36)
    expect(result.sequences_skipped).toBe(1)
    const ray = await findSequenceByName(db, 'Email, Ray, no trigger')
    expect(ray?.id).toBe('theo-edited-this')
    expect(ray?.active).toBe(false)
    expect((await loadSettings(db)).sequence_by_persona.ray.email).toBe('theo-edited-this')
  })

  it('keeps a slot Theo pointed at another existing sequence, refills one pointing nowhere', async () => {
    await seed(db)
    const other = await findSequenceByName(db, 'Email, Maya, new rental license')
    await updateSettings(
      {
        sequence_by_persona: {
          maya: { email: other!.id, mail: 'gone-sequence' },
        },
      },
      db,
    )
    const result = await seed(db)
    expect(result.settings_filled).toEqual(['maya.mail'])
    const after = await loadSettings(db)
    expect(after.sequence_by_persona.maya.email).toBe(other!.id)
    const mail = await findSequenceByName(db, 'Postcard, Maya, no trigger')
    expect(after.sequence_by_persona.maya.mail).toBe(mail!.id)
  })
})
