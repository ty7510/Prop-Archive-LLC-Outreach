// Carto SQL API client for Philadelphia open data (no key). Owned by the sources builder.
// SQL is built from fixed text plus validated zips and integers only. Requests go out one at a
// time, 250 ms apart, with a 15 s timeout and 2 retries on network errors, 429 and 5xx.

export const CARTO_URL = 'https://phl.carto.com/api/v2/sql'
export const CARTO_GAP_MS = 250
export const CARTO_TIMEOUT_MS = 15_000
export const CARTO_RETRIES = 2

const ZIP5 = /^\d{5}$/

/** `'19104','19121'` for an IN list. Throws on anything that is not exactly five digits. */
export function zipList(zips: readonly string[]): string {
  if (zips.length === 0) throw new Error('zipList: at least one zip is required')
  const seen = new Set<string>()
  for (const z of zips) {
    if (typeof z !== 'string' || !ZIP5.test(z)) throw new Error(`zipList: bad zip ${String(z)}`)
    seen.add(z)
  }
  return [...seen].map((z) => `'${z}'`).join(',')
}

/** A non-negative integer for LIMIT, OFFSET and day windows. Throws otherwise. */
export function int(value: number, name = 'value'): number {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${name} must be a whole number between 0 and 1000000, got ${String(value)}`)
  }
  return value
}

/** OPA categories that are homes people rent out. Fixed text, never user input. */
export const RESIDENTIAL_CATEGORIES = [
  'SINGLE FAMILY',
  'MULTI FAMILY',
  'MIXED USE',
  'APARTMENTS  > 4 UNITS',
] as const

export function categoryList(): string {
  return RESIDENTIAL_CATEGORIES.map((c) => `'${c}'`).join(',')
}

/** The full GET url for one query. */
export function cartoUrl(sqlText: string, base = CARTO_URL): string {
  return `${base}?q=${encodeURIComponent(sqlText)}`
}

export interface CartoClientOptions {
  fetch?: typeof fetch
  gapMs?: number
  timeoutMs?: number
  retries?: number
  /** Injectable for tests: defaults to a real setTimeout wait. */
  sleep?: (ms: number) => Promise<void>
  baseUrl?: string
}

export interface CartoClient {
  query<T = Record<string, unknown>>(sqlText: string): Promise<T[]>
  /** How many HTTP requests this client has sent. */
  readonly requests: number
}

export class CartoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CartoError'
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * A polite client: serial requests with a gap between them, a timeout per request,
 * and retries on 429 / 5xx / network errors.
 */
export function createCartoClient(opts: CartoClientOptions = {}): CartoClient {
  const doFetch = opts.fetch ?? globalThis.fetch
  const gapMs = opts.gapMs ?? CARTO_GAP_MS
  const timeoutMs = opts.timeoutMs ?? CARTO_TIMEOUT_MS
  const retries = opts.retries ?? CARTO_RETRIES
  const sleep = opts.sleep ?? realSleep
  const base = opts.baseUrl ?? CARTO_URL

  let chain: Promise<unknown> = Promise.resolve()
  let lastAt = 0
  let requests = 0

  async function once<T>(sqlText: string): Promise<T[]> {
    const wait = lastAt + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastAt = Date.now()
    requests++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(cartoUrl(sqlText, base), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        const text = await safeText(res)
        throw new CartoError(`Carto answered ${res.status}: ${text.slice(0, 200)}`, res.status)
      }
      const body = (await res.json()) as { rows?: T[]; error?: unknown }
      if (!Array.isArray(body.rows)) {
        throw new CartoError(`Carto answered without rows: ${JSON.stringify(body).slice(0, 200)}`)
      }
      return body.rows
    } finally {
      clearTimeout(timer)
    }
  }

  async function withRetries<T>(sqlText: string): Promise<T[]> {
    let attempt = 0
    for (;;) {
      try {
        return await once<T>(sqlText)
      } catch (err) {
        const retryable =
          !(err instanceof CartoError) || err.status === 429 || (err.status ?? 500) >= 500
        if (!retryable || attempt >= retries) throw err
        attempt++
        await sleep(gapMs * 2 ** attempt)
      }
    }
  }

  return {
    query<T>(sqlText: string): Promise<T[]> {
      const next = chain.then(() => withRetries<T>(sqlText))
      chain = next.catch(() => undefined)
      return next
    },
    get requests() {
      return requests
    },
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
