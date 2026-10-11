// Settings API: GET, PUT (partial), GET /providers. Fully working. Owned by the scaffold.
import { Router } from 'express'
import type { ProvidersResponse } from '../../shared/types.ts'
import { getDb } from '../db/client.ts'
import { PROVIDER_ENV_KEYS, presentProviders } from '../env.ts'
import { asyncHandler } from '../lib/http.ts'
import { getSettings, updateSettings } from '../lib/settings.ts'

export const settingsRouter = Router()

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getSettings(getDb()))
  }),
)

settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await updateSettings(req.body, getDb()))
  }),
)

settingsRouter.get('/providers', (_req, res) => {
  const present = presentProviders()
  const body: ProvidersResponse = { ...present, env_keys: PROVIDER_ENV_KEYS }
  res.json(body)
})

export default settingsRouter
