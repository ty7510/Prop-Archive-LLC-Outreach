// Zod schemas and TS types shared by server and client. Owned by the scaffold.
// Every API body is validated with one of these on the server and typed with them on the client.
import { z } from 'zod'

// ---------- enums (spec section 4) ----------

export const LEAD_SOURCES = ['opa', 'li', 'csv', 'manual'] as const
export const LeadSourceSchema = z.enum(LEAD_SOURCES)
export type LeadSource = z.infer<typeof LeadSourceSchema>

export const LEAD_STATUSES = [
  'new',
  'enriching',
  'enriched',
  'enrolled',
  'contacted',
  'replied',
  'booked',
  'joined',
  'not_interested',
  'unsubscribed',
  'bounced',
  'disqualified',
] as const
export const LeadStatusSchema = z.enum(LEAD_STATUSES)
export type LeadStatus = z.infer<typeof LeadStatusSchema>

export const PERSONAS = ['maya', 'ray', 'denise'] as const
export const PersonaSchema = z.enum(PERSONAS)
export type Persona = z.infer<typeof PersonaSchema>

export const LEAD_PERSONAS = [...PERSONAS, 'unknown'] as const
export const LeadPersonaSchema = z.enum(LEAD_PERSONAS)
export type LeadPersona = z.infer<typeof LeadPersonaSchema>

export const SEQUENCE_PERSONAS = [...PERSONAS, 'any'] as const
export const SequencePersonaSchema = z.enum(SEQUENCE_PERSONAS)
export type SequencePersona = z.infer<typeof SequencePersonaSchema>

export const OWNER_KINDS = ['person', 'llc', 'unknown'] as const
export const OwnerKindSchema = z.enum(OWNER_KINDS)
export type OwnerKind = z.infer<typeof OwnerKindSchema>

export const EMAIL_STATUSES = ['unknown', 'valid', 'risky', 'invalid'] as const
export const EmailStatusSchema = z.enum(EMAIL_STATUSES)
export type EmailStatus = z.infer<typeof EmailStatusSchema>

export const PHONE_TYPES = ['unknown', 'mobile', 'landline', 'voip'] as const
export const PhoneTypeSchema = z.enum(PHONE_TYPES)
export type PhoneType = z.infer<typeof PhoneTypeSchema>

export const CHANNELS = ['email', 'mail', 'linkedin', 'instagram', 'call'] as const
export const ChannelSchema = z.enum(CHANNELS)
export type Channel = z.infer<typeof ChannelSchema>

export const HUMAN_CHANNELS = ['linkedin', 'instagram', 'call'] as const
export type HumanChannel = (typeof HUMAN_CHANNELS)[number]

export const TRIGGER_TYPES = ['new_license', 'recent_sale', 'csv', 'none'] as const
export const TriggerTypeSchema = z.enum(TRIGGER_TYPES)
export type TriggerType = z.infer<typeof TriggerTypeSchema>

export const SEQUENCE_TRIGGERS = ['new_license', 'recent_sale', 'any'] as const
export const SequenceTriggerSchema = z.enum(SEQUENCE_TRIGGERS)
export type SequenceTrigger = z.infer<typeof SequenceTriggerSchema>

export const ENROLLMENT_STATUSES = [
  'active',
  'paused',
  'done',
  'stopped_replied',
  'stopped_unsubscribed',
  'stopped_bounced',
  'stopped_manual',
] as const
export const EnrollmentStatusSchema = z.enum(ENROLLMENT_STATUSES)
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>

export const MESSAGE_DIRECTIONS = ['out', 'in'] as const
export const MessageDirectionSchema = z.enum(MESSAGE_DIRECTIONS)
export type MessageDirection = z.infer<typeof MessageDirectionSchema>

export const MESSAGE_STATUSES = [
  'dry_run',
  'queued',
  'sending',
  'ready_for_human',
  'sent',
  'skipped',
  'failed',
  'bounced',
  'received',
] as const
export const MessageStatusSchema = z.enum(MESSAGE_STATUSES)
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export const REPLY_CLASSIFICATIONS = [
  'interested',
  'booked',
  'not_now',
  'not_interested',
  'unsubscribe',
  'bounce',
  'other',
] as const
export const ReplyClassificationSchema = z.enum(REPLY_CLASSIFICATIONS)
export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>

