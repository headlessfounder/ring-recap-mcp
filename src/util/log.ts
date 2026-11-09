import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import path from 'node:path'
import pino, { type Logger } from 'pino'

/**
 * Minimal daily-rotating file sink: logs/ring-recap-YYYY-MM-DD.log.
 * Writes are synchronous so nothing is lost when a launchd job exits.
 * Old files are removed by the retention sweep.
 */
class DailyFile {
  private fd: number | undefined
  private day = ''
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }
  write(chunk: string): boolean {
    const day = new Date().toISOString().slice(0, 10)
    if (day !== this.day || this.fd === undefined) {
      if (this.fd !== undefined) closeSync(this.fd)
      this.fd = openSync(path.join(this.dir, `ring-recap-${day}.log`), 'a')
      this.day = day
    }
    writeSync(this.fd, chunk)
    return true
  }
}

const stderrStream = { write: (s: string) => process.stderr.write(s) }

/** Live binding: modules import `log` and get the configured logger once initLogger runs. */
export let log: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, stderrStream)

export function initLogger(logsDir: string, opts: { stderr: boolean }): Logger {
  const streams: pino.StreamEntry[] = []
  try {
    streams.push({ stream: new DailyFile(logsDir) })
  } catch {
    // vault not writable; stderr only
  }
  if (opts.stderr || streams.length === 0) streams.push({ stream: stderrStream })
  log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams),
  )
  return log
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
