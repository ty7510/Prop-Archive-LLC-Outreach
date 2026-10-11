// When the next step goes out and how many more may go today (spec section 10, Scheduling).
import { and, eq, gte, inArray, or } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import { CHANNELS, type Channel } from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import { messages } from '../db/schema.ts'
import { scheduleInWindow } from '../lib/sendWindow.ts'
import { addDays, startOfDayInTz } from '../lib/time.ts'

export const MAX_JITTER_MINUTES = 25

/**
 * `from + delayDays`, moved into the next send window with 0..25 minutes of jitter.
 * null when the window can never open (no days enabled).
 */
export function nextSendAt(
  settings: Settings,
  from: Date,
  delayDays: number,
  random: () => number = Math.random,
): Date | null {
  return scheduleInWindow(settings, addDays(from, delayDays), MAX_JITTER_MINUTES, random)
}

export type ChannelCounts = Record<Channel, number>

export function zeroCounts(): ChannelCounts {
  return { email: 0, mail: 0, linkedin: 0, instagram: 0, call: 0 }
}

/** Statuses that use up a slot of the daily cap. dry_run counts too so a dry run paces like live. */
export const CAP_STATUSES = ['sent', 'ready_for_human', 'dry_run'] as const

/**
 * Outbound messages per channel that count against today's cap in the send window's zone:
 * rows created today with a capped status, plus anything with a sent_at today.
 */
export async function countTodayByChannel(
  db: Db,
  settings: Settings,
  now: Date,
): Promise<ChannelCounts> {
  const dayStart = startOfDayInTz(now, settings.send_window.tz).toISOString()
  const rows = await db
    .select({ channel: messages.channel })
    .from(messages)
    .where(
      and(
        eq(messages.direction, 'out'),
        or(
          and(inArray(messages.status, [...CAP_STATUSES]), gte(messages.created_at, dayStart)),
          gte(messages.sent_at, dayStart),
        ),
      ),
    )
  const counts = zeroCounts()
  for (const r of rows) {
    if ((CHANNELS as readonly string[]).includes(r.channel)) counts[r.channel] += 1
  }
  return counts
}

/** How many more messages each channel may produce today. Never below zero. */
export function remainingToday(settings: Settings, used: ChannelCounts): ChannelCounts {
  const out = zeroCounts()
  for (const c of CHANNELS) out[c] = Math.max(0, settings.daily_caps[c] - used[c])
  return out
}
