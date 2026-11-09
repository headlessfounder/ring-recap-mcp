import type { CameraInfo, RawVideo, RingSession } from './client.js'
import { dayRange, localDay } from '../util/time.js'
import { log } from '../util/log.js'

/**
 * Ring returns at most this many rows per videoSearch call, newest first, and ignores order=asc
 * (measured 2026-11-08; the spec assumed 100). A full page means the window was truncated, so it
 * gets split. Splitting does not depend on which end Ring kept, so a future order change is harmless.
 */
export const SEARCH_CAP = 20
const FOUR_HOURS = 4 * 3_600_000
const MIN_WINDOW = 60_000

export interface ClipUrls {
  hq: string | null
  untranscoded: string | null
  lq: string | null
}

export interface ClipRecord {
  dingId: string
  cameraId: string
  cameraName: string
  day: string
  createdAt: number
  durationS: number | null
  kind: string | null
  personDetected: 0 | 1 | null
  state: string | null
  urls: ClipUrls
}

function urlOrNull(u: unknown): string | null {
  return typeof u === 'string' && /^https?:\/\//.test(u) ? u : null
}

function personFlag(v: unknown): 0 | 1 | null {
  if (v === true || v === 1 || v === 'true') return 1
  if (v === false || v === 0 || v === 'false') return 0
  return null
}

export function normalize(raw: RawVideo, cam: Pick<CameraInfo, 'id' | 'name'>, tz: string): ClipRecord | null {
  const dingId = raw?.ding_id != null ? String(raw.ding_id) : ''
  const createdAt = typeof raw?.created_at === 'number' ? raw.created_at : Date.parse(String(raw?.created_at))
  if (!dingId || !Number.isFinite(createdAt)) return null
  const duration = Number(raw.duration)
  return {
    dingId,
    cameraId: cam.id,
    cameraName: cam.name,
    day: localDay(createdAt, tz),
    createdAt,
    durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
    kind: raw.kind ? String(raw.kind) : null,
    personDetected: personFlag(raw.cv_properties?.person_detected),
    state: raw.state ? String(raw.state) : null,
    urls: {
      hq: urlOrNull(raw.hq_url),
      untranscoded: urlOrNull(raw.untranscoded_url),
      lq: urlOrNull(raw.lq_url),
    },
  }
}

/** Splits [from, to) into 4 hour windows (the first split) or halves (deeper splits). */
export function splitWindow(from: number, to: number, isWholeDay: boolean): Array<[number, number]> {
  if (isWholeDay) {
    const out: Array<[number, number]> = []
    for (let s = from; s < to; s += FOUR_HOURS) out.push([s, Math.min(to, s + FOUR_HOURS)])
    return out
  }
  const mid = from + Math.floor((to - from) / 2)
  return [
    [from, mid],
    [mid, to],
  ]
}

type SearchFn = (from: number, to: number) => Promise<RawVideo[]>

/** Queries a window; if Ring returns a full page, splits it and queries again. */
export async function searchAll(search: SearchFn, from: number, to: number): Promise<RawVideo[]> {
  const seen = new Map<string, RawVideo>()
  const walk = async (a: number, b: number, wholeDay: boolean): Promise<void> => {
    const rows = await search(a, b)
    if (rows.length >= SEARCH_CAP && b - a > MIN_WINDOW) {
      log.info({ from: a, to: b, rows: rows.length }, 'videoSearch hit the cap; splitting window')
      for (const [x, y] of splitWindow(a, b, wholeDay)) await walk(x, y, false)
      return
    }
    if (rows.length >= SEARCH_CAP) log.warn({ from: a, to: b }, 'videoSearch still capped at minimum window; some clips may be missing')
    for (const r of rows) if (r?.ding_id != null) seen.set(String(r.ding_id), r)
    if (rows.length > SEARCH_CAP) log.info({ rows: rows.length }, 'videoSearch returned more rows than the known cap')
  }
  await walk(from, to, true)
  return [...seen.values()]
}

/** Every clip Ring has for one camera on one local day, oldest first. */
export async function fetchDayClips(
  ring: RingSession,
  cam: CameraInfo,
  day: string,
  tz: string,
): Promise<ClipRecord[]> {
  const { from, to } = dayRange(day, tz)
  const rows = await searchAll((a, b) => ring.videoSearch(cam.id, a, b), from, to)
  return rows
    .map((r) => normalize(r, cam, tz))
    .filter((c): c is ClipRecord => !!c && c.day === day && c.createdAt >= from && c.createdAt < to)
    .sort((a, b) => a.createdAt - b.createdAt)
}
