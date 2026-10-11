import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'
import { isWithinSendWindow, nextWindowStart, scheduleInWindow } from './sendWindow.ts'
import { zonedParts } from './time.ts'

const NY = 'America/New_York'
const window = { ...DEFAULT_SETTINGS.send_window } // Mon-Fri 08:30-17:00 New York

describe('isWithinSendWindow', () => {
  it('is true on a weekday inside the hours', () => {
    // Wed 2026-10-14 10:00 New York = 14:00Z (EDT)
    expect(isWithinSendWindow(window, new Date('2026-10-14T14:00:00Z'))).toBe(true)
  })

  it('accepts the whole Settings object too', () => {
    expect(isWithinSendWindow(DEFAULT_SETTINGS, new Date('2026-10-14T14:00:00Z'))).toBe(true)
  })

  it('is false before the start', () => {
    // Wed 08:29 New York
    expect(isWithinSendWindow(window, new Date('2026-10-14T12:29:00Z'))).toBe(false)
    // exactly 08:30 is in
    expect(isWithinSendWindow(window, new Date('2026-10-14T12:30:00Z'))).toBe(true)
  })

  it('is false at and after the end', () => {
    // Wed 17:00 New York is out (end is exclusive), 16:59 is in
    expect(isWithinSendWindow(window, new Date('2026-10-14T21:00:00Z'))).toBe(false)
    expect(isWithinSendWindow(window, new Date('2026-10-14T20:59:00Z'))).toBe(true)
  })

  it('is false on weekends', () => {
    // Sat 2026-10-17 12:00 New York
    expect(isWithinSendWindow(window, new Date('2026-10-17T16:00:00Z'))).toBe(false)
    // Sun 2026-10-18 12:00 New York
    expect(isWithinSendWindow(window, new Date('2026-10-18T16:00:00Z'))).toBe(false)
  })

  it('uses the zone, not the server clock: 10:00Z is 06:00 in New York', () => {
    expect(isWithinSendWindow(window, new Date('2026-10-14T10:00:00Z'))).toBe(false)
  })

  it('handles winter time (EST, UTC-5)', () => {
    // Wed 2026-12-16 09:00 New York = 14:00Z
    expect(isWithinSendWindow(window, new Date('2026-12-16T14:00:00Z'))).toBe(true)
    // 2026-12-16 16:30 New York = 21:30Z, still in
    expect(isWithinSendWindow(window, new Date('2026-12-16T21:30:00Z'))).toBe(true)
    // 2026-12-16 17:00 New York = 22:00Z, out
    expect(isWithinSendWindow(window, new Date('2026-12-16T22:00:00Z'))).toBe(false)
  })

  it('returns false for a broken window', () => {
    expect(isWithinSendWindow({ ...window, start: '17:00', end: '08:30' }, new Date())).toBe(false)
    expect(isWithinSendWindow({ ...window, days: [] }, new Date('2026-10-14T14:00:00Z'))).toBe(
      false,
    )
  })
})

describe('nextWindowStart', () => {
  it('returns the same instant when already inside', () => {
    const d = new Date('2026-10-14T14:00:00Z')
    expect(nextWindowStart(window, d)).toBe(d)
  })

  it('moves an early morning to 08:30 the same day', () => {
    const next = nextWindowStart(window, new Date('2026-10-14T10:00:00Z')) // 06:00 NY Wed
    expect(next?.toISOString()).toBe('2026-10-14T12:30:00.000Z')
  })

  it('moves an evening to 08:30 the next day', () => {
    const next = nextWindowStart(window, new Date('2026-10-14T22:00:00Z')) // 18:00 NY Wed
    expect(next?.toISOString()).toBe('2026-10-15T12:30:00.000Z')
  })

  it('skips the weekend from Friday evening to Monday morning', () => {
    const next = nextWindowStart(window, new Date('2026-10-16T22:00:00Z')) // Fri 18:00 NY
    expect(next?.toISOString()).toBe('2026-10-19T12:30:00.000Z') // Mon 08:30 EDT
    const p = zonedParts(next as Date, NY)
    expect(p.weekday).toBe(1)
    expect(p.hour).toBe(8)
    expect(p.minute).toBe(30)
  })

  it('skips Saturday and Sunday from a Saturday', () => {
    const next = nextWindowStart(window, new Date('2026-10-17T16:00:00Z')) // Sat
    expect(zonedParts(next as Date, NY).weekday).toBe(1)
  })

  it('is DST-safe across the fall-back weekend (2026-11-01)', () => {
    // Fri 2026-10-30 18:00 EDT = 22:00Z. Next window Mon 2026-11-02 08:30 EST = 13:30Z.
    const next = nextWindowStart(window, new Date('2026-10-30T22:00:00Z'))
    expect(next?.toISOString()).toBe('2026-11-02T13:30:00.000Z')
    const p = zonedParts(next as Date, NY)
    expect([p.hour, p.minute]).toEqual([8, 30])
  })

  it('is DST-safe across the spring-forward weekend (2027-03-14)', () => {
    // Fri 2027-03-12 18:00 EST = 23:00Z. Next window Mon 2027-03-15 08:30 EDT = 12:30Z.
    const next = nextWindowStart(window, new Date('2027-03-12T23:00:00Z'))
    expect(next?.toISOString()).toBe('2027-03-15T12:30:00.000Z')
    const p = zonedParts(next as Date, NY)
    expect([p.hour, p.minute]).toEqual([8, 30])
  })

  it('returns null when no day is allowed', () => {
    expect(nextWindowStart({ ...window, days: [] }, new Date())).toBeNull()
  })

  it('works for another zone', () => {
    const la = { ...window, tz: 'America/Los_Angeles' }
    const next = nextWindowStart(la, new Date('2026-10-14T10:00:00Z')) // 03:00 LA Wed
    expect(next?.toISOString()).toBe('2026-10-14T15:30:00.000Z')
  })
})

describe('scheduleInWindow', () => {
  it('adds jitter inside the window', () => {
    const wanted = new Date('2026-10-14T10:00:00Z') // 06:00 NY -> 08:30 NY
    const d = scheduleInWindow(window, wanted, 25, () => 0.5)
    expect(d?.toISOString()).toBe('2026-10-14T12:43:00.000Z')
  })

  it('never pushes past the window end', () => {
    const wanted = new Date('2026-10-14T20:50:00Z') // 16:50 NY, inside
    const d = scheduleInWindow(window, wanted, 25, () => 0.99)
    expect(d?.toISOString()).toBe('2026-10-14T20:50:00.000Z')
  })
})
