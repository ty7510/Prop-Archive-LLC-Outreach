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

/** 'replied': Theo logs by hand that someone wrote back (LinkedIn, a call, a letter, his own email). */
export const OUTCOME_KINDS = ['demo_booked', 'beta_joined', 'not_interested', 'replied'] as const
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

/** Why Claude web research is not running: its monthly limit is used up, or it failed and rests. */
export const ResearchPausedSchema = z.object({
  reason: z.enum(['cap', 'down']),
  used: z.number().nullable(),
  cap: z.number().nullable(),
  /** When down: what went wrong, in plain words ("the Anthropic account is out of credits"). */
  why: z.string().optional(),
  /** When down: what fixes it, or that it is tried again by itself. */
  hint: z.string().optional(),
  /** When down: when the app asks Claude again (ISO). */
  retry_at: z.string().optional(),
})
export type ResearchPaused = z.infer<typeof ResearchPausedSchema>

export const EnrichResultSchema = z.object({
  enriched: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  /** Set when research is paused, so the Enrich button can say why nothing happened. */
  research_paused: ResearchPausedSchema.optional(),
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
  /** For 'replied': where they wrote back, and what they said. */
  channel: ChannelSchema.optional(),
  note: z.string().trim().max(2000).optional(),
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
  /** True when the test went through Sign in with Google (a real email was sent to the inbox). */
  google: z.boolean().optional(),
})

/** Where Sign in with Google stands for the app, as GET /api/settings/google-mail reports it. */
export const GoogleMailStatusSchema = z.object({
  state: z.enum(['connected', 'not_connected', 'not_on_replit', 'lookup_failed', 'refused']),
  /** The connected Google account, lower-case, when connected. */
  email: z.string().nullable(),
  detail: z.string(),
})
export type GoogleMailStatus = z.infer<typeof GoogleMailStatusSchema>
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
  /** When Theo marked it done (contacted_recently only). */
  sent_at: z.string().nullable(),
  /** To call or write to them himself. */
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** A LinkedIn note written for this person and their company (waiting notes only). */
  personal_note: z.boolean().optional(),
})
export type QueueItem = z.infer<typeof QueueItemSchema>

/** One waiting LinkedIn note: written for the person when `personal`, else Theo's own note. */
export const LinkedInNoteSchema = z.object({
  message_id: z.string(),
  body: z.string(),
  personal: z.boolean(),
})
export type LinkedInNote = z.infer<typeof LinkedInNoteSchema>

/** Someone in the sequence with no LinkedIn profile yet: Theo can look them up and paste it. */
export const LinkedInWantedSchema = z.object({
  lead_id: z.string(),
  person: z.string(),
  company: z.string().nullable(),
  city: z.string().nullable(),
})
export type LinkedInWanted = z.infer<typeof LinkedInWantedSchema>

export const LinkedInProfileBodySchema = z.object({
  url: z.string().trim().min(1).max(500),
})
export type LinkedInProfileBody = z.infer<typeof LinkedInProfileBodySchema>

export const WrongProfileBodySchema = z.object({ message_id: z.string().optional() })
export type WrongProfileBody = z.infer<typeof WrongProfileBodySchema>

export const LinkedInProfileResultSchema = z.object({
  linkedin_url: z.string(),
  /** A note for them is waiting on the Go page now. */
  queued: z.boolean(),
})
export type LinkedInProfileResult = z.infer<typeof LinkedInProfileResultSchema>

/**
 * One step on a person's to-do card. `postcard` is the printout (one US Letter page mailed in a
 * folder with Theo's card since 2026-10-16; older cards may still hold a 4x6 postcard), `email` is
 * written by the app and sent by Theo from Gmail, and `call` is only on cards made before then.
 */
/**
 * fillTodo's reason when there was room for LinkedIn notes today but nobody new has a LinkedIn
 * profile to add (every profiled lead already reached, or research found none yet).
 */
export const NO_NEW_LINKEDIN = 'nobody new with a LinkedIn'

export const TodoStepKindSchema = z.enum([
  'linkedin_connect',
  'linkedin_follow_up',
  'postcard',
  'email',
  'call',
])
export type TodoStepKind = z.infer<typeof TodoStepKindSchema>

export const TodoStepSchema = z.object({
  message_id: z.string(),
  kind: TodoStepKindSchema,
  channel: ChannelSchema,
  status: z.enum(['waiting', 'done', 'skipped']),
  /** The note, the printout's part about them, the email or what to say on the call. */
  body: z.string(),
  /** The email's subject, or the printout's heading. */
  subject: z.string().nullable(),
  /** Profile link, postal address JSON or phone. */
  to_address: z.string().nullable(),
  /** LinkedIn only: the app found this profile itself, so Theo checks it is the right person. */
  found_by_app: z.boolean(),
  /** Mail only: a one-page printout (true) or an old 4x6 postcard (false). */
  printout: z.boolean(),
  /** House-rule checks on the words as they are now, for proofing. Empty when all is well. */
  problems: z.array(z.string()),
})
export type TodoStep = z.infer<typeof TodoStepSchema>

