// GET /api/activity?limit= -> ActivityEntry[] newest first. Working now via lib/activity.ts.
// OWNED BY: the autopilot builder (may extend). Owned by the scaffold until then.
import { Router } from 'express'
import { ActivityQuerySchema } from '../../shared/types.ts'
import { getDb } from '../db/client.ts'
import { listActivity } from '../lib/activity.ts'
import { asyncHandler, parseOr400 } from '../lib/http.ts'

export const activityRouter = Router()

activityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { limit } = parseOr400(ActivityQuerySchema, req.query, 'query')
    res.json(await listActivity(limit, getDb()))
  }),
)

export default activityRouter
