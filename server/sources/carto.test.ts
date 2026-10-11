import { describe, expect, it, vi } from 'vitest'
import {
  CARTO_URL,
  CartoError,
  cartoUrl,
  categoryList,
  createCartoClient,
  int,
  zipList,
} from './carto.ts'
import { buildNewLicensesSql } from './li.ts'
import {
  buildOpaOwnersCountSql,
  buildOpaOwnersSql,
  buildRecentSalesSql,
  previewOpaOwners,
} from './opa.ts'

const ZIPS = ['19104', '19121']

describe('SQL fragments', () => {
  it('zipList quotes five digit zips and dedupes', () => {
    expect(zipList(['19104', '19121', '19104'])).toBe("'19104','19121'")
  })
  it('zipList refuses anything that is not five digits', () => {
    expect(() => zipList(['1910'])).toThrow()
    expect(() => zipList(["19104' OR 1=1 --"])).toThrow()
    expect(() => zipList(['19104-1234'])).toThrow()
    expect(() => zipList([])).toThrow()
    expect(() => zipList([19104 as unknown as string])).toThrow()
  })
  it('int refuses non-integers and negatives', () => {
    expect(int(50)).toBe(50)
    expect(() => int(-1)).toThrow()
    expect(() => int(1.5)).toThrow()
    expect(() => int(Number.NaN)).toThrow()
    expect(() => int('5; DROP TABLE' as unknown as number)).toThrow()
  })
  it('categoryList is fixed text', () => {
    expect(categoryList()).toBe(
      "'SINGLE FAMILY','MULTI FAMILY','MIXED USE','APARTMENTS  > 4 UNITS'",
    )
  })
  it('cartoUrl encodes the query', () => {
    expect(cartoUrl('SELECT 1')).toBe(`${CARTO_URL}?q=SELECT%201`)
  })
})

describe('OPA owners SQL', () => {
  it('groups by normalised mailing street and zip and pages by owners', () => {
    const q = buildOpaOwnersSql(ZIPS, 3, 20, 50, 100)
    expect(q).toContain("left(zip_code, 5) IN ('19104','19121')")
    expect(q).toContain('HAVING count(*) BETWEEN 3 AND 20')
    expect(q).toContain('LIMIT 50 OFFSET 100')
    expect(q).toContain('GROUP BY key_street, key_zip')
    expect(q).toContain('JOIN owners o ON b.key_street = o.key_street AND b.key_zip = o.key_zip')
    expect(q).toContain('regexp_replace(')
    expect(q).toContain('owner_property_count')
    expect(q).toContain('parcel_number')
    expect(q).not.toContain('number_of_units')
  })
  it('refuses bad zips, bad numbers and min above max', () => {
    expect(() => buildOpaOwnersSql(['abcde'], 3, 20)).toThrow()
    expect(() => buildOpaOwnersSql(ZIPS, 3, 20, -1)).toThrow()
    expect(() => buildOpaOwnersSql(ZIPS, 21, 20)).toThrow()
    expect(() => buildOpaOwnersSql(ZIPS, 3.5, 20)).toThrow()
  })
  it('the count query has no page', () => {
    const q = buildOpaOwnersCountSql(ZIPS, 3, 20)
    expect(q).toContain('SELECT count(*) AS owners FROM owners')
    expect(q).not.toContain('LIMIT')
  })
  it('previewOpaOwners is pure and returns both queries with urls', () => {
    const p = previewOpaOwners(['19104', '19104', '19121'], 3, 20)
    expect(p.zips).toEqual(['19104', '19121'])
    expect(p.count_sql).toBe(buildOpaOwnersCountSql(ZIPS, 3, 20))
    expect(p.first_page_sql).toBe(buildOpaOwnersSql(ZIPS, 3, 20, 50, 0))
    expect(p.count_url.startsWith(`${CARTO_URL}?q=`)).toBe(true)
    expect(decodeURIComponent(p.first_page_url.slice(CARTO_URL.length + 3))).toBe(p.first_page_sql)
  })
})

