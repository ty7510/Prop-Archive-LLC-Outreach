// Settings keys, defaults and validation (spec section 7). Owned by the scaffold.
// The server stores each key as one row in the `settings` table; the API exposes the merged object.
import { z } from 'zod'
import { ChannelSchema, PersonaSchema } from './types.ts'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ZIP5 = /^\d{5}$/

export const ENRICH_PROVIDER_IDS = [
  'li_license',
  'claude_research',
  'hunter',
  'apollo',
  'pdl',
] as const
export const EnrichProviderIdSchema = z.enum(ENRICH_PROVIDER_IDS)
export type EnrichProviderId = z.infer<typeof EnrichProviderIdSchema>

export const ChannelTogglesSchema = z.object({
  email: z.boolean().default(true),
  mail: z.boolean().default(false),
  linkedin: z.boolean().default(true),
  instagram: z.boolean().default(false),
  call: z.boolean().default(true),
})
export type ChannelToggles = z.infer<typeof ChannelTogglesSchema>

export const DailyCapsSchema = z.object({
  email: z.number().int().min(0).max(1000).default(20),
  mail: z.number().int().min(0).max(1000).default(10),
  linkedin: z.number().int().min(0).max(1000).default(15),
  instagram: z.number().int().min(0).max(1000).default(10),
  call: z.number().int().min(0).max(1000).default(10),
})
export type DailyCaps = z.infer<typeof DailyCapsSchema>

export const SendWindowSchema = z.object({
  tz: z.string().min(1).default('America/New_York'),
  /** 0 = Sunday ... 6 = Saturday, same as Date.getDay(). */
  days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  start: z.string().regex(HHMM, 'use HH:MM').default('08:30'),
  end: z.string().regex(HHMM, 'use HH:MM').default('17:00'),
})
export type SendWindow = z.infer<typeof SendWindowSchema>

export const MonthlyCreditCapSchema = z.object({
  hunter: z.number().int().min(0).default(50),
  apollo: z.number().int().min(0).default(100),
  pdl: z.number().int().min(0).default(50),
  claude_research: z.number().int().min(0).default(200),
})
export type MonthlyCreditCap = z.infer<typeof MonthlyCreditCapSchema>

export const EnrichmentSettingsSchema = z.object({
  providers: z
    .array(EnrichProviderIdSchema)
    .default(['li_license', 'claude_research', 'hunter', 'apollo', 'pdl']),
  monthly_credit_cap: MonthlyCreditCapSchema.default({
    hunter: 50,
    apollo: 100,
    pdl: 50,
    claude_research: 200,
  }),
})
export type EnrichmentSettings = z.infer<typeof EnrichmentSettingsSchema>

/** Sequence id per channel for one persona. null means "no sequence for this channel". */
export const PersonaSequencesSchema = z.object({
  email: z.string().nullable().default(null),
  mail: z.string().nullable().default(null),
  linkedin: z.string().nullable().default(null),
  instagram: z.string().nullable().default(null),
  call: z.string().nullable().default(null),
})
export type PersonaSequences = z.infer<typeof PersonaSequencesSchema>

const EMPTY_PERSONA_SEQUENCES: PersonaSequences = {
  email: null,
  mail: null,
  linkedin: null,
  instagram: null,
  call: null,
}

export const SequenceByPersonaSchema = z.object({
  maya: PersonaSequencesSchema.default(EMPTY_PERSONA_SEQUENCES),
  ray: PersonaSequencesSchema.default(EMPTY_PERSONA_SEQUENCES),
  denise: PersonaSequencesSchema.default(EMPTY_PERSONA_SEQUENCES),
})
export type SequenceByPersona = z.infer<typeof SequenceByPersonaSchema>

/** What the API shows instead of a stored inbox password. Sending it back keeps the stored one. */
export const SECRET_MASK = '••••••••'

/**
 * One warmed inbox the sequence sends from. The app rotates across active inboxes, never past
 * each one's daily limit, and reads replies from each over IMAP with the same login.
 */
export const SendingInboxSchema = z.object({
  id: z.string().trim().min(1),
  from_name: z.string().trim().max(120).default(''),
  email: z.string().trim().email('use a full email address'),
  smtp_host: z.string().trim().max(200).default(''),
  smtp_port: z.number().int().min(1).max(65535).default(587),
  /** Usually the email address itself. */
  smtp_user: z.string().trim().max(200).default(''),
  /** App password. Never returned by the API (SECRET_MASK instead). */
  smtp_pass: z.string().max(500).default(''),
  /** Where replies are read. Blank means replies to this inbox are not tracked. */
  imap_host: z.string().trim().max(200).default(''),
  imap_port: z.number().int().min(1).max(65535).default(993),
  daily_limit: z.number().int().min(0).max(500).default(30),
  active: z.boolean().default(true),
})
export type SendingInbox = z.infer<typeof SendingInboxSchema>

