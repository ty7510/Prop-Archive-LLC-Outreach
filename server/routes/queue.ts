// Human queue API (linkedin, instagram, call, print mail). FILLED BY: the outreach builder.
import { Router } from 'express'
import { EditStepBodySchema, QueueActionBodySchema } from '../../shared/types.ts'
import { asyncHandler, notFound, parseOr400 } from '../lib/http.ts'
import { outreachDeps } from '../outreach/index.ts'
import {
  actOnQueueItem,
  editStepText,
  labelsDownload,
  listQueue,
  personalLinkedInNote,
  printoutDoc,
  printPage,
  restoreQueueItem,
} from '../outreach/queue.ts'
import { fillTodo, listTodo } from '../outreach/todo.ts'

export const queueRouter = Router()

/** The message ids in ?ids=a,b,c (at most 200). */
function idsOf(raw: unknown): string[] {
  return (typeof raw === 'string' ? raw : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200)
}

// GET /api/queue -> Queue (ready_for_human messages grouped by channel)
queueRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listQueue(outreachDeps()))
  }),
)

// GET /api/queue/todo -> TodoList (people with every step, complete, replied)
queueRouter.get(
  '/todo',
  asyncHandler(async (_req, res) => {
    res.json(await listTodo(outreachDeps()))
  }),
)

// POST /api/queue/todo/fill -> { added } : put today's people on the list now, not next round
queueRouter.post(
  '/todo/fill',
  asyncHandler(async (_req, res) => {
    res.json(await fillTodo(outreachDeps(), { limit: 25 }))
  }),
)

// GET /api/queue/print?ids=a,b,c[&labels=1] -> HTML page: one printout (or postcard) per sheet,
// or with labels=1 the same people as envelope address labels
queueRouter.get(
  '/print',
  asyncHandler(async (req, res) => {
    const ids = idsOf(req.query.ids)
    const labels = req.query.labels === '1'
    res.type('html').send(await printPage(outreachDeps(), ids, { labels }))
  }),
)

// GET /api/queue/labels.pdf?ids=a,b,c -> PDF file: one 4x6 in portrait label per page, sent as a
// download named for the day (envelope-labels-2026-10-24.pdf) so it saves on a phone too
queueRouter.get(
  '/labels.pdf',
  asyncHandler(async (req, res) => {
    const file = await labelsDownload(outreachDeps(), idsOf(req.query.ids))
    if (!file) throw notFound('No envelope labels for these steps')
    res
      .type('application/pdf')
      .set('Content-Disposition', `attachment; filename="${file.filename}"`)
      .set('Cache-Control', 'private, no-store')
      .send(Buffer.from(file.pdf))
  }),
)

// GET /api/queue/:messageId/printout -> PrintoutDoc (proof and edit one printout)
queueRouter.get(
  '/:messageId/printout',
  asyncHandler(async (req, res) => {
    res.json(await printoutDoc(outreachDeps(), String(req.params.messageId)))
  }),
)

// PUT /api/queue/:messageId/text { subject?, body } -> EditStepResult (Theo's words on a waiting step)
queueRouter.put(
  '/:messageId/text',
  asyncHandler(async (req, res) => {
    const body = parseOr400(EditStepBodySchema, req.body ?? {})
    res.json(await editStepText(outreachDeps(), String(req.params.messageId), body))
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
