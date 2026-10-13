// Settings API: GET, PUT (partial), GET /providers. Fully working. Owned by the scaffold.
import { Router } from 'express'
import { appPasswordProblem, SendingInboxSchema, type SendingInbox } from '../../shared/settings.ts'
import type { GoogleMailStatus, ProvidersResponse } from '../../shared/types.ts'
import { getDb } from '../db/client.ts'
import { PROVIDER_ENV_KEYS, presentProviders } from '../env.ts'
import { logActivity } from '../lib/activity.ts'
import { asyncHandler } from '../lib/http.ts'
import { getSettings, updateSettings } from '../lib/settings.ts'
import { badRequest } from '../lib/http.ts'
import { restartDryRunEnrollments } from '../outreach/enroll.ts'
import {
  googleSignInFix,
  maskSettings,
  refreshGoogleAccount,
  restoreInboxSecrets,
  testInbox,
} from '../outreach/inboxes.ts'
import { outreachDeps } from '../outreach/index.ts'
import { sequenceReadiness } from '../outreach/readiness.ts'

export const settingsRouter = Router()

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(maskSettings(await getSettings(getDb())))
  }),
)

settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const before = await getSettings(getDb())
    const body: unknown = req.body
    const patch =
      body && typeof body === 'object' && 'sending_inboxes' in body
        ? {
            ...body,
            sending_inboxes: restoreInboxSecrets(
              before.sending_inboxes,
              (body as { sending_inboxes: unknown }).sending_inboxes,
            ),
          }
        : body
    const next = await updateSettings(patch, getDb())
    // Dry run -> Live: sequences that only ever dry-ran start over, so step 1 really goes out.
    if (!before.live_mode && next.live_mode) await restartDryRunEnrollments(outreachDeps())
    await logInboxChanges(before.sending_inboxes, next.sending_inboxes)
    res.json(maskSettings(next))
  }),
)

/** One Activity line per inbox whose password changed: what happened, never the password itself. */
async function logInboxChanges(
  before: readonly SendingInbox[],
  after: readonly SendingInbox[],
): Promise<void> {
  const prev = new Map(before.map((i) => [i.id, i]))
  for (const inbox of after) {
    const was = prev.get(inbox.id)?.smtp_pass ?? ''
    if (was === inbox.smtp_pass) continue
    const password = !inbox.smtp_pass ? 'cleared' : was ? 'replaced' : 'added'
    const shape = appPasswordProblem(inbox.smtp_host, inbox.smtp_pass)
    await logActivity(
      shape ? 'warn' : 'info',
      'inbox_saved',
      {
        inbox: inbox.email,
        password,
        length: inbox.smtp_pass.length,
        ...(shape ? { problem: shape } : {}),
      },
      null,
      getDb(),
    )
  }
}

/** Log in to one inbox (as typed in the form, or as saved when the password is masked). */
settingsRouter.post(
  '/inboxes/test',
  asyncHandler(async (req, res) => {
    const before = await getSettings(getDb())
    const [restored] = restoreInboxSecrets(before.sending_inboxes, [req.body]) as unknown[]
    const parsed = SendingInboxSchema.safeParse(restored)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Check the inbox fields', 'VALIDATION')
    }
    const result = await testInbox(outreachDeps(), parsed.data)
    await logActivity(
      result.smtp.ok ? 'info' : 'warn',
      'inbox_test',
      { inbox: parsed.data.email, smtp: result.smtp, imap: result.imap },
      null,
      getDb(),
    )
    res.json(result)
  }),
)

/** Which Google account Sign in with Google (Replit's Gmail connector) is signed in as, if any. */
settingsRouter.get(
  '/google-mail',
  asyncHandler(async (req, res) => {
    const acct = await refreshGoogleAccount(outreachDeps(), { fresh: req.query.fresh === '1' })
    const body: GoogleMailStatus = acct.ok
      ? { state: 'connected', email: acct.email, detail: `Signed in with Google as ${acct.email}` }
      : {
          state: acct.reason,
          email: null,
          detail:
            acct.reason === 'not_connected'
              ? googleSignInFix('your inbox address', acct)
              : acct.detail,
        }
    res.json(body)
  }),
)

/** What the sequence still needs before it can run, with the fix for each. */
settingsRouter.get(
  '/readiness',
  asyncHandler(async (_req, res) => {
    res.json(await sequenceReadiness(outreachDeps()))
  }),
)

settingsRouter.get('/providers', (_req, res) => {
  const present = presentProviders()
  const body: ProvidersResponse = { ...present, env_keys: PROVIDER_ENV_KEYS }
  res.json(body)
})

export default settingsRouter
