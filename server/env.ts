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
    z.string().default('file:./data/outreach.db'),
  ),
  /** Only for a hosted libsql DATABASE_URL (Turso). */
  DATABASE_AUTH_TOKEN: optional,

  ANTHROPIC_API_KEY: optional,

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
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.parse(source)
  if (!parsed.SESSION_SECRET) {
    // A fresh secret per boot means sessions reset on restart. Fine for one user; set it in .env to keep logins.
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

/** The .env key a user has to add for a provider group. For "add KEY in Settings" messages. */
export const PROVIDER_ENV_KEYS: Record<keyof ProvidersPresent, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  smtp: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'],
  resend: ['RESEND_API_KEY'],
  imap: ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS'],
  lob: ['LOB_API_KEY'],
  hunter: ['HUNTER_API_KEY'],
  apollo: ['APOLLO_API_KEY'],
  pdl: ['PDL_API_KEY'],
}
