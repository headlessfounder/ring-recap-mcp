import { mkdirSync } from 'node:fs'
import { loadConfig, type ResolvedConfig } from './config.js'
import { Ledger } from './db/ledger.js'
import { onAuthState, RingSession } from './ring/client.js'
import { initLogger } from './util/log.js'

export interface AppContext {
  config: ResolvedConfig
  ledger: Ledger
  ring: RingSession
}

let ctx: AppContext | undefined

export function createContext(opts: { stderrLogs: boolean; ringIdleMs?: number; config?: ResolvedConfig }): AppContext {
  if (ctx) return ctx
  const config = opts.config ?? loadConfig()
  const v = config.vault
  for (const d of [v.root, v.raw, v.frames, v.clips, v.thumbs, v.facesEnrolled, v.facesUnknown, v.recaps, v.logs]) {
    mkdirSync(d, { recursive: true })
  }
  initLogger(v.logs, { stderr: opts.stderrLogs })
  const ledger = new Ledger(v.ledger)
  const ring = new RingSession(config.locationName, { idleMs: opts.ringIdleMs })
  onAuthState((s) => ledger.setKv('auth', s))
  ctx = { config, ledger, ring }
  return ctx
}

export function closeContext(): void {
  if (!ctx) return
  ctx.ring.dispose()
  ctx.ledger.close()
  ctx = undefined
}
