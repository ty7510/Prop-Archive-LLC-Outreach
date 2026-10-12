// Leads API (spec section 6). Filled by the sources builder: list, get, patch, import, discover.
// POST /:id/enroll, /:id/stop and /:id/outcome live in routes/sequences.ts (leadOutreachRouter),
// mounted at /api/leads ahead of this router, so they are not repeated here.
import { Router, type NextFunction, type Request, type Response } from 'express'
import { and, desc, eq, getTableColumns, inArray, sql, or, type SQL } from 'drizzle-orm'
import multer from 'multer'
import { z } from 'zod'
import {
  DiscoverBodySchema,
  LEAD_STATUSES,
  LeadPatchSchema,
  LeadPersonaSchema,
  type EventKind,
  type LeadStatus,
  type Paged,
} from '../../shared/types.ts'
import { modules, requireModule } from '../contracts.ts'
import { getDb } from '../db/client.ts'
import {
  enrollments,
  events,
  leads,
  messages,
  properties,
  sequences,
  type Lead,
} from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { asyncHandler, badRequest, conflict, notFound, parseOr400 } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { withJobLock } from '../lib/locks.ts'
import { nowIso } from '../lib/time.ts'
import { displayNameFor } from '../sources/merge.ts'
import { neighborhoodForLead } from '../sources/neighborhoods.ts'

export const leadsRouter = Router()

export type LeadRow = Lead & { display_name: string; neighborhood: string }

export function toLeadRow(lead: Lead): LeadRow {
  return { ...lead, display_name: displayNameFor(lead), neighborhood: neighborhoodForLead(lead) }
}

const statusList = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined
    const parts = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const bad = parts.filter((p) => !(LEAD_STATUSES as readonly string[]).includes(p))
    if (bad.length > 0) {
      ctx.addIssue({ code: 'custom', message: `unknown status ${bad.join(', ')}` })
      return z.NEVER
    }
    return parts as LeadStatus[]
  })

