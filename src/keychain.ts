import { spawnSync } from 'node:child_process'

/** All secrets live in the login Keychain under this service name. */
export const KEYCHAIN_SERVICE = 'ring-recap'

export type SecretName = 'ring-refresh-token' | 'xai-api-key'

const SECURITY = '/usr/bin/security'

/** Test hook: lets unit tests run without touching the real Keychain. */
let memoryStore: Map<string, string> | undefined
export function useMemoryKeychain(store: Map<string, string> | undefined): void {
  memoryStore = store
}

export function getSecret(account: SecretName): string | undefined {
  if (memoryStore) return memoryStore.get(account)
  return readSecret(account, KEYCHAIN_SERVICE)
}

/** `security -i` reads commands with a ~4 KB line buffer and silently truncates longer lines. */
const STDIN_LINE_LIMIT = 3800

/**
 * Writes a secret. Short values go through `security -i` on stdin so they never appear in `ps`.
 * Long values (Ring tokens with push credentials folded in can pass 4 KB) must go on argv,
 * because `security -i` would truncate them. Either way the value is read back and compared.
 */
export function setSecret(account: SecretName, value: string, service = KEYCHAIN_SERVICE): void {
  if (memoryStore) {
    memoryStore.set(account, value)
    return
  }
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('"') || value.includes('\\')) {
    throw new Error(`Refusing to store ${account}: unexpected characters in value`)
  }
  const label = `ring-recap ${account}`
  const cmd = `add-generic-password -U -s ${service} -a ${account} -l "${label}" -w "${value}"\n`
  const r =
    cmd.length < STDIN_LINE_LIMIT
      ? spawnSync(SECURITY, ['-i'], { input: cmd, encoding: 'utf8' })
      : spawnSync(SECURITY, ['add-generic-password', '-U', '-s', service, '-a', account, '-l', label, '-w', value], {
          encoding: 'utf8',
        })
  if (r.status !== 0 || /error|fail|unknown command/i.test(r.stderr ?? '')) {
    throw new Error(`Keychain write for ${account} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`)
  }
  const check = readSecret(account, service)
  if (check !== value) throw new Error(`Keychain write for ${account} did not read back correctly`)
}

function readSecret(account: string, service: string): string | undefined {
  const r = spawnSync(SECURITY, ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8' })
  if (r.status !== 0) return undefined
  const v = r.stdout.replace(/\n$/, '')
  return v.length ? v : undefined
}

export function deleteSecret(account: string, service = KEYCHAIN_SERVICE): void {
  if (memoryStore) {
    memoryStore.delete(account)
    return
  }
  spawnSync(SECURITY, ['delete-generic-password', '-s', service, '-a', account], { encoding: 'utf8' })
}