export const TodoPersonSchema = z.object({
  lead_id: z.string(),
  person: z.string(),
  company: z.string().nullable(),
  property_count: z.number().int(),
  city: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** 1 the first time on the list, 2 after one recycle, and so on. */
  round: z.number().int().min(1),
  steps: z.array(TodoStepSchema),
  /**
   * No LinkedIn profile yet: `not_found` when the finder found none (the LinkedIn step still has
   * the note, with a search button and a paste box), `no_name` when there is no name to search.
   */
  linkedin_missing: z.enum(['not_found', 'no_name']).nullable(),
  added_at: z.string(),
})
export type TodoPerson = z.infer<typeof TodoPersonSchema>

export const CompletePersonSchema = z.object({
  lead_id: z.string(),
  person: z.string(),
  company: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** What Theo did, e.g. ["LinkedIn note", "Postcard"]. */
  done: z.array(z.string()),
  last_done_at: z.string(),
  /** When they come back on the list if they have not replied. */
  back_on: z.string(),
})
export type CompletePerson = z.infer<typeof CompletePersonSchema>

export const RepliedPersonSchema = z.object({
  lead_id: z.string(),
  person: z.string(),
  company: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  status: LeadStatusSchema,
  channel: ChannelSchema.nullable(),
  /** What they said, when Theo wrote it down or it came by email. */
  note: z.string().nullable(),
  replied_at: z.string(),
})
export type RepliedPerson = z.infer<typeof RepliedPersonSchema>

export const TodoListSchema = z.object({
  people: z.array(TodoPersonSchema),
  complete: z.array(CompletePersonSchema),
  replied: z.array(RepliedPersonSchema),
  /** New people put on the list today, and the daily number. */
  /** People whose LinkedIn note Theo marked sent today, and the daily goal. */
  today: z.object({ sent: z.number().int(), goal: z.number().int() }),
  /** Steps marked sent today, per list: LinkedIn notes, printouts (mail) and emails. */
  sent_today: z.object({
    linkedin: z.number().int(),
    mail: z.number().int(),
    email: z.number().int(),
  }),
  recycle_after_days: z.number().int(),
  /** The lines under every email Theo sends from the list (opt-out and mailing address). */
  email_footer: z.string(),
  /** The Gmail account Open in Gmail writes from (reply_to, else owner_email). */
  gmail_user: z.string(),
})
export type TodoList = z.infer<typeof TodoListSchema>

export const QueueSchema = z.object({
  groups: z.record(ChannelSchema, z.array(QueueItemSchema)),
  total: z.number().int().min(0),
  /** Tasks Theo skipped in the last 7 days, so one skipped by mistake can come back. */
  skipped_recently: z.array(QueueItemSchema),
  /** People Theo reached by hand in the last 30 days who have not answered yet: log a reply here. */
  contacted_recently: z.array(QueueItemSchema),
  /** Top people in the sequence with no LinkedIn profile, to look up while under today's goal. */
  linkedin_wanted: z.array(LinkedInWantedSchema),
  /** Per channel: tasks done today and the daily goal (the channel's daily cap). */
  today: z.record(
    ChannelSchema,
    z.object({ done: z.number().int().min(0), goal: z.number().int().min(0) }),
  ),
})
export type Queue = z.infer<typeof QueueSchema>

/** Theo's own words for a waiting step (the note, the email, the printout's part about them). */
export const EditStepBodySchema = z.object({
  /** The email's subject or the printout's heading. Ignored for a LinkedIn note. */
  subject: z.string().trim().max(200).optional(),
  body: z.string().max(6000),
})
export type EditStepBody = z.infer<typeof EditStepBodySchema>

export const EditStepResultSchema = z.object({
  message_id: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  /** House-rule checks on what was saved (it is saved anyway: Theo has the last word). */
  problems: z.array(z.string()),
})
export type EditStepResult = z.infer<typeof EditStepResultSchema>

/** Everything one printout page shows (shared/printout.ts PrintoutParts, without the edit link). */
export const PrintoutPartsSchema = z.object({
  heading: z.string(),
  body: z.string(),
  overview: z.string(),
  features: z.string(),
  bio: z.string(),
  closing: z.string(),
  preparedFor: z.array(z.string()),
  date: z.string(),
  ownerName: z.string(),
  email: z.string(),
  site: z.string(),
})
export type PrintoutPartsData = z.infer<typeof PrintoutPartsSchema>

/** One printout to proof and edit. heading/body are this person's; the rest is from Settings. */
export const PrintoutDocSchema = z.object({
  message_id: z.string(),
  lead_id: z.string(),
  status: MessageStatusSchema,
  person: z.string(),
  /** Where it is mailed, one line ('' when there is no address). */
  address: z.string(),
  parts: PrintoutPartsSchema,
  /** House-rule checks on this person's part as it is now. */
  problems: z.array(z.string()),
})
export type PrintoutDoc = z.infer<typeof PrintoutDocSchema>

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
