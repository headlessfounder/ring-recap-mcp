import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { ClipRecord } from '../ring/events.js'

export type ClipStatus = 'queued' | 'downloaded' | 'transcribed' | 'described' | 'faced' | 'done' | 'failed'

/** A clip that fails this many times is left alone (its mp4 is deleted after the second failure). */
export const MAX_ATTEMPTS = 2
/** recaps.camera_id used for the whole-location rollup */
export const ROLLUP_ID = 'site'

export interface ClipRow {
  ding_id: string
  camera_id: string
  camera_name: string
  day: string
  created_at: number
  duration_s: number | null
  kind: string | null
  person_detected: number | null
  status: ClipStatus
  error: string | null
  transcript: string | null
  description: string | null
  faces_json: string | null
  bytes: number | null
  updated_at: number
  attempts: number
  audio_state: string | null
  tags_json: string | null
}

export interface RunRow {
  id: number
  day: string
  started_at: number
  finished_at: number | null
  clips_found: number | null
  clips_done: number | null
  clips_failed: number | null
  notes: string | null
}

export interface RecapRow {
  day: string
  camera_id: string
  markdown: string
  json: string
  generated_at: number
}

export interface SearchHit {
  ding_id: string
  day: string
  created_at: number
  camera_id: string
  camera_name: string
  snippet: string
}

type Patch = Partial<Omit<ClipRow, 'ding_id' | 'updated_at'>>

const PATCHABLE = new Set([
  'camera_name', 'duration_s', 'kind', 'person_detected', 'status', 'error', 'transcript', 'description',
  'faces_json', 'bytes', 'attempts', 'audio_state', 'tags_json',
])

function schemaSql(): string {
  return readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
}

