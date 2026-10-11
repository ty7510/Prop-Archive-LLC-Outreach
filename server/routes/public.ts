// Public routes used from emails: one-click unsubscribe and tracked redirects. No auth.
// FILLED BY: the outreach builder. Mounted at the app root (paths are /u/... and /r/...).
import { Router } from 'express'
import { asyncHandler } from '../lib/http.ts'
import { getSettings } from '../lib/settings.ts'
import { outreachDeps } from '../outreach/index.ts'
import { resolveRedirect, unsubscribeByToken, unsubscribePage } from '../outreach/tracking.ts'

export const publicRouter = Router()

const unsubscribe = asyncHandler(async (req, res) => {
  const deps = outreachDeps()
  const ok = await unsubscribeByToken(deps, String(req.params.token))
  const settings = await getSettings(deps.db)
  res
    .status(ok ? 200 : 404)
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(unsubscribePage(ok, settings.site_url))
})

// GET /u/:token -> small HTML page: "You will not get more email from us"
publicRouter.get('/u/:token', unsubscribe)
// POST /u/:token -> same, for List-Unsubscribe-Post one click
publicRouter.post('/u/:token', unsubscribe)

// GET /r/:token/:dest (dest = demo | beta | site) -> 302 with utm params, records a click event
publicRouter.get(
  '/r/:token/:dest',
  asyncHandler(async (req, res) => {
    const q = (k: string) =>
      typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined
    const target = await resolveRedirect(outreachDeps(), {
      token: String(req.params.token),
      dest: String(req.params.dest),
      channel: q('c'),
      sequence: q('s'),
    })
    if (!target) {
      res.status(404).type('text/plain').send('This link is not valid.')
      return
    }
    res.set('Cache-Control', 'no-store').redirect(302, target.url)
  }),
)

export default publicRouter
