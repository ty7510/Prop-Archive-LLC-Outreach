// Enrichment API. enrichRouter is mounted at /api/leads (POST /api/leads/enrich);
// enrichUsageRouter at /api/enrich (GET /api/enrich/usage). Owned by the enrich builder.
import { Router } from 'express'
import { ENRICH_PROVIDER_IDS, type EnrichProviderId } from '../../shared/settings.ts'
import { EnrichBodySchema, type ProvidersPresent } from '../../shared/types.ts'
import { requireModule } from '../contracts.ts'
import { PROVIDER_ENV_KEYS, presentProviders } from '../env.ts'
import { usageReport } from '../enrich/usage.ts'
import { getDb } from '../db/client.ts'
import { asyncHandler, badRequest, conflict, parseOr400 } from '../lib/http.ts'
import { withJobLock } from '../lib/locks.ts'
import { getSettings } from '../lib/settings.ts'

export const enrichRouter = Router()

/** How many leads "Enrich all not enriched" takes in one go. */
export const ENRICH_ALL_LIMIT = 500

// POST /api/leads/enrich { ids?: string[], all?: boolean } -> EnrichResult
enrichRouter.post(
  '/enrich',
  asyncHandler(async (req, res) => {
    const body = parseOr400(EnrichBodySchema, req.body)
    if (!body.ids && !body.all) {
      throw badRequest('Send ids (a list of lead ids) or all: true', 'VALIDATION')
    }
    const enrich = requireModule('enrich')
    // Same lock as the autopilot's enrich job, so the two never work the same leads at once.
    const run = await withJobLock(
      'enrich',
      async () => {
        const ids = new Set(body.ids ?? [])
        if (body.all) for (const id of await enrich.pickBatch(ENRICH_ALL_LIMIT)) ids.add(id)
        return enrich.enrichLeads([...ids])
      },
      getDb(),
    )
    if (run.skipped) {
      throw conflict(
        'Already enriching (the autopilot is on it). Try again in a minute.',
        'RUNNING',
      )
    }
    res.json(run.result)
  }),
)

export const enrichUsageRouter = Router()

/** Which env key group turns each provider on. li_license is public data and needs none. */
const PROVIDER_KEY_GROUP: Record<EnrichProviderId, keyof ProvidersPresent | null> = {
  li_license: null,
  claude_research: 'anthropic',
  hunter: 'hunter',
  apollo: 'apollo',
  pdl: 'pdl',
}

// GET /api/enrich/usage -> { month, tz, providers: [{ provider, used, calls, cap, configured, env_keys }] }
enrichUsageRouter.get(
  '/usage',
  asyncHandler(async (_req, res) => {
    const settings = await getSettings()
    const report = await usageReport(settings)
    const present = presentProviders()
    const enabled = new Set(settings.enrichment.providers)
    res.json({
      month: report.month,
      tz: report.tz,
      providers: ENRICH_PROVIDER_IDS.map((id) => {
        const row = report.providers.find((p) => p.provider === id)
        const group = PROVIDER_KEY_GROUP[id]
        return {
          provider: id,
          used: row?.used ?? 0,
          calls: row?.calls ?? 0,
          cap: row?.cap ?? null,
          enabled: enabled.has(id),
          configured: group ? present[group] : true,
          env_keys: group ? PROVIDER_ENV_KEYS[group] : [],
        }
      }),
    })
  }),
)

export default enrichRouter
