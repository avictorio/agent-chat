# Testing and visual checks

Part of the agent guide (`AGENTS.md` sections 9 and 10): the test suites,
how to run them, and how UI changes are checked by eye. Read `AGENTS.md`
first.

## 9. Testing

From a local CLI you can usually hit `https://chat.victorio.cloud` directly
with `curl` or `fetch`.

From a cloud session on the `agent-chat` environment, the site is reachable
directly and the proxy adds the owner key to **every** request (section 2).
Live probes there are therefore owner requests: they cannot show the
no-token (401), bad-token (403) or member-only rules. Check those with
`npm run test:api` locally, or with Browser Rendering below, which sends
only the headers your script sets.

From other cloud environments, the sandbox normally **cannot** reach the
site. Use Cloudflare's Browser Rendering API instead:
`POST /accounts/{account}/browser-rendering/content` with
`url: "https://chat.victorio.cloud/"` and
`addScriptTag: [{ content: "<your JS>" }]`. The JS runs on the site's own
origin, so relative `fetch('/api/...')` calls work. Have it write a JSON
result into a `<pre id="result">`, use
`waitForSelector: { selector: "#result" }`, and parse the returned HTML.
Browser Rendering is rate-limited (HTTP 429), so batch your checks into one
script rather than many calls.

Test checklist:

- **Rooms:** two creation paths: the owner key (`POST /api/rooms/ROOM`)
  and the public one (`POST /api/create-room`, section 3). Use a fresh
  throwaway room per test run; digest posts burn that room's 3-a-day
  limit. Afterwards remove its invites and delete it:
  `DELETE /api/rooms/ROOM?confirm=ROOM`. Deleting is permanent. Rooms in
  `PROTECTED_ROOMS` in `worker/limits.ts` (`henry-hank-order-up`) can't be
  deleted through the API.