/** Links that leads click and hosts we post lead data to: https only, with a real host name. */
export const HttpsUrl = z
  .string()
  .trim()
  .refine(
    (v) => {
      try {
        const u = new URL(v)
        return u.protocol === 'https:' && u.hostname.length > 0
      } catch {
        return false
      }
    },
    { message: 'use a full https:// address' },
  )

export const SettingsSchema = z.object({
  autopilot_on: z.boolean().default(false),
  live_mode: z.boolean().default(false),

  owner_name: z.string().default('Theo Young'),
  owner_email: z.string().default('theo@proparchive.biz'),
  from_name: z.string().default('Theo at Prop Archive'),
  from_email: z.string().default('theo@proparchive.biz'),
  reply_to: z.string().default('theo@proparchive.biz'),
  /** CAN-SPAM footer. Required before live email goes out. */
  physical_address: z.string().default(''),

  site_url: HttpsUrl.default('https://proparchive.app'),
  demo_url: HttpsUrl.default('https://proparchive.app/demo'),
  beta_url: HttpsUrl.default('https://proparchive.app/?beta=1'),

  target_zips: z
    .array(z.string().regex(ZIP5, 'use a 5 digit zip'))
    .default(['19104', '19121', '19122', '19139', '19143', '19146', '19125']),
  min_props: z.number().int().min(0).default(3),
  max_props: z.number().int().min(0).default(20),
  min_icp_score: z.number().int().min(0).max(100).default(50),
  personas: z.array(PersonaSchema).default(['maya', 'ray', 'denise']),

  channels: ChannelTogglesSchema.default({
    email: true,
    mail: false,
    linkedin: true,
    instagram: false,
    call: true,
  }),
  daily_caps: DailyCapsSchema.default({
    email: 20,
    mail: 10,
    linkedin: 15,
    instagram: 10,
    call: 10,
  }),
  send_window: SendWindowSchema.default({
    tz: 'America/New_York',
    days: [1, 2, 3, 4, 5],
    start: '08:30',
    end: '17:00',
  }),
  max_new_leads_per_day: z.number().int().min(0).default(50),

  enrichment: EnrichmentSettingsSchema.default({
    providers: ['li_license', 'claude_research', 'hunter', 'apollo', 'pdl'],
    monthly_credit_cap: { hunter: 50, apollo: 100, pdl: 50, claude_research: 200 },
  }),

  sequence_by_persona: SequenceByPersonaSchema.default({
    maya: EMPTY_PERSONA_SEQUENCES,
    ray: EMPTY_PERSONA_SEQUENCES,
    denise: EMPTY_PERSONA_SEQUENCES,
  }),

  /** Warmed inboxes the sequence sends from, in rotation. Empty: the .env SMTP or Resend sender. */
  sending_inboxes: z.array(SendingInboxSchema).max(20).default([]),
  /** The accounts Theo works the LinkedIn, Instagram and Facebook steps from. Shown on each task. */
  my_linkedin_url: z.string().trim().max(300).default(''),
  my_instagram: z.string().trim().max(300).default(''),
  my_facebook: z.string().trim().max(300).default(''),
  /** The one sequence the autopilot puts new leads into. null: per-channel sequence_by_persona. */
  main_sequence_id: z.string().nullable().default(null),

  email_provider: z.enum(['smtp', 'resend']).default('smtp'),
  mail_provider: z.enum(['lob', 'print']).default('print'),

  notify_owner_on_reply: z.boolean().default(true),
  human_queue_webhook_url: z.union([z.literal(''), HttpsUrl]).default(''),
  /** Random on first boot (server/lib/settings.ts ensureWebhookSecret). */
  webhook_secret: z.string().default(''),
})

export type Settings = z.infer<typeof SettingsSchema>
export type SettingsKey = keyof Settings
export type SettingsPatch = Partial<{ [K in SettingsKey]: unknown }>

export const SETTINGS_KEYS = Object.keys(SettingsSchema.shape) as SettingsKey[]

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** Partial update schema: any subset of keys, each validated by its own schema when present. */
export const SettingsPatchSchema = SettingsSchema.partial().strict()

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep merge for plain objects. Arrays and primitives in `patch` replace the base value. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T
  }
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const current = out[k]
    out[k] = isPlainObject(current) && isPlainObject(v) ? deepMerge(current, v) : v
  }
  return out as T
}

/**
 * Merge a partial settings object onto a base (defaults when omitted) and validate the result.
 * Throws a ZodError when the merged object is invalid. Unknown keys are dropped.
 */
export function mergeSettings(partial: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const patch = isPlainObject(partial) ? partial : {}
  const known: Record<string, unknown> = {}
  for (const k of SETTINGS_KEYS) {
    if (k in patch) known[k] = patch[k]
  }
  return SettingsSchema.parse(deepMerge(base, known))
}

/** Channel keys in a stable order for UIs and loops. */
export const SETTINGS_CHANNELS = ChannelSchema.options