export const EVENT_KINDS = [
  'click',
  'open',
  'demo_booked',
  'beta_joined',
  'reply',
  'unsubscribe',
  'note',
  'status_change',
  'enrolled',
  'stopped',
  'sent',
  'queued',
  'bounce',
  'do_not_contact',
] as const
export const EventKindSchema = z.enum(EVENT_KINDS)
export type EventKind = z.infer<typeof EventKindSchema>

export const SUPPRESSION_KINDS = ['email', 'domain', 'address', 'phone'] as const
export const SuppressionKindSchema = z.enum(SUPPRESSION_KINDS)
export type SuppressionKind = z.infer<typeof SuppressionKindSchema>

export const JOB_NAMES = [
  'discover',
  'enrich',
  'enroll',
  'send',
  'sync_replies',
  'housekeeping',
] as const
export const JobNameSchema = z.enum(JOB_NAMES)
export type JobName = z.infer<typeof JobNameSchema>

export const JOB_STATUSES = ['running', 'ok', 'error'] as const
export const JobStatusSchema = z.enum(JOB_STATUSES)
export type JobStatus = z.infer<typeof JobStatusSchema>

export const ACTIVITY_LEVELS = ['info', 'warn', 'error'] as const
export const ActivityLevelSchema = z.enum(ACTIVITY_LEVELS)
export type ActivityLevel = z.infer<typeof ActivityLevelSchema>

export const OUTCOME_KINDS = ['demo_booked', 'beta_joined', 'not_interested'] as const
export const OutcomeKindSchema = z.enum(OUTCOME_KINDS)
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>

// ---------- JSON column shapes ----------

export const LeadTriggerSchema = z.object({
  type: TriggerTypeSchema,
  date: z.string().optional(),
  detail: z.string().optional(),
})
export type LeadTrigger = z.infer<typeof LeadTriggerSchema>

export const LeadChannelsSchema = z.object({
  email: z.boolean(),
  mail: z.boolean(),
  linkedin: z.boolean(),
  instagram: z.boolean(),
  call: z.boolean(),
})
export type LeadChannels = z.infer<typeof LeadChannelsSchema>

export const NO_CHANNELS: LeadChannels = {
  email: false,
  mail: false,
  linkedin: false,
  instagram: false,
  call: false,
}

/** Raw provider payloads keyed by provider id, each with a fetched_at ISO string. */
export const LeadEnrichmentSchema = z.record(
  z.string(),
  z.object({ fetched_at: z.string(), data: z.unknown() }),
)
export type LeadEnrichment = z.infer<typeof LeadEnrichmentSchema>

// ---------- common ----------

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const NOT_BUILT: ApiError = { error: 'not built yet', code: 'NOT_BUILT' }

export interface Paged<T> {
  items: T[]
  page: number
  limit: number
  total: number
}

// ---------- auth ----------

export const LoginBodySchema = z.object({
  password: z.string().min(1),
})
export type LoginBody = z.infer<typeof LoginBodySchema>

export const MeSchema = z.object({
  loggedIn: z.boolean(),
})
export type Me = z.infer<typeof MeSchema>

// ---------- health ----------

export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  dbOk: z.boolean(),
  liveMode: z.boolean(),
  autopilotOn: z.boolean(),
})
export type Health = z.infer<typeof HealthSchema>

// ---------- leads ----------

