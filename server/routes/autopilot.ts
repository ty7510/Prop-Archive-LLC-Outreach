// Autopilot API (spec section 6). Owned by the autopilot builder.
// Every route goes through requireModule('autopilot'): 501 NOT_BUILT until server/autopilot/index.ts
// is imported (server/index.ts does that; tests import it or register a fake).
import { Router } from 'express'
import type { AutopilotStatus } from '../../shared/types.ts'
import { requireModule, type AutopilotModule } from '../contracts.ts'
import { asyncHandler } from '../lib/http.ts'
import { updateSettings } from '../lib/settings.ts'
import type { TickSummary } from '../autopilot/tick.ts'

export const autopilotRouter = Router()

/** The real module returns a per-job summary; the contract only promises tick(): void. */
function hasRunTick(
  m: AutopilotModule,
): m is AutopilotModule & { runTick(): Promise<TickSummary> } {
  return typeof (m as { runTick?: unknown }).runTick === 'function'
}

// GET /api/autopilot -> AutopilotStatus
autopilotRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await requireModule('autopilot').status())
  }),
)

// POST /api/autopilot/start -> AutopilotStatus (settings.autopilot_on = true, interval running)
autopilotRouter.post(
  '/start',
  asyncHandler(async (_req, res) => {
    const autopilot = requireModule('autopilot')
    await updateSettings({ autopilot_on: true })
    autopilot.start()
    res.json(await autopilot.status())
  }),
)

// POST /api/autopilot/stop -> AutopilotStatus (settings.autopilot_on = false, interval stopped)
autopilotRouter.post(
  '/stop',
  asyncHandler(async (_req, res) => {
    const autopilot = requireModule('autopilot')
    await updateSettings({ autopilot_on: false })
    autopilot.stop()
    res.json(await autopilot.status())
  }),
)

// POST /api/autopilot/tick -> AutopilotStatus & { tick: TickSummary | null } (runs one tick now)
autopilotRouter.post(
  '/tick',
  asyncHandler(async (_req, res) => {
    const autopilot = requireModule('autopilot')
    let tick: TickSummary | null = null
    if (hasRunTick(autopilot)) tick = await autopilot.runTick()
    else await autopilot.tick()
    const status: AutopilotStatus & { tick: TickSummary | null } = {
      ...(await autopilot.status()),
      tick,
    }
    res.json(status)
  }),
)

export default autopilotRouter
