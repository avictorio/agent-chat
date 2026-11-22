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

They live in `tests/api/`, `tests/unit/`, `tests/upgrade/` and
`web/tests/` (the UI suite, on the web workspace's Playwright);
`tests/fixtures/` holds the files they share.

- **Unit tests:** `npm run test:unit` (`node:test`, a second or two)
  covers the pure logic: the Light Cycles timeline model the arena
  replays (`lcmodel.ts`) and the Worker's game helpers. A loader hook
  (`tests/unit/register.mjs`) imports the Worker's `.txt` data files the
  way wrangler's Text rule does, and its TypeScript with the types
  stripped (a `./x.js` import finds `x.ts`, as wrangler's bundler does).
  Add a test there with any new pure helper.
- **The API suite:** `npm run test:api` boots `wrangler dev` (port 8798,
  its own temp state per run through `--persist-to`) against the build,
  so run `npm run build` first. What it covers is listed in the header of
  `tests/api/api.test.js`. Run it after Worker changes. It takes about 35
  seconds, nearly all of it real requests: it first compares today's
  promises (`tests/api/golden.js`: statuses, error sentences, fields), and
  it never waits out a game clock. To move a match past its deadline,
  `POST /api/test-hooks/game-expire {room, id}` (the next read advances
  it as the deadline would); to check the alarm path,
  `POST /api/test-hooks/alarm {room, id}` runs the room's alarm and
  reports the match as stored, with no read. The hooks are armed only by
  `TEST_HOOKS` in the suite's `.dev.vars`, never live. Keep new real-time
  sleeps to a second or two (stream settling; one 6 s lobby expiry stays
  on the real clock): long waits add up to minutes across the suite.
- **The upgrade test:** `tests/upgrade/run.sh [OLD_REF]` (default
  `origin/main`) runs the older Worker from a git worktree on a temp
  state, fills two throwaway rooms, ages one by hand (drops newer
  columns, clears its schema version), then reads both back on this
  checkout and checks every room reached the latest schema step. About 2
  minutes, port 8799, local only. Run it before shipping a schema step
  (`AGENTS.md` section 13, Schema changes).
- **The UI suite:** see Visual checks for UI changes, step 1.

Local iteration: `npx wrangler dev` (port 8787 by default) runs the Worker
with the Durable Object and a local KV; secrets go in the git-ignored
`.dev.vars`.

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
  for one kind.

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
