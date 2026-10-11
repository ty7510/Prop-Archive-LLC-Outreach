// Every table (spec section 4) plus provider_usage. Owned by the scaffold.
// Ids are text ULIDs. Timestamps are ISO strings in text columns. JSON columns use { mode: 'json' }.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type {
  ActivityLevel,
  Channel,
  EmailStatus,
  EnrollmentStatus,
  EventKind,
  JobStatus,
  LeadChannels,
  LeadEnrichment,
  LeadPersona,
  LeadSource,
  LeadStatus,
  LeadTrigger,
  MessageDirection,
  MessageStatus,
  OwnerKind,
  PhoneType,
  ReplyClassification,
  SequencePersona,
  SequenceTrigger,
  SuppressionKind,
} from '../../shared/types.ts'

export const leads = sqliteTable(
  'leads',
  {
    id: text('id').primaryKey(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),

    source: text('source').$type<LeadSource>().notNull().default('manual'),
    status: text('status').$type<LeadStatus>().notNull().default('new'),
    persona: text('persona').$type<LeadPersona>().notNull().default('unknown'),
    icp_score: integer('icp_score').notNull().default(0),
    owner_kind: text('owner_kind').$type<OwnerKind>().notNull().default('unknown'),

    full_name: text('full_name'),
    first_name: text('first_name'),
    last_name: text('last_name'),
    company: text('company'),

    email: text('email'),
    email_status: text('email_status').$type<EmailStatus>().notNull().default('unknown'),
    phone: text('phone'),
    phone_type: text('phone_type').$type<PhoneType>().notNull().default('unknown'),
    linkedin_url: text('linkedin_url'),
    instagram_url: text('instagram_url'),
    website: text('website'),

    mailing_street: text('mailing_street'),
    mailing_city: text('mailing_city'),
    mailing_state: text('mailing_state'),
    mailing_zip: text('mailing_zip'),
    mailing_verified: integer('mailing_verified', { mode: 'boolean' }).notNull().default(false),

    property_count: integer('property_count').notNull().default(0),
    unit_count: integer('unit_count').notNull().default(0),
    zips: text('zips', { mode: 'json' }).$type<string[]>().notNull().default([]),

    trigger: text('trigger', { mode: 'json' })
      .$type<LeadTrigger>()
      .notNull()
      .default({ type: 'none' }),
    channels: text('channels', { mode: 'json' })
      .$type<LeadChannels>()
      .notNull()
      .default({ email: false, mail: false, linkedin: false, instagram: false, call: false }),
    enrichment: text('enrichment', { mode: 'json' }).$type<LeadEnrichment>().notNull().default({}),

    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    notes: text('notes'),

    do_not_contact: integer('do_not_contact', { mode: 'boolean' }).notNull().default(false),
    unsubscribe_token: text('unsubscribe_token').notNull(),

    last_contacted_at: text('last_contacted_at'),
    last_replied_at: text('last_replied_at'),
    next_action_at: text('next_action_at'),

    dedupe_key: text('dedupe_key'),
  },
  (t) => [
    uniqueIndex('leads_unsubscribe_token_uq').on(t.unsubscribe_token),
    uniqueIndex('leads_dedupe_key_uq').on(t.dedupe_key),
    index('leads_status_idx').on(t.status),
    index('leads_persona_idx').on(t.persona),
    index('leads_email_idx').on(t.email),
  ],
)

export const properties = sqliteTable(
  'properties',
  {
    id: text('id').primaryKey(),
    lead_id: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    address: text('address'),
    zip: text('zip'),
    category: text('category'),
    units: integer('units'),
    sale_date: text('sale_date'),
    sale_price: integer('sale_price'),
    market_value: integer('market_value'),
    opa_account: text('opa_account'),
    license_num: text('license_num'),
    license_issue_date: text('license_issue_date'),
    license_expiry: text('license_expiry'),
    source: text('source').$type<LeadSource>().notNull().default('opa'),
    raw: text('raw', { mode: 'json' }).$type<unknown>(),
  },
  (t) => [
    index('properties_lead_id_idx').on(t.lead_id),
    index('properties_opa_account_idx').on(t.opa_account),
  ],
)

