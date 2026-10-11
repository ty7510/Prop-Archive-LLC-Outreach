import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'
import { createTestDb } from '../db/client.ts'
import {
  capFor,
  creditsUsed,
  monthRange,
  recordUsage,
  usageReport,
  wouldExceedCap,
} from './usage.ts'

describe('monthRange', () => {
  it('bounds the calendar month in the zone', () => {
    const r = monthRange(new Date('2026-10-11T03:00:00Z'), 'America/New_York')
    expect(r.key).toBe('2026-10')
    expect(r.startIso).toBe('2026-10-01T04:00:00.000Z') // EDT
    expect(r.endIso).toBe('2026-11-01T04:00:00.000Z')
  })

  it('late evening on the last day still counts in the zone month', () => {
    // 2026-11-01 01:00 UTC is still Oct 31 in New York.
    const r = monthRange(new Date('2026-11-01T01:00:00Z'), 'America/New_York')
    expect(r.key).toBe('2026-10')
  })

  it('rolls over December', () => {
    const r = monthRange(new Date('2026-12-15T12:00:00Z'), 'America/New_York')
    expect(r.key).toBe('2026-12')
    expect(r.endIso).toBe('2027-01-01T05:00:00.000Z') // EST
  })
})

describe('caps', () => {
  it('capFor knows which providers have caps', () => {
    expect(capFor(DEFAULT_SETTINGS.enrichment.monthly_credit_cap, 'hunter')).toBe(50)
    expect(capFor(DEFAULT_SETTINGS.enrichment.monthly_credit_cap, 'li_license')).toBeNull()
  })

  it('wouldExceedCap', () => {
    expect(wouldExceedCap(49, 1, 50)).toBe(false)
    expect(wouldExceedCap(50, 1, 50)).toBe(true)
    expect(wouldExceedCap(49, 2, 50)).toBe(true)
    expect(wouldExceedCap(1000, 1, null)).toBe(false)
  })

  it('counts this month only', async () => {
    const db = await createTestDb()
    const now = new Date('2026-10-11T12:00:00Z')
    await recordUsage('hunter', 2, 'L1', now, db)
    await recordUsage('hunter', 1, 'L2', now, db)
    await recordUsage('hunter', 5, 'L3', new Date('2026-09-30T12:00:00Z'), db)
    await recordUsage('apollo', 1, 'L1', now, db)
    await recordUsage('li_license', 0, 'L1', now, db)
    const range = monthRange(now, 'America/New_York')
    expect(await creditsUsed('hunter', range, db)).toEqual({ used: 3, calls: 2 })
    expect(await creditsUsed('pdl', range, db)).toEqual({ used: 0, calls: 0 })
    expect(await creditsUsed('li_license', range, db)).toEqual({ used: 0, calls: 1 })

    const report = await usageReport(DEFAULT_SETTINGS, now, db)
    expect(report.month).toBe('2026-10')
    expect(report.providers.map((p) => p.provider)).toEqual([
      'li_license',
      'claude_research',
      'hunter',
      'apollo',
      'pdl',
    ])
    expect(report.providers.find((p) => p.provider === 'hunter')).toEqual({
      provider: 'hunter',
      used: 3,
      calls: 2,
      cap: 50,
    })
  })
})
