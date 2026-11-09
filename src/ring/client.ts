/**
 * The ONLY module that imports ring-client-api. If Ring changes its API, the fix lives here.
 *
 * Pinned: ring-client-api 14.3.0, tested 2026-11-08 against a live 8 camera location.
 *
 * Notes on the library's behavior that shaped this wrapper:
 * - requestWithRetry() retries network failures forever (every 5 s). Every call here gets a hard timeout.
 * - fetchAndBuildLocations() registers an FCM push receiver and emits a new refresh token
 *   (with push credentials folded in). We persist every emitted token to the Keychain immediately.
 * - Auth failures surface as Error("Failed to fetch oauth token from Ring ... refresh token ...").
 */
import { RingApi, type Location, type RingCamera, type VideoSearchResult } from 'ring-client-api'
import { useLogger } from 'ring-client-api/util'
import { getSecret, setSecret } from '../keychain.js'
import { errMsg, log } from '../util/log.js'
import { retry } from '../util/retry.js'

export const RING_CLIENT_VERSION = '14.3.0'
export const RING_CLIENT_TESTED = '2026-11-08'

const CALL_TIMEOUT_MS = 90_000

export class AuthExpiredError extends Error {
  readonly code = 'auth_expired'
  constructor(message: string) {
    super(message)
  }
}
export class NoTokenError extends Error {
  readonly code = 'no_token'
}
export class LocationNotFoundError extends Error {
  readonly code = 'location_not_found'
}
export class RingTimeoutError extends Error {
  readonly code = 'timeout'
}

export function isAuthError(err: unknown): boolean {
  if (err instanceof AuthExpiredError || err instanceof NoTokenError) return true
  const msg = errMsg(err)
  const status = (err as { response?: { status?: number } })?.response?.status
  return (
    status === 401 ||
    /oauth token|refresh token|unauthori[sz]ed|invalid_grant|\b401\b|2-factor|2fa/i.test(msg)
  )
}

/** HTTP status from a ring-client-api error, if any. */
export function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
}

export interface CameraInfo {
  id: string
  name: string
  online: boolean
  model: string
  deviceType: string
  /** true if any field in the raw device data looks like an enabled E2EE flag */
  e2eeFlag: boolean
}

/** Raw video search row, kept close to Ring's shape; events.ts normalizes it. */
export type RawVideo = VideoSearchResult

export type AuthState = { status: 'ok' | 'auth_expired' | 'no_token' | 'error'; at: number; message?: string }

let authListener: ((s: AuthState) => void) | undefined
export function onAuthState(fn: (s: AuthState) => void): void {
  authListener = fn
}
function reportAuth(s: Omit<AuthState, 'at'>): void {
  authListener?.({ ...s, at: Date.now() })
}

let loggerInstalled = false
function installRingLogger(): void {
  if (loggerInstalled) return
  loggerInstalled = true
  useLogger({
    logInfo: (...m: unknown[]) => log.debug({ ring: m.map(String).join(' ') }, 'ring-client-api'),
    logError: (m: unknown) => log.warn({ ring: errMsg(m) }, 'ring-client-api'),
  })
}

function withTimeout<T>(p: Promise<T>, what: string, ms = CALL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new RingTimeoutError(`${what} timed out after ${ms / 1000}s`)), ms)
    }),
  ])
}

function deepFindE2ee(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 5) return false
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/e2ee|end_to_end/i.test(k) && (v === true || v === 'enabled' || v === 1)) return true
    if (typeof v === 'object' && deepFindE2ee(v, depth + 1)) return true
  }
  return false
}

function toCameraInfo(c: RingCamera): CameraInfo {
  return {
    id: String(c.id),
    name: c.name,
    online: !c.isOffline,
    model: c.model && c.model !== 'Unknown Model' ? c.model : `Unknown model (${String(c.deviceType)})`,
    deviceType: String(c.deviceType),
    e2eeFlag: deepFindE2ee(c.data),
  }
}

/**
 * One authenticated Ring session per process. Reconnects lazily; drops itself after idle.
 * Every public method goes through `call()` which handles auth retry and timeouts.
 */
export class RingSession {
  private api?: RingApi
  private location?: Location
  private camerasById = new Map<string, RingCamera>()
  private idleTimer?: NodeJS.Timeout
  private connecting?: Promise<void>
  private authFailures = 0
  private connectedAt = 0

  constructor(
    private readonly locationName: string,
    private readonly opts: { idleMs?: number } = {},
  ) {}

