// Human queue API (linkedin, instagram, call, print mail). STUB: 501 NOT_BUILT.
// FILLED BY: the outreach builder.
import { Router } from 'express'
import { notBuilt } from '../lib/http.ts'

export const queueRouter = Router()

const stub = () => {
  throw notBuilt()
}

// GET /api/queue -> Queue (ready_for_human messages grouped by channel)
queueRouter.get('/', stub)
// GET /api/queue/print?ids=a,b,c -> HTML page, one letter per page
queueRouter.get('/print', stub)
// POST /api/queue/:messageId/done { note? } -> QueueActionResult
queueRouter.post('/:messageId/done', stub)
// POST /api/queue/:messageId/skip { note? } -> QueueActionResult
queueRouter.post('/:messageId/skip', stub)

export default queueRouter
