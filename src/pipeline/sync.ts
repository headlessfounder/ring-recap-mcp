import { existsSync } from 'node:fs'
import type { AppContext } from '../context.js'
import type { ClipRow } from '../db/ledger.js'
import { isAuthError, type CameraInfo } from '../ring/client.js'
import { DownloadFailedError, downloadClip, StillProcessingError } from '../ring/download.js'
import { fetchDayClips, type ClipRecord } from '../ring/events.js'
import { acquireLock, freeBytes } from '../util/fsx.js'
import { errMsg, log } from '../util/log.js'
import { mapLimit } from '../util/retry.js'
import { addDays, assertDay, yesterday } from '../util/time.js'
import { clipPaths } from './paths.js'

export const STAGES = ['download', 'audio', 'frames', 'describe', 'faces', 'all'] as const
export type Stage = (typeof STAGES)[number]

/** Stages implemented so far; later phases extend this list. */
export const AVAILABLE_STAGES: readonly Stage[] = ['download']

export interface SyncOptions {
  day?: string
  stage?: Stage
}

export interface SyncSummary {
  runId: number
  day: string
  stage: Stage
  found: number
  new: number
  processed: number
  downloadedNow: number
  done: number
  failed: number
  pending: number
  durationS: number
  camerasOffline: string[]
  warnings: string[]
}

export class DiskSpaceError extends Error {
  readonly code = 'disk_low'
}

export interface Counters {
  downloadedNow: number
  stillProcessing: number
  failedNow: number
  completedStage: number
}

interface CameraDownloadStats {
  attempted: number
  failed4xx: number
}

function rowToRecord(row: ClipRow, cam?: CameraInfo): ClipRecord {
  return {
    dingId: row.ding_id,
    cameraId: row.camera_id,
    cameraName: cam?.name ?? row.camera_name,
    day: row.day,
    createdAt: row.created_at,
    durationS: row.duration_s,
    kind: row.kind,
    personDetected: row.person_detected === null ? null : row.person_detected ? 1 : 0,
    state: 'completed',
    urls: { hq: null, untranscoded: null, lq: null },
  }
}

/** Download step. Returns false if the clip must wait for a later run. */
async function stepDownload(
  ctx: AppContext,
  clip: ClipRecord,
  row: ClipRow,
  counters: Counters,
  stats: CameraDownloadStats,
): Promise<boolean> {
  const p = clipPaths(ctx.config.vault, clip.day, clip.cameraId, clip.dingId)
  if (existsSync(p.mp4)) {
    if (row.status === 'queued' || row.status === 'failed') ctx.ledger.update(clip.dingId, { status: 'downloaded' })
    return true
  }
  // A clip whose later stages already ran does not need its video again.
  if (row.description !== null && row.transcript !== null) return true
  stats.attempted++
  try {
    const r = await downloadClip(clip, p.mp4, () => ctx.ring.recordingUrl(clip.cameraId, clip.dingId, false))
    ctx.ledger.update(clip.dingId, { status: 'downloaded', bytes: r.bytes, error: null })
    counters.downloadedNow++
    log.debug({ dingId: clip.dingId, bytes: r.bytes, source: r.source }, 'downloaded')
    return true
  } catch (e) {
    if (e instanceof StillProcessingError) {
      counters.stillProcessing++
      ctx.ledger.update(clip.dingId, { status: 'queued', error: 'still processing on Ring; requeued' })
      return false
    }
    // 401/403 on every source is what a camera with E2EE on looks like; 404 just means no recording.
    if (e instanceof DownloadFailedError && e.statuses.length && e.statuses.every((s) => s === 401 || s === 403)) {
      stats.failed4xx++
    }
    if (e instanceof DownloadFailedError && e.statuses.length && e.statuses.every((s) => s === 404)) {
      throw new Error(`recording_unavailable: Ring has no video for this event (404 on every URL)`)
    }
    throw e
  }
}

async function processClip(
  ctx: AppContext,
  clip: ClipRecord,
  stage: Stage,
  counters: Counters,
  stats: CameraDownloadStats,
): Promise<void> {
  const row = ctx.ledger.get(clip.dingId)
  if (!row || !ctx.ledger.isRetryable(row)) return
  try {
    if (!(await stepDownload(ctx, clip, row, counters, stats))) return
    if (stage === 'download') {
      counters.completedStage++
      return
    }
    throw new Error(`Stage "${stage}" is not built yet`)
  } catch (e) {
    if (isAuthError(e)) throw e
    const attempts = ctx.ledger.markFailed(clip.dingId, errMsg(e))
    counters.failedNow++
    log.warn({ dingId: clip.dingId, camera: clip.cameraName, attempts, err: errMsg(e) }, 'clip failed')
  }
}