export const LeadsQuerySchema = z.object({
  status: LeadStatusSchema.optional(),
  persona: LeadPersonaSchema.optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type LeadsQuery = z.infer<typeof LeadsQuerySchema>

/** Statuses Theo may set by hand from the lead panel. */
export const MANUAL_LEAD_STATUSES = [
  'new',
  'booked',
  'joined',
  'not_interested',
  'disqualified',
] as const
export const ManualLeadStatusSchema = z.enum(MANUAL_LEAD_STATUSES)

export const LeadPatchSchema = z
  .object({
    notes: z.string().max(10_000).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    do_not_contact: z.boolean().optional(),
    status: ManualLeadStatusSchema.optional(),
  })
  .strict()
export type LeadPatch = z.infer<typeof LeadPatchSchema>

export const ImportResultSchema = z.object({
  import_id: z.string(),
  filename: z.string(),
  row_count: z.number().int().min(0),
  created: z.number().int().min(0),
  merged: z.number().int().min(0),
  skipped: z.number().int().min(0),
  errors: z.array(z.string()),
})
export type ImportResult = z.infer<typeof ImportResultSchema>

export const DiscoverBodySchema = z.object({
  zips: z
    .array(z.string().regex(/^\d{5}$/))
    .max(50)
    .optional(),
  limit: z.number().int().min(1).max(1000).optional(),
})
export type DiscoverBody = z.infer<typeof DiscoverBodySchema>

export const DiscoverResultSchema = z.object({
  created: z.number().int().min(0),
  merged: z.number().int().min(0),
  skipped: z.number().int().min(0),
})
export type DiscoverResult = z.infer<typeof DiscoverResultSchema>

export const EnrichBodySchema = z.object({
  ids: z.array(z.string()).max(500).optional(),
  all: z.boolean().optional(),
})
export type EnrichBody = z.infer<typeof EnrichBodySchema>

export const EnrichResultSchema = z.object({
  enriched: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
})
export type EnrichResult = z.infer<typeof EnrichResultSchema>

export const EnrollBodySchema = z.object({
  sequence_id: z.string().min(1),
})
export type EnrollBody = z.infer<typeof EnrollBodySchema>

export const StopBodySchema = z.object({
  reason: z.string().max(500).optional(),
})
export type StopBody = z.infer<typeof StopBodySchema>

export const OutcomeBodySchema = z.object({
  kind: OutcomeKindSchema,
})
export type OutcomeBody = z.infer<typeof OutcomeBodySchema>

// ---------- sequences ----------

export const SequenceStepInputSchema = z.object({
  step_index: z.number().int().min(0).optional(),
  delay_days: z.number().int().min(0).max(365),
  /** A step may use another channel than its sequence (email, then LinkedIn, then mail). */
  channel: ChannelSchema.optional(),
  subject: z.string().max(200).nullable().optional(),
  body: z.string().min(1).max(20_000),
  notes: z.string().max(2000).nullable().optional(),
})
export type SequenceStepInput = z.infer<typeof SequenceStepInputSchema>

export const SequenceCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channel: ChannelSchema,
  persona: SequencePersonaSchema.default('any'),
  trigger: SequenceTriggerSchema.default('any'),
  active: z.boolean().default(true),
  description: z.string().max(2000).nullable().optional(),
  steps: z.array(SequenceStepInputSchema).min(1).max(20),
})
export type SequenceCreate = z.infer<typeof SequenceCreateSchema>

/** PUT replaces the whole sequence. Fields left out keep their value; steps, when given, replace all. */
export const SequenceUpdateSchema = SequenceCreateSchema.partial()
export type SequenceUpdate = z.infer<typeof SequenceUpdateSchema>

export const SequencePreviewBodySchema = z.object({
  lead_id: z.string().optional(),
})
export type SequencePreviewBody = z.infer<typeof SequencePreviewBodySchema>

export const RenderedStepSchema = z.object({
  step_id: z.string(),
  step_index: z.number().int(),
  delay_days: z.number().int(),
  channel: ChannelSchema,
  subject: z.string().nullable(),
  body: z.string(),
})
export type RenderedStep = z.infer<typeof RenderedStepSchema>

// ---------- sequence readiness ----------

export const ReadinessItemSchema = z.object({
  key: z.string(),
  ok: z.boolean(),
  /** false: recommended, the sequence still runs without it. */
  required: z.boolean(),
  label: z.string(),
  fix: z.string(),
})
export type ReadinessItem = z.infer<typeof ReadinessItemSchema>

export const InboxTestResultSchema = z.object({
  smtp: z.object({ ok: z.boolean(), message: z.string() }),
  imap: z.object({ ok: z.boolean(), message: z.string() }),
})
export type InboxTestResult = z.infer<typeof InboxTestResultSchema>

