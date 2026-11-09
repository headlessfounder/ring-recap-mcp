# Install and run on a headless Mac

A runbook for a person or an AI agent setting up ring-recap-mcp on an always-on Mac that nobody
sits at: a Mac mini, a Mac Studio or a MacBook with the lid closed. Run the steps in order. Each
step ends with a check; do not move on until it passes.

**For agents.** Some steps need the owner in person, because they involve a password, a 2FA code
or a macOS security prompt. They are marked **OWNER**. Ask the owner to do them, in a real terminal
on the Mac (Terminal.app over Screen Sharing, or `ssh -t`). Never ask for passwords, Ring
credentials or API keys in chat, and never write them to a file.

## 0. What you need

| Item | Notes |
| --- | --- |
| Apple Silicon Mac | macOS 14 or newer (tested on macOS 26). Intel is untested. |
| Free disk | At least 150 GB for 7 days of footage at a busy 8 camera site (about 12 GB/day). Quieter sites need much less. An external APFS SSD works. |
| Admin account on the Mac | For Homebrew and power settings (`sudo`). |
| Ring account | Owner of the location. End-to-end encryption **off** for the cameras (downloads fail otherwise). Plan with video recording. |
| xAI API key | Only from Phase 3 on (vision descriptions). Or use local Ollama instead. |

## 1. Prepare the Mac for headless use

### 1.1 Remote access (OWNER, once, at the Mac)

System Settings → General → Sharing:

* **Remote Login** on (SSH). Allow only the admin user.
* **Screen Sharing** on. You need it for the few interactive steps and after restarts.

Check, from another machine: `ssh <user>@<mac>.local 'sw_vers -productVersion'`.

### 1.2 Never sleep

```bash
sudo pmset -a sleep 0 disksleep 0 powernap 0 womp 1
sudo pmset -a autorestart 1        # desktops: power back on after an outage
pmset -g | grep -E ' sleep|disksleep|autorestart'
```

**MacBook with the lid closed.** Keep it on its power adapter. Then run:

```bash
sudo pmset -a disablesleep 1       # stays awake with the lid closed (undo: disablesleep 0)
```

Check: `pmset -g` shows `sleep 0` (and `SleepDisabled 1` on a MacBook).

### 1.3 Login session and Keychain after a restart (OWNER decides)

The jobs run as **launchd user agents**, and they read secrets from the **login Keychain**. Both
need the user to be logged in, so a reboot needs someone to log in again. Pick one:

* **A. FileVault on (recommended, because the footage is sensitive).** After a power loss or
  restart, someone must log in once, either at the Mac or through Screen Sharing. Recent macOS
  versions can also unlock FileVault over SSH after a restart; check whether yours can. For
  planned restarts, `sudo fdesetup authrestart` skips the unlock prompt once.
* **B. Automatic login.** System Settings → Users & Groups → Automatically log in as. Only possible
  with FileVault off. The jobs come back by themselves after an outage, but the disk is
  unencrypted.

**Keychain locking.** Make sure the login Keychain does not lock itself while the user stays
logged in:

```bash
security show-keychain-info ~/Library/Keychains/login.keychain-db   # want: no-timeout
security set-keychain-settings ~/Library/Keychains/login.keychain-db  # clears auto-lock
```

Over plain SSH, the login Keychain can be locked even while the user is logged in at the console.
`security` then fails with "User interaction is not allowed". Unlock it for that SSH session:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db       # OWNER types the login password
```

## 2. Install prerequisites

```bash
# Homebrew (asks for the admin password: OWNER)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# Node 24 LTS (tested). Node 22 also works.
brew install node@24 git
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zprofile
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

Check: `node -v` prints v24 or v22, and `which node` points into `/opt/homebrew`. The launchd
templates use whatever `node` is on PATH when you run `scripts/install.sh launchd`.

## 3. Get the code

Clone into a permanent folder. The installer refuses to point launchd at `/tmp`.

```bash
git clone https://github.com/headlessfounder/ring-recap-mcp.git ~/ring-recap-mcp
cd ~/ring-recap-mcp
```

## 4. Install tools, model and build

```bash
scripts/install.sh deps     # brew ffmpeg + whisper-cpp
scripts/install.sh model    # whisper large-v3-turbo (about 1.6 GB, sha256 verified, resumable)
scripts/install.sh check    # ffmpeg -version, whisper-cli --help, model present
scripts/install.sh build    # npm ci + build
npm test                    # all tests must pass
scripts/install.sh config   # writes ~/.config/ring-recap/config.json and the vault folders
```

Check: `scripts/install.sh check` ends with "checks passed", and `npm test` reports no failures.

## 5. Configure

Edit `~/.config/ring-recap/config.json`. The full key list is in the README.

| Key | Set it to |
| --- | --- |
| `locationName` | The Ring location to read, as shown in the Ring app. Leave `""` if the account has only one location. Other locations are ignored. |
| `timezone` | IANA name of the site, for example `America/New_York`. |
| `vaultDir` | Where clips, footage and the ledger live. Default `~/RingVault`. For an external SSD use `/Volumes/<name>/RingVault`. |
| `syncHourLocal` | Hour for the nightly job (default 4). |

Check: `node dist/index.js --doctor` shows the config, binaries and model as present.

## 6. Ring sign-in (OWNER)

The owner runs this in a real terminal on the Mac. It needs the Ring email, password and the 2FA
code:

```bash
cd ~/ring-recap-mcp && scripts/auth.sh
```

