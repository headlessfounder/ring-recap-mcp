#!/usr/bin/env node
// Gets a Ring refresh token and stores it in the macOS Keychain without ever printing it.
// Same flow as ring-client-api's ring-auth-cli (email, password, 2fa code), but the password
// is masked and the token goes straight to Keychain (service ring-recap, account ring-refresh-token).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import readline from 'node:readline'
import { RingRestClient } from 'ring-client-api/rest-client'

const SERVICE = 'ring-recap'
const ACCOUNT = 'ring-refresh-token'

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(question)
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

function storeToken(token) {
  if (!/^[\x21-\x7e]+$/.test(token) || token.includes('"') || token.includes('\\')) {
    throw new Error('Token has unexpected characters; not storing it')
  }
  // `security -i` truncates lines over ~4 KB, so long tokens go on argv (brief, local only).
  const label = `ring-recap ${ACCOUNT}`
  const cmd = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "${label}" -w "${token}"\n`
  const w =
    cmd.length < 3800
      ? spawnSync('/usr/bin/security', ['-i'], { input: cmd, encoding: 'utf8' })
      : spawnSync('/usr/bin/security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-l', label, '-w', token], { encoding: 'utf8' })
  if (w.status !== 0 || /error|fail|unknown command/i.test(w.stderr ?? '')) throw new Error(`Keychain write failed: ${w.stderr}`)
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8' })
  if (r.stdout.replace(/\n$/, '') !== token) throw new Error('Keychain read-back did not match')
}

async function main() {
  console.log('Ring sign-in for ring-recap-mcp. Your password and the resulting token are never displayed or written to disk.')
  const email = await ask('Ring email: ')
  const password = await ask('Ring password: ', { hidden: true })
  const client = new RingRestClient({ email, password, controlCenterDisplayName: 'ring-recap-mcp' })
  let auth
  try {
    auth = await client.getCurrentAuth()
  } catch (e) {
    if (!client.promptFor2fa) {
      console.error(`Sign-in failed: ${e?.message ?? e}`)
      process.exit(1)
    }
    console.log(client.promptFor2fa)
    for (let i = 0; i < 5 && !auth; i++) {
      const code = await ask('2fa code: ')
      try {
        auth = await client.getAuth(code)
      } catch (err) {
        console.log(`That code did not work (${err?.message ?? err}). Try again.`)
      }
    }
    if (!auth) {
      console.error('Too many failed 2fa attempts.')
      process.exit(1)
    }
  }
  const token = auth?.refresh_token
  if (!token) throw new Error('Ring did not return a refresh token')
  storeToken(token)
  const fp = createHash('sha256').update(token).digest('hex').slice(0, 10)
  console.log(`Stored Ring refresh token in Keychain (service ${SERVICE}, account ${ACCOUNT}, ${token.length} chars, fingerprint ${fp}).`)
  client.clearTimeouts?.()
  process.exit(0)
}

main().catch((e) => {
  console.error(`error: ${e?.message ?? e}`)
  process.exit(1)
})
