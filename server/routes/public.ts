// Public routes used from emails: one-click unsubscribe and tracked redirects. No auth.
// FILLED BY: the outreach builder. Mounted at the app root (paths are /u/... and /r/...).
// GET /u/:token only shows a button (link scanners fetch every link in a mail and must not
// unsubscribe anyone); the POST, from that button or from List-Unsubscribe-Post, does the work.
import { Router, type NextFunction, type Request, type Response } from 'express'
import { LoginLimiter, asyncHandler, clientKey } from '../lib/http.ts'
import { getSettings } from '../lib/settings.ts'
import { outreachDeps } from '../outreach/index.ts'
import {
  resolveRedirect,
  unsubscribeByToken,
  unsubscribePage,
  unsubscribeState,
} from '../outreach/tracking.ts'

export const publicRouter = Router()

/** Hits per client IP per minute on the public routes. In memory, one process. */
export const PUBLIC_HITS_PER_MINUTE = 120
export const publicLimiter = new LoginLimiter(PUBLIC_HITS_PER_MINUTE, 60_000)

function limitHits(req: Request, res: Response, next: NextFunction): void {
  const key = clientKey(req)
  if (!publicLimiter.allowed(key)) {
    res
      .status(429)
      .set('Retry-After', '60')
      .type('text/plain')
      .send('Too many requests. Try again in a minute.')
    return
  }
  publicLimiter.recordFailure(key)
  next()
}

const sendPage = (res: Response, status: number, html: string) =>
  res.status(status).set('Cache-Control', 'no-store').type('html').send(html)

// GET /u/:token -> a page with one button "Stop emails to me" (or "You are unsubscribed" when done)
publicRouter.get(
  '/u/:token',
  limitHits,
  asyncHandler(async (req, res) => {
    const deps = outreachDeps()
    const state = await unsubscribeState(deps, String(req.params.token))
    const settings = await getSettings(deps.db)
    if (state === 'unknown') {
      sendPage(res, 404, unsubscribePage('not_found', settings.site_url))
      return
    }
    sendPage(res, 200, unsubscribePage(state === 'done' ? 'done' : 'confirm', settings.site_url))
  }),
)

// POST /u/:token -> unsubscribes (the button above, or List-Unsubscribe-Post one click)
publicRouter.post(
  '/u/:token',
  limitHits,
  asyncHandler(async (req, res) => {
    const deps = outreachDeps()
    const ok = await unsubscribeByToken(deps, String(req.params.token))
    const settings = await getSettings(deps.db)
    sendPage(res, ok ? 200 : 404, unsubscribePage(ok ? 'done' : 'not_found', settings.site_url))
  }),
)

// GET /r/:token/:dest (dest = demo | beta | site) -> 302 with utm params, records a click event
publicRouter.get(
  '/r/:token/:dest',
  limitHits,
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
