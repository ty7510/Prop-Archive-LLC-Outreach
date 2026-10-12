// Zod-parsed process.env with defaults. Owned by the scaffold.
// Import `env` for values. Never send key values to the client; use presentProviders().
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ProvidersPresent } from '../shared/types.ts'

const optional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
)

const optionalPort = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.coerce.number().int().min(1).max(65535).optional(),
)

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().min(1).max(65535).default(5300),
  ),
  APP_PASSWORD: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
  DATABASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().default(''),
  ),

  ANTHROPIC_API_KEY: optional,
  /** Needed when the key is organization-level, not scoped to a workspace. */
  ANTHROPIC_WORKSPACE_ID: optional,

  SMTP_HOST: optional,
  SMTP_PORT: optionalPort,
  SMTP_USER: optional,
  SMTP_PASS: optional,

  RESEND_API_KEY: optional,

  IMAP_HOST: optional,
  IMAP_PORT: optionalPort,
  IMAP_USER: optional,
  IMAP_PASS: optional,

  LOB_API_KEY: optional,
  HUNTER_API_KEY: optional,
  APOLLO_API_KEY: optional,
  PDL_API_KEY: optional,
})

export type Env = z.infer<typeof EnvSchema>

/** Parse an env-like object. Exported so tests can build an Env without touching process.env. */
/** Secret names Theo has used for the workspace (an ID or a workspace-scoped key). */
const WORKSPACE_SECRETS = ['ANTHROPIC_WORKSPACE_ID', 'Claude_Workspace_ID', 'WORK_SPACE_CLAUDE']

export function parseEnv(source: Record<string, string | undefined>): Env {
  // Accept the names Theo's Replit secrets use, so the same secrets work here.
  const pick = (...names: string[]) => names.map((n) => source[n]?.trim()).find(Boolean)
  // A workspace secret can hold either the workspace ID (wrkspc_...) or a new key made inside a
  // workspace (sk-ant-...). An ID becomes the anthropic-workspace-id header; a workspace key is
  // used as the key, ahead of an organization key that Anthropic refuses without a workspace.
  const workspaceValues = WORKSPACE_SECRETS.map((n) => source[n]?.trim()).filter((v): v is string =>
    Boolean(v),
  )
  const workspaceKey = workspaceValues.find((v) => v.startsWith('sk-ant-'))
  const workspaceId = workspaceValues.find((v) => !v.startsWith('sk-ant-'))
  const parsed = EnvSchema.parse({
    ...source,
    ANTHROPIC_API_KEY:
      pick('ANTHROPIC_API_KEY') ?? workspaceKey ?? pick('Claude_API', 'CLAUDE_API_KEY'),
    // The workspace header only goes with an organization key, never with a workspace key.
    ANTHROPIC_WORKSPACE_ID: workspaceKey && !pick('ANTHROPIC_API_KEY') ? undefined : workspaceId,
  })
  if (!parsed.SESSION_SECRET) {
    // A fresh secret per boot means sessions reset on restart. Fine for one user; set
    // SESSION_SECRET in Replit Secrets (or .env locally) to keep logins.
    parsed.SESSION_SECRET = randomBytes(32).toString('hex')
  }
  return parsed
}

export const env: Env = parseEnv(process.env)

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'

/** Which provider key groups are present. Booleans only, never values. */
export function presentProviders(e: Env = env): ProvidersPresent {
  return {
    anthropic: Boolean(e.ANTHROPIC_API_KEY),
    smtp: Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS),
    resend: Boolean(e.RESEND_API_KEY),
    imap: Boolean(e.IMAP_HOST && e.IMAP_USER && e.IMAP_PASS),
    lob: Boolean(e.LOB_API_KEY),
    hunter: Boolean(e.HUNTER_API_KEY),
    apollo: Boolean(e.APOLLO_API_KEY),
    pdl: Boolean(e.PDL_API_KEY),
  }
}

/**
 * The secret a user has to add for a provider group, named the way Theo adds it in Replit
 * Secrets. CLAUDE_API_KEY is the name he uses (ANTHROPIC_API_KEY and Claude_API work too).
 */
export const PROVIDER_ENV_KEYS: Record<keyof ProvidersPresent, string[]> = {
  anthropic: ['CLAUDE_API_KEY'],
  smtp: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'],
  resend: ['RESEND_API_KEY'],
  imap: ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS'],
  lob: ['LOB_API_KEY'],
  hunter: ['HUNTER_API_KEY'],
  apollo: ['APOLLO_API_KEY'],
  pdl: ['PDL_API_KEY'],
}