  private async connect(): Promise<void> {
    if (this.location) return
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      installRingLogger()
      const refreshToken = getSecret('ring-refresh-token')
      if (!refreshToken) {
        reportAuth({ status: 'no_token', message: 'No Ring refresh token in Keychain. Run scripts/auth.sh' })
        throw new NoTokenError('No Ring refresh token in Keychain (service ring-recap, account ring-refresh-token). Run scripts/auth.sh')
      }
      const api = new RingApi({ refreshToken, controlCenterDisplayName: 'ring-recap-mcp' })
      api.onRefreshTokenUpdated.subscribe(({ newRefreshToken, oldRefreshToken }) => {
        if (!newRefreshToken || newRefreshToken === oldRefreshToken) return
        try {
          if (getSecret('ring-refresh-token') !== newRefreshToken) {
            setSecret('ring-refresh-token', newRefreshToken)
            log.info('Ring refresh token rotated; saved to Keychain')
          }
        } catch (e) {
          log.error({ err: errMsg(e) }, 'Failed to save rotated Ring refresh token')
        }
      })
      this.api = api
      try {
        const locations = await withTimeout(api.getLocations(), 'Ring getLocations')
        log.info(
          { locations: locations.map((l) => ({ name: l.name, cameras: l.cameras.length })), using: this.locationName },
          'Ring locations',
        )
        // Names are matched trimmed and case-insensitive (Ring keeps stray trailing spaces).
        // A blank locationName is allowed only when the account has exactly one location.
        const wanted = this.locationName.trim().toLowerCase()
        const match = wanted ? locations.filter((l) => l.name.trim().toLowerCase() === wanted) : locations
        if (match.length !== 1) {
          const names = locations.map((l) => `"${l.name.trim()}"`).join(', ')
          throw new LocationNotFoundError(
            !wanted
              ? `This Ring account has ${locations.length} locations (${names || 'none'}). Set locationName in the config to one of them.`
              : match.length === 0
                ? `Ring location "${this.locationName}" not found. Available: ${names || 'none'}`
                : `Ring location name "${this.locationName}" is ambiguous (${match.length} matches)`,
          )
        }
        this.location = match[0]
        this.camerasById = new Map(this.location.cameras.map((c) => [String(c.id), c]))
        this.authFailures = 0
        this.connectedAt = Date.now()
        reportAuth({ status: 'ok' })
      } catch (e) {
        this.dispose()
        throw e
      }
    })().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.opts.idleMs) {
      this.idleTimer = setTimeout(() => this.dispose(), this.opts.idleMs)
      this.idleTimer.unref()
    }
  }

  /** Runs fn with a live session. On an auth error, re-reads the Keychain once and retries. */
  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.connect()
        const out = await withTimeout(fn(), what)
        this.touch()
        return out
      } catch (e) {
        if (e instanceof NoTokenError || e instanceof LocationNotFoundError) throw e
        if (isAuthError(e)) {
          this.authFailures++
          this.dispose()
          log.warn({ attempt, err: errMsg(e) }, `Ring auth failure during ${what}`)
          if (attempt >= 2 || this.authFailures >= 2) {
            reportAuth({ status: 'auth_expired', message: errMsg(e) })
            throw new AuthExpiredError(`Ring auth failed twice (${errMsg(e)}). Run scripts/auth.sh to get a new refresh token.`)
          }
          continue // another process may have rotated the token; reconnect reads Keychain again
        }
        if (e instanceof RingTimeoutError) this.dispose()
        throw e
      }
    }
  }

  /** fresh=true re-fetches device data (online state) unless we connected moments ago. */
  async cameras(opts: { fresh?: boolean } = {}): Promise<CameraInfo[]> {
    return this.call('list cameras', async () => {
      if (opts.fresh && this.api && Date.now() - this.connectedAt > 10_000) {
        const { allCameras } = await this.api.fetchRingDevices()
        for (const d of allCameras) this.camerasById.get(String(d.id))?.updateData(d)
      }
      return [...this.camerasById.values()].map(toCameraInfo)
    })
  }

  private camera(cameraId: string): RingCamera {
    const c = this.camerasById.get(cameraId)
    if (!c) throw new Error(`Camera ${cameraId} is not in location "${this.locationName}"`)
    return c
  }

  /** One videoSearch window. Retries transient failures with backoff. */
  async videoSearch(cameraId: string, dateFrom: number, dateTo: number): Promise<RawVideo[]> {
    return retry(
      () =>
        this.call(`videoSearch ${cameraId}`, async () => {
          const res = await this.camera(cameraId).videoSearch({ dateFrom, dateTo, order: 'asc' })
          return Array.isArray(res?.video_search) ? res.video_search : []
        }),
      {
        attempts: 3,
        baseMs: 2000,
        shouldRetry: (e) => !isAuthError(e) && !(e instanceof LocationNotFoundError),
        onRetry: (e, n, wait) => log.warn({ cameraId, n, wait, err: errMsg(e) }, 'videoSearch retry'),
      },
    )
  }

  /** Timestamp (ms) of the newest event on a camera, or null. */
  async lastEventAt(cameraId: string): Promise<number | null> {
    return this.call(`last event ${cameraId}`, async () => {
      const res = await this.camera(cameraId).getEvents({ limit: 1 })
      const ev = res?.events?.[0]
      const t = ev ? Date.parse(ev.created_at) : NaN
      return Number.isFinite(t) ? t : null
    })
  }

  /** Fresh signed download URL for a ding, used when the search URLs fail. */
  async recordingUrl(cameraId: string, dingId: string, transcoded: boolean): Promise<string | null> {
    try {
      return await this.call(`recording url ${dingId}`, () =>
        this.camera(cameraId).getRecordingUrl(dingId, { transcoded }),
      )
    } catch (e) {
      if (isAuthError(e)) throw e
      log.warn({ dingId, err: errMsg(e) }, 'getRecordingUrl failed')
      return null
    }
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    try {
      this.api?.disconnect()
    } catch {
      // ignore
    }
    this.api = undefined
    this.location = undefined
    this.camerasById.clear()
  }
}
