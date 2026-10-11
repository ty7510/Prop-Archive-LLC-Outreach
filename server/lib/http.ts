// Express helpers: async wrapper, typed errors, auth middleware, body parsing. Owned by the scaffold.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ZodError, type ZodType } from 'zod'
import { ModuleNotRegisteredError } from '../contracts.ts'
import { env } from '../env.ts'

declare global {
  // cookie-session stores whatever we put on req.session; declare the one flag we use.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace CookieSessionInterfaces {
    interface CookieSessionObject {
      loggedIn?: boolean
      loggedInAt?: string
    }
  }
}

/** An error that maps straight to an HTTP response: { error, code? } with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new HttpError(400, message, code)
export const unauthorized = (message = 'Please log in', code = 'UNAUTHORIZED') =>
  new HttpError(401, message, code)
export const forbidden = (message = 'Not allowed', code = 'FORBIDDEN') =>
  new HttpError(403, message, code)
export const notFound = (message = 'Not found', code = 'NOT_FOUND') =>
  new HttpError(404, message, code)
export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, message, code)
export const notBuilt = () => new HttpError(501, 'not built yet', 'NOT_BUILT')

/** Send `{ error, code? }` with a status. */
export function apiError(res: Response, status: number, error: string, code?: string): void {
  res.status(status).json(code ? { error, code } : { error })
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown

/** Wrap an async route so thrown errors reach the error handler. */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/** First zod issue as one readable line: "channels.email: expected boolean". */
export function zodMessage(err: ZodError): string {
  const first = err.issues[0]
  if (!first) return 'Invalid input'
  const path = first.path.map(String).join('.')
  return path ? `${path}: ${first.message}` : first.message
}

/** Parse with a zod schema or throw a 400 HttpError. */
export function parseOr400<T>(schema: ZodType<T>, value: unknown, what = 'body'): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw badRequest(`Invalid ${what}: ${zodMessage(result.error)}`, 'VALIDATION')
  }
  return result.data
}

export function isLoggedIn(req: Request): boolean {
  return Boolean(req.session?.loggedIn)
}

/** Reject with 401 unless the cookie session says logged in. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (isLoggedIn(req)) return next()
  next(unauthorized())
}

/**
 * Constant-time compare of the submitted password with APP_PASSWORD. False when APP_PASSWORD is unset.
 * Both sides are hashed first so the comparison never leaks the password length.
 */
export function passwordMatches(candidate: string, expected: string = env.APP_PASSWORD): boolean {
  if (!expected || !candidate) return false
  const a = createHash('sha256').update(candidate).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export const tooManyTries = (message = 'Too many tries. Wait 15 minutes and try again.') =>
  new HttpError(429, message, 'TOO_MANY_TRIES')

/**
 * Brute-force guard for the one password login: at most `max` failed tries per key (the client
 * IP) inside a sliding window. In memory on purpose: one process, one owner, resets on restart.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>()
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length) this.failures.set(key, list)
    else this.failures.delete(key)
    return list
  }

  /** True while the key is still allowed to try. */
  allowed(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length < this.max
  }

  recordFailure(key: string, now = Date.now()): void {
    const list = this.recent(key, now)
    list.push(now)
    this.failures.set(key, list)
  }

  reset(key: string): void {
    this.failures.delete(key)
  }

  resetAll(): void {
    this.failures.clear()
  }
}

export const loginLimiter = new LoginLimiter()

/** The key the login limiter counts by: the client IP (trust proxy is on, so Replit's header counts). */
export function clientKey(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/** Last middleware in the chain: turns thrown errors into { error, code } JSON. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // Express needs the 4-arg signature to treat this as an error handler.
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    apiError(res, err.status, err.message, err.code)
    return
  }
  if (err instanceof ZodError) {
    apiError(res, 400, `Invalid input: ${zodMessage(err)}`, 'VALIDATION')
    return
  }
  if (err instanceof ModuleNotRegisteredError) {
    apiError(res, 501, 'not built yet', 'NOT_BUILT')
    return
  }
  const anyErr = err as { type?: string; status?: number; message?: string }
  if (anyErr?.type === 'entity.parse.failed') {
    apiError(res, 400, 'Body is not valid JSON', 'BAD_JSON')
    return
  }
  if (anyErr?.type === 'entity.too.large') {
    apiError(res, 413, 'Body too large', 'TOO_LARGE')
    return
  }
  if (env.NODE_ENV !== 'test') console.error('[http] unhandled error', err)
  apiError(res, 500, 'Something went wrong on the server', 'INTERNAL')
}
