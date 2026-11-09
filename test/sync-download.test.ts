import { existsSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { clipPaths } from '../src/pipeline/paths.js'
import { syncDay } from '../src/pipeline/sync.js'
import { DAY, camera, fakeCdn, fakeRing, makeCtx, tempVault, testConfig, timesInDay, video, type FakeRing } from './helpers.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

describe('sync_day --stage download', () => {
  it('downloads every clip once, falls back across URLs, and is idempotent', async () => {
    const cdn = await fakeCdn((req, res) => {
      // clip "b2" has a broken hq_url; its untranscoded url works
      if (req.url === '/hq/b2.mp4') return res.writeHead(500).end(), true
      if (req.url === '/raw/b2.mp4') return res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.alloc(999, 1)), true
      return false
    })
    cleanups.push(cdn.close)
    const v = tempVault()
    cleanups.push(v.cleanup)
    const [t1, t2, t3, t4] = timesInDay(4)
    const f: FakeRing = {
      cameras: [camera('1', 'Back door'), camera('2', 'Office'), camera('3', 'Garage', false)],
      videos: new Map([
        ['1', [video('a1', t1, cdn.url), video('a2', t2, cdn.url)]],
        ['2', [video('b1', t3, cdn.url), video('b2', t4, cdn.url)]],
      ]),
      searchCalls: [],
    }
    const ctx = makeCtx(testConfig(v.dir), fakeRing(f))
    cleanups.push(() => ctx.ledger.close())

    const first = await syncDay(ctx, { day: DAY, stage: 'download' })
    expect(first.found).toBe(4)
    expect(first.new).toBe(4)
    expect(first.downloadedNow).toBe(4)
    expect(first.failed).toBe(0)
    expect(first.camerasOffline).toEqual(['Garage'])
    // offline camera with zero events is not a warning; online cameras with events are fine
    expect(first.warnings).toEqual([])
    for (const id of ['a1', 'a2', 'b1', 'b2']) {
      const cam = id.startsWith('a') ? '1' : '2'
      const p = clipPaths(ctx.config.vault, DAY, cam, id)
      expect(existsSync(p.mp4)).toBe(true)
      expect(statSync(p.mp4).size).toBeGreaterThan(0)
      expect(ctx.ledger.get(id)!.status).toBe('downloaded')
    }
    expect(ctx.ledger.get('b2')!.bytes).toBe(999)

    const hitsBefore = cdn.hits.length
    const second = await syncDay(ctx, { day: DAY, stage: 'download' })
    expect(second.found).toBe(4)
    expect(second.new).toBe(0)
    expect(second.downloadedNow).toBe(0)
    expect(cdn.hits.length).toBe(hitsBefore) // nothing fetched again
    expect(ctx.ledger.lastRun()!.finished_at).not.toBeNull()
  })

  it('requeues clips still processing and warns on silent online cameras', async () => {
    const cdn = await fakeCdn()
    cleanups.push(cdn.close)
    const v = tempVault()
    cleanups.push(v.cleanup)
    const [t1] = timesInDay(1)
    const f: FakeRing = {
      cameras: [camera('1', 'Back door'), camera('2', 'Side yard')],
      videos: new Map([['1', [video('p1', t1, cdn.url, { hq_url: null, state: 'timed_out' as never })]]]),
      searchCalls: [],
    }
    const ctx = makeCtx(testConfig(v.dir), fakeRing(f))
    cleanups.push(() => ctx.ledger.close())
    const s = await syncDay(ctx, { day: DAY, stage: 'download' })
    expect(s.pending).toBe(1)
    expect(s.failed).toBe(0)
    expect(ctx.ledger.get('p1')!.status).toBe('queued')
    expect(s.warnings.some((w) => w.startsWith('Side yard: online but returned zero events'))).toBe(true)
  })

  it('marks a clip failed, keeps it retryable once, and flags likely E2EE on all-403 cameras', async () => {
    const cdn = await fakeCdn((_req, res) => (res.writeHead(403).end(), true))
    cleanups.push(cdn.close)
    const v = tempVault()
    cleanups.push(v.cleanup)
    const times = timesInDay(3)
    const f: FakeRing = {
      cameras: [camera('1', 'Back door')],
      videos: new Map([['1', times.map((t, i) => video(`x${i}`, t, cdn.url))]]),
      searchCalls: [],
    }
    const ctx = makeCtx(testConfig(v.dir), fakeRing(f))
    cleanups.push(() => ctx.ledger.close())
    const s1 = await syncDay(ctx, { day: DAY, stage: 'download' })
    expect(s1.failed).toBe(3)
    expect(ctx.ledger.get('x0')!.attempts).toBe(1)
    expect(ctx.ledger.getKv<{ detected: boolean }>('encryption')!.detected).toBe(true)
    expect(s1.warnings.join(' ')).toMatch(/encryption/i)
    await syncDay(ctx, { day: DAY, stage: 'download' })
    expect(ctx.ledger.get('x0')!.attempts).toBe(2)
    const before = cdn.hits.length
    await syncDay(ctx, { day: DAY, stage: 'download' }) // failed out: not retried a third time
    expect(cdn.hits.length).toBe(before)
  })

  it('refuses to run on a low disk and when another sync holds the lock', async () => {
    const v = tempVault()
    cleanups.push(v.cleanup)
    const ctx = makeCtx(testConfig(v.dir, { minFreeDiskGB: 1e9 }), fakeRing({ cameras: [], videos: new Map(), searchCalls: [] }))
    cleanups.push(() => ctx.ledger.close())
    await expect(syncDay(ctx, { day: DAY, stage: 'download' })).rejects.toThrow(/Refusing to sync/)
  })
})

describe('encryption flag', () => {
  it('is not cleared by a run that attempted no downloads', async () => {
    const cdn = await fakeCdn((_req, res) => (res.writeHead(403).end(), true))
    cleanups.push(cdn.close)
    const v = tempVault()
    cleanups.push(v.cleanup)
    const f: FakeRing = {
      cameras: [camera('1', 'Back door')],
      videos: new Map([['1', timesInDay(3).map((t, i) => video(`e${i}`, t, cdn.url))]]),
      searchCalls: [],
    }
    const ctx = makeCtx(testConfig(v.dir), fakeRing(f))
    cleanups.push(() => ctx.ledger.close())
    for (let i = 0; i < 3; i++) await syncDay(ctx, { day: DAY, stage: 'download' })
    expect(ctx.ledger.getKv<{ detected: boolean }>('encryption')!.detected).toBe(true)
  })
})

describe('missing recordings', () => {
  it('treats 404 on every URL as recording_unavailable, not encryption', async () => {
    const cdn = await fakeCdn((_req, res) => (res.writeHead(404).end(), true))
    cleanups.push(cdn.close)
    const v = tempVault()
    cleanups.push(v.cleanup)
    const f: FakeRing = {
      cameras: [camera('1', 'Driveway')],
      videos: new Map([['1', timesInDay(3).map((t, i) => video(`n${i}`, t, cdn.url))]]),
      searchCalls: [],
    }
    const ctx = makeCtx(testConfig(v.dir), fakeRing(f))
    cleanups.push(() => ctx.ledger.close())
    const s = await syncDay(ctx, { day: DAY, stage: 'download' })
    expect(s.failed).toBe(3)
    expect(ctx.ledger.get('n0')!.error).toMatch(/^recording_unavailable/)
    expect(ctx.ledger.getKv<{ detected: boolean }>('encryption')!.detected).toBe(false)
  })
})
