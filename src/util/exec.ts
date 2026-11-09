import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  timeoutMs?: number
  cwd?: string
  /** resolve instead of reject on non-zero exit */
  allowFailure?: boolean
  input?: string
  env?: NodeJS.ProcessEnv
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message)
  }
}

/** Runs a binary with an argv array (never a shell string). Kills it on timeout. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : undefined
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      stderr += d
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000)
    })
    if (opts.input !== undefined) child.stdin!.end(opts.input)
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const result = { code: code ?? -1, stdout, stderr }
      if (timedOut) return reject(new ExecError(`${cmd} timed out after ${opts.timeoutMs}ms`, result))
      if (result.code !== 0 && !opts.allowFailure) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ')
        return reject(new ExecError(`${cmd} exited ${result.code}: ${tail}`, result))
      }
      resolve(result)
    })
  })
}
