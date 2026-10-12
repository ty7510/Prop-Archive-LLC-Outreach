// Open a research source page and return its text, so verify.ts can confirm a quote is really on
// it. Only public http(s) pages on ports 80/443: the host is resolved once, every address must be
// public (server/lib/net.ts), and the socket connects to exactly that address (no second lookup
// for DNS rebinding to slip through). Redirects are followed by hand, each hop checked the same way.
import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { isPrivateAddress } from '../lib/net.ts'

/** The page text, or null when it could not be read (blocked, private, too slow, not text). */
export type PageFetcher = (url: string) => Promise<string | null>

const MAX_BYTES = 1_500_000
const TIMEOUT_MS = 8000
/** The most one page may take from connect to last byte. */
const DEADLINE_MS = 10_000
const MAX_REDIRECTS = 3

/** A lookup that refuses names with any private address and pins the first public one. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4)
    const list = Array.isArray(addresses) ? addresses : []
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error(`${hostname} is not a public address`), '', 4)
    }
    const first = list[0]!
    if ((options as { all?: boolean }).all) {
      ;(callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        first,
      ])
    } else callback(null, first.address, first.family)
  })
}

export function allowedUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.port && u.port !== '80' && u.port !== '443') return null
    if (u.username || u.password) return null
    // A numeric host never goes through the lookup below, so it is refused here.
    if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) return null
    return u
  } catch {
    return null
  }
}

/** Test seams only: production always uses the public-only lookup and the 10 s deadline. */
export interface GetOptions {
  lookup?: LookupFunction
  deadlineMs?: number
}

export function getOnce(
  url: URL,
  opts: GetOptions = {},
): Promise<{ status: number; location?: string; body: string }> {
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    // Settle exactly once, whatever happens: end, error, close, size cap or the deadline.
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn()
    }
    const fail = (err: Error) => {
      done(() => reject(err))
      req.destroy()
    }
    // A hard deadline for the whole request. The socket timeout alone restarts on every byte, so
    // a page that drips one byte at a time could otherwise hold a research run forever.
    const deadline = setTimeout(() => fail(new Error('deadline')), opts.deadlineMs ?? DEADLINE_MS)
    const req = lib.get(
      url,
      {
        lookup: opts.lookup ?? publicOnlyLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ProparchiveOutreach/1.0; contact check)',
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        const type = String(res.headers['content-type'] ?? '')
        const declared = Number(res.headers['content-length'] ?? 0)
        if (status >= 300 && status < 400) {
          res.resume()
          return done(() => resolve({ status, ...(location ? { location } : {}), body: '' }))
        }
        if (!/text\/|html|json|xml/i.test(type) || declared > MAX_BYTES) {
          res.destroy()
          return done(() => resolve({ status, body: '' }))
        }
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BYTES) return fail(new Error('page too large'))
          chunks.push(c)
        })
        res.on('end', () =>
          done(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') })),
        )
        res.on('error', (err) => fail(err))
        res.on('close', () => fail(new Error('closed')))
      },
    )
    req.on('timeout', () => fail(new Error('timeout')))
    req.on('error', (err) => fail(err))
    req.on('close', () => fail(new Error('closed')))
  })
}

/** Strip tags and entities well enough to search the words of a page. */
export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** The real fetcher. Never throws. */
export const fetchPublicPage: PageFetcher = async (raw) => {
  // Redirect hops each get their own deadline; MAX_REDIRECTS keeps the total bounded too.
  let url = allowedUrl(raw)
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    try {
      const res = await getOnce(url)
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = allowedUrl(new URL(res.location, url).toString())
        continue
      }
      if (res.status !== 200 || !res.body) return null
      return pageText(res.body)
    } catch {
      return null
    }
  }
  return null
}