/** Quote every token so user text can never be parsed as FTS5 syntax. */
export function ftsQuery(q: string): string {
  const tokens = q.match(/[\p{L}\p{N}_']+/gu) ?? []
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

export class Ledger {
  readonly db: Database.Database

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 15000')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(schemaSql())
  }

  close(): void {
    this.db.close()
  }

  /** Insert a newly found clip as queued; refresh metadata (and the current camera name) otherwise. */
  upsertFound(c: ClipRecord): 'new' | 'existing' {
    const now = Date.now()
    const existing = this.get(c.dingId)
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO clips (ding_id, camera_id, camera_name, day, created_at, duration_s, kind, person_detected, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(c.dingId, c.cameraId, c.cameraName, c.day, c.createdAt, c.durationS, c.kind, c.personDetected, now)
      return 'new'
    }
    this.db
      .prepare(
        `UPDATE clips SET camera_name = ?, duration_s = COALESCE(?, duration_s), kind = COALESCE(?, kind),
           person_detected = COALESCE(?, person_detected), updated_at = ? WHERE ding_id = ?`,
      )
      .run(c.cameraName, c.durationS, c.kind, c.personDetected, now, c.dingId)
    if (existing.camera_name !== c.cameraName && existing.status === 'done') this.indexFts(c.dingId)
    return 'existing'
  }

  get(dingId: string): ClipRow | undefined {
    return this.db.prepare('SELECT * FROM clips WHERE ding_id = ?').get(dingId) as ClipRow | undefined
  }

  forDay(day: string): ClipRow[] {
    return this.db.prepare('SELECT * FROM clips WHERE day = ? ORDER BY created_at, ding_id').all(day) as ClipRow[]
  }

  countsForDay(day: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM clips WHERE day = ? GROUP BY status')
      .all(day) as Array<{ status: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }

  countsByCamera(day: string): Array<{ camera_id: string; camera_name: string; n: number }> {
    return this.db
      .prepare(
        `SELECT camera_id, MAX(camera_name) AS camera_name, COUNT(*) AS n FROM clips WHERE day = ?
         GROUP BY camera_id ORDER BY camera_name`,
      )
      .all(day) as Array<{ camera_id: string; camera_name: string; n: number }>
  }

  /** Clips that still need work: not done, and not failed out. */
  isRetryable(row: ClipRow): boolean {
    if (row.status === 'done') return false
    if (row.status === 'failed' && row.attempts >= MAX_ATTEMPTS) return false
    return true
  }

  update(dingId: string, patch: Patch): void {
    const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k))
    if (!keys.length) return
    const sets = keys.map((k) => `${k} = @${k}`).join(', ')
    this.db
      .prepare(`UPDATE clips SET ${sets}, updated_at = @updated_at WHERE ding_id = @ding_id`)
      .run({ ...patch, updated_at: Date.now(), ding_id: dingId })
  }

  markFailed(dingId: string, error: string): number {
    this.db
      .prepare(
        `UPDATE clips SET status = 'failed', error = ?, attempts = attempts + 1, updated_at = ? WHERE ding_id = ?`,
      )
      .run(error.slice(0, 2000), Date.now(), dingId)
    return this.get(dingId)?.attempts ?? 0
  }

  markDone(dingId: string): void {
    const tx = this.db.transaction(() => {
      this.update(dingId, { status: 'done', error: null })
      this.indexFts(dingId)
    })
    tx()
  }

  indexFts(dingId: string): void {
    const row = this.get(dingId)
    if (!row) return
    let tags = ''
    try {
      const t = row.tags_json ? JSON.parse(row.tags_json) : null
      if (t && Array.isArray(t.tags)) tags = t.tags.join(' ')
      if (t?.notable) tags += ' notable'
    } catch {
      // ignore bad json
    }
    this.db.prepare('DELETE FROM clips_fts WHERE ding_id = ?').run(dingId)
    this.db
      .prepare(
        'INSERT INTO clips_fts (ding_id, camera_name, transcript, description, faces_json, tags) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(dingId, row.camera_name, row.transcript ?? '', row.description ?? '', row.faces_json ?? '', tags)
  }

  search(opts: { query: string; from?: string; to?: string; camera?: string; limit?: number }): SearchHit[] {
    const match = ftsQuery(opts.query)
    if (!match) return []
    const where: string[] = ['clips_fts MATCH @match']
    const params: Record<string, unknown> = { match, limit: Math.min(Math.max(opts.limit ?? 20, 1), 200) }
    if (opts.from) {
      where.push('c.day >= @from')
      params.from = opts.from
    }
    if (opts.to) {
      where.push('c.day <= @to')
      params.to = opts.to
    }
    if (opts.camera) {
      where.push('(c.camera_id = @camera OR lower(c.camera_name) = lower(@camera))')
      params.camera = opts.camera
    }
    return this.db
      .prepare(
        `SELECT c.ding_id, c.day, c.created_at, c.camera_id, c.camera_name,
                snippet(clips_fts, -1, '[', ']', '...', 14) AS snippet
         FROM clips_fts JOIN clips c ON c.ding_id = clips_fts.ding_id
         WHERE ${where.join(' AND ')}
         ORDER BY bm25(clips_fts), c.created_at DESC
         LIMIT @limit`,
      )
      .all(params) as SearchHit[]
  }

  failedCount(sinceDay?: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM clips WHERE status = 'failed' ${sinceDay ? 'AND day >= ?' : ''}`)
      .get(...(sinceDay ? [sinceDay] : [])) as { n: number }
    return r.n
  }

  /** Days in [fromDay, beforeDay) that still have retryable clips. */
  daysNeedingWork(fromDay: string, beforeDay: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT day FROM clips WHERE day >= ? AND day < ?
           AND status != 'done' AND NOT (status = 'failed' AND attempts >= ?) ORDER BY day`,
      )
      .all(fromDay, beforeDay, MAX_ATTEMPTS) as Array<{ day: string }>
    return rows.map((r) => r.day)
  }

  deleteClipsBefore(day: string): number {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM clips_fts WHERE ding_id IN (SELECT ding_id FROM clips WHERE day < ?)').run(day)
      return this.db.prepare('DELETE FROM clips WHERE day < ?').run(day).changes
    })
    return tx()
  }

  // ---- recaps ----
  putRecap(r: Omit<RecapRow, 'generated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO recaps (day, camera_id, markdown, json, generated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, camera_id) DO UPDATE SET markdown = excluded.markdown, json = excluded.json,
           generated_at = excluded.generated_at`,
      )
      .run(r.day, r.camera_id, r.markdown, r.json, Date.now())
  }

  getRecap(day: string, cameraId = ROLLUP_ID): RecapRow | undefined {
    return this.db.prepare('SELECT * FROM recaps WHERE day = ? AND camera_id = ?').get(day, cameraId) as
      | RecapRow
      | undefined
  }

  recapsForDay(day: string): RecapRow[] {
    return this.db.prepare('SELECT * FROM recaps WHERE day = ? ORDER BY camera_id').all(day) as RecapRow[]
  }

  recentRecapDays(limit = 30): string[] {
    return (
      this.db
        .prepare(`SELECT day FROM recaps WHERE camera_id = '${ROLLUP_ID}' ORDER BY day DESC LIMIT ?`)
        .all(limit) as Array<{ day: string }>
    ).map((r) => r.day)
  }

  latestRecapDay(): string | undefined {
    return this.recentRecapDays(1)[0]
  }

  // ---- runs ----
  startRun(day: string, notes = ''): number {
    return Number(
      this.db.prepare('INSERT INTO runs (day, started_at, notes) VALUES (?, ?, ?)').run(day, Date.now(), notes)
        .lastInsertRowid,
    )
  }

  finishRun(id: number, s: { found: number; done: number; failed: number; notes: string }): void {
    this.db
      .prepare(
        'UPDATE runs SET finished_at = ?, clips_found = ?, clips_done = ?, clips_failed = ?, notes = ? WHERE id = ?',
      )
      .run(Date.now(), s.found, s.done, s.failed, s.notes, id)
  }

  getRun(id: number): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
  }

  lastRun(): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as RunRow | undefined
  }

  lastFinishedRun(): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as
      | RunRow
      | undefined
  }

  // ---- kv ----
  getKv<T = unknown>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    if (!r) return undefined
    try {
      return JSON.parse(r.value) as T
    } catch {
      return undefined
    }
  }

  setKv(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now())
  }
}
