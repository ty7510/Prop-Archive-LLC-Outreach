// Human queue API (linkedin, instagram, call, print mail). FILLED BY: the outreach builder.
import { Router } from 'express'
import { QueueActionBodySchema } from '../../shared/types.ts'
import { asyncHandler, parseOr400 } from '../lib/http.ts'
import { outreachDeps } from '../outreach/index.ts'
import {
  actOnQueueItem,
  listQueue,
  personalLinkedInNote,
  printPage,
  restoreQueueItem,
} from '../outreach/queue.ts'

export const queueRouter = Router()

// GET /api/queue -> Queue (ready_for_human messages grouped by channel)
queueRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listQueue(outreachDeps()))
  }),
)

// GET /api/queue/print?ids=a,b,c -> HTML page, one letter per page
queueRouter.get(
  '/print',
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : ''
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200)
    res.type('html').send(await printPage(outreachDeps(), ids))
  }),
)

// POST /api/queue/:messageId/done { note? } -> QueueActionResult
queueRouter.post(
  '/:messageId/done',
  asyncHandler(async (req, res) => {
    const body = parseOr400(QueueActionBodySchema, req.body ?? {})
    res.json(await actOnQueueItem(outreachDeps(), String(req.params.messageId), 'done', body.note))
  }),
)

// POST /api/queue/:messageId/skip { note? } -> QueueActionResult
queueRouter.post(
  '/:messageId/skip',
  asyncHandler(async (req, res) => {
    const body = parseOr400(QueueActionBodySchema, req.body ?? {})
    res.json(await actOnQueueItem(outreachDeps(), String(req.params.messageId), 'skip', body.note))
  }),
)

// POST /api/queue/:messageId/note -> LinkedInNote (written for this person once, then saved)
queueRouter.post(
  '/:messageId/note',
  asyncHandler(async (req, res) => {
    res.json(await personalLinkedInNote(outreachDeps(), String(req.params.messageId)))
  }),
)

// POST /api/queue/:messageId/restore -> QueueActionResult (a task Theo skipped comes back)
queueRouter.post(
  '/:messageId/restore',
  asyncHandler(async (req, res) => {
    res.json(await restoreQueueItem(outreachDeps(), String(req.params.messageId)))
  }),
)

export default queueRouter
