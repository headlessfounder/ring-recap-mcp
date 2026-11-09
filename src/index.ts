#!/usr/bin/env node
/**
 * Entry point.
 *
 *   node dist/index.js                      MCP over stdio (for Claude and other local clients)
 *   node dist/index.js --http [--port N]    MCP over Streamable HTTP on 127.0.0.1 (launchd KeepAlive)
 *   node dist/index.js --run sync_day [--date YYYY-MM-DD] [--stage download|...|all] [--catch-up]
 *   node dist/index.js --run <tool> [--key value ...]   any other tool, JSON to stdout
 *   node dist/index.js --doctor             config, binaries, model, keychain presence
 *
 * Exit codes for --run: 0 ok, 1 error, 2 Ring auth expired / no token, 3 low disk, 4 sync already running.
 */
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const isStdio = !argv.some((a) => a === '--http' || a === '--run' || a === '--doctor' || a === '--version')

// stdout belongs to the MCP protocol in stdio mode: route stray console output to stderr
// before any library gets a chance to print.
if (isStdio) {
  const toErr = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')
  console.log = toErr
  console.info = toErr
  console.debug = toErr
  console.warn = toErr
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}

function toolArgs(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--') || a === '--run') {
      continue
    }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
      continue
    }
    i++
    if (/^-?\d+(\.\d+)?$/.test(next) && key !== 'date' && key !== 'from' && key !== 'to') out[key] = Number(next)
    else if (next === 'true' || next === 'false') out[key] = next === 'true'
    else out[key] = next
  }
  // CLI names that differ from the tool schema
  if ('dingId' in out) {
    out.ding_id = out.dingId
    delete out.dingId
  }
  delete out.run
  return out
}

function exitCodeFor(err: unknown): number {
  const code = (err as { code?: string })?.code
  if (code === 'auth_expired' || code === 'no_token') return 2
  if (code === 'disk_low') return 3
  if ((err as Error)?.name === 'LockHeldError' || (err as Error)?.constructor?.name === 'LockHeldError') return 4
  return 1
}

async function main(): Promise<number> {
  if (argv.includes('--version')) {
    const { VERSION } = await import('./server.js')
    console.log(VERSION)
    return 0
  }

  const { loadConfig } = await import('./config.js')

  if (argv.includes('--doctor')) {
    const { getSecret } = await import('./keychain.js')
    const { RING_CLIENT_VERSION, RING_CLIENT_TESTED } = await import('./ring/client.js')
    const cfg = loadConfig()
    console.log(
      JSON.stringify(
        {
          config: cfg.configPath,
          configExists: existsSync(cfg.configPath),
          locationName: cfg.locationName,
          timezone: cfg.timezone,
          vault: cfg.vault.root,
          bins: Object.fromEntries(Object.entries(cfg.bins).map(([k, v]) => [k, { path: v, exists: existsSync(v) }])),
          whisperModel: { path: cfg.whisperModelPath, exists: existsSync(cfg.whisperModelPath) },
          keychain: {
            'ring-refresh-token': getSecret('ring-refresh-token') ? 'present' : 'missing',
            'xai-api-key': getSecret('xai-api-key') ? 'present' : 'missing',
          },
          ringClientApi: { version: RING_CLIENT_VERSION, tested: RING_CLIENT_TESTED },
          describer: cfg.describer,
          faces: cfg.faces.enabled,
        },
        null,
        2,
      ),
    )
    return 0
  }

  const { createContext, closeContext } = await import('./context.js')
  const { log, errMsg } = await import('./util/log.js')

  const shutdown = (code: number) => {
    try {
      closeContext()
    } finally {
      process.exit(code)
    }
  }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(130))

  if (argv.includes('--run')) {
    const tool = flag('run')
    if (!tool) throw new Error('--run needs a tool name')
    const ctx = createContext({ stderrLogs: true })
    try {
      let result: unknown
      if (tool === 'sync_day') {
        const { syncDay, syncScheduled } = await import('./pipeline/sync.js')
        const stage = (flag('stage') || undefined) as import('./pipeline/sync.js').Stage | undefined
        const date = flag('date') || undefined
        result = argv.includes('--catch-up') && !date ? await syncScheduled(ctx, stage) : await syncDay(ctx, { day: date, stage })
      } else {
        const { TOOLS } = await import('./tools/index.js')
        const def = TOOLS.find((t) => t.name === tool)
        if (!def) throw new Error(`Unknown tool "${tool}". Known: ${TOOLS.map((t) => t.name).join(', ')}`)
        const { z } = await import('zod')
        const args = z.object(def.inputSchema).parse(toolArgs())
        const out = await def.handler(ctx, args)
        result = out.text ?? out.json
      }
      process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n')
      return 0
    } catch (e) {
      log.error({ err: errMsg(e) }, `--run ${tool} failed`)
      process.stderr.write(`error: ${errMsg(e)}\n`)
      return exitCodeFor(e)
    } finally {
      closeContext()
    }
  }

  const { startHttp, startStdio } = await import('./server.js')
  if (argv.includes('--http')) {
    const cfg = loadConfig()
    if (!cfg.http.enabled) {
      process.stderr.write('HTTP transport is disabled in config (http.enabled=false)\n')
      return 1
    }
    const port = Number(flag('port') || cfg.http.port)
    const ctx = createContext({ stderrLogs: true, ringIdleMs: 10 * 60_000, config: cfg })
    await startHttp(ctx, port)
    return -1 // keep running
  }

  const ctx = createContext({ stderrLogs: false, ringIdleMs: 10 * 60_000 })
  await startStdio(ctx)
  return -1
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code)
  },
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(exitCodeFor(err))
  },
)