describe('recent sales and new license SQL', () => {
  it('recent sales uses a day window and residential categories', () => {
    const q = buildRecentSalesSql(ZIPS, 90, 500, 500)
    expect(q).toContain('sale_date >= current_date - 90')
    expect(q).toContain("category_code_description IN ('SINGLE FAMILY'")
    expect(q).toContain('ORDER BY sale_date DESC, parcel_number LIMIT 500 OFFSET 500')
    expect(() => buildRecentSalesSql(['x'], 90)).toThrow()
  })
  it('new licenses filters Rental and initialissuedate', () => {
    const q = buildNewLicensesSql(ZIPS, 60, 500, 0)
    expect(q).toContain('FROM business_licenses')
    expect(q).toContain("licensetype = 'Rental'")
    expect(q).toContain("left(zip, 5) IN ('19104','19121')")
    expect(q).toContain('initialissuedate >= current_date - 60')
    expect(q).toContain('opa_account_num')
    expect(q).toContain('numberofunits')
    expect(() => buildNewLicensesSql(ZIPS, -5)).toThrow()
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createCartoClient', () => {
  it('fetches the encoded url and returns rows', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ rows: [{ a: 1 }] }))
    const client = createCartoClient({ fetch: fetchMock, sleep: async () => {} })
    const rows = await client.query<{ a: number }>('SELECT 1 AS a')
    expect(rows).toEqual([{ a: 1 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${CARTO_URL}?q=SELECT%201%20AS%20a`)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(client.requests).toBe(1)
  })

  it('runs queries one at a time with a gap between them', async () => {
    const order: string[] = []
    const sleeps: number[] = []
    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const fetchMock = vi.fn(async (url: string) => {
      order.push(`start ${decodeURIComponent(url.split('q=')[1] ?? '')}`)
      await Promise.resolve()
      order.push('end')
      return jsonResponse({ rows: [] })
    })
    const client = createCartoClient({
      fetch: fetchMock as unknown as typeof fetch,
      gapMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })
    await Promise.all([client.query('A'), client.query('B'), client.query('C')])
    expect(order).toEqual(['start A', 'end', 'start B', 'end', 'start C', 'end'])
    expect(sleeps).toEqual([250, 250])
    vi.restoreAllMocks()
  })

  it('retries twice on 500 and 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: ['boom'] }, 500))
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ rows: [{ ok: true }] }))
    const sleeps: number[] = []
    const client = createCartoClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      retries: 2,
      gapMs: 250,
    })
    expect(await client.query('Q')).toEqual([{ ok: true }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // back-off waits (gap * 2^attempt) between attempts; the polite gap waits are at most 250
    expect(sleeps.filter((ms) => ms > 250)).toEqual([500, 1000])
    expect(sleeps.every((ms) => ms <= 1000)).toBe(true)
  })

  it('gives up after the retries and throws a CartoError', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: ['down'] }, 503))
    const client = createCartoClient({ fetch: fetchMock, sleep: async () => {}, retries: 2 })
    await expect(client.query('Q')).rejects.toBeInstanceOf(CartoError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 400 (bad SQL is our bug)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: ['syntax'] }, 400))
    const client = createCartoClient({ fetch: fetchMock, sleep: async () => {}, retries: 2 })
    await expect(client.query('Q')).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries network errors', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ rows: [1] }))
    const client = createCartoClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    })
    expect(await client.query('Q')).toEqual([1])
  })

  it('rejects an answer without rows', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ nope: true }))
    const client = createCartoClient({ fetch: fetchMock, sleep: async () => {}, retries: 0 })
    await expect(client.query('Q')).rejects.toThrow(/without rows/)
  })

  it('a failed query does not block the next one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: ['x'] }, 400))
      .mockResolvedValueOnce(jsonResponse({ rows: [2] }))
    const client = createCartoClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
    })
    const first = client.query('A')
    const second = client.query('B')
    await expect(first).rejects.toThrow()
    expect(await second).toEqual([2])
  })
})
