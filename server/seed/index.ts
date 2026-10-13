// Seed: default sequences from content/sequences/*.md and settings.sequence_by_persona.
// Owned by the content builder. Spec section 13.
// Idempotent: server/index.ts calls seed(db) on first boot and `npm run seed` runs it by hand.
// A sequence whose name already exists is left alone, so Theo's edits in the UI survive a re-seed.
import { and, eq, inArray, ne } from 'drizzle-orm'
import { PERSONAS, type Channel, type Persona } from '../../shared/types.ts'
import type { PersonaSequences, SequenceByPersona } from '../../shared/settings.ts'
import type { Db } from '../db/client.ts'
import { sequenceSteps, sequences, settings as settingsTable } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { loadSettings, updateSettings } from '../lib/settings.ts'
import { nowIso } from '../lib/time.ts'
import { loadSequenceFiles, type SequenceFile } from './content.ts'

export { parseSequenceMarkdown, findVariables, TEMPLATE_VARS } from './parse.ts'
export type { ParsedSequence, ParsedStep } from './parse.ts'
export { loadSequenceFiles, findContentDir } from './content.ts'

export interface SeedResult {
  /** Sequences inserted by this run. */
  sequences: number
  /** Sequences left alone because the name already existed. */
  sequences_skipped: number
  /** Sample leads inserted. Always 0: the seed ships no leads. */
  leads: number
  /** settings.sequence_by_persona slots filled by this run, as "persona.channel". */
  settings_filled: string[]
  /** True when this run changed nothing. */
  skipped: boolean
}

/** Channels that get a default sequence per persona. Instagram has no default copy. */
export const SEEDED_CHANNELS = [
  'email',
  'mail',
  'linkedin',
  'call',
] as const satisfies readonly Channel[]

async function insertSequence(db: Db, file: SequenceFile): Promise<string> {
  const now = nowIso()
  const id = newId()
  const { parsed } = file
  await db.insert(sequences).values({
    id,
    name: parsed.name,
    channel: parsed.channel,
    persona: parsed.persona,
    trigger: parsed.trigger,
    active: true,
    description: parsed.description,
    created_at: now,
    updated_at: now,
  })
  if (parsed.steps.length > 0) await db.insert(sequenceSteps).values(stepRows(id, file))
  return id
}

function stepRows(sequenceId: string, file: SequenceFile) {
  return file.parsed.steps.map((s) => ({
    id: newId(),
    sequence_id: sequenceId,
    step_index: s.step_index,
    delay_days: s.delay_days,
    subject: s.channel === 'email' ? s.subject : null,
    body: s.body,
    channel: s.channel,
    notes: s.notes,
  }))
}

/**
 * Fill empty slots in settings.sequence_by_persona with the "no trigger" (stored as trigger
 * "any") sequence for that persona and channel. A slot that already points at an existing
 * sequence is Theo's choice and stays. A slot pointing at a deleted sequence is refilled.
 */
export async function fillSequenceByPersona(db: Db): Promise<string[]> {
  const rows = await db
    .select({
      id: sequences.id,
      channel: sequences.channel,
      persona: sequences.persona,
      trigger: sequences.trigger,
    })
    .from(sequences)
  const existingIds = new Set(rows.map((r) => r.id))
  const defaults = new Map<string, string>()
  for (const r of rows) {
    if (r.trigger !== 'any') continue
    const key = `${r.persona}.${r.channel}`
    if (!defaults.has(key)) defaults.set(key, r.id)
  }

  const current = await loadSettings(db)
  const next: SequenceByPersona = structuredClone(current.sequence_by_persona)
  const filled: string[] = []
  for (const persona of PERSONAS) {
    const slots: PersonaSequences = next[persona as Persona]
    for (const channel of SEEDED_CHANNELS) {
      const have = slots[channel]
      if (have && existingIds.has(have)) continue
      const id = defaults.get(`${persona}.${channel}`)
      if (!id) continue
      slots[channel] = id
      filled.push(`${persona}.${channel}`)
    }
  }
  if (filled.length > 0) await updateSettings({ sequence_by_persona: next }, db)
  return filled
}

/** Insert the default sequences that are not there yet, then fill sequence_by_persona. */
export async function seed(db: Db): Promise<SeedResult> {
  const files = await loadSequenceFiles()
  const existing = await db.select({ name: sequences.name }).from(sequences)
  const have = new Set(existing.map((r) => r.name))

  let inserted = 0
  let skippedCount = 0
  for (const file of files) {
    if (have.has(file.parsed.name)) {
      skippedCount++
      continue
    }
    await insertSequence(db, file)
    have.add(file.parsed.name)
    inserted++
  }

  const filled = await fillSequenceByPersona(db)
  return {
    sequences: inserted,
    sequences_skipped: skippedCount,
    leads: 0,
    settings_filled: filled,
    skipped: inserted === 0 && filled.length === 0,
  }
}

