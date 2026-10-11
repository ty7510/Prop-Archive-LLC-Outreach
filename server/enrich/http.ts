// fetch with a timeout and retries on 429/5xx/network errors. Shared by the HTTP providers.
export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_RETRIES = 2

export interface HttpDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  retries?: number
  /** Base backoff in ms; retry n waits base * 2^(n-1). Tests set 0. */
  backoffMs?: number
}

export interface JsonResponse<T = unknown> {
  status: number
  data: T | null
  text: string
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * GET/POST and parse JSON. Retries 429, 5xx, timeouts and network errors with backoff.
 * Non-retryable 4xx answers are returned, not thrown, so the caller can decide (a 404 from
 * PDL means "no match", not "broken").
 */
export async function fetchJson<T = unknown>(
  provider: string,
  url: string,
  init: RequestInit = {},
  deps: HttpDeps = {},
): Promise<JsonResponse<T>> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const sleep = deps.sleep ?? defaultSleep
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = deps.retries ?? DEFAULT_RETRIES
  const backoffMs = deps.backoffMs ?? 500

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal })
      const text = await res.text()
      if (isRetryable(res.status)) {
        lastError = new ProviderHttpError(provider, res.status, `${provider}: HTTP ${res.status}`)
        continue
      }
      let data: T | null = null
      if (text) {
        try {
          data = JSON.parse(text) as T
        } catch {
          data = null
        }
      }
      return { status: res.status, data, text }
    } catch (err) {
      // AbortError (timeout) or a network failure: try again.
      lastError = err
    } finally {
      clearTimeout(timer)
    }
  }
  if (lastError instanceof ProviderHttpError) throw lastError
  const msg = lastError instanceof Error ? lastError.message : String(lastError)
  throw new ProviderHttpError(provider, 0, `${provider}: ${msg || 'request failed'}`)
}

/** Build a query string from defined values only. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    u.set(k, String(v))
  }
  return u.toString()
}

/** 'https://www.Acme-Homes.com/about' -> 'acme-homes.com'. Empty when it is not a URL or domain. */
export function domainOf(website: string | null | undefined): string {
  if (!website) return ''
  let host = website.trim().toLowerCase()
  if (!host) return ''
  try {
    const withScheme = /^[a-z]+:\/\//.test(host) ? host : `https://${host}`
    host = new URL(withScheme).hostname
  } catch {
    return ''
  }
  host = host.replace(/^www\./, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return ''
  // Free mailbox hosts are not a business domain.
  if (/(^|\.)(gmail|yahoo|hotmail|outlook|aol|icloud|comcast|verizon)\.(com|net)$/.test(host)) {
    return ''
  }
  return host
}
