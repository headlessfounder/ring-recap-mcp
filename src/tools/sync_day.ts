import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { REPO_DIR } from '../config.js'
import type { AppContext } from '../context.js'
import { AVAILABLE_STAGES, STAGES, type Stage } from '../pipeline/sync.js'
import { readLock } from '../util/fsx.js'
import { sleep } from '../util/retry.js'
import { assertDay, yesterday } from '../util/time.js'
import { defineTool } from './types.js'

const WAIT_MS = 50_000

function runSummary(ctx: AppContext, runId: number) {
  const run = ctx.ledger.getRun(runId)
  if (!run) return undefined
  let notes: unknown = run.notes
  try {
    notes = run.notes ? JSON.parse(run.notes) : null
  } catch {
    // keep raw
  }
  return {
    runId: run.id,
    day: run.day,
    finished: run.finished_at !== null,
    found: run.clips_found,
    done: run.clips_done,
    failed: run.clips_failed,
    durationS: run.finished_at ? Math.round((run.finished_at - run.started_at) / 1000) : null,
    details: notes,
  }
}

/**
 * MCP clients time out long tool calls, and a full day can take most of an hour.
 * So the tool runs the sync in a detached child process, waits up to ~50 s, and
 * returns either the finished summary or a progress snapshot.
 */
export const syncDayTool = defineTool({
  name: 'sync_day',
  title: 'Sync one day of Ring clips',
  description:
    'Pulls, transcribes, describes and recaps every clip at the configured location for a date (default yesterday). Idempotent: only clips not already done are processed. Returns the run summary, or progress if it is still running (call again to check).',
  inputSchema: {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, local time. Defaults to yesterday.'),
    stage: z.enum(STAGES).optional().describe('Stop after this stage (download, audio, frames, describe, faces) or run everything (all).'),
  },
  readOnly: false,
  handler: async (ctx, args) => {
    const day = assertDay(args.date ?? yesterday(ctx.config.timezone))
    const stage: Stage = args.stage ?? (AVAILABLE_STAGES.includes('all') ? 'all' : AVAILABLE_STAGES[AVAILABLE_STAGES.length - 1])
    if (!AVAILABLE_STAGES.includes(stage)) throw new Error(`Stage "${stage}" is not available yet`)
    const holder = readLock(ctx.config.vault.lock)
    if (holder) {
      return {
        json: { status: 'already_running', holder, progress: holder.day ? ctx.ledger.countsForDay(holder.day) : null },
      }
    }
    const before = ctx.ledger.lastRun()?.id ?? 0
    const out = openSync(path.join(ctx.config.vault.logs, 'sync-child.log'), 'a')
    const child = spawn(
      process.execPath,
      [path.join(REPO_DIR, 'dist', 'index.js'), '--run', 'sync_day', '--date', day, '--stage', stage],
      { detached: true, stdio: ['ignore', out, out], env: process.env },
    )
    let exited: number | null | undefined
    child.on('exit', (code) => (exited = code))
    child.unref()
    const deadline = Date.now() + WAIT_MS
    let runId: number | undefined
    while (Date.now() < deadline) {
      await sleep(1000)
      const last = ctx.ledger.lastRun()
      if (last && last.id > before && last.day === day) runId = last.id
      if (exited !== undefined) break
    }
    if (runId === undefined) {
      if (exited !== undefined && exited !== 0) {
        return { json: { status: 'failed_to_start', exitCode: exited, log: path.join(ctx.config.vault.logs, 'sync-child.log') } }
      }
      return { json: { status: 'starting', pid: child.pid, day } }
    }
    const summary = runSummary(ctx, runId)
    if (summary?.finished) return { json: { status: exited === 0 ? 'finished' : 'finished_with_error', exitCode: exited, ...summary } }
    return {
      json: {
        status: 'running',
        pid: child.pid,
        day,
        progress: ctx.ledger.countsForDay(day),
        hint: 'Still working. Call sync_day or health again later for the final summary.',
      },
    }
  },
})