/** Same as shared LeadsQuerySchema but `status` may be a comma separated list for the filter chips. */
export const LeadsListQuerySchema = z.object({
  status: statusList,
  persona: LeadPersonaSchema.optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

// GET /api/leads?status=&persona=&q=&page=&limit=  -> Paged<LeadRow>
leadsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb()
    const query = parseOr400(LeadsListQuerySchema, req.query, 'query')
    const where: SQL[] = []
    if (query.status && query.status.length > 0) where.push(inArray(leads.status, query.status))
    if (query.persona) where.push(eq(leads.persona, query.persona))
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, ' ')}%`
      const match = or(
        sql`lower(${leads.full_name}) like lower(${needle})`,
        sql`lower(${leads.company}) like lower(${needle})`,
        sql`lower(${leads.email}) like lower(${needle})`,
        sql`lower(${leads.mailing_street}) like lower(${needle})`,
        sql`lower(${leads.mailing_zip}) like lower(${needle})`,
        sql`lower(${leads.phone}) like lower(${needle})`,
      )
      if (match) where.push(match)
    }
    const filter = where.length > 0 ? and(...where) : undefined

    const totalRows = await db.select({ id: leads.id }).from(leads).where(filter)
    const items = await db
      .select()
      .from(leads)
      .where(filter)
      .orderBy(desc(leads.icp_score), desc(leads.updated_at))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit)

    const body: Paged<LeadRow> = {
      items: items.map(toLeadRow),
      page: query.page,
      limit: query.limit,
      total: totalRows.length,
    }
    res.json(body)
  }),
)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
})

/** multer errors become plain 400s instead of a 500. */
function uploadCsv(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is over 10 MB'
          : `Upload problem: ${err.message}`
      return next(badRequest(message, 'UPLOAD'))
    }
    next(err)
  })
}

// POST /api/leads/import (multipart, field "file") -> ImportResult
leadsRouter.post(
  '/import',
  uploadCsv,
  asyncHandler(async (req, res) => {
    const file = req.file
    if (!file) throw badRequest('Choose a CSV file first (form field "file")', 'NO_FILE')
    const sources = requireModule('sources')
    const result = await sources.importCsv(file.buffer, file.originalname || 'upload.csv')
    res.json(result)
  }),
)

// POST /api/leads/discover { zips?, limit? } -> DiscoverResult
leadsRouter.post(
  '/discover',
  asyncHandler(async (req, res) => {
    const body = parseOr400(DiscoverBodySchema, req.body ?? {})
    const sources = requireModule('sources')
    const run = await withJobLock('discover', () => sources.discover(body), getDb())
    if (run.skipped) {
      throw conflict('Already finding leads. Try again in a minute.', 'RUNNING')
    }
    res.json(run.result)
  }),
)

async function loadLead(id: string): Promise<Lead> {
  const [lead] = await getDb().select().from(leads).where(eq(leads.id, id)).limit(1)
  if (!lead) throw notFound('Lead not found', 'LEAD_NOT_FOUND')
  return lead
}

// GET /api/leads/:id -> lead with properties, enrollments, messages, events
leadsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = getDb()
    const id = String(req.params.id)
    const lead = await loadLead(id)
    const props = await db
      .select()
      .from(properties)
      .where(eq(properties.lead_id, id))
      .orderBy(properties.address)
    const enrolls = await db
      .select({
        ...getTableColumns(enrollments),
        sequence_name: sequences.name,
        channel: sequences.channel,
      })
      .from(enrollments)
      .leftJoin(sequences, eq(enrollments.sequence_id, sequences.id))
      .where(eq(enrollments.lead_id, id))
      .orderBy(desc(enrollments.started_at))
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.lead_id, id))
      .orderBy(desc(messages.created_at))
    const evs = await db
      .select()
      .from(events)
      .where(eq(events.lead_id, id))
      .orderBy(desc(events.at))
    res.json({
      ...toLeadRow(lead),
      properties: props,
      enrollments: enrolls,
      messages: msgs,
      events: evs,
    })
  }),
)

async function addEvent(leadId: string, kind: EventKind, detail?: unknown): Promise<void> {
  await getDb()
    .insert(events)
    .values({ id: newId(), lead_id: leadId, kind, detail: detail ?? null, at: nowIso() })
}

/** Stop every active sequence for a lead: through the outreach module when built, else directly. */
async function stopOutreach(leadId: string, reason: string): Promise<void> {
  if (modules.outreach) {
    await modules.outreach.stopLead(leadId, reason)
    return
  }
  const db = getDb()
  await db
    .update(enrollments)
    .set({ status: 'stopped_manual', ended_at: nowIso() })
    .where(and(eq(enrollments.lead_id, leadId), inArray(enrollments.status, ['active', 'paused'])))
  await db
    .update(messages)
    .set({ status: 'skipped', error: reason })
    .where(
      and(
        eq(messages.lead_id, leadId),
        eq(messages.direction, 'out'),
        inArray(messages.status, ['queued', 'ready_for_human']),
      ),
    )
}

// PATCH /api/leads/:id (LeadPatch) -> LeadRow
leadsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = getDb()
    const id = String(req.params.id)
    const lead = await loadLead(id)
    const patch = parseOr400(LeadPatchSchema, req.body)
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to change', 'EMPTY_PATCH')

    const set: Partial<Lead> = { updated_at: nowIso() }
    if (patch.notes !== undefined) set.notes = patch.notes
    if (patch.tags !== undefined) set.tags = [...new Set(patch.tags)]
    if (patch.do_not_contact !== undefined) set.do_not_contact = patch.do_not_contact
    if (patch.status !== undefined) set.status = patch.status
    await db.update(leads).set(set).where(eq(leads.id, id))

    if (patch.do_not_contact === true && !lead.do_not_contact) {
      await addEvent(id, 'do_not_contact', { by: 'hand' })
      await stopOutreach(id, 'do_not_contact')
      await logActivity('info', 'lead.do_not_contact', { lead: displayNameFor(lead) }, id, db)
    }
    if (patch.status !== undefined && patch.status !== lead.status) {
      await addEvent(id, 'status_change', { from: lead.status, to: patch.status, by: 'hand' })
      // A final answer by hand ends every sequence and clears Theo's queue, like the outcome route.
      if (patch.status !== 'new') await stopOutreach(id, patch.status)
    }
    if (patch.notes !== undefined && patch.notes !== (lead.notes ?? '')) {
      await addEvent(id, 'note', { length: patch.notes.length })
    }
    res.json(toLeadRow(await loadLead(id)))
  }),
)

export default leadsRouter
