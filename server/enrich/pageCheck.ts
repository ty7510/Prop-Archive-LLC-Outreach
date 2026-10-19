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
    // Replit has no IPv6 route, so connect over IPv4 when the name has an IPv4 address.
    const first = list.find((a) => a.family === 4) ?? list[0]!
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

/** Cloudflare's email protection: the first byte is the key, every later byte is XOR'd with it. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return null
  const key = parseInt(hex.slice(0, 2), 16)
  let out = ''
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key)
  }
  return out.includes('@') ? out : null
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  commat: '@',
  period: '.',
  hyphen: '-',
  dash: '-',
  ndash: '-',
  lpar: '(',
  rpar: ')',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, n: string) => safeChar(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

function safeChar(code: number): string {
  if (code === 160) return ' '
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
}

/**
 * Strip tags and entities well enough to search the words of a page. What a visitor can reach but
 * the visible words leave out is kept too: mailto: and tel: links, emails hidden by Cloudflare,
 * and the business details sites put in JSON-LD for search engines.
 */
export function pageText(html: string): string {
  const extra: string[] = []
  for (const m of html.matchAll(/href\s*=\s*["']?\s*(mailto|tel):([^"'\s>]+)/gi)) {
    const value = m[2]!.split('?')[0]!
    try {
      extra.push(decodeEntities(decodeURIComponent(value)))
    } catch {
      extra.push(decodeEntities(value))
    }
  }
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']?([0-9a-f]+)/gi)) {
    const email = decodeCfEmail(m[1]!)
    if (email) extra.push(email)
  }
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    const email = decodeCfEmail(m[1]!)
    if (email) extra.push(email)
  }
  for (const m of html.matchAll(
    /<script[^>]*type\s*=\s*["']?application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    extra.push(m[1]!.replace(/\\\//g, '/'))
  }
  const visible = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
  return [visible, ...extra].join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * A bot check, an "access denied" page or an empty app shell instead of the real page. It says
 * nothing about what the real page shows, so it counts as "could not open", never as a page
 * that leaves the contact out.
 */
export function isBlockedPage(html: string, text = pageText(html)): boolean {
  if (text.length < 200) return true
  if (text.length > 6000) return false
  // Not "challenge-platform": Cloudflare adds that script to ordinary pages too.
  return /_cf_chl_opt|cf-chl-|<title>\s*(just a moment|attention required|access denied|security check|are you a robot|pardon our interruption)|px-captcha|_incapsula_resource|captcha-delivery\.com|enable javascript and cookies to continue|please verify you are a human/i.test(
    html,
  )
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
      const text = pageText(res.body)
      return isBlockedPage(res.body, text) ? null : text
    } catch {
      return null
    }
  }
  return null
}
