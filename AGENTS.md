# AGENTS.md

Briefing for AI coding agents (Claude Code, Codex, Cursor and others) working in this repo.

## What this is

A local MCP server for macOS. Once a day it pulls every Ring event clip from one location,
transcribes the audio on the Mac (whisper.cpp), describes sampled frames with a vision model (Grok,
or a local model through Ollama) and writes time-coded recaps. Agents query it over MCP.

* Install and run on a Mac: [docs/INSTALL_HEADLESS_MAC.md](docs/INSTALL_HEADLESS_MAC.md)
* What to build next, with designs and acceptance checks: [docs/ROADMAP.md](docs/ROADMAP.md)

## Rules (do not break these)

1. macOS on Apple Silicon. No Docker.
2. Video never leaves the Mac, except as sampled JPEG frames sent to the vision model. Audio never
   leaves the Mac. Footage export tools write local files only.
3. Ring access only through `ring-client-api`, and only inside `src/ring/client.ts`. The API is
   unofficial, so build for failure: retries with backoff and hard timeouts. A camera that returns
   zero events while online is a health warning, not a crash.
4. Secrets live in the macOS login Keychain only (service `ring-recap`; accounts
   `ring-refresh-token`, `xai-api-key`). Never put them in files, env vars, logs, test fixtures or
   chat.
5. Idempotent: rerunning `sync_day` for a date only processes clips that are not done.
6. No em dashes in any generated text, recaps or tool output. Use `noEmDash()` from
   `src/util/sanitize.ts`. Prefer to avoid them in docs too.
7. Key everything on `camera.id`, never the camera name. Names change.
8. One install reads exactly one Ring location (`locationName`). Never touch other locations.
9. Refuse to sync with less than `minFreeDiskGB` free.
10. Keep the repo generic. No real camera ids, site names, addresses, people or account details
    in code, tests, docs or commits. Site-specific values belong in the user's
    `~/.config/ring-recap/config.json`, which is never committed.

## Working agreement

* Work through the phases in [docs/ROADMAP.md](docs/ROADMAP.md) in order. Do not start a phase until
  the acceptance checks of the previous one pass. Commit at the end of each phase.
* Ask the owner only for:
  * Ring sign-in: they run `scripts/auth.sh` themselves.
  * The xAI key: Phase 3, after you show them the projected daily cost.
  * The checks only a human can do: spot-checking counts against the Ring app, and reading recaps.
* Measure before you assume. Ring's real behavior has already differed from the docs: a 20 row
  page cap, newest first, files longer than `duration`. Write each new finding into the README
  "Implementation notes" section.
* Every change keeps `npm run build` and `npm test` green. Tests never touch Ring, the network or
  the real Keychain. Use the fakes in `test/helpers.ts` (`fakeRing`, `fakeCdn`, temp vaults,
  `useMemoryKeychain`).

## Commands

```bash
npm run build                 # tsc + copy schema.sql into dist/
npm test                      # vitest, LOG_LEVEL=silent
node dist/index.js --doctor   # config, binaries, model, keychain presence
node dist/index.js --run list_cameras
node dist/index.js --run sync_day --date YYYY-MM-DD --stage download
node dist/index.js --run health
node dist/index.js --http     # MCP over HTTP on 127.0.0.1:8787
node dist/index.js            # MCP over stdio
```

## Code map

```
src/
  index.ts            CLI entry: stdio | --http | --run <tool> | --doctor; exit codes
  server.ts           MCP server, tool registration, HTTP transport (localhost, DNS rebinding checks)
  config.ts           zod config schema, defaults, vault paths, binary lookup
  keychain.ts         /usr/bin/security wrapper (stdin for short values, argv for long, read-back)
  context.ts          AppContext {config, ledger, ring}
  ring/client.ts      the ONLY ring-client-api importer: auth, token rotation, timeouts, location filter
  ring/events.ts      videoSearch window splitting (20 row cap), normalize to ClipRecord
  ring/download.ts    hq -> untranscoded -> lq -> recording_url fallback, .part + rename
  pipeline/sync.ts    one day end to end; STAGES / AVAILABLE_STAGES; lock; runs row
  pipeline/paths.ts   vault file layout
  db/schema.sql       tables (IF NOT EXISTS)
  db/ledger.ts        all SQL lives here; FTS queries quote every token
  tools/*.ts          one file per MCP tool; register in tools/index.ts
  util/               time (DST-safe), sanitize, exec, retry, log (pino, daily files), fsx (disk, lock)
scripts/install.sh    deps | model | check | build | config | secrets | launchd [server|sync] | unload | faces
scripts/auth.sh       Ring sign-in -> Keychain (scripts/ring-auth.mjs)
launchd/*.plist       templates rendered by install.sh
test/                 vitest; helpers.ts has the fakes
```

## Facts about the Ring API (ring-client-api 14.3.0, measured 2026-11-08)

* `videoSearch` returns at most 20 rows, newest first, and ignores `order=asc`. `src/ring/events.ts`
  splits windows (4 hours, then halves, down to 1 minute) until each window is under the cap.
* The library retries network errors forever, so every call in `client.ts` has a 90 s timeout.
* Location names can carry trailing spaces. Matching is trimmed and case-insensitive.
* Some very short events 404 on every URL. These are `recording_unavailable`, not encryption.
  Only 401/403 on every download from a camera counts toward the E2EE warning.
* Downloaded MP4s run 1 to 6 s longer than the row's `duration`, so wall-clock times
  (`created_at + offset`) are approximate. Do not calibrate. Tools pad every wall-clock window by
  `timePaddingSeconds` (default 10) on both sides
  ([ROADMAP section 4](docs/ROADMAP.md#4-time-codes-the-model)).
* Rotated refresh tokens arrive through `onRefreshTokenUpdated` and are saved to the Keychain at
  once.
