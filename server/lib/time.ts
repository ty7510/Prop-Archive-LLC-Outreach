// Time helpers. All timestamps in the database are ISO strings in UTC. Owned by the scaffold.

export function nowIso(): string {
  return new Date().toISOString()
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const partsFormatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsFormatters.set(tz, f)
  }
  return f
}

/** The wall clock parts of an instant in a time zone. DST-safe because Intl does the work. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  }
}

/** Offset of a zone from UTC at an instant, in minutes (New York winter = -300). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - date.getTime()) / 60_000)
}

/**
 * The UTC instant for a wall clock time in a zone, DST-safe.
 * Inside a spring-forward gap the result lands after the gap; in a fall-back overlap it picks the first.
 */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  let offset = tzOffsetMinutes(new Date(guess), tz)
  let result = guess - offset * 60_000
  const offset2 = tzOffsetMinutes(new Date(result), tz)
  if (offset2 !== offset) {
    offset = offset2
    result = guess - offset * 60_000
  }
  return new Date(result)
}

/** 'YYYY-MM-DD' of an instant in a zone. The key for "today" counters and daily caps. */
export function dayKeyInTz(date: Date, tz: string): string {
  const p = zonedParts(date, tz)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** The UTC instant where a zone's calendar day starts. */
export function startOfDayInTz(date: Date, tz: string): Date {
  const p = zonedParts(date, tz)
  return zonedTimeToUtc(tz, p.year, p.month, p.day)
}

/** 'YYYY-MM' of an instant in a zone. The key for monthly credit caps. */
export function monthKeyInTz(date: Date, tz: string): string {
  const p = zonedParts(date, tz)
  return `${p.year}-${pad2(p.month)}`
}

/** Human readable time in a zone, for the UI and logs. formatInTz(d, 'America/New_York') -> 'Oct 11, 2026, 9:05 AM' */
export function formatInTz(
  date: Date | string,
  tz: string,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }).format(d)
}

/** Parse 'HH:MM' into minutes since midnight. Returns null when malformed. */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Days between two instants, fractional. */
export function daysBetween(a: Date | string, b: Date | string): number {
  const da = typeof a === 'string' ? new Date(a) : a
  const db = typeof b === 'string' ? new Date(b) : b
  return (db.getTime() - da.getTime()) / 86_400_000
}
