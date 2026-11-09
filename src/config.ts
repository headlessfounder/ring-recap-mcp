import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { getSecret, type SecretName } from './keychain.js'

export const CONFIG_PATH =
  process.env.RING_RECAP_CONFIG ?? path.join(homedir(), '.config', 'ring-recap', 'config.json')

const FacesSchema = z.object({
  enabled: z.boolean().default(false),
  matchThreshold: z.number().min(0).max(1).default(0.45),
  /** python interpreter for the faces sidecar; defaults to python/.venv/bin/python */
  python: z.string().optional(),
})

const RetentionSchema = z.object({
  clipJsonDays: z.number().int().positive().default(365),
  thumbsDays: z.number().int().positive().default(180),
  unknownFacesDays: z.number().int().positive().default(30),
  /** raw mp4 / frame dirs left behind by crashes are swept after this many days */
  leftoverMediaDays: z.number().int().positive().default(7),
  logsDays: z.number().int().positive().default(30),
})

const HttpSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).default(8787),
})

const BinSchema = z.object({
  ffmpeg: z.string().optional(),
  ffprobe: z.string().optional(),
  whisper: z.string().optional(),
})

export const ConfigSchema = z.object({
  /** Ring location to read. Blank = the account's only location (error if it has several). */
  locationName: z.string().default(''),
  vaultDir: z.string().default('~/RingVault'),
  timezone: z.string().default('America/New_York'),
  syncHourLocal: z.number().int().min(0).max(23).default(4),
  describer: z.enum(['grok', 'ollama']).default('grok'),
  grokModel: z.string().default('grok-4'),
  grokBaseUrl: z.string().default('https://api.x.ai/v1'),
  ollamaModel: z.string().default('qwen2.5-vl:7b'),
  ollamaBaseUrl: z.string().default('http://127.0.0.1:11434'),
  frameEverySeconds: z.number().positive().default(2),
  maxFramesPerClip: z.number().int().positive().default(24),
  whisperModel: z.string().default('ggml-large-v3-turbo.bin'),
  modelsDir: z.string().default('~/.local/share/ring-recap/models'),
  skipTranscriptIfSilent: z.boolean().default(true),
  silenceDbThreshold: z.number().default(-45),
  concurrency: z.number().int().min(1).max(8).default(3),
  minFreeDiskGB: z.number().nonnegative().default(20),
  faces: FacesSchema.prefault({}),
  retention: RetentionSchema.prefault({}),
  http: HttpSchema.prefault({}),
  bin: BinSchema.prefault({}),
})

export type Config = z.infer<typeof ConfigSchema>

export interface VaultPaths {
  root: string
  raw: string
  frames: string
  clips: string
  thumbs: string
  facesEnrolled: string
  facesUnknown: string
  recaps: string
  logs: string
  ledger: string
  lock: string
}

export interface ResolvedConfig extends Config {
  configPath: string
  repoDir: string
  vault: VaultPaths
  whisperModelPath: string
  bins: { ffmpeg: string; ffprobe: string; whisper: string }
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

/** repo root: dist/config.js or src/config.ts both live one level below it */
export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function findBin(name: string, override?: string): string {
  if (override) return expandHome(override)
  // Prefer Homebrew builds over whatever happens to be first on PATH (e.g. conda ffmpeg).
  for (const prefix of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const candidate = path.join(prefix, name)
    if (existsSync(candidate)) return candidate
  }
  return name
}

export function vaultPaths(root: string): VaultPaths {
  return {
    root,
    raw: path.join(root, 'raw'),
    frames: path.join(root, 'frames'),
    clips: path.join(root, 'clips'),
    thumbs: path.join(root, 'thumbs'),
    facesEnrolled: path.join(root, 'faces', 'enrolled'),
    facesUnknown: path.join(root, 'faces', 'unknown'),
    recaps: path.join(root, 'recaps'),
    logs: path.join(root, 'logs'),
    ledger: path.join(root, 'ledger.sqlite'),
    lock: path.join(root, 'sync.lock'),
  }
}

export function resolveConfig(raw: unknown, configPath = CONFIG_PATH): ResolvedConfig {
  const cfg = ConfigSchema.parse(raw ?? {})
  // Validate the timezone early; Intl throws RangeError on unknown zones.
  new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone })
  const root = path.resolve(expandHome(cfg.vaultDir))
  const modelsDir = path.resolve(expandHome(cfg.modelsDir))
  const whisperModelPath = path.isAbsolute(expandHome(cfg.whisperModel))
    ? expandHome(cfg.whisperModel)
    : path.join(modelsDir, cfg.whisperModel)
  return {
    ...cfg,
    configPath,
    repoDir: REPO_DIR,
    vault: vaultPaths(root),
    whisperModelPath,
    bins: {
      ffmpeg: findBin('ffmpeg', cfg.bin.ffmpeg),
      ffprobe: findBin('ffprobe', cfg.bin.ffprobe),
      whisper: findBin('whisper-cli', cfg.bin.whisper),
    },
  }
}

let cached: ResolvedConfig | undefined

/** Loads ~/.config/ring-recap/config.json (or $RING_RECAP_CONFIG). Missing file means all defaults. */
export function loadConfig(configPath = CONFIG_PATH): ResolvedConfig {
  if (cached && cached.configPath === configPath) return cached
  let raw: unknown = {}
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (e) {
      throw new Error(`Could not parse ${configPath}: ${(e as Error).message}`)
    }
  }
  cached = resolveConfig(raw, configPath)
  return cached
}

/** Secrets never live in config.json; they come from the macOS Keychain (service "ring-recap"). */
export function loadSecret(name: SecretName): string | undefined {
  return getSecret(name)
}
