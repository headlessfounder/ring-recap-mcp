export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
  /** return false to stop retrying (e.g. auth errors, 4xx) */
  shouldRetry?: (err: unknown, attempt: number) => boolean
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Exponential backoff with full jitter. `attempts` counts the first try. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3
  const baseMs = opts.baseMs ?? 1000
  const maxMs = opts.maxMs ?? 20_000
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      if (attempt === attempts || (opts.shouldRetry && !opts.shouldRetry(err, attempt))) break
      const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      const wait = Math.round(cap / 2 + Math.random() * (cap / 2))
      opts.onRetry?.(err, attempt, wait)
      await sleep(wait)
    }
  }
  throw lastErr
}

/** Runs `fn` over items with at most `limit` in flight. Never rejects; collects per-item errors. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { ok: true, value: await fn(items[i], i) }
      } catch (error) {
        results[i] = { ok: false, error }
      }
    }
  })
  await Promise.all(workers)
  return results
}
