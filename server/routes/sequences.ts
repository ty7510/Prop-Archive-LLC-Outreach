// Sequences API (spec section 6) plus the lead enroll / stop / outcome actions.
// FILLED BY: the outreach builder.
// leadOutreachRouter is mounted at /api/leads ahead of leadsRouter so these three paths are live
// without touching leads.ts.
import { Router } from 'express'
import {
  EnrollBodySchema,
  LinkedInProfileBodySchema,
  WrongProfileBodySchema,
  OutcomeBodySchema,
  SequenceCreateSchema,
  SequencePreviewBodySchema,
  SequenceUpdateSchema,
  StopBodySchema,
} from '../../shared/types.ts'
import { asyncHandler, parseOr400 } from '../lib/http.ts'
import { enrollLead, stopLead } from '../outreach/enroll.ts'
import { outreachDeps } from '../outreach/index.ts'
import { recordOutcome } from '../outreach/outcomes.ts'
import { actOnQueueItem, saveLinkedInProfile } from '../outreach/queue.ts'
import { rejectLinkedInProfile } from '../outreach/linkedinFinder.ts'
import { clearStepProfile } from '../outreach/todo.ts'
import {
  createSequence,
  deleteSequence,
  listSequences,
  previewSequence,
  testSend,
  updateSequence,
} from '../outreach/sequences.ts'

export const sequencesRouter = Router()

// GET /api/sequences -> Sequence[] each with steps and enrolled count
sequencesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listSequences(outreachDeps()))
  }),
)

// POST /api/sequences (SequenceCreate) -> Sequence with steps
sequencesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseOr400(SequenceCreateSchema, req.body)
    res.status(201).json(await createSequence(outreachDeps(), body))
  }),
)

// PUT /api/sequences/:id (SequenceUpdate, steps replace all) -> Sequence with steps
sequencesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseOr400(SequenceUpdateSchema, req.body)
    res.json(await updateSequence(outreachDeps(), String(req.params.id), body))
  }),
)

// DELETE /api/sequences/:id -> { ok: true }
sequencesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteSequence(outreachDeps(), String(req.params.id))
    res.json({ ok: true })
  }),
)

// POST /api/sequences/:id/preview { lead_id? } -> RenderedStep[]
sequencesRouter.post(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const body = parseOr400(SequencePreviewBodySchema, req.body ?? {})
    res.json(await previewSequence(outreachDeps(), String(req.params.id), body.lead_id))
  }),
)

// POST /api/sequences/:id/test-send -> { ok: true, to } (emails step 1 to settings.owner_email)
sequencesRouter.post(
  '/:id/test-send',
  asyncHandler(async (req, res) => {
    res.json(await testSend(outreachDeps(), String(req.params.id)))
  }),
)

/** Mounted at /api/leads before leadsRouter: enroll, stop and outcome for one lead. */
export const leadOutreachRouter = Router()

// POST /api/leads/:id/enroll { sequence_id } -> { ok: true }
leadOutreachRouter.post(
  '/:id/enroll',
  asyncHandler(async (req, res) => {
    const body = parseOr400(EnrollBodySchema, req.body)
    await enrollLead(outreachDeps(), String(req.params.id), body.sequence_id)
    res.json({ ok: true })
  }),
)

// POST /api/leads/:id/stop { reason? } -> { ok: true, stopped }
leadOutreachRouter.post(
  '/:id/stop',
  asyncHandler(async (req, res) => {
    const body = parseOr400(StopBodySchema, req.body ?? {})
    const stopped = await stopLead(outreachDeps(), String(req.params.id), body.reason ?? 'manual')
    res.json({ ok: true, stopped })
  }),
)

// POST /api/leads/:id/outcome { kind, channel?, note? } -> Lead
leadOutreachRouter.post(
  '/:id/outcome',
  asyncHandler(async (req, res) => {
    const body = parseOr400(OutcomeBodySchema, req.body)
    res.json(
      await recordOutcome(outreachDeps(), String(req.params.id), body.kind, 'manual', {
        channel: body.channel,
        note: body.note,
      }),
    )
  }),
)

// POST /api/leads/:id/linkedin { url } -> { linkedin_url, queued }
leadOutreachRouter.post(
  '/:id/linkedin',
  asyncHandler(async (req, res) => {
    const body = parseOr400(LinkedInProfileBodySchema, req.body)
    res.json(await saveLinkedInProfile(outreachDeps(), String(req.params.id), body.url))
  }),
)

// POST /api/leads/:id/linkedin/wrong { message_id? } -> { ok } : the profile is someone else
leadOutreachRouter.post(
  '/:id/linkedin/wrong',
  asyncHandler(async (req, res) => {
    const body = parseOr400(WrongProfileBodySchema, req.body ?? {})
    const deps = outreachDeps()
    await rejectLinkedInProfile(deps, String(req.params.id))
    // On the to-do list the note stays on the card without the profile, so Theo can find them
    // himself; anywhere else the task is skipped as before.
    if (body.message_id && !(await clearStepProfile(deps, body.message_id))) {
      await actOnQueueItem(deps, body.message_id, 'skip', 'wrong person')
    }
    res.json({ ok: true })
  }),
)

export default sequencesRouter
