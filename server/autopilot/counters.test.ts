import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type Db } from '../db/client.ts'
import { enrollments, events, leads, messages, sequences } from '../db/schema.ts'
import { dayRangeInTz, todayCounts } from './counters.ts'

const TZ = 'America/New_York'
// Tuesday 2026-10-13 10:00 New York.
const NOW = new Date('2026-10-13T14:00:00.000Z')
const TODAY = '2026-10-13T12:00:00.000Z' // 08:00 New York
const EDGE_IN = '2026-10-13T04:00:00.000Z' // 00:00 New York, first instant of today
const EDGE_OUT = '2026-10-13T03:59:59.000Z' // 23:59:59 New York yesterday
const YESTERDAY = '2026-10-12T15:00:00.000Z'
const TOMORROW = '2026-10-14T04:00:00.000Z' // 00:00 New York tomorrow

describe('dayRangeInTz', () => {
  it('bounds the New York day in UTC', () => {
    expect(dayRangeInTz(NOW, TZ)).toEqual({ start: EDGE_IN, end: TOMORROW })
  })

  it('handles the 25 hour fall-back day', () => {
    const r = dayRangeInTz(new Date('2026-11-01T15:00:00.000Z'), TZ)
    expect(r.start).toBe('2026-11-01T04:00:00.000Z') // EDT midnight
    expect(r.end).toBe('2026-11-02T05:00:00.000Z') // EST midnight
  })

  it('handles the 23 hour spring-forward day', () => {
    const r = dayRangeInTz(new Date('2027-03-14T15:00:00.000Z'), TZ)
    expect(r.start).toBe('2027-03-14T05:00:00.000Z')
    expect(r.end).toBe('2027-03-15T04:00:00.000Z')
  })

  it('rolls over month and year ends', () => {
    expect(dayRangeInTz(new Date('2026-10-31T15:00:00.000Z'), TZ).end).toBe(
      '2026-11-01T04:00:00.000Z',
    )
    expect(dayRangeInTz(new Date('2026-12-31T15:00:00.000Z'), TZ).end).toBe(
      '2027-01-01T05:00:00.000Z',
    )
  })

  it('works in UTC too', () => {
    expect(dayRangeInTz(NOW, 'UTC')).toEqual({
      start: '2026-10-13T00:00:00.000Z',
      end: '2026-10-14T00:00:00.000Z',
    })
  })
})

describe('todayCounts', () => {
  let db: Db

  beforeEach(async () => {
    db = await createTestDb()
  })

  it('is all zeros on an empty database', async () => {
    expect(await todayCounts(TZ, NOW, db)).toEqual({
      discovered: 0,
      enriched: 0,
      enrolled: 0,
      sent: 0,
      queued: 0,
      replied: 0,
      booked: 0,
      joined: 0,
    })
  })

  it('counts only rows inside the local day', async () => {
    const lead = (id: string, created_at: string, extra: Partial<typeof leads.$inferInsert> = {}) =>
      ({
        id,
        created_at,
        updated_at: created_at,
        unsubscribe_token: `tok-${id}`,
        ...extra,
      }) as typeof leads.$inferInsert

    await db.insert(leads).values([
      lead('L1', TODAY), // discovered today, status new
      lead('L2', EDGE_IN, { status: 'enriched' }), // first instant of today
      lead('L3', EDGE_OUT, { status: 'enriched' }), // last second of yesterday
      lead('L4', YESTERDAY, { status: 'enrolled', updated_at: TODAY }), // enriched earlier, enrolled today
      lead('L5', TOMORROW), // not today
      lead('L6', YESTERDAY, { status: 'new', updated_at: TODAY }), // touched today but not enriched
    ])
    await db.insert(sequences).values({
      id: 'S1',
      name: 'Email',
      channel: 'email',
      created_at: YESTERDAY,
      updated_at: YESTERDAY,
    })
    await db.insert(enrollments).values([
      { id: 'E1', lead_id: 'L2', sequence_id: 'S1', started_at: TODAY },
      { id: 'E2', lead_id: 'L4', sequence_id: 'S1', started_at: YESTERDAY },
    ])
    const msg = (
      id: string,
      status: typeof messages.$inferInsert.status,
      created_at: string,
      extra: Partial<typeof messages.$inferInsert> = {},
    ): typeof messages.$inferInsert => ({
      id,
      lead_id: 'L1',
      channel: 'email',
      idempotency_key: id,
      status,
      created_at,
      ...extra,
    })
    await db.insert(messages).values([
      msg('M1', 'sent', YESTERDAY, { sent_at: TODAY }), // created yesterday, sent today: counts
      msg('M2', 'sent', TODAY, { sent_at: YESTERDAY }), // sent yesterday: no
      msg('M3', 'dry_run', TODAY), // dry run is not sent
      msg('M4', 'ready_for_human', TODAY, { channel: 'linkedin' }),
      msg('M5', 'ready_for_human', EDGE_OUT, { channel: 'call' }),
      msg('M6', 'queued', TODAY), // queued but not for a human: no
      msg('M7', 'received', TODAY, { direction: 'in' }),
      msg('M8', 'received', TODAY, { direction: 'in' }),
      msg('M9', 'received', YESTERDAY, { direction: 'in' }),
      msg('M10', 'sent', TODAY, { direction: 'in', sent_at: TODAY }), // inbound never counts as sent
    ])
    await db.insert(events).values([
      { id: 'V1', lead_id: 'L1', kind: 'demo_booked', at: TODAY },
      { id: 'V2', lead_id: 'L1', kind: 'demo_booked', at: EDGE_OUT },
      { id: 'V3', lead_id: 'L1', kind: 'beta_joined', at: EDGE_IN },
      { id: 'V4', lead_id: 'L1', kind: 'beta_joined', at: TODAY },
      { id: 'V5', lead_id: 'L1', kind: 'beta_joined', at: TOMORROW },
      { id: 'V6', lead_id: 'L1', kind: 'click', at: TODAY },
    ])

    expect(await todayCounts(TZ, NOW, db)).toEqual({
      discovered: 2, // L1, L2
      enriched: 2, // L2, L4
      enrolled: 1,
      sent: 1,
      queued: 1,
      replied: 3, // M7, M8, M10
      booked: 1,
      joined: 2,
    })
  })

  it('follows the zone: the same rows look different from UTC', async () => {
    await db
      .insert(leads)
      .values({ id: 'L', created_at: EDGE_OUT, updated_at: EDGE_OUT, unsubscribe_token: 'tok-L' })
    expect((await todayCounts(TZ, NOW, db)).discovered).toBe(0)
    expect((await todayCounts('UTC', NOW, db)).discovered).toBe(1)
  })
})
