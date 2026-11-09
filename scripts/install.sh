#!/usr/bin/env bash
# Ring Recap installer.
#
#   scripts/install.sh            # everything: deps, model, build, config, secrets, launchd server
#   scripts/install.sh deps       # brew ffmpeg + whisper-cpp
#   scripts/install.sh model      # download the whisper model (resumable, sha256 verified)
#   scripts/install.sh build      # npm ci + npm run build
#   scripts/install.sh config     # create ~/.config/ring-recap/config.json and the vault dirs
#   scripts/install.sh secrets    # prompt for the Ring token (via auth.sh) and the xAI key
#   scripts/install.sh launchd [server|sync|both]   # render + load launchd agents (default both)
#   scripts/install.sh unload [server|sync|both]    # unload launchd agents (default both)
#   scripts/install.sh faces      # python 3.12 venv for the faces sidecar (phase 4)
#   scripts/install.sh check      # verify ffmpeg, whisper-cli and the model
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$HOME/.config/ring-recap"
CONFIG_FILE="${RING_RECAP_CONFIG:-$CONFIG_DIR/config.json}"
MODELS_DIR="${RING_RECAP_MODELS_DIR:-$HOME/.local/share/ring-recap/models}"
MODEL_NAME="${WHISPER_MODEL_NAME:-ggml-large-v3-turbo.bin}"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"
VAULT="${RING_RECAP_VAULT:-$HOME/RingVault}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LABEL_SYNC="com.ringrecap.sync"
LABEL_SERVER="com.ringrecap.server"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

brew_prefix() {
  if command -v brew >/dev/null 2>&1; then brew --prefix; else echo /opt/homebrew; fi
}

cmd_deps() {
  [[ "$(uname -s)" == "Darwin" ]] || die "macOS only"
  command -v brew >/dev/null 2>&1 || die "Homebrew is required: https://brew.sh"
  for f in ffmpeg whisper-cpp; do
    if brew list --formula "$f" >/dev/null 2>&1; then
      say "$f already installed ($(brew list --versions "$f"))"
    else
      say "brew install $f"
      brew install "$f"
    fi
  done
}

cmd_model() {
  mkdir -p "$MODELS_DIR"
  local dest="$MODELS_DIR/$MODEL_NAME"
  say "Resolving $MODEL_URL"
  local headers expected_sha expected_size
  headers="$(curl -sIL --fail "$MODEL_URL" | tr -d '\r')" || die "Could not reach huggingface.co"
  expected_sha="$(printf '%s\n' "$headers" | awk -F': ' 'tolower($1)=="x-linked-etag"{gsub(/"/,"",$2); print $2}' | tail -1)"
  expected_size="$(printf '%s\n' "$headers" | awk -F': ' 'tolower($1)=="x-linked-size"{print $2}' | tail -1)"
  if [[ -f "$dest" && -n "$expected_size" && "$(stat -f%z "$dest")" == "$expected_size" ]]; then
    say "Model already present: $dest"
  else
    say "Downloading $MODEL_NAME (${expected_size:-unknown} bytes) to $MODELS_DIR"
    curl -L --fail --retry 5 --retry-delay 3 -C - -o "$dest.part" "$MODEL_URL"
    mv "$dest.part" "$dest"
  fi
  if [[ -n "$expected_sha" && ${#expected_sha} -eq 64 ]]; then
    say "Verifying sha256"
    local actual
    actual="$(shasum -a 256 "$dest" | awk '{print $1}')"
    [[ "$actual" == "$expected_sha" ]] || { rm -f "$dest"; die "sha256 mismatch (got $actual, want $expected_sha); deleted, rerun to download again"; }
    say "sha256 ok"
  else
    warn "No sha256 published in headers; size check only"
  fi
}

cmd_check() {
  local prefix ok=1
  prefix="$(brew_prefix)"
  local ffmpeg="$prefix/bin/ffmpeg" whisper="$prefix/bin/whisper-cli"
  say "ffmpeg -version"
  if "$ffmpeg" -version | head -1; then :; else warn "ffmpeg failed"; ok=0; fi
  say "whisper-cli --help"
  if "$whisper" --help >/dev/null 2>&1; then
    "$whisper" --help 2>&1 | head -3
  else
    warn "whisper-cli --help failed"; ok=0
  fi
  if [[ -f "$MODELS_DIR/$MODEL_NAME" ]]; then
    say "model: $MODELS_DIR/$MODEL_NAME ($(du -h "$MODELS_DIR/$MODEL_NAME" | awk '{print $1}'))"
  else
    warn "model missing: $MODELS_DIR/$MODEL_NAME (run: scripts/install.sh model)"; ok=0
  fi
  [[ $ok -eq 1 ]] && say "checks passed" || die "checks failed"
}

cmd_build() {
  cd "$REPO"
  say "npm ci"
  npm ci --no-audit --no-fund
  say "npm run build"
  npm run build
}

cmd_config() {
  mkdir -p "$CONFIG_DIR"
  if [[ -f "$CONFIG_FILE" ]]; then
    say "Config exists: $CONFIG_FILE"
  else
    cp "$REPO/config.example.json" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    say "Wrote $CONFIG_FILE"
  fi
  mkdir -p "$VAULT"/{raw,frames,clips,thumbs,faces/enrolled,faces/unknown,recaps,logs}
  chmod 700 "$VAULT"
  say "Vault ready: $VAULT"
}

cmd_secrets() {
  if security find-generic-password -s ring-recap -a ring-refresh-token >/dev/null 2>&1; then
    say "Ring refresh token already in Keychain (rerun scripts/auth.sh to replace it)"
  else
    "$REPO/scripts/auth.sh"
  fi
  if security find-generic-password -s ring-recap -a xai-api-key >/dev/null 2>&1; then
    say "xAI API key already in Keychain"
  else
    say "Paste your xAI API key when prompted (input hidden, asked twice)"
    security add-generic-password -U -s ring-recap -a xai-api-key -l "ring-recap xai-api-key" -w
    say "Stored xAI key in Keychain (service ring-recap, account xai-api-key)"
  fi
}

render_plist() {
  local src="$1" dest="$2" node hour
  node="$(command -v node)"
  hour="$(cd "$REPO" && node -e 'import("./dist/config.js").then(m=>console.log(m.loadConfig().syncHourLocal))' 2>/dev/null || echo 4)"
  sed -e "s#__NODE__#$node#g" \
      -e "s#__REPO__#$REPO#g" \
      -e "s#__HOME__#$HOME#g" \
      -e "s#__VAULT__#$VAULT#g" \
      -e "s#__BREW__#$(brew_prefix)#g" \
      -e "s#__HOUR__#$hour#g" \
      "$src" > "$dest"
  plutil -lint "$dest" >/dev/null || die "Rendered plist is invalid: $dest"
}

labels_for() {
  case "${1:-both}" in
    server) echo "$LABEL_SERVER" ;;
    sync) echo "$LABEL_SYNC" ;;
    both) echo "$LABEL_SYNC $LABEL_SERVER" ;;
    *) die "Expected server, sync or both (got $1)" ;;
  esac
}

