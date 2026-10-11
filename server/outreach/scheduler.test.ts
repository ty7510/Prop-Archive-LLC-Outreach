import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'
import { messages } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { isWithinSendWindow } from '../lib/sendWindow.ts'
import { countTodayByChannel, nextSendAt, remainingToday, zeroCounts } from './scheduler.ts'
import { insertLead, setup } from './testFixtures.ts'

// Tuesday 2026-10-13 10:00 in New York (EDT, UTC-4).
const TUE_10 = new Date('2026-10-13T14:00:00.000Z')

describe('nextSendAt', () => {
  it('keeps a time that already falls in the window (random 0 means no jitter)', () => {
    const d = nextSendAt(DEFAULT_SETTINGS, TUE_10, 3, () => 0)
    expect(d?.toISOString()).toBe('2026-10-16T14:00:00.000Z') // Friday 10:00
  })

  it('moves a weekend landing to Monday at the window start', () => {
    const d = nextSendAt(DEFAULT_SETTINGS, TUE_10, 4, () => 0) // Saturday
    expect(d?.toISOString()).toBe('2026-10-19T12:30:00.000Z') // Monday 08:30 EDT
  })

  it('moves an after-hours landing to the next morning', () => {
    const evening = new Date('2026-10-13T22:30:00.000Z') // 18:30 EDT
    const d = nextSendAt(DEFAULT_SETTINGS, evening, 0, () => 0)
    expect(d?.toISOString()).toBe('2026-10-14T12:30:00.000Z')
  })

  it('adds 0 to 25 minutes of jitter and stays inside the window', () => {
    const lo = nextSendAt(DEFAULT_SETTINGS, TUE_10, 4, () => 0)!
    const hi = nextSendAt(DEFAULT_SETTINGS, TUE_10, 4, () => 0.999)!
    expect(hi.getTime() - lo.getTime()).toBe(25 * 60_000)
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const d = nextSendAt(DEFAULT_SETTINGS, TUE_10, 4, () => r)!
      const jitter = d.getTime() - lo.getTime()
      expect(jitter).toBeGreaterThanOrEqual(0)
      expect(jitter).toBeLessThanOrEqual(25 * 60_000)
      expect(jitter % 60_000).toBe(0)
      expect(isWithinSendWindow(DEFAULT_SETTINGS, d)).toBe(true)
    }
  })

  it('falls back to the window start when jitter would cross the end', () => {
    const nearEnd = new Date('2026-10-13T20:50:00.000Z') // 16:50 EDT, window ends 17:00
    const d = nextSendAt(DEFAULT_SETTINGS, nearEnd, 0, () => 0.999)
    expect(d?.toISOString()).toBe('2026-10-13T20:50:00.000Z')
  })

  it('returns null when no days are enabled', () => {
    const s = { ...DEFAULT_SETTINGS, send_window: { ...DEFAULT_SETTINGS.send_window, days: [] } }
    expect(nextSendAt(s, TUE_10, 1)).toBeNull()
  })
})

describe('daily caps', () => {
  it('counts sent, ready_for_human and dry_run rows created today per channel, not yesterday', async () => {
    const { db } = await setup()
    const lead = await insertLead(db)
    const today = '2026-10-13T13:00:00.000Z' // 09:00 EDT today
    const yesterday = '2026-10-12T20:00:00.000Z' // 16:00 EDT yesterday
    const add = (
      channel: 'email' | 'linkedin' | 'call',
      status: 'sent' | 'ready_for_human' | 'dry_run' | 'queued' | 'skipped',
      created_at: string,
      sent_at: string | null = null,
    ) =>
      db.insert(messages).values({
        id: newId(),
        lead_id: lead.id,
        channel,
        direction: 'out',
        status,
        idempotency_key: newId(),
        body: 'x',
        created_at,
        sent_at,
      })
    await add('email', 'sent', today, today)
    await add('email', 'sent', today, today)
    await add('email', 'dry_run', today)
    await add('email', 'queued', today) // waiting: does not count
    await add('email', 'skipped', today) // does not count
    await add('email', 'sent', yesterday, yesterday) // yesterday: does not count
    await add('linkedin', 'ready_for_human', today)
    await add('linkedin', 'ready_for_human', yesterday)
    await add('call', 'ready_for_human', yesterday, today) // marked done today: counts

    const counts = await countTodayByChannel(db, DEFAULT_SETTINGS, TUE_10)
    expect(counts).toEqual({ email: 3, mail: 0, linkedin: 1, instagram: 0, call: 1 })

    const left = remainingToday(DEFAULT_SETTINGS, counts)
    expect(left.email).toBe(DEFAULT_SETTINGS.daily_caps.email - 3)
    expect(left.linkedin).toBe(DEFAULT_SETTINGS.daily_caps.linkedin - 1)
    expect(left.mail).toBe(DEFAULT_SETTINGS.daily_caps.mail)
  })

  it('never goes below zero', () => {
    const used = { ...zeroCounts(), email: 999 }
    expect(remainingToday(DEFAULT_SETTINGS, used).email).toBe(0)
  })
})