// ---------- queue (human channels) ----------

export const QueueItemSchema = z.object({
  message_id: z.string(),
  lead_id: z.string(),
  channel: ChannelSchema,
  person: z.string(),
  company: z.string().nullable(),
  to_address: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  sequence_name: z.string().nullable(),
  step_index: z.number().int().nullable(),
  scheduled_at: z.string().nullable(),
  created_at: z.string(),
})
export type QueueItem = z.infer<typeof QueueItemSchema>

export const QueueSchema = z.object({
  groups: z.record(ChannelSchema, z.array(QueueItemSchema)),
  total: z.number().int().min(0),
})
export type Queue = z.infer<typeof QueueSchema>

export const QueueActionBodySchema = z.object({
  note: z.string().max(2000).optional(),
})
export type QueueActionBody = z.infer<typeof QueueActionBodySchema>

export const QueueActionResultSchema = z.object({
  message_id: z.string(),
  status: MessageStatusSchema,
})
export type QueueActionResult = z.infer<typeof QueueActionResultSchema>

// ---------- autopilot ----------

export const TodayCountsSchema = z.object({
  discovered: z.number().int().min(0),
  enriched: z.number().int().min(0),
  enrolled: z.number().int().min(0),
  sent: z.number().int().min(0),
  queued: z.number().int().min(0),
  replied: z.number().int().min(0),
  booked: z.number().int().min(0),
  joined: z.number().int().min(0),
})
export type TodayCounts = z.infer<typeof TodayCountsSchema>

export const ZERO_TODAY: TodayCounts = {
  discovered: 0,
  enriched: 0,
  enrolled: 0,
  sent: 0,
  queued: 0,
  replied: 0,
  booked: 0,
  joined: 0,
}

export const JobRunSummarySchema = z.object({
  job: z.string(),
  status: JobStatusSchema,
  started_at: z.string(),
  finished_at: z.string().nullable(),
  summary: z.unknown().nullable(),
  error: z.string().nullable(),
})
export type JobRunSummary = z.infer<typeof JobRunSummarySchema>

export const AutopilotStatusSchema = z.object({
  on: z.boolean(),
  liveMode: z.boolean(),
  lastTick: z.string().nullable(),
  nextTick: z.string().nullable(),
  today: TodayCountsSchema,
  jobs: z.record(z.string(), JobRunSummarySchema),
})
export type AutopilotStatus = z.infer<typeof AutopilotStatusSchema>

// ---------- activity ----------

export const ActivityEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  level: ActivityLevelSchema,
  event: z.string(),
  lead_id: z.string().nullable(),
  detail: z.unknown().nullable(),
})
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>

export const ActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>

// ---------- webhooks ----------

export const WebhookOutcomeBodySchema = z
  .object({
    email: z.string().email().optional(),
    lead_id: z.string().optional(),
    kind: z.enum(['demo_booked', 'beta_joined']),
  })
  .refine((b) => Boolean(b.email || b.lead_id), {
    message: 'email or lead_id is required',
  })
export type WebhookOutcomeBody = z.infer<typeof WebhookOutcomeBodySchema>

// ---------- providers ----------

export const PROVIDER_KEY_GROUPS = [
  'anthropic',
  'smtp',
  'resend',
  'imap',
  'lob',
  'hunter',
  'apollo',
  'pdl',
] as const
export type ProviderKeyGroup = (typeof PROVIDER_KEY_GROUPS)[number]

export const ProvidersPresentSchema = z.object({
  anthropic: z.boolean(),
  smtp: z.boolean(),
  resend: z.boolean(),
  imap: z.boolean(),
  lob: z.boolean(),
  hunter: z.boolean(),
  apollo: z.boolean(),
  pdl: z.boolean(),
})
export type ProvidersPresent = z.infer<typeof ProvidersPresentSchema>

/** GET /api/settings/providers: presence booleans plus the .env key names each group needs. */
export const ProvidersResponseSchema = ProvidersPresentSchema.extend({
  env_keys: z.record(z.string(), z.array(z.string())),
})
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>
