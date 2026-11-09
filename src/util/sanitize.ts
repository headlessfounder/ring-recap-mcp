/**
 * House rule: no em dashes anywhere in generated text or recaps.
 * Models love them, so every string that leaves the pipeline goes through this.
 */
export function noEmDash(text: string): string {
  return (
    text
      // spaced dash used as a clause break: "door — open" -> "door, open"
      .replace(/[ \t]+[—―–][ \t]+/g, ', ')
      // numeric ranges with an en dash: "6–10" -> "6-10"
      .replace(/(\d)–(\d)/g, '$1-$2')
      // unspaced em dash between words: "door—open" -> "door, open"
      .replace(/(\S)[—―](\S)/g, '$1, $2')
      // anything left over
      .replace(/[—―]/g, ',')
      .replace(/–/g, '-')
      // tidy punctuation the replacements can create
      .replace(/,\s*([,.;:!?])/g, '$1')
  )
}

/** Deep-sanitizes every string in a JSON-ish value. */
export function noEmDashDeep<T>(value: T): T {
  if (typeof value === 'string') return noEmDash(value) as T
  if (Array.isArray(value)) return value.map((v) => noEmDashDeep(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = noEmDashDeep(v)
    return out as T
  }
  return value
}

export function oneLine(text: string, max = 200): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 3).trimEnd() + '...' : s
}

/** Safe single path segment (person names, ids). */
export function safeSegment(s: string): string {
  const clean = s.trim().replace(/[^A-Za-z0-9 _.-]/g, '').replace(/^\.+/, '').slice(0, 64).trim()
  if (!clean) throw new Error(`"${s}" is not usable as a name`)
  return clean
}