cmd_launchd() {
  [[ -f "$REPO/dist/index.js" ]] || die "Build first: scripts/install.sh build"
  case "$REPO" in
    *"/scratch-workspaces/"*|/tmp/*|/private/tmp/*) die "Refusing to point launchd at a temporary folder ($REPO). Move the repo somewhere permanent first." ;;
  esac
  mkdir -p "$LAUNCH_AGENTS" "$VAULT/logs"
  local uid; uid="$(id -u)"
  for label in $(labels_for "${1:-both}"); do
    local dest="$LAUNCH_AGENTS/$label.plist"
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true
    render_plist "$REPO/launchd/$label.plist" "$dest"
    launchctl bootstrap "gui/$uid" "$dest"
    say "Loaded $label ($dest)"
  done
  launchctl print "gui/$uid/$LABEL_SYNC" 2>/dev/null | grep -E 'state|Hour|Minute' | head -5 || true
}

cmd_unload() {
  local uid; uid="$(id -u)"
  for label in $(labels_for "${1:-both}"); do
    launchctl bootout "gui/$uid/$label" 2>/dev/null && say "Unloaded $label" || say "$label was not loaded"
  done
}

cmd_faces() {
  local py
  py="$(command -v python3.12 || true)"
  if [[ -z "$py" ]]; then
    say "brew install python@3.12"
    brew install python@3.12
    py="$(brew --prefix python@3.12)/bin/python3.12"
  fi
  say "Creating venv with $py"
  "$py" -m venv "$REPO/python/.venv"
  "$REPO/python/.venv/bin/pip" install --upgrade pip
  "$REPO/python/.venv/bin/pip" install -r "$REPO/python/requirements.txt"
  say "Faces sidecar ready. Set faces.enabled=true in $CONFIG_FILE to turn it on."
}

main() {
  local cmd="${1:-all}"
  case "$cmd" in
    deps) cmd_deps ;;
    model) cmd_model ;;
    check) cmd_check ;;
    build) cmd_build ;;
    config) cmd_config ;;
    secrets) cmd_secrets ;;
    launchd) cmd_launchd "${2:-both}" ;;
    unload) cmd_unload "${2:-both}" ;;
    faces) cmd_faces ;;
    all)
      # Only the MCP server for now. The nightly job needs the full pipeline (stage "all"):
      # load it with `scripts/install.sh launchd sync` once Phase 3 is done (see docs/ROADMAP.md).
      cmd_deps; cmd_model; cmd_check; cmd_build; cmd_config; cmd_secrets; cmd_launchd server
      say "Done. Headless setup (sleep, auto-login, Keychain): docs/INSTALL_HEADLESS_MAC.md"
      ;;
    *) die "Unknown command: $cmd" ;;
  esac
}

main "$@"
