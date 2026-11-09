import { describe, expect, it } from 'vitest'
import { noEmDash, noEmDashDeep, oneLine, safeSegment } from '../src/util/sanitize.js'
import { resolveConfig } from '../src/config.js'

describe('noEmDash', () => {
  it('removes every em dash form', () => {
    expect(noEmDash('A person enters — carrying a box.')).toBe('A person enters, carrying a box.')
    expect(noEmDash('door—open')).toBe('door, open')
    expect(noEmDash('between 6–10 PM')).toBe('between 6-10 PM')
    expect(noEmDash('trailing —.')).not.toMatch(/[—–―]/)
    expect(noEmDash('plain text, no dashes')).toBe('plain text, no dashes')
  })

  it('cleans nested values', () => {
    const out = noEmDashDeep({ a: ['x — y'], b: { c: 'p—q' }, n: 3 })
    expect(JSON.stringify(out)).not.toMatch(/[—–]/)
    expect(out.n).toBe(3)
  })

  it('truncates to one line', () => {
    expect(oneLine('a\n\n b   c')).toBe('a b c')
    expect(oneLine('x'.repeat(50), 10)).toBe('xxxxxxx...')
  })

  it('makes safe path segments', () => {
    expect(safeSegment('Jane Doe')).toBe('Jane Doe')
    expect(safeSegment('../../etc')).toBe('etc')
    expect(() => safeSegment('///')).toThrow()
  })
})

describe('config', () => {
  it('fills defaults and nested defaults', () => {
    const c = resolveConfig({ locationName: 'Home', faces: { enabled: true } }, '/tmp/x.json')
    expect(c.faces.enabled).toBe(true)
    expect(c.faces.matchThreshold).toBe(0.45)
    expect(c.retention.clipJsonDays).toBe(365)
    expect(c.http.port).toBe(8787)
    expect(c.vault.ledger.endsWith('RingVault/ledger.sqlite')).toBe(true)
    expect(c.whisperModelPath.endsWith('/ggml-large-v3-turbo.bin')).toBe(true)
  })

  it('rejects bad timezones and describers', () => {
    expect(() => resolveConfig({ timezone: 'Mars/Olympus' })).toThrow()
    expect(() => resolveConfig({ describer: 'gpt' })).toThrow()
  })
})
