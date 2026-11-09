import { z } from 'zod'
import type { AppContext } from '../context.js'
import type { AuthState, CameraInfo } from '../ring/client.js'
import { dirBytes, freeBytes, readLock } from '../util/fsx.js'
import { errMsg } from '../util/log.js'
import { addDays, yesterday } from '../util/time.js'
import { defineTool } from './types.js'

export async function health(ctx: AppContext, opts: { live?: boolean } = {}) {
  const { ledger, config } = ctx
  let cameras = ledger.getKv<{ at: number; cameras: CameraInfo[] }>('cameras')
  let liveError: string | undefined
  if (opts.live !== false) {
    try {
      const cams = await ctx.ring.cameras({ fresh: true })
      cameras = { at: Date.now(), cameras: cams }
      ledger.setKv('cameras', cameras)
    } catch (e) {
      liveError = errMsg(e)
      const code = (e as { code?: string }).code
      if (code === 'no_token' || code === 'auth_expired') {
        ledger.setKv('auth', { status: code, at: Date.now(), message: liveError } satisfies AuthState)
      }
    }
  }
  const auth: { status: string; at: number; message?: string } = ledger.getKv<AuthState>('auth') ?? {
    status: 'unknown',
    at: 0,
  }
  const last = ledger.lastRun()
  let lastNotes: Record<string, unknown> | null = null
  try {
    lastNotes = last?.notes ? JSON.parse(last.notes) : null
  } catch {
    lastNotes = null
  }
  const since = addDays(yesterday(config.timezone), -6)
  const failed = ledger.db
    .prepare(
      `SELECT ding_id, day, camera_name, attempts, error FROM clips WHERE status = 'failed' AND day >= ?
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(since)
  const encryption = ledger.getKv<{ detected: boolean; cameras: string[] }>('encryption')
  const e2eeFlagged = (cameras?.cameras ?? []).filter((c) => c.e2eeFlag).map((c) => c.name)
  return {
    auth: auth.status,
    authMessage: auth.message,
    authCheckedAt: auth.at ? new Date(auth.at).toISOString() : null,
    liveCheckError: liveError,
    lastRun: last
      ? {
          id: last.id,
          day: last.day,
          startedAt: new Date(last.started_at).toISOString(),
          finishedAt: last.finished_at ? new Date(last.finished_at).toISOString() : null,
          found: last.clips_found,
          done: last.clips_done,
          failed: last.clips_failed,
          warnings: (lastNotes?.warnings as string[] | undefined) ?? [],
        }
      : null,
    syncRunning: readLock(config.vault.lock) ?? null,
    camerasOffline: (cameras?.cameras ?? []).filter((c) => !c.online).map((c) => ({ id: c.id, name: c.name })),
    camerasCheckedAt: cameras?.at ? new Date(cameras.at).toISOString() : null,
    failedClips: ledger.failedCount(since),
    failedClipsRecent: failed,
    vaultBytes: await dirBytes(config.vault.root),
    diskFreeBytes: freeBytes(config.vault.root),
    encryptionDetected: !!encryption?.detected || e2eeFlagged.length > 0,
    encryptionCameras: [...new Set([...(encryption?.cameras ?? []), ...e2eeFlagged])],
  }
}

export const healthTool = defineTool({
  name: 'health',
  title: 'Ring recap health',
  description:
    'Auth state, last run, offline cameras, failed clips (last 7 days), vault size, free disk and whether end-to-end encryption looks enabled.',
  inputSchema: {
    live: z.boolean().optional().describe('Check Ring live (default true). false = report cached state only.'),
  },
  readOnly: true,
  handler: async (ctx, args) => ({ json: await health(ctx, { live: args.live }) }),
})
