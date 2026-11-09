/** Timezone math without a dependency. All "day" strings are YYYY-MM-DD in the configured zone. */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const partsFormatters = new Map<string, Intl.DateTimeFormat>()
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
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

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function wallClock(epochMs: number, tz: string): WallClock {
  const out: Record<string, number> = {}
  for (const p of partsFormatter(tz).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  }
}

/** Offset of tz from UTC at the given instant, in ms (e.g. -5h for EST). */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const w = wallClock(epochMs, tz)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - (epochMs - (epochMs % 1000 + 1000) % 1000)
}

export function isDay(s: string): boolean {
  const m = DAY_RE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

export function assertDay(s: string): string {
  if (!isDay(s)) throw new Error(`Invalid date "${s}", expected YYYY-MM-DD`)
  return s
}

export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(assertDay(day))!
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n))
  return d.toISOString().slice(0, 10)
}

/** Epoch ms of local midnight that starts `day` in `tz`. */
export function zonedMidnight(day: string, tz: string): number {
  const m = DAY_RE.exec(assertDay(day))!
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const off1 = tzOffsetMs(guess - tzOffsetMs(guess, tz), tz)
  let t = guess - off1
  // Second pass settles DST transitions that land near midnight.
  const off2 = tzOffsetMs(t, tz)
  if (off2 !== off1) t = guess - off2
  return t
}

/** [from, to) epoch ms for a local day. Handles 23 and 25 hour DST days. */
export function dayRange(day: string, tz: string): { from: number; to: number } {
  return { from: zonedMidnight(day, tz), to: zonedMidnight(addDays(day, 1), tz) }
}

export function localDay(epochMs: number, tz: string): string {
  const w = wallClock(epochMs, tz)
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`
}

export function yesterday(tz: string, now = Date.now()): string {
  return addDays(localDay(now, tz), -1)
}

/** "22:14" */
export function localTime24(epochMs: number, tz: string): string {
  const w = wallClock(epochMs, tz)
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
}

/** "10:14 PM" */
export function localTime12(epochMs: number, tz: string): string {
  const w = wallClock(epochMs, tz)
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12
  return `${h}:${String(w.minute).padStart(2, '0')} ${w.hour < 12 ? 'AM' : 'PM'}`
}

export function localHour(epochMs: number, tz: string): number {
  return wallClock(epochMs, tz).hour
}

/** After 10 PM or before 6 AM local. */
export function isAfterHours(epochMs: number, tz: string): boolean {
  const h = localHour(epochMs, tz)
  return h >= 22 || h < 6
}