The password prompt is masked. The refresh token goes straight to the login Keychain (service
`ring-recap`, account `ring-refresh-token`) and is never printed. The script shows only its length
and a fingerprint. The Mac then appears in the Ring app under Control Center → Authorized Client
Devices as `ring-recap-mcp`. If an older install on another machine is listed there, remove it.

Check:

```bash
node dist/index.js --doctor | grep ring-refresh-token     # "present"
node dist/index.js --run list_cameras                     # the location's cameras, nothing else
```

If `list_cameras` says the location was not found, the error lists the names the account has.
Copy one into `locationName`.

## 7. Verify the pull (Phase 1 acceptance)

```bash
D=$(date -v-1d +%F)
node dist/index.js --run sync_day --date "$D" --stage download   # a busy site takes about 25 min
node dist/index.js --run sync_day --date "$D" --stage download   # rerun: "new": 0, "downloadedNow": 0
node dist/index.js --run health
```

OWNER spot check: pick 3 cameras. Compare the per-camera counts with the Ring app's Event History
for that day:

```bash
sqlite3 ~/RingVault/ledger.sqlite "select camera_name, count(*) from clips where day='$D' group by 1 order by 2 desc"
```

Footage is not swept automatically until Phase 3. Delete test days by hand when done
(`rm -rf ~/RingVault/raw/<day>`).

## 8. Run the MCP server

### Same Mac (Claude Code, Claude Desktop or another local client), over stdio

```json
{ "mcpServers": { "ring-recap": { "command": "/opt/homebrew/opt/node@24/bin/node", "args": ["/Users/<user>/ring-recap-mcp/dist/index.js"] } } }
```

### Always-on HTTP server (launchd, KeepAlive)

```bash
scripts/install.sh launchd server
curl -s http://127.0.0.1:8787/healthz
```

The endpoint is `http://127.0.0.1:8787/mcp` (Streamable HTTP, stateless, POST). It listens on
localhost only, has no auth, and rejects foreign Host and Origin headers.

### An agent on another machine

Use an SSH tunnel. It needs no code change and is encrypted:

```bash
ssh -N -L 8787:127.0.0.1:8787 <user>@<mac>.local
# the remote agent now uses http://127.0.0.1:8787/mcp on its own machine
```

Do not bind the server to a public interface. Token auth for Tailscale-style access is planned in
[ROADMAP.md](ROADMAP.md) Phase 6.

## 9. Nightly job

Load it only after Phase 3 is done. Until then the full pipeline (stage `all`) does not exist yet,
and the nightly run would exit with an error.

```bash
scripts/install.sh launchd sync
launchctl print gui/$(id -u)/com.ringrecap.sync | grep -E 'state|Hour|Minute'
```

It runs `node dist/index.js --run sync_day --catch-up` at `syncHourLocal`. That processes yesterday,
plus any day in the past week that still has retryable clips. Output goes to
`~/RingVault/logs/launchd.log`. To test it without waiting for the scheduled hour:

```bash
launchctl kickstart -p gui/$(id -u)/com.ringrecap.sync
```

## 10. Keep building

The remaining phases are specified in [ROADMAP.md](ROADMAP.md), and the rules are in
[AGENTS.md](../AGENTS.md). Commit at the end of each phase. The owner provides the xAI API key
only in Phase 3, after seeing the projected daily cost:

```bash
security add-generic-password -U -s ring-recap -a xai-api-key -l "ring-recap xai-api-key" -w   # OWNER, hidden prompt
```

## 11. Operate

| Task | Command |
| --- | --- |
| Status | `node dist/index.js --run health` |
| Logs | `ls ~/RingVault/logs/` (daily `ring-recap-YYYY-MM-DD.log`, `launchd.log`, `server.log`) |
| Update | `git pull && scripts/install.sh build && launchctl kickstart -k gui/$(id -u)/com.ringrecap.server` |
| Stop jobs | `scripts/install.sh unload` (or `unload server` / `unload sync`) |
| Uninstall | `scripts/install.sh unload`, then `security delete-generic-password -s ring-recap -a ring-refresh-token`, the same for `xai-api-key`, then delete `~/RingVault`, `~/.config/ring-recap` and `~/.local/share/ring-recap`. Remove the device in Ring Control Center. |

Exit codes from `--run`: 0 ok, 1 error, 2 Ring auth expired or no token, 3 low disk, 4 another sync
is running.

## 12. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Exit code 2, `health.auth` = `auth_expired` | OWNER reruns `scripts/auth.sh`. The token was revoked or expired. |
| "User interaction is not allowed" | Login Keychain is locked in this SSH session: `security unlock-keychain ~/Library/Keychains/login.keychain-db`. |
| `Ring location "X" not found. Available: ...` | Copy one of the listed names into `locationName`. Trailing spaces and case do not matter. |
| Exit code 3 | Under `minFreeDiskGB` free. Free space, or move `vaultDir` to a bigger disk. |
| Exit code 4 | Another sync holds `~/RingVault/sync.lock`. It is taken over automatically if its process died. |
| Health warns about encryption | A camera answered 401/403 on every download. Turn off end-to-end encryption for it in the Ring app. |
| `recording_unavailable` on a few clips | Ring has no video for that event (404 on every URL). Expected for a small share of very short clips. |
| An online camera returns zero events | Shown as a health warning. Check the camera's recording settings in the Ring app. |
| Jobs do not run after a restart | Nobody is logged in (see step 1.3), or the Mac is asleep (step 1.2). Check `launchctl print gui/$(id -u)/com.ringrecap.server`. |
| `whisper-cli` or `ffmpeg` not found under launchd | launchd's PATH comes from the plist. Rerun `scripts/install.sh launchd` after installing Homebrew tools. |
