// Sequences API (spec section 6). STUB: 501 NOT_BUILT.
// FILLED BY: the outreach builder.
import { Router } from 'express'
import { notBuilt } from '../lib/http.ts'

export const sequencesRouter = Router()

const stub = () => {
  throw notBuilt()
}

// GET /api/sequences -> Sequence[] each with steps and enrolled count
sequencesRouter.get('/', stub)
// POST /api/sequences (SequenceCreate) -> Sequence with steps
sequencesRouter.post('/', stub)
// PUT /api/sequences/:id (SequenceUpdate, steps replace all) -> Sequence with steps
sequencesRouter.put('/:id', stub)
// DELETE /api/sequences/:id -> { ok: true }
sequencesRouter.delete('/:id', stub)
// POST /api/sequences/:id/preview { lead_id? } -> RenderedStep[]
sequencesRouter.post('/:id/preview', stub)
// POST /api/sequences/:id/test-send -> { ok: true } (sends step 1 to settings.owner_email)
sequencesRouter.post('/:id/test-send', stub)

export default sequencesRouter
