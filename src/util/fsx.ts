import { closeSync, existsSync, openSync, readFileSync, rmSync, statfsSync, writeSync } from 'node:fs'
import { run } from './exec.js'

export function freeBytes(dir: string): number {
  const s = statfsSync(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** Total bytes under dir (du is far faster than walking 100k+ small files from node). */
export async function dirBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  const r = await run('/usr/bin/du', ['-sk', dir], { allowFailure: true, timeoutMs: 60_000 })
  const kb = Number(r.stdout.trim().split(/\s+/)[0])
  return Number.isFinite(kb) ? kb * 1024 : 0
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class LockHeldError extends Error {
  constructor(
    readonly holder: { pid: number; day?: string; startedAt?: number },
  ) {
    super(`Another sync is already running (pid ${holder.pid}${holder.day ? `, day ${holder.day}` : ''})`)
  }
}

export function readLock(file: string): { pid: number; day?: string; startedAt?: number } | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof v?.pid === 'number' && pidAlive(v.pid)) return v
  } catch {
    // missing or garbage
  }
  return undefined
}

/** Exclusive cross-process lock via O_EXCL; stale locks (dead pid) are taken over. */
export function acquireLock(file: string, info: { day: string }): () => void {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, day: info.day, startedAt: Date.now() }))
      closeSync(fd)
      let released = false
      const release = () => {
        if (released) return
        released = true
        try {
          const v = JSON.parse(readFileSync(file, 'utf8'))
          if (v?.pid === process.pid) rmSync(file, { force: true })
        } catch {
          // already gone
        }
      }
      process.once('exit', release)
      return release
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = readLock(file)
      if (holder) throw new LockHeldError(holder)
      rmSync(file, { force: true }) // stale
    }
  }
  throw new Error(`Could not acquire ${file}`)
}
