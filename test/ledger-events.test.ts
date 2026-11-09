import { afterEach, describe, expect, it } from 'vitest'
import { Ledger, ftsQuery } from '../src/db/ledger.js'
import { normalize, searchAll, splitWindow } from '../src/ring/events.js'
import type { RawVideo } from '../src/ring/client.js'
import { dayRange } from '../src/util/time.js'
import { DAY, TZ, camera, tempVault, timesInDay, video } from './helpers.js'

const vaults: Array<() => void> = []
afterEach(() => vaults.splice(0).forEach((c) => c()))

describe('events', () => {
  it('normalizes ring rows', () => {
    const [t] = timesInDay(1)
    const c = normalize(video('123', t, 'https://x', { hq_url: null }), camera('9', 'Back door'), TZ)!
    expect(c.dingId).toBe('123')
    expect(c.day).toBe(DAY)
    expect(c.personDetected).toBe(1)
    expect(c.urls.hq).toBeNull()
    expect(c.urls.lq).toBe('https://x/lq/123.mp4')
  })

  it('splits the day into 4 hour windows, then halves', () => {
    const { from, to } = dayRange(DAY, TZ)
    expect(splitWindow(from, to, true)).toHaveLength(6)
    const halves = splitWindow(from, from + 4 * 3_600_000, false)
    expect(halves).toEqual([
      [from, from + 2 * 3_600_000],
      [from + 2 * 3_600_000, from + 4 * 3_600_000],
    ])
  })

  it('recovers every clip when Ring caps results at 20, newest first', async () => {
    const times = timesInDay(250)
    const all = times.map((t, i) => video(String(1000 + i), t, 'https://x'))
    const { from, to } = dayRange(DAY, TZ)
    let calls = 0
    const rows = await searchAll(
      async (a, b) => {
        calls++
        return all
          .filter((v) => v.created_at >= a && v.created_at < b)
          .sort((x, y) => y.created_at - x.created_at)
          .slice(0, 20) as RawVideo[]
      },
      from,
      to,
    )
    expect(rows).toHaveLength(250)
    expect(new Set(rows.map((r) => r.ding_id)).size).toBe(250)
    expect(calls).toBeGreaterThan(6)
  })

  it('handles a burst of clips inside one busy hour', async () => {
    const { from } = dayRange(DAY, TZ)
    const burst = Array.from({ length: 70 }, (_, i) => video(`b${i}`, from + 14 * 3_600_000 + i * 45_000, 'https://x'))
    const rows = await searchAll(
      async (a, b) => burst.filter((v) => v.created_at >= a && v.created_at < b).sort((x, y) => y.created_at - x.created_at).slice(0, 20) as RawVideo[],
      from,
      from + 86_400_000,
    )
    expect(rows).toHaveLength(70)
  })
})

describe('ledger', () => {
  it('upserts, keeps done clips done, and searches with FTS', () => {
    const v = tempVault()
    vaults.push(v.cleanup)
    const l = new Ledger(`${v.dir}/ledger.sqlite`)
    const [t1, t2] = timesInDay(2)
    const c1 = normalize(video('1', t1, 'https://x'), camera('9', 'Back door'), TZ)!
    const c2 = normalize(video('2', t2, 'https://x'), camera('9', 'Back door'), TZ)!
    expect(l.upsertFound(c1)).toBe('new')
    expect(l.upsertFound(c2)).toBe('new')
    l.update('1', { transcript: 'hello forklift', description: 'Two people move a pallet.', tags_json: JSON.stringify({ tags: ['pallet'], notable: true }) })
    l.markDone('1')
    expect(l.upsertFound({ ...c1, cameraName: 'Back Door (renamed)' })).toBe('existing')
    expect(l.get('1')!.status).toBe('done')
    expect(l.get('1')!.camera_name).toBe('Back Door (renamed)')
    expect(l.search({ query: 'pallet' }).map((h) => h.ding_id)).toEqual(['1'])
    expect(l.search({ query: 'renamed' })).toHaveLength(1) // FTS camera name follows the rename
    expect(l.search({ query: 'notable' })).toHaveLength(1)
    expect(l.search({ query: 'forklift', camera: 'back door (renamed)' })).toHaveLength(1)
    expect(l.search({ query: 'forklift', from: '2026-11-08' })).toHaveLength(0)
    // FTS syntax in user input must not throw
    expect(() => l.search({ query: 'back-door "AND OR (' })).not.toThrow()
    expect(ftsQuery('a-b "c')).toBe('"a" "b" "c"')
    // failures and retry bookkeeping
    expect(l.markFailed('2', 'boom')).toBe(1)
    expect(l.isRetryable(l.get('2')!)).toBe(true)
    l.markFailed('2', 'boom again')
    expect(l.isRetryable(l.get('2')!)).toBe(false)
    expect(l.countsForDay(DAY)).toEqual({ done: 1, failed: 1 })
    l.setKv('auth', { status: 'ok' })
    expect(l.getKv<{ status: string }>('auth')!.status).toBe('ok')
    l.close()
  })
})
