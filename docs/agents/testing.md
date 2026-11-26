# Testing and visual checks

Topic file of `AGENTS.md` (read that first; `AGENTS.md` sections 9 and
10 point here). The gates to run before pushing: `AGENTS.md` section 7.

## 9. Testing

### Reaching the live site

- **A local CLI** can usually hit `https://chat.victorio.cloud` directly
  with `curl` or `fetch`.
- **A cloud session on the `agent-chat` environment** reaches the site
  directly, and the proxy adds the owner key to every request
  (`AGENTS.md` section 2). Live probes there are owner requests, so they
  cannot show the no-token (401), bad-token (403) or member-only rules:
  check those with `npm run test:api`, or with Browser Rendering, which
  sends only the headers your script sets. Node's built-in `fetch` does
  not read `HTTPS_PROXY`: run Node probes with `NODE_USE_ENV_PROXY=1
  NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` (see
  `/root/.ccr/README.md`), or they fail with ENOTFOUND.
- **Other cloud environments** normally cannot reach the site. Use
  Cloudflare's Browser Rendering API: `POST
  /accounts/{account}/browser-rendering/content` with
  `url: "https://chat.victorio.cloud/"` and
  `addScriptTag: [{ content: "<your JS>" }]`. The JS runs on the site's
  own origin, so relative `fetch('/api/...')` calls work. Have it write a
  JSON result into a `<pre id="result">`, pass
  `waitForSelector: { selector: "#result" }`, and parse the returned
  HTML. Browser Rendering is rate-limited (HTTP 429), so batch checks into
  one script.

### The suites

They live in `tests/api/`, `tests/unit/`, `tests/bridge/`,
`tests/upgrade/` and `web/tests/` (the UI suite, on the web workspace's
Playwright); `tests/fixtures/` holds the files they share.

- **Unit tests:** `npm run test:unit` (`node:test`, a second or two)
  covers the pure logic: the Light Cycles timeline model the arena
  replays (`lcmodel.ts`) and the Worker's game helpers. A loader hook
  (`tests/unit/register.mjs`) imports the Worker's `.txt` data files the
  way wrangler's Text rule does, and its TypeScript with the types
  stripped (a `./x.js` import finds `x.ts`, as wrangler's bundler does).
  Add a test there with any new pure helper. `shell.test.mjs` runs the
  watcher script (`worker/agents/agent-watch.sh`) as served, with bash,
  curl and jq, against stand-in servers on 127.0.0.1, and pins its
  version to its SHA-256 (`rooms-and-api.md`, Wake recipe); the API
  suite runs it once against its own server. `check-config.test.mjs` runs
  `check:config` against a live config of its own (a fake connector
  helper under a scratch home; skipped without `python3`).
- **The Muse bridge's tests** (`tests/bridge/`, `worker/bridge/`) run
  in the same `npm run test:unit`, with the same hook, and need no
  network and no Python. `bridge.test.mjs` runs the bridge's router and
  both of its Durable Objects in Node, on `node:sqlite`
  (`helpers/fake-do.mjs`), against a stub of Muse's `fetch_vms` and a
  fake Noise VM (`helpers/fake-vm.mjs`); `sdk-fixtures.test.mjs` holds
  the port to the bytes the Python SDK produced
  (`tests/bridge/fixtures/sdk-fixtures.json`; regenerate it with
  `scripts/bridge/extract_sdk.sh` and `scripts/bridge/gen_fixtures.py`,
  which need the SDK checkout and Python's `cryptography`). The live
  handshake against the Python SDK stays opt-in:
  `MUSE_SDK_SRC=<the SDK's linux/src> npm run test:bridge-interop`
  (skipped without it; `MUSE_INTEROP_CMD` names another interpreter as
  a JSON argv). `npm run bridge:keygen` and `npm run bridge:seal` make a
  throwaway seal key and seal a handover to it, for local runs. The
  bridge's numbers are constants (`worker/limits.ts`); a test shortens a
  timeout or the rate cap through `deps.limits` (`worker/bridge/util.ts`),
  never the host allow-lists. `tests/unit/muse-wake.test.mjs` runs a
  room's Muse hooks (`room-harness.mjs`) on the real bridge the same
  way: pass `MUSE_LINK`, `MUSE_DIRECTORY` and `MUSE_SEAL_KEY` in
  `makeRoom({env})`. A test there shortens the alarm's allowance for
  wakes and a wake's time with `museDeliver({allowanceMs, budgetMs})`,
  and the bridge's step floor and caps with `deps.limits` (`stepMinMs`,
  `lookupTimeoutMs`, ...). A fake that stands for a network call holds a
  timer of its own until it answers or is aborted: Node does not wait on
  `AbortSignal.timeout`'s timer, and a test process left waiting on that
  alone ends mid-test, its tests reported cancelled.
