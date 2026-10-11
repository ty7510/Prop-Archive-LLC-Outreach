// Shared helpers for the outreach tests: an in-memory db, a deps bag with fakes, leads, sequences.
import { eq } from 'drizzle-orm'
import { createTestDb, setDefaultDb, type Db } from '../db/client.ts'
import {
  leads,
  sequenceSteps,
  sequences,
  type Lead,
  type NewLead,
  type NewSequence,
  type Sequence,
  type SequenceStep,
} from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { invalidateSettingsCache, updateSettings } from '../lib/settings.ts'
import { testDeps, type Mailer, type OutgoingMail, type OutreachDeps } from './deps.ts'

export interface Fixture {
  db: Db
  deps: OutreachDeps
  /** Every mail the fake SMTP transport "sent". */
  outbox: OutgoingMail[]
}

/** Fresh db + deps with a fake SMTP mailer that records into `outbox`. */
export async function setup(overrides: Partial<OutreachDeps> = {}): Promise<Fixture> {
  const db = await createTestDb()
  setDefaultDb(db)
  invalidateSettingsCache()
  const outbox: OutgoingMail[] = []
  const mailer: Mailer = {
    async sendMail(mail) {
      outbox.push(mail)
      return { messageId: `<${outbox.length}@test.local>` }
    },
  }
  const deps = testDeps(db, { smtp: () => mailer, ...overrides })
  return { db, deps, outbox }
}

export async function setSettings(db: Db, partial: Record<string, unknown>): Promise<void> {
  await updateSettings(partial, db)
}

let leadCounter = 0

export async function insertLead(db: Db, patch: Partial<NewLead> = {}): Promise<Lead> {
  leadCounter++
  const now = new Date('2026-10-01T12:00:00.000Z').toISOString()
  const row: NewLead = {
    id: newId(),
    created_at: now,
    updated_at: now,
    source: 'manual',
    status: 'enriched',
    persona: 'ray',
    icp_score: 75,
    owner_kind: 'person',
    full_name: `Lead ${leadCounter}`,
    first_name: 'Lead',
    last_name: String(leadCounter),
    company: null,
    email: `lead${leadCounter}@example.com`,
    email_status: 'valid',
    phone: `21555500${String(leadCounter).padStart(2, '0')}`,
    linkedin_url: `https://www.linkedin.com/in/lead${leadCounter}`,
    mailing_street: `${100 + leadCounter} Example St`,
    mailing_city: 'Philadelphia',
    mailing_state: 'PA',
    mailing_zip: '19146',
    property_count: 8,
    unit_count: 12,
    zips: ['19146'],
    trigger: { type: 'none' },
    channels: { email: true, mail: true, linkedin: true, instagram: false, call: true },
    unsubscribe_token: `tok-${newId()}`,
    dedupe_key: `lead-${leadCounter}-${newId()}`,
    ...patch,
  }
  await db.insert(leads).values(row)
  const saved = await db.select().from(leads).where(eq(leads.id, row.id))
  return saved[0] as Lead
}

export interface StepInput {
  delay_days: number
  subject?: string | null
  body: string
}

export async function insertSequence(
  db: Db,
  patch: Partial<NewSequence> = {},
  steps: StepInput[] = [
    { delay_days: 0, subject: 'Hi {{first_name}}', body: 'Hello {{first_name}}. {{demo_link}}' },
    { delay_days: 3, subject: 'Again {{first_name}}', body: 'Second note. {{beta_link}}' },
  ],
): Promise<{ sequence: Sequence; steps: SequenceStep[] }> {
  const now = new Date('2026-10-01T12:00:00.000Z').toISOString()
  const channel = patch.channel ?? 'email'
  const seq: NewSequence = {
    id: newId(),
    name: patch.name ?? `Seq ${channel}`,
    channel,
    persona: 'any',
    trigger: 'any',
    active: true,
    created_at: now,
    updated_at: now,
    ...patch,
  }
  await db.insert(sequences).values(seq)
  const rows: SequenceStep[] = steps.map((s, i) => ({
    id: newId(),
    sequence_id: seq.id,
    step_index: i,
    delay_days: s.delay_days,
    subject: s.subject ?? null,
    body: s.body,
    channel,
    notes: null,
  }))
  await db.insert(sequenceSteps).values(rows)
  return { sequence: seq as Sequence, steps: rows }
}
