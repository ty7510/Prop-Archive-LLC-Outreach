// Settings API: GET, PUT (partial), GET /providers. Fully working. Owned by the scaffold.
import { Router } from 'express'
import { SendingInboxSchema } from '../../shared/settings.ts'
import type { ProvidersResponse } from '../../shared/types.ts'
import { getDb } from '../db/client.ts'
import { PROVIDER_ENV_KEYS, presentProviders } from '../env.ts'
import { asyncHandler } from '../lib/http.ts'
import { getSettings, updateSettings } from '../lib/settings.ts'
import { badRequest } from '../lib/http.ts'
import { restartDryRunEnrollments } from '../outreach/enroll.ts'
import { maskSettings, restoreInboxSecrets, testInbox } from '../outreach/inboxes.ts'
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
    res.json(maskSettings(next))
  }),
)

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
    res.json(await testInbox(outreachDeps(), parsed.data))
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
