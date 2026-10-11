import { describe, expect, it } from 'vitest'
import { domainOf, fetchJson, ProviderHttpError, qs } from './http.ts'
import { hangingFetch, queuedFetch } from './testing.ts'

const noSleep = async () => {}

describe('fetchJson', () => {
  it('returns parsed JSON on 200', async () => {
    const f = queuedFetch([{ status: 200, body: { ok: 1 } }])
    const res = await fetchJson('t', 'https://x/a', {}, { fetch: f, sleep: noSleep })
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ ok: 1 })
    expect(f.calls).toHaveLength(1)
  })

  it('retries 429 then succeeds', async () => {
    const f = queuedFetch([
      { status: 429, body: {} },
      { status: 200, body: { ok: true } },
    ])
    const res = await fetchJson('t', 'https://x', {}, { fetch: f, sleep: noSleep, backoffMs: 0 })
    expect(res.status).toBe(200)
    expect(f.calls).toHaveLength(2)
  })

  it('retries 500 twice then throws a ProviderHttpError', async () => {
    const f = queuedFetch([{ status: 500, text: 'boom' }])
    const slept: number[] = []
    await expect(
      fetchJson('hunter', 'https://x', {}, { fetch: f, sleep: async (ms) => void slept.push(ms) }),
    ).rejects.toBeInstanceOf(ProviderHttpError)
    expect(f.calls).toHaveLength(3)
    expect(slept).toEqual([500, 1000])
  })

  it('returns non-retryable 4xx instead of throwing', async () => {
    const f = queuedFetch([{ status: 404, body: { error: 'nope' } }])
    const res = await fetchJson('t', 'https://x', {}, { fetch: f, sleep: noSleep })
    expect(res.status).toBe(404)
    expect(res.data).toEqual({ error: 'nope' })
    expect(f.calls).toHaveLength(1)
  })

  it('times out a hung request and retries, then throws', async () => {
    await expect(
      fetchJson(
        'pdl',
        'https://x',
        {},
        { fetch: hangingFetch(), sleep: noSleep, timeoutMs: 5, retries: 1 },
      ),
    ).rejects.toThrow(/pdl: .*abort/i)
  })

  it('survives a network error and a non-JSON body', async () => {
    let n = 0
    const f = (async () => {
      n++
      if (n === 1) throw new TypeError('fetch failed')
      return new Response('<html>', { status: 200 })
    }) as unknown as typeof fetch
    const res = await fetchJson('t', 'https://x', {}, { fetch: f, sleep: noSleep })
    expect(res.status).toBe(200)
    expect(res.data).toBeNull()
    expect(res.text).toBe('<html>')
  })
})

describe('qs and domainOf', () => {
  it('drops empty values', () => {
    expect(qs({ a: 'x', b: null, c: undefined, d: '', e: 3 })).toBe('a=x&e=3')
  })

  it('extracts a business domain', () => {
    expect(domainOf('https://www.Acme-Homes.com/about')).toBe('acme-homes.com')
    expect(domainOf('acmehomes.net')).toBe('acmehomes.net')
    expect(domainOf('gmail.com')).toBe('')
    expect(domainOf('not a url')).toBe('')
    expect(domainOf(null)).toBe('')
  })
})
