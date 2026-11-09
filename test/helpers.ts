import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveConfig, type ResolvedConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { Ledger } from '../src/db/ledger.js'
import type { CameraInfo, RawVideo, RingSession } from '../src/ring/client.js'
import { dayRange } from '../src/util/time.js'

export const TZ = 'America/New_York'
export const DAY = '2026-11-07'

export function tempVault(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ring-recap-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function testConfig(vaultDir: string, extra: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig({ vaultDir, timezone: TZ, minFreeDiskGB: 0, ...extra }, path.join(vaultDir, 'config.json'))
}

export interface FakeRing {
  cameras: CameraInfo[]
  videos: Map<string, RawVideo[]>
  searchCalls: Array<{ cameraId: string; from: number; to: number }>
}

/** Ring stand-in: like the real API, returns the newest 20 rows in the window, newest first. */
export function fakeRing(f: FakeRing): RingSession {
  return {
    cameras: async () => f.cameras,
    videoSearch: async (cameraId: string, from: number, to: number) => {
      f.searchCalls.push({ cameraId, from, to })
      return (f.videos.get(cameraId) ?? [])
        .filter((v) => v.created_at >= from && v.created_at < to)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 20)
    },
    lastEventAt: async () => null,
    recordingUrl: async () => null,
    dispose: () => {},
  } as unknown as RingSession
}

export function makeCtx(config: ResolvedConfig, ring: RingSession): AppContext {
  return { config, ledger: new Ledger(config.vault.ledger), ring }
}

export function camera(id: string, name: string, online = true): CameraInfo {
  return { id, name, online, model: 'Stick Up Cam', deviceType: 'stickup_cam', e2eeFlag: false }
}

export function video(dingId: string, createdAt: number, baseUrl: string, extra: Partial<RawVideo> = {}): RawVideo {
  return {
    ding_id: dingId,
    created_at: createdAt,
    hq_url: `${baseUrl}/hq/${dingId}.mp4`,
    lq_url: `${baseUrl}/lq/${dingId}.mp4`,
    untranscoded_url: `${baseUrl}/raw/${dingId}.mp4`,
    preroll_duration: null,
    thumbnail_url: '',
    kind: 'motion',
    state: 'completed',
    had_subscription: true,
    favorite: false,
    duration: 12,
    cv_properties: { person_detected: true, stream_broken: null, detection_type: null },
    ...extra,
  } as RawVideo
}

/** Evenly spaced times across the local test day. */
export function timesInDay(n: number, day = DAY): number[] {
  const { from, to } = dayRange(day, TZ)
  const step = Math.floor((to - from) / (n + 1))
  return Array.from({ length: n }, (_, i) => from + step * (i + 1))
}

/** Local HTTP server that plays the role of Ring's CDN. */
export async function fakeCdn(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean) {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (handler?.(req, res)) return
    if (req.url?.startsWith('/hq/')) {
      res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.alloc(2048, 7))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => server.close(() => r())) }
}
