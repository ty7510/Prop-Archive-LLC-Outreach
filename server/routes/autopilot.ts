// Autopilot API (spec section 6). STUB: 501 NOT_BUILT.
// FILLED BY: the autopilot builder.
import { Router } from 'express'
import { notBuilt } from '../lib/http.ts'

export const autopilotRouter = Router()

const stub = () => {
  throw notBuilt()
}

// GET /api/autopilot -> AutopilotStatus
autopilotRouter.get('/', stub)
// POST /api/autopilot/start -> AutopilotStatus
autopilotRouter.post('/start', stub)
// POST /api/autopilot/stop -> AutopilotStatus
autopilotRouter.post('/stop', stub)
// POST /api/autopilot/tick -> AutopilotStatus (runs one tick now)
autopilotRouter.post('/tick', stub)

export default autopilotRouter
