#!/usr/bin/env bash
# Gets a Ring refresh token and stores it in the Keychain (service ring-recap, account ring-refresh-token).
#
#   scripts/auth.sh             masked password prompt, token never printed (default)
#   scripts/auth.sh --official  wraps `npx -p ring-client-api ring-auth-cli` exactly as published;
#                               note that CLI echoes your password. The token line is captured and hidden.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
[[ -d node_modules/ring-client-api ]] || npm ci --no-audit --no-fund

if [[ "${1:-}" != "--official" ]]; then
  exec node scripts/ring-auth.mjs
fi

# Official CLI path: pass output through, but swallow the line that contains the token.
node --input-type=module -e '
import { spawn, spawnSync } from "node:child_process"
const child = spawn("npx", ["--no-install", "-p", "ring-client-api@14.3.0", "ring-auth-cli"], { stdio: ["inherit", "pipe", "inherit"] })
let token
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  const m = chunk.match(/"refreshToken":\s*"([^"]+)"/)
  if (m) {
    token = m[1]
    process.stdout.write(chunk.replace(m[0], "\"refreshToken\": \"<hidden, saved to Keychain>\""))
  } else process.stdout.write(chunk)
})
child.on("exit", (code) => {
  if (!token) { console.error("No refresh token captured"); process.exit(code || 1) }
  const w = spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-s", "ring-recap", "-a", "ring-refresh-token", "-l", "ring-recap ring-refresh-token", "-w", token], { encoding: "utf8" })
  const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "ring-recap", "-a", "ring-refresh-token", "-w"], { encoding: "utf8" })
  if (w.status !== 0 || r.stdout.trim() !== token) { console.error("Keychain write failed"); process.exit(1) }
  console.log("Stored Ring refresh token in Keychain.")
})
'