/** The seeded sequence row for a name, or null. Handy for scripts and tests. */
export async function findSequenceByName(db: Db, name: string) {
  const rows = await db.select().from(sequences).where(eq(sequences.name, name))
  return rows[0] ?? null
}

/**
 * The one sequence Theo runs (content/sequences/main-*.md): the app sends three emails; the
 * LinkedIn note and the postcard are his tasks.
 */
export const MAIN_SEQUENCE_NAME = 'Three emails, LinkedIn and a postcard'
/** Earlier names of the main sequence. Upgraded in place, so leads already in it keep going. */
export const OLD_MAIN_SEQUENCE_NAMES = ['Email, LinkedIn, then mail']
const MAIN_SETUP_KEY = '_main_sequence_setup_v1'
const MAIN_STEPS_KEY = '_main_sequence_steps_v2'

async function hasKey(db: Db, key: string): Promise<boolean> {
  const rows = await db
    .select({ key: settingsTable.key })
    .from(settingsTable)
    .where(eq(settingsTable.key, key))
    .limit(1)
  return rows.length > 0
}

async function markKey(db: Db, key: string): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key, value: nowIso() })
    .onConflictDoNothing({ target: settingsTable.key })
}

/**
 * Give an older main sequence the current name, description and steps, keeping its id, so the
 * leads already in it carry on from the step they are on (step 2 is still the LinkedIn note).
 */
async function upgradeInPlace(db: Db, id: string, file: SequenceFile): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(sequences)
      .set({
        name: file.parsed.name,
        description: file.parsed.description,
        updated_at: nowIso(),
      })
      .where(eq(sequences.id, id))
    await tx.delete(sequenceSteps).where(eq(sequenceSteps.sequence_id, id))
    if (file.parsed.steps.length > 0) await tx.insert(sequenceSteps).values(stepRows(id, file))
  })
}

/**
 * Make sure the main sequence exists, and once per database switch everything over to it: the
 * main sequence on, every other sequence off, new leads go into it, and the channels it uses on
 * (Instagram and calls off). Runs on every boot; after the first time it only re-adds the
 * sequence if it was deleted, so Theo's later toggles stay as he left them.
 */
export async function ensureMainSequence(
  db: Db,
): Promise<{ id: string; created: boolean; switched: boolean; upgraded: boolean }> {
  const existing = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(eq(sequences.name, MAIN_SEQUENCE_NAME))
    .limit(1)
  let id = existing[0]?.id
  let created = false
  let upgraded = false
  const mainFile = async () => {
    const file = (await loadSequenceFiles()).find((f) => f.parsed.name === MAIN_SEQUENCE_NAME)
    if (!file) throw new Error(`content/sequences has no "${MAIN_SEQUENCE_NAME}" file`)
    return file
  }
  if (!id && !(await hasKey(db, MAIN_STEPS_KEY))) {
    const old = await db
      .select({ id: sequences.id })
      .from(sequences)
      .where(inArray(sequences.name, OLD_MAIN_SEQUENCE_NAMES))
      .limit(1)
    if (old[0]) {
      id = old[0].id
      await upgradeInPlace(db, id, await mainFile())
      upgraded = true
    }
  }
  if (!id) {
    id = await insertSequence(db, await mainFile())
    created = true
  }
  await markKey(db, MAIN_STEPS_KEY)

  if (await hasKey(db, MAIN_SETUP_KEY)) {
    // Deleted and re-added: point the autopilot at the new copy.
    if (created) await updateSettings({ main_sequence_id: id }, db)
    return { id, created, switched: false, upgraded }
  }

  const now = nowIso()
  await db
    .update(sequences)
    .set({ active: false, updated_at: now })
    .where(and(ne(sequences.id, id), eq(sequences.active, true)))
  await db.update(sequences).set({ active: true, updated_at: now }).where(eq(sequences.id, id))
  await updateSettings(
    {
      main_sequence_id: id,
      channels: { email: true, linkedin: true, mail: true, instagram: false, call: false },
    },
    db,
  )
  await markKey(db, MAIN_SETUP_KEY)
  return { id, created, switched: true, upgraded }
}