export const sequences = sqliteTable('sequences', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  channel: text('channel').$type<Channel>().notNull(),
  persona: text('persona').$type<SequencePersona>().notNull().default('any'),
  trigger: text('trigger').$type<SequenceTrigger>().notNull().default('any'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  description: text('description'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const sequenceSteps = sqliteTable(
  'sequence_steps',
  {
    id: text('id').primaryKey(),
    sequence_id: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    step_index: integer('step_index').notNull(),
    delay_days: integer('delay_days').notNull().default(0),
    subject: text('subject'),
    body: text('body').notNull(),
    channel: text('channel').$type<Channel>().notNull(),
    notes: text('notes'),
  },
  (t) => [uniqueIndex('sequence_steps_seq_index_uq').on(t.sequence_id, t.step_index)],
)

export const enrollments = sqliteTable(
  'enrollments',
  {
    id: text('id').primaryKey(),
    lead_id: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    sequence_id: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    status: text('status').$type<EnrollmentStatus>().notNull().default('active'),
    current_step: integer('current_step').notNull().default(0),
    next_send_at: text('next_send_at'),
    started_at: text('started_at').notNull(),
    ended_at: text('ended_at'),
    /** Bumped every time the lead is put back into this sequence, so idempotency keys never collide. */
    run: integer('run').notNull().default(0),
  },
  (t) => [
    uniqueIndex('enrollments_lead_sequence_uq').on(t.lead_id, t.sequence_id),
    index('enrollments_status_next_idx').on(t.status, t.next_send_at),
  ],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    lead_id: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    enrollment_id: text('enrollment_id').references(() => enrollments.id, {
      onDelete: 'set null',
    }),
    step_id: text('step_id').references(() => sequenceSteps.id, { onDelete: 'set null' }),
    channel: text('channel').$type<Channel>().notNull(),
    direction: text('direction').$type<MessageDirection>().notNull().default('out'),
    status: text('status').$type<MessageStatus>().notNull().default('queued'),
    /** `enrollment_id:step_index` for outbound; provider message id for inbound. */
    idempotency_key: text('idempotency_key').notNull(),
    subject: text('subject'),
    body: text('body').notNull().default(''),
    /** Email address, postal address as JSON text, or profile URL / phone for human channels. */
    to_address: text('to_address'),
    provider: text('provider'),
    provider_message_id: text('provider_message_id'),
    scheduled_at: text('scheduled_at'),
    sent_at: text('sent_at'),
    error: text('error'),
    /** How many times a provider was asked to carry this message. Bounded retries live in send.ts. */
    attempts: integer('attempts').notNull().default(0),
    classification: text('classification').$type<ReplyClassification>(),
    raw: text('raw', { mode: 'json' }).$type<unknown>(),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('messages_idempotency_key_uq').on(t.idempotency_key),
    index('messages_lead_id_idx').on(t.lead_id),
    index('messages_status_channel_idx').on(t.status, t.channel),
    index('messages_provider_message_id_idx').on(t.provider_message_id),
  ],
)

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    lead_id: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<EventKind>().notNull(),
    detail: text('detail', { mode: 'json' }).$type<unknown>(),
    at: text('at').notNull(),
  },
  (t) => [index('events_lead_id_idx').on(t.lead_id), index('events_kind_at_idx').on(t.kind, t.at)],
)

export const suppression = sqliteTable(
  'suppression',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<SuppressionKind>().notNull(),
    /** Normalised: lower-case email or domain, normalised street|zip, digits-only phone. */
    value: text('value').notNull(),
    reason: text('reason'),
    at: text('at').notNull(),
  },
  (t) => [uniqueIndex('suppression_kind_value_uq').on(t.kind, t.value)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>(),
})

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    job: text('job').notNull(),
    started_at: text('started_at').notNull(),
    finished_at: text('finished_at'),
    status: text('status').$type<JobStatus>().notNull().default('running'),
    summary: text('summary', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
  },
  (t) => [index('job_runs_job_started_idx').on(t.job, t.started_at)],
)

export const activityLog = sqliteTable(
  'activity_log',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    level: text('level').$type<ActivityLevel>().notNull().default('info'),
    event: text('event').notNull(),
    lead_id: text('lead_id'),
    detail: text('detail', { mode: 'json' }).$type<unknown>(),
  },
  (t) => [index('activity_log_at_idx').on(t.at)],
)

export const imports = sqliteTable('imports', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  filename: text('filename').notNull(),
  row_count: integer('row_count').notNull().default(0),
  created: integer('created').notNull().default(0),
  merged: integer('merged').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  at: text('at').notNull(),
  errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),
})

/** One row per paid provider call, so monthly credit caps can be counted. */
export const providerUsage = sqliteTable(
  'provider_usage',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    lead_id: text('lead_id'),
    credits: integer('credits').notNull().default(1),
    at: text('at').notNull(),
  },
  (t) => [index('provider_usage_provider_at_idx').on(t.provider, t.at)],
)

// ---------- inferred types ----------

export type Lead = typeof leads.$inferSelect
export type NewLead = typeof leads.$inferInsert
export type Property = typeof properties.$inferSelect
export type NewProperty = typeof properties.$inferInsert
export type Sequence = typeof sequences.$inferSelect
export type NewSequence = typeof sequences.$inferInsert
export type SequenceStep = typeof sequenceSteps.$inferSelect
export type NewSequenceStep = typeof sequenceSteps.$inferInsert
export type Enrollment = typeof enrollments.$inferSelect
export type NewEnrollment = typeof enrollments.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
export type Suppression = typeof suppression.$inferSelect
export type NewSuppression = typeof suppression.$inferInsert
export type SettingRow = typeof settings.$inferSelect
export type NewSettingRow = typeof settings.$inferInsert
export type JobRun = typeof jobRuns.$inferSelect
export type NewJobRun = typeof jobRuns.$inferInsert
export type ActivityLogRow = typeof activityLog.$inferSelect
export type NewActivityLogRow = typeof activityLog.$inferInsert
export type Import = typeof imports.$inferSelect
export type NewImport = typeof imports.$inferInsert
export type ProviderUsage = typeof providerUsage.$inferSelect
export type NewProviderUsage = typeof providerUsage.$inferInsert

export const schema = {
  leads,
  properties,
  sequences,
  sequenceSteps,
  enrollments,
  messages,
  events,
  suppression,
  settings,
  jobRuns,
  activityLog,
  imports,
  providerUsage,
}
export type Schema = typeof schema
