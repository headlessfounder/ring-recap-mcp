import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayRange,
  isAfterHours,
  isDay,
  localDay,
  localTime12,
  localTime24,
  yesterday,
  zonedMidnight,
} from '../src/util/time.js'

const NY = 'America/New_York'
const iso = (ms: number) => new Date(ms).toISOString()

describe('time', () => {
  it('validates days', () => {
    expect(isDay('2026-11-07')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('2026-1-7')).toBe(false)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('finds local midnight in EST and EDT', () => {
    expect(iso(zonedMidnight('2026-11-07', NY))).toBe('2026-11-07T05:00:00.000Z') // EST
    expect(iso(zonedMidnight('2026-07-04', NY))).toBe('2026-07-04T04:00:00.000Z') // EDT
  })

  it('handles 25 and 23 hour DST days', () => {
    const fall = dayRange('2026-11-01', NY) // DST ends 2 AM Nov 1 2026
    expect((fall.to - fall.from) / 3_600_000).toBe(25)
    const spring = dayRange('2026-03-08', NY) // DST starts 2 AM Mar 8 2026
    expect((spring.to - spring.from) / 3_600_000).toBe(23)
    const normal = dayRange('2026-11-07', NY)
    expect((normal.to - normal.from) / 3_600_000).toBe(24)
  })

  it('maps instants back to local day and time', () => {
    const t = Date.parse('2026-11-08T03:14:00Z') // 10:14 PM EST on Nov 7
    expect(localDay(t, NY)).toBe('2026-11-07')
    expect(localTime24(t, NY)).toBe('22:14')
    expect(localTime12(t, NY)).toBe('10:14 PM')
    expect(isAfterHours(t, NY)).toBe(true)
    expect(isAfterHours(Date.parse('2026-11-07T17:00:00Z'), NY)).toBe(false) // noon
    expect(localTime12(Date.parse('2026-11-07T05:05:00Z'), NY)).toBe('12:05 AM')
  })

  it('computes yesterday in the configured zone, not UTC', () => {
    // 11:30 PM Nov 8 EST is already Nov 9 in UTC
    expect(yesterday(NY, Date.parse('2026-11-09T04:30:00Z'))).toBe('2026-11-07')
    expect(yesterday(NY, Date.parse('2026-11-09T05:30:00Z'))).toBe('2026-11-08')
  })
})
