// Send window maths: is it a good time to send, and when is the next one. Pure. Owned by the scaffold.
import type { SendWindow, Settings } from '../../shared/settings.ts'
import { parseHHMM, zonedParts, zonedTimeToUtc } from './time.ts'

type WindowSource = Settings | SendWindow | { send_window: SendWindow }

function windowOf(source: WindowSource): SendWindow {
  return 'send_window' in source ? source.send_window : source
}

/** True when `date` falls on an allowed weekday between start (inclusive) and end (exclusive) in the window's zone. */
export function isWithinSendWindow(source: WindowSource, date: Date = new Date()): boolean {
  const w = windowOf(source)
  const start = parseHHMM(w.start)
  const end = parseHHMM(w.end)
  if (start === null || end === null || end <= start) return false
  const p = zonedParts(date, w.tz)
  if (!w.days.includes(p.weekday)) return false
  const minutes = p.hour * 60 + p.minute
  return minutes >= start && minutes < end
}

/**
 * The earliest instant at or after `date` that is inside the send window.
 * Returns `date` itself when already inside. Returns null when the window can never open
 * (no days, or end not after start).
 */
export function nextWindowStart(source: WindowSource, date: Date = new Date()): Date | null {
  const w = windowOf(source)
  const start = parseHHMM(w.start)
  const end = parseHHMM(w.end)
  if (start === null || end === null || end <= start || w.days.length === 0) return null
  if (isWithinSendWindow(w, date)) return date

  const p = zonedParts(date, w.tz)
  const nowMinutes = p.hour * 60 + p.minute
  // Candidate days: today (only if before start) then the next 7 days.
  for (let offset = 0; offset <= 7; offset++) {
    const weekday = (p.weekday + offset) % 7
    if (!w.days.includes(weekday)) continue
    if (offset === 0 && nowMinutes >= start) continue
    // Build the wall clock date `offset` days ahead in the zone, then convert to UTC.
    const base = Date.UTC(p.year, p.month - 1, p.day + offset)
    const d = new Date(base)
    const candidate = zonedTimeToUtc(
      w.tz,
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      Math.floor(start / 60),
      start % 60,
    )
    if (candidate.getTime() >= date.getTime()) return candidate
  }
  return null
}

/**
 * Move an instant into the send window and add a random 0..maxJitterMinutes jitter.
 * `random` is injectable for tests.
 */
export function scheduleInWindow(
  source: WindowSource,
  wanted: Date,
  maxJitterMinutes = 25,
  random: () => number = Math.random,
): Date | null {
  const start = nextWindowStart(source, wanted)
  if (!start) return null
  const jitter = Math.floor(random() * (maxJitterMinutes + 1)) * 60_000
  const withJitter = new Date(start.getTime() + jitter)
  // Jitter may push past the window end; if so, fall back to the window start.
  return isWithinSendWindow(source, withJitter) ? withJitter : start
}
