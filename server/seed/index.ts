// Seed: default sequences from content/sequences/*.md, sample leads, settings.sequence_by_persona.
// FILLED BY: the content builder. Spec section 13.
// Must stay idempotent: server/index.ts calls seed(db) on every boot and `npm run seed` runs it by hand.
import { count } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { sequences } from '../db/schema.ts'

export interface SeedResult {
  sequences: number
  leads: number
  skipped: boolean
}

/** No-op for now: reports what is there and inserts nothing. The content builder replaces the body. */
export async function seed(db: Db): Promise<SeedResult> {
  const [row] = await db.select({ n: count() }).from(sequences)
  return { sequences: row?.n ?? 0, leads: 0, skipped: true }
}