- **Server behavior has an automated suite:** `npm run test:api` boots
  wrangler dev (port 8798, its own temp state per run via `--persist-to`)
  and checks the access matrix, draft-media privacy, create-room
  validation/409/rollback, the invite-only invariants, publish-on-complete,
  room destruction, the upload engine (including direct-upload signing),
  MCP, stream frames and the game engines. Run it after Worker changes.
  It takes about 35 seconds, nearly all of it real requests: it first
  compares today's promises (`tests/api/golden.js`: statuses, error
  sentences, fields), and it never waits out a game clock. To move a
  match past its deadline, call `POST /api/test-hooks/game-expire
  {room, id}` (the next read advances it as the deadline would); to
  check the alarm path, `POST /api/test-hooks/alarm {room, id}` runs the
  room's alarm and reports the match as stored, with no read. Keep new
  real-time sleeps to a second or two (stream settling, one 6 s lobby
  expiry left on the real clock); a wait of 30 s or more cost the suite
  six minutes before 2026-11-22.
  The suites live in `tests/api/` (this one), `tests/unit/` and
  `web/tests/` (the UI suite, on the web workspace's Playwright);
  `tests/fixtures/` holds the files they share.
- **Unit tests:** `npm run test:unit` (`node:test`, a second or two) covers
  the pure logic: the Light Cycles timeline model the arena replays
  (`lcmodel.ts`, run straight from TypeScript) and the Worker's game
  helpers - answer matching, the move-field parser, the engine table,
  card boards and tallies, image checks, the Letter Grid dictionary. A
  loader hook (`tests/unit/register.mjs`) imports the Worker's `.txt`
  data files the way wrangler's Text rule does, and its TypeScript
  modules with their types stripped (a `./x.js` import finds `x.ts`, as
  wrangler's bundler does). Add a test there with
  any new pure helper.
- **Every changed endpoint:** test the happy path, the validation errors, and
  the access rules: no token (401), bad token (403), revoked token, a valid
  invite, and the owner key.
- **Invite-only rooms:** create an invite with the owner key, test, then
  `DELETE /api/rooms/ROOM/invites` to clean up.
- **Unaffected features:** confirm that messages, the stream and the docs
  still work.
- **Activity log:** read the `log:` keys in KV (room deletions, push
  errors).
- **Failure lines:** Workers Logs (dashboard: Workers, victorio-chat,
  Logs; or the observability telemetry API) keep every `console` line,
  the Room Durable Object's included. `warn()` (`worker/lib/log.ts`)
  writes one JSON line per unexpected failure, `{"warn": "area.what",
  "error": ..., ids}`: filter on the `warn` field to see what has been
  going wrong, and on its value (`media.read`, `alarm.arm`, `push.send`...)
  for one kind. AGENTS.md section 13 has the rules for adding one.

Local iteration: `npx wrangler dev` (port 8787 by default; the API suite uses 8798) runs the Worker locally with
the Durable Object and a local KV; secrets go in the git-ignored `.dev.vars`.

---

## 10. Visual checks for UI changes

Anthony asked for this explicitly: UI changes must be inspected with real
screenshots, actually looked at, before calling them fixed. Reaffirmed
2026-11-07 with the commit gate made explicit: **always inspect visually
before committing, at both desktop and mobile sizes** — a UI change is not
committed, let alone pushed, until its screenshots have actually been
looked at in both sizes.

1. **Use the real build.** The UI suite in `web/tests/ui/` serves the built
   app (`web/app/dist`) through a fake API, scenario by scenario: the fake
   API and the runner are `harness.js`, the scenarios are split by feature
   (`shell`, `chat`, `people-media`, `games`, `arenas`, `arenas-3d`,
   `battleship`, each `<feature>.test.js`), and `run.js` runs the files in
   parallel (`npm test` in `web/`; `JOBS=n` sets how many at once,
   `FILES=chat,games` picks files, `ONLY=name1,name2` picks scenarios; one
   file alone is `node tests/ui/<feature>.test.js`). The full suite takes
   about 7 minutes on a 4-core sandbox and is CPU-bound: the 3D scenes
   render in software (SwiftShader) on every core, so more jobs at once
   only slow each other down. `UI_TIMES=1` prints each scenario's time
   (browser launch, page load, the rest); `UI_REDUCED_MOTION=1` runs every
   scenario with prefers-reduced-motion, about 4 minutes, for iterating
   (the 3D scenes stop animating, so it doesn't exercise the motion code
   or give the screenshots people see - run the full suite before a
   deploy). In a Claude cloud
   sandbox add `-r ./tests/system-chromium.js` after `node` (from `web/`)
   to use the preinstalled Chromium. The suite runs on a fixed clock
   (`NOW` in `harness.js`, UTC; `CLOCK=real` for the machine's), so two
   runs of a build give the same screenshots except where something
   animates (the 3D scenes, Henry's GIF avatar, live pulses and second
   countdowns); they land in `web/tests/shots/`. In a scenario, wait on
   state (`waitForSelector`, `waitForFunction`, or `settle(page)` after an
   action), not a fixed `waitForTimeout`: fixed sleeps are what failed
   under load. Keep a sleep only to time a gesture (a long press) or to
   give a 3D scene time to draw before a screenshot. A scenario fails on an uncaught page error, on a
   request the fake API doesn't handle (a missing stub route or a broken
   path: add the route), and on a console error other than "Failed to
   load resource" with an HTTP status the stub returned on purpose; pass
   `allowConsole` (a RegExp) for an expected one. For a refactor that
   must not change the markup (the games' panels moving to React),
   `node -r ./tests/system-chromium.js tests/ui/panelsnap.js before.json`
   records every game's chat card and arena (Game and History tabs) in
   each fixture state, with and without WebGL, at desktop and phone width;
   run it on the old and the new build and compare with
   `node tests/ui/panelsnap.js diff before.json after.json`.
   `ONLY_GAMES=tr,au` limits it to some fixtures; `STYLES=1` adds a hash
   of each element's computed style (CSS Typed OM computed values, with
   animations settled, so two runs of one build agree) for a CSS move
   that must not change how anything looks.
2. **Serve them as production does.** Use Playwright
   `page.route('https://chat.victorio.cloud/**', ...)`: serve the page for
   `/r/...` and `/`, stub `/api/.../messages` and the board endpoints with
   sample JSON, and stub `/stream` with an empty SSE body. The pages then
   render as they do in production.
3. **Screenshot every state.** Do both pages, with `colorScheme` `light` and
   `dark`, at desktop and phone (about 390 px) widths. Click through each
   theme-toggle state and reload to check the saved state persists. Look at
   the screenshots, and sample pixel colors too, not just `getComputedStyle`.
4. **Check auto-dark.** Browser auto-dark (Chrome/Samsung) is the known
   trouble spot: the Light theme opts out with CSS `color-scheme: only
   light`. In the Playwright Chromium, the
   `--blink-settings=forceDarkModeEnabled=true` flag darkens **every** page
   regardless of that opt-out, so it can't confirm the fix. The
   `WebContentsForceDark` feature flag doesn't darken anything headless. Say
   so in your report, and ask Anthony to check on his phone.
5. **Compare before and after.** Screenshot the old version and the new one
   to confirm the bug reproduces before the fix and is gone after. Deploy
   only when the screenshots look right, then re-verify the deployed hashes.
6. **Report in words.** Report findings plainly, including what you couldn't
   test. Don't send screenshots unless asked.

**Safe areas:** in the installed web app (standalone) the page renders
edge-to-edge, so any fixed or full-height UI (top bars, drawers, footers)
must pad with `env(safe-area-inset-*)` under `viewport-fit=cover`. The inset
is 0 in ordinary browsers, so it costs nothing there. Check top AND bottom:
the composer and the drawer foot already carry the bottom inset; headers
and drawer tops are the ones that get missed.


---
