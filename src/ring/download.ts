import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ClipRecord } from './events.js'
import { errMsg, log } from '../util/log.js'
import { retry } from '../util/retry.js'

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/** A clip with no hq_url younger than this is assumed to still be processing on Ring's side. */
const PROCESSING_GRACE_MS = 45 * 60_000

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class StillProcessingError extends Error {
  readonly code = 'still_processing'
}

export class DownloadFailedError extends Error {
  constructor(
    message: string,
    /** HTTP statuses seen per source; all-4xx across a camera is the E2EE signature */
    readonly statuses: number[],
  ) {
    super(message)
  }
}

export function isStillProcessing(clip: ClipRecord, now = Date.now()): boolean {
  if (clip.urls.hq) return false
  if (clip.state && clip.state !== 'completed') return true
  return now - clip.createdAt < PROCESSING_GRACE_MS
}

async function fetchToFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`)
  }
  const type = res.headers.get('content-type') ?? ''
  if (/text\/html|xml|json/i.test(type)) {
    // S3/CloudFront error bodies come back 200 sometimes; never save them as video.
    throw new HttpError(415, `Unexpected content-type ${type}`)
  }
  const part = `${dest}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(part))
    const { size } = await stat(part)
    if (size <= 0) throw new Error('Downloaded file is empty')
    await rename(part, dest)
    return size
  } catch (e) {
    await rm(part, { force: true })
    throw e
  }
}

export interface DownloadResult {
  bytes: number
  source: string
}

/**
 * Downloads a clip to `dest`, trying hq -> untranscoded -> lq, then a freshly signed URL.
 * Each source gets 3 tries with jittered backoff; 4xx moves straight to the next source.
 */
export async function downloadClip(
  clip: ClipRecord,
  dest: string,
  fallbackUrl?: () => Promise<string | null>,
): Promise<DownloadResult> {
  if (isStillProcessing(clip)) {
    throw new StillProcessingError(`Clip ${clip.dingId} has no hq_url yet (state=${clip.state ?? 'unknown'})`)
  }
  await mkdir(path.dirname(dest), { recursive: true })
  const sources: Array<[string, string | null | (() => Promise<string | null>)]> = [
    ['hq', clip.urls.hq],
    ['untranscoded', clip.urls.untranscoded],
    ['lq', clip.urls.lq],
  ]
  if (fallbackUrl) sources.push(['recording_url', fallbackUrl])
  const statuses: number[] = []
  const errors: string[] = []
  for (const [name, src] of sources) {
    const url = typeof src === 'function' ? await src() : src
    if (!url) continue
    try {
      const bytes = await retry(() => fetchToFile(url, dest), {
        attempts: 3,
        baseMs: 1500,
        shouldRetry: (e) => !(e instanceof HttpError && e.status >= 400 && e.status < 500),
        onRetry: (e, n, wait) => log.debug({ dingId: clip.dingId, name, n, wait, err: errMsg(e) }, 'download retry'),
      })
      return { bytes, source: name }
    } catch (e) {
      if (e instanceof HttpError) statuses.push(e.status)
      errors.push(`${name}: ${errMsg(e)}`)
    }
  }
  if (!errors.length) throw new DownloadFailedError(`No download URL for clip ${clip.dingId}`, [])
  throw new DownloadFailedError(`Download failed for ${clip.dingId} (${errors.join('; ')})`, statuses)
}