export async function syncDay(ctx: AppContext, opts: SyncOptions = {}): Promise<SyncSummary> {
  const { config, ledger, ring } = ctx
  const day = assertDay(opts.day ?? yesterday(config.timezone))
  const stage: Stage = opts.stage ?? 'all'
  if (!AVAILABLE_STAGES.includes(stage)) {
    throw new Error(`Stage "${stage}" is not available yet. Available: ${AVAILABLE_STAGES.join(', ')}`)
  }
  const free = freeBytes(config.vault.root)
  if (free < config.minFreeDiskGB * 1e9) {
    throw new DiskSpaceError(
      `Refusing to sync: ${(free / 1e9).toFixed(1)} GB free on the vault disk, need ${config.minFreeDiskGB} GB`,
    )
  }
  const release = acquireLock(config.vault.lock, { day })
  const started = Date.now()
  const runId = ledger.startRun(day, JSON.stringify({ stage, status: 'running' }))
  const warnings: string[] = []
  const counters: Counters = { downloadedNow: 0, stillProcessing: 0, failedNow: 0, completedStage: 0 }
  let found = 0
  let fresh = 0
  let camerasOffline: string[] = []
  try {
    const cameras = await ring.cameras()
    camerasOffline = cameras.filter((c) => !c.online).map((c) => c.name)
    ledger.setKv('cameras', { at: Date.now(), cameras })
    log.info({ day, stage, cameras: cameras.length, offline: camerasOffline }, 'sync start')

    // 1. find every clip for the day, per camera
    const records = new Map<string, ClipRecord>()
    const camById = new Map(cameras.map((c) => [c.id, c]))
    for (const cam of cameras) {
      try {
        const clips = await fetchDayClips(ring, cam, day, config.timezone)
        if (clips.length === 0 && cam.online) warnings.push(`${cam.name}: online but returned zero events for ${day}`)
        for (const c of clips) records.set(c.dingId, c)
        log.info({ camera: cam.name, cameraId: cam.id, clips: clips.length }, 'camera searched')
      } catch (e) {
        if (isAuthError(e)) throw e
        warnings.push(`${cam.name}: search failed (${errMsg(e)})`)
        log.error({ camera: cam.name, err: errMsg(e) }, 'camera search failed')
      }
    }
    found = records.size
    for (const c of records.values()) if (ledger.upsertFound(c) === 'new') fresh++

    // 2. process everything not done for the day (includes earlier failures with retries left)
    const todo = ledger
      .forDay(day)
      .filter((r) => ledger.isRetryable(r))
      .map((r) => records.get(r.ding_id) ?? rowToRecord(r, camById.get(r.camera_id)))
    const perCamera = new Map<string, CameraDownloadStats>()
    const statsFor = (id: string) => {
      let s = perCamera.get(id)
      if (!s) perCamera.set(id, (s = { attempted: 0, failed4xx: 0 }))
      return s
    }
    const results = await mapLimit(todo, config.concurrency, (clip) =>
      processClip(ctx, clip, stage, counters, statsFor(clip.cameraId)),
    )
    const authFailure = results.find((r) => !r.ok && isAuthError(r.error))
    if (authFailure && !authFailure.ok) throw authFailure.error

    // 3. E2EE heuristic: every download on a camera rejected with 4xx
    const suspects = [...perCamera.entries()]
      .filter(([, s]) => s.attempted >= 3 && s.failed4xx === s.attempted)
      .map(([id]) => camById.get(id)?.name ?? id)
    const flagged = cameras.filter((c) => c.e2eeFlag).map((c) => c.name)
    const attempted = [...perCamera.values()].some((s) => s.attempted > 0)
    // Only a run that actually tried downloads (or saw an explicit flag) may change the verdict.
    if (attempted || flagged.length) {
      const encryption = {
        detected: suspects.length + flagged.length > 0,
        cameras: [...new Set([...suspects, ...flagged])],
        at: Date.now(),
      }
      ledger.setKv('encryption', encryption)
      if (encryption.detected) {
        warnings.push(`Downloads rejected on ${encryption.cameras.join(', ')}. End-to-end encryption may be on.`)
      }
    }
  } finally {
    const counts = ledger.countsForDay(day)
    const summary = {
      stage,
      found,
      new: fresh,
      ...counters,
      counts,
      warnings,
      camerasOffline,
      durationS: Math.round((Date.now() - started) / 1000),
    }
    ledger.finishRun(runId, {
      found,
      done: counts.done ?? 0,
      failed: counts.failed ?? 0,
      notes: JSON.stringify(summary),
    })
    release()
  }
  const counts = ledger.countsForDay(day)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const summary: SyncSummary = {
    runId,
    day,
    stage,
    found,
    new: fresh,
    processed: counters.completedStage,
    downloadedNow: counters.downloadedNow,
    done: counts.done ?? 0,
    failed: counts.failed ?? 0,
    pending: total - (counts.done ?? 0) - (counts.failed ?? 0),
    durationS: Math.round((Date.now() - started) / 1000),
    camerasOffline,
    warnings,
  }
  log.info(summary, 'sync finished')
  return summary
}

/**
 * The nightly entry point: yesterday, plus any of the previous 7 days that still have
 * retryable clips (failures get exactly one more try on the next run).
 */
export async function syncScheduled(ctx: AppContext, stage: Stage = 'all'): Promise<SyncSummary[]> {
  const target = yesterday(ctx.config.timezone)
  const extra = ctx.ledger.daysNeedingWork(addDays(target, -7), target)
  const out: SyncSummary[] = []
  for (const day of [...extra, target]) out.push(await syncDay(ctx, { day, stage }))
  return out
}