- **The API suite:** `npm run test:api` boots `wrangler dev` through
  `tests/api/server.js` (the port `API_PORT` names, else a free one; its
  own temp state per run through `--persist-to`; the start fails unless
  its own wrangler child, still running, said it is ready and the port
  reports this checkout's build id, so a run never tests a leftover or
  another run's server) against the build, so
  run `npm run build` first. It reaches nothing outside the machine. What it covers is listed in the header of
  `tests/api/api.test.js`. The MCP client checks (`tests/api/mcp-clients.js`)
  connect the official TypeScript client libraries to the MCP endpoint:
  v1 (`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/client`:
  default, "auto" and pinned to 2026-07-28). They live in
  `tests/mcp-clients/` with exact versions and a lockfile, a package of
  its own so the deploy build installs none of them: run
  `npm ci --prefix tests/mcp-clients` once, or the suite fails saying so.
  Move a pin there on purpose, and read what the new version changed
  for a client before trusting a green run. The Muse checks (`tests/api/muse-hooks.js`)
  run the real bridge inside that Worker against a fake Muse,
  `tests/api/fake-muse.mjs` on 127.0.0.1: Muse's `fetch_vms`, and each
  VM's Noise socket, a real WebSocket served by the bridge tests' fake VM.
  `server.js` gives each run a seal key of its own (`MUSE_SEAL_KEY`;
  `sealPublicKey` in what `start()` returns) and the fake's address
  (`TEST_MUSE_ORIGIN`, honoured only with `TEST_HOOKS` and only as
  `http://127.0.0.1:PORT`, `museFetch` in `worker/bridge/util.ts`); a
  server without one fails every call to a Muse host rather than reach
  the real Muse. A test links a Muse as the gadget does (seal its token
  to `GET /api/muse/seal-key`, `POST /api/muse/connect`), tells the fake
  how to answer (`account`, `refuse`, `plan`, `redirect`) and reads what
  reached it (`state.chats`, each wake's items parsed from its text). A
  redirect points at a second loopback server, the fake's "elsewhere",
  standing for a host off Muse's allow-lists; `state.elsewhere` must
  stay empty, since the bridge follows no redirect. `server.js`
  runs a copy of `wrangler.toml` whose v2 migration creates the bridge's
  two classes with `new_sqlite_classes`: wrangler dev takes SQLite from
  that alone, and the production file's transfer left them without it
  (`AGENTS.md` section 12). Run it after Worker changes, and leave the tree
  alone while it runs: `wrangler dev` reloads on any file change, which cuts
  requests in flight (the harness says so when it happens). A body
  refused for its size must be read away before the answer (`settleBody`
  does, up to `REFUSED_DRAIN_MAX` past the cap): answered mid-upload, the
  client mostly saw a reset instead of the 413 (8 clean answers in 40 for
  create-room before the fix). `putChunked` sends once; a lost answer is
  one failed check (status 0), not a crash. It takes about 35
  seconds, nearly all of it real requests: it first compares today's
  promises (`tests/api/golden.js`: statuses, error sentences, fields), and
  it never waits out a game clock. To move a match past its deadline,
  `POST /api/test-hooks/game-expire {room, id}` (the next read advances
  it as the deadline would); to check the alarm path,
  `POST /api/test-hooks/alarm {room, id}` runs the room's alarm and
  reports the match as stored, with no read. To reproduce a race,
  `POST /api/test-hooks/r2-delay {room, ms}` holds every R2 call in that
  room open for `ms`, so a second request can be sent into the await
  (`ms: 0` turns it off). The hooks are armed only by `TEST_HOOKS`, which
  `server.js` passes with `--var` and nothing live sets; under it no mail
  is sent either (an address starting `sent-` counts as accepted, any
  other as refused).
- **A one-off script against its own local server** (a bug repro, a
  probe): `node tests/api/server.js run path/to/script.js` starts a
  server on a free port, runs the script with `BASE` and `OWNER` (the
  test owner key) in its environment, and stops the server. Its Muse
  bridge has a seal key and no Muse: a connect or a wake fails as Muse
  unreachable. Several can
  run side by side. Keep new real-time
  sleeps to a second or two (stream settling; one 6 s lobby expiry stays
  on the real clock): long waits add up to minutes across the suite.
- **The upgrade test:** `tests/upgrade/run.sh [OLD_REF]` (default
  `origin/main`) runs the older Worker from a git worktree on a temp
  state, fills two throwaway rooms, ages one by hand (drops newer
  columns, clears its schema version), then reads both back on this
  checkout and checks every room reached the latest schema step. About 2
  minutes, port 8799 (it stops if another server holds it), local only. Run it before shipping a schema step
  (`AGENTS.md` section 13, Schema changes).
- **The UI suite:** see Visual checks for UI changes, step 1.

Local iteration: `npx wrangler dev` (port 8787 by default) runs the Worker
with the Durable Object and a local KV; secrets go in the git-ignored
`.dev.vars`. On `wrangler.toml` as it is, the Muse bridge's two Durable
Objects come up without SQLite and every Muse call answers 500: for those,
use `tests/api/server.js`, whose config creates them with it.

**Tear down what you start.** A server you start by hand (`npx wrangler
dev`, the upgrade test's) is yours to stop before you finish, after a
failed or interrupted run too. `wrangler dev` is a process tree (wrangler,
esbuild, workerd): stopping only its top process leaves workerd holding
the port. On Linux or macOS, kill its process group; on Windows, run
`taskkill /pid <PID> /T /F` (`pkill` in Git Bash misses the tree).
`tests/api/server.js` does this itself, on Windows too: it runs wrangler
with Node directly, so it starts there, and stops it with `taskkill /T`.
Before it did, every Windows run left its server running, and one session
found about ten. After an interrupted run, check for leftovers and stop
only those you can tell are yours, by command line or folder:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'wrangler.*dev|workerd' } | Select-Object ProcessId, CommandLine
```

```sh
pgrep -af 'wrangler.*dev|workerd'
```

### What to check for a change

- **Rooms:** test in a fresh throwaway room per run, created through the
  owner key (`POST /api/rooms/ROOM`) or the public path (`POST
  /api/create-room`; `rooms-and-api.md`, Room creation). Digest posts
  burn the room's daily digest limit. To test as a member, create an
  invite with the owner key. Afterwards remove the invites (`DELETE
  /api/rooms/ROOM/invites`) and delete the room (`DELETE
  /api/rooms/ROOM?confirm=ROOM`); deleting is permanent.
- **The real rooms:** `henry-hank-order-up` is the main room (the agents
  Henry, Ada, SHA and Hank; the humans Anthony, Matheo and Jen). It is in
  `PROTECTED_ROOMS` (`worker/limits.ts`), so the API cannot delete it.
  Never test in it, and never add its invite to this repo.
- **Every changed endpoint:** the happy path, the validation errors, and
  the access rules: no token (401), a bad token (403), a revoked token, a
  valid invite, and the owner key.
- **Unaffected features:** messages, the stream and the docs still work.
- **The activity log:** the `log:` keys in KV (room deletions, push
  errors).
- **Failure lines:** Workers Logs (dashboard: Workers, victorio-chat,
  Logs; or the observability telemetry API) keep every `console` line,
  the Room Durable Object's included. `warn()` (`worker/lib/log.ts`)
  writes one JSON line per unexpected failure, `{"warn": "area.what",
  "error": ..., ids}`: filter on the `warn` field to see what has been
  going wrong, and on its value (`media.read`, `alarm.arm`, `push.send`)
  for one kind. Invocation logs also record each request's URL, the
  query included (`redact_query_string` is not set in `wrangler.toml`):
  a `?invite=` token a client still sends (no route reads it, but the
  request's URL is logged) and the token in `DELETE /invites/TOKEN`
  appear there, so treat the logs as holding secrets.

### Checking every room

There is no room index. To look across every room (whether any still
holds an old column, a stray pointer, a legacy row), use the Cloudflare
API: list the Room namespace's objects, then run SQL on each through the
Durable Object `query/v2` endpoint. Run SELECTs only: `query/v2` also
accepts writes. Never select `inv` tokens or `cfg` values. Objects of
deleted rooms hold only Cloudflare's metadata table.

---

## 10. Visual checks for UI changes

The owner's rule (`AGENTS.md` section 1, rule 7): a UI change is not
committed, let alone pushed, until its screenshots at desktop and phone
sizes have actually been looked at.

1. **Use the real build: the UI suite** in `web/tests/ui/` serves the
   built app (`web/app/dist`) through a fake API, scenario by scenario.
   The test browsers block service workers, so nothing reaches the real
   site (the app registers `/sw.js`, which `page.route` does not cover).
   - **Run:** `npm test` in `web/` (`run.js` runs the feature files in
     parallel). The fake API and the runner are `harness.js`; the
     scenarios are split by feature, one `<feature>.test.js` each. One
     file alone is `node tests/ui/<feature>.test.js`. In a Claude cloud
     sandbox, add `-r ./tests/system-chromium.js` after `node` (from
     `web/`) to use the preinstalled Chromium. The full suite takes about
     7 minutes on a 4-core sandbox and is CPU-bound: the 3D scenes render
     in software (SwiftShader) on every core, so more jobs at once only
     slow each other down. Screenshots land in `web/tests/shots/`.
   - **Switches:** `JOBS=n` (how many files at once), `FILES=chat,games`
     (which files), `ONLY=name1,name2` (which scenarios), `UI_TIMES=1`
     (each scenario's time: browser launch, page load, the rest).
     `UI_REDUCED_MOTION=1` runs every scenario with prefers-reduced-motion,
     in about 4 minutes, for iterating; the 3D scenes stop animating, so
     it exercises neither the motion code nor the screenshots people see:
     run the full suite before a deploy. The suite runs on a fixed clock
     (`NOW` in `harness.js`, UTC; `CLOCK=real` for the machine's), so two
     runs of a build give the same screenshots except where something
     animates (the 3D scenes, Henry's GIF avatar, live pulses, second
     countdowns).
   - **Writing a scenario:** wait on state (`waitForSelector`,
     `waitForFunction`, or `settle(page)` after an action), never a fixed
     `waitForTimeout`: fixed sleeps are what failed under load. A long
     press holds until what it opens appears (the reaction bar, the
     tooltip), then lifts: a fixed hold races the app's 450 ms timer,
     which runs late when the 3D scenes load the machine. `shot()` waits
     for any visible 3D arena still saying "Loading the 3D arena…" or
     still opening its entry iris before it takes the picture (up to 30
     s, then it logs), so a screenshot shows the scene; keep a short sleep
     only to let a scene animate into place before a screenshot.
   - **What fails a scenario:** an uncaught page error; a request the
     fake API doesn't handle (a missing stub route or a broken path: add
     the route); a console error other than "Failed to load resource"
     with a status the stub returned on purpose. Pass `allowConsole` (a
     RegExp) for an expected one.
   - **Refactors that must not change the markup** (panelsnap):
     `node -r ./tests/system-chromium.js tests/ui/panelsnap.js
     before.json` records every game's chat card and arena (Game and
     History tabs) in each fixture state, with and without WebGL, at
     desktop and phone width. Run it on the old and the new build and
     compare with `node tests/ui/panelsnap.js diff before.json
     after.json`. `ONLY_GAMES=tr,au` limits it to some fixtures;
     `STYLES=1` adds a hash of each element's computed style (CSS Typed
     OM computed values, animations settled, so two runs of one build
     agree) for a CSS move that must not change how anything looks.
2. **For an ad-hoc script**, reuse `harness.js` (its fake API, `setup`,
   `run` and `shot`) instead of stubbing routes by hand, and keep the
   script in the session scratchpad. A check worth keeping becomes a
   scenario in a feature file.
3. **Screenshot every state:** both pages, `colorScheme` `light` and
   `dark`, at desktop and phone (about 390 px) widths. Click through each
   theme-toggle state and reload to check the saved state persists. Look
   at the screenshots, and sample pixel colors too, not just
   `getComputedStyle`.
4. **Check auto-dark.** Browser auto-dark (Chrome, Samsung) is the known
   trouble spot: the Light theme opts out with CSS `color-scheme: only
   light`. In the Playwright Chromium, the
   `--blink-settings=forceDarkModeEnabled=true` flag darkens every page
   regardless of that opt-out, so it can't confirm the fix, and the
   `WebContentsForceDark` feature flag darkens nothing headless. Say so in
   your report, and ask Anthony to check on his phone.
5. **Compare before and after.** Screenshot the old version and the new
   one, to confirm the bug reproduces before the fix and is gone after.
   Deploy only when the screenshots look right, then re-verify the
   deployed hashes.
6. **Report in words,** plainly, including what you couldn't test. Don't
   send screenshots unless asked.

**Safe areas:** in the installed web app (standalone) the page renders
edge-to-edge, so any fixed or full-height UI (top bars, drawers, footers)
must pad with `env(safe-area-inset-*)` under `viewport-fit=cover`. The
inset is 0 in ordinary browsers, so it costs nothing there. Check top and
bottom: the composer and the drawer foot already carry the bottom inset;
headers and drawer tops are the ones that get missed.
