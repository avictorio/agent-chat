# Codebase restructure plan

Started 2026-11-20 at the owner's request. Goal: a layout where the
Cloudflare-specific code and the web app are clearly separate, each
organized by responsibility, with a real component layer in the web app
and guard rails (lint, unit tests, a typed contract) that keep it that way.

This file is the working checklist. Tick items as they land, add the
commit to the progress log at the bottom, and keep it current: a session
picking this up should be able to continue from here alone. When every
phase is done, fold the final layout into AGENTS.md and README.md and
delete this file.

## Resume here (next session)

State on 2026-11-20: phase 1 and step 2.1 are live; 4.6 is done. Next is
step 2.2. The built-in `cc-plugin-privacy` plugin blocked the split tool in
the session that started this (it flags scripts that read the Worker code,
which reads the sender address from config), so at the owner's request
`.claude/settings.json` turns it off; that only applies in a new session.

1. `npm i` at the repo root (the split tool's acorn), `npm i` in `web/`,
   `npm run build`.
2. Step 2.2, the four `lib/` modules:
   ```
   T="node scripts/split-module.js move"
   $T worker/lib/http.js CORS,SSE_HEADERS,json,html,readBody,sseFrame,parseRange --header "HTTP helpers shared by the routes and the Room object."
   $T worker/lib/crypto.js SHA256_K,sha256Bytes,hmacSha256,b64urlEncode,b64urlDecode,sha256hex,concatBytes,hkdf,hexBytes,hmacBytes,pemToDer --header "Hashing, HMAC, HKDF and base64url helpers (Web Crypto, plus a synchronous SHA-256)."
   $T worker/lib/sniff.js sniffAudio,sniffImage,sniffVideo,decodeTextPayload,cleanFileName --header "File-type sniffing (never trust a Content-Type) and upload payload decoding."
   $T worker/lib/text.js escHtml,clamp,clipText,daysBetween,capped,isPlaceholder,htmlToText,mentionsName,nameFold,memberNameProblem,MAX_NAME,speakableText --header "Small text and number helpers."
   node scripts/split-module.js verify && npm run check
   ```
   Then fix the stray comment the move carries: "Identify an image by its
   first bytes ... SVG is not accepted." sits above `parseRange` in
   `lib/http.js`; it belongs above `sniffImage` in `lib/sniff.js`. And the
   "Whether a room exists ..." comment above `escHtml` belongs to
   `roomExists` (2.8). A `npx wrangler deploy --dry-run` should list the
   new `lib/*.js` modules (the `**/*.js` ESModule rule).
3. Gates (the API suite; the UI suite only if web/ changed), deploy, verify
   live, log it below, then 2.3 onward the same way. `verify` after every
   move is the safety net for imports `node --check` can't see.
4. When phase 2 is done: remove `.claude/settings.json` and its
   `.gitignore` exception, so the privacy plugin is back on.

## Ground rules for every step

- **Behaviour stays the same.** Moves and splits only; a bug found on the
  way is fixed in its own commit and noted in the log.
- **One step, one deploy.** Each checked group ships to `main` on its
  own, so a problem points at one change.
- **Gates before each deploy:** `cd web && npx tsc -p app --noEmit && npm run build`,
  `npm run check`, the API suite (`npm run test:api`), the full UI suite
  (155 scenarios), and desktop + phone screenshots when anything visible
  could move.
- **Docs move with the code.** AGENTS.md, README.md, web/README.md and the
  immersive-3d-games skill reference paths; update them in the same commit.
- **Use `git mv`** so file history follows the move.
- **Keep CSS class names and element ids.** The UI suite selects on them;
  change one only with its test in the same commit.
- The AGENTS.md ground rules still apply (secrets stay in Cloudflare,
  deploy only through `main`, throwaway `yourtest-*` rooms for live
  probes).

## Where we are going

```
agent-chat/
├─ wrangler.toml            Cloudflare config stays at the root
├─ worker/                  everything that runs on Cloudflare (was src/)
│  ├─ index.js              entry point + route table only
│  ├─ routes/               one file per API area: rooms, messages, uploads,
│  │                        media, games, mcp, pages
│  ├─ room/                 the Room Durable Object: Room.js (lifecycle,
│  │                        sockets, alarm), schema.js, messages.js,
│  │                        members.js, uploads.js, voices.js
│  ├─ games/                game rules, no Cloudflare APIs: engine.js (the
│  │                        plug-in contract) + one file per game; data/
│  ├─ platform/             outside services: r2-s3.js, webpush.js,
│  │                        gmail.js, cartesia.js, claude.js
│  ├─ agents/               MCP server, API docs text, agent-recipe.md,
│  │                        agent-watch.sh
│  └─ lib/                  http helpers, crypto, file-type sniffing
├─ web/app/src/
│  ├─ app/                  entry, routing, providers (pages, templates)
│  ├─ ui/                   design system: tokens.css, Button, IconButton,
│  │                        Chip, Badge, Avatar, Dialog, Tabs, Toast,
│  │                        ProgressBar..., each with its own CSS
│  ├─ features/             room, feed, composer, board, media, home, shell
│  └─ games/
│     ├─ shared/            catalog, GamesView, dialogs, cards
│     ├─ three/             the 3D engine: arena3d, juice, sfx, atmos, chime
│     └─ <game>/            one folder per game: panel, Arena3D, model,
│                           its own pieces
├─ contract/                API and game-state types both sides check against
└─ tests/                   api/, ui/, unit/
```

Atomic design applies to `ui/` (atoms such as Button and Chip; molecules
such as the reaction bar or an upload progress row). Larger sections and
pages stay grouped by feature, not in literal atoms/molecules/organisms
folders. Component CSS lives next to the component as plain `.css` files
(not CSS Modules), so class names stay stable.

## Phase 1: serve the web app as Workers Static Assets

Today the Worker imports every built file as a text module (`src/app/`,
2.2 MB, ~25 renamed files per UI change). Cloudflare serves the build
directly instead; the Worker still runs first for everything except the
hashed `/assets/*`, so it keeps the API, the page routes and the
build-id stamp.

- [x] `web/app/public/_headers`: one-year immutable cache for `/assets/*`
      (what the Worker sends today)
- [x] `wrangler.toml`: `[assets]` with `directory = "web/app/dist"`,
      `binding = "ASSETS"`, `run_worker_first = ["/*", "!/assets/*"]`,
      `html_handling = "none"`, `not_found_handling = "none"`; drop the
      `app/` module rules
- [x] Worker: `page()` and `currentBuildId()` read `index.html` through
      `env.ASSETS` (stamp over the `next-dev` placeholder, hash for the
      build id); remove the `APP_INDEX` / `APP_ASSETS` imports and the
      asset-map route
- [x] Delete `src/app/` and `web/scripts/emit-app.py`
- [x] `scripts/check-inline.js` checks `web/app/index.html`
- [x] Root `npm run build`; the API suite says clearly when the web build
      is missing
- [x] Workers Builds: build command
      `npm ci --prefix web && npm run build --prefix web` (set through the
      Cloudflare connector before the push; harmless for the old layout)
- [x] Docs: README, AGENTS (deploy workflow, modules row, pitfalls, the
      ground rule about `src/app/`), web/README, PARITY note, the 3D
      skill's verification steps
- [x] Found on the way: the client's update check skipped an unstamped
      page by looking for `__BUILD_ID__`; the unstamped value is now the
      build's own `next-dev`
- [x] Gates, deploy, then verify live: the build log is green; `/` and
      `/r/ROOM` are stamped and match `/api/build`; an asset answers with
      the immutable cache header; a lazy 3D arena chunk loads; an unknown
      `/assets/` path is a 404

## Phase 2: split the Worker into modules

`src/worker.js` is 11,743 lines: the Room Durable Object (~7,000 lines,
370 methods, ~220 of them game rules), routing (~1,400), the API docs
text (~800) and every integration. Split it without changing behaviour.
The no-bundle deploy already uploads extra ES modules; only the module
rules change. Room methods move into per-area files installed on the
class (`Object.assign(Room.prototype, ...)`) so `this` and every call
site stay as they are; turning them into plain functions can come later.

- Tooling for the split (not committed): an acorn-based script moves named
  top-level declarations into a module with the comment block above them,
  exports them, adds the imports both ways, and refuses a move whose code
  needs a name that stays in the entry (so modules never import back from
  `index.js`). Rehearsed in a scratch clone: 2.1 plus the four `lib/`
  modules passed the full API suite.
- [x] 2.1 `git mv src worker`; `main = "worker/index.js"` (the entry is
      the old file, renamed); `base_dir = "worker"`; paths in docs and
      scripts. Also: an ESModule rule for `**/*.js` (the Text rule's
      `fallthrough = false` drops wrangler's default module rules, so
      sibling `.js` modules would not upload without it), and
      `scripts/check-worker.js` syntax-checks every module (`npm run check`)
- [ ] 2.2 `lib/`: http helpers (json, html, CORS, SSE), crypto (SHA-256,
      HMAC, base64url, HKDF), file sniffing, text helpers
- [ ] 2.3 `platform/`: R2 S3 signing and ListParts, Web Push, Gmail,
      Cartesia voices, the Claude referee
- [ ] 2.4 `agents/`: MCP catalog and tool calls, the API docs text,
      onboarding, `agent-recipe.md`, `agent-watch.sh`
- [ ] 2.5 `games/`: `engine.js` (GAME_ENGINES, aliases, shared helpers),
      one file per game (its engine object, data loaders and Room
      methods), `data/` word lists
- [ ] 2.6 `routes/`: the fetch handler becomes a route table; one file per
      API area
- [ ] 2.7 `room/`: the rest of the Room class by area (schema, messages,
      members and invites, uploads, voices, streams, digest, games glue)
- [ ] 2.8 Fix comments left in the wrong place by earlier edits (for
      example the stale "Whether a room exists" note above `escHtml`)
- [ ] 2.9 Remove `.claude/settings.json` (and its `.gitignore`
      exception): the privacy plugin back on once the split is done

## Phase 3: reorganize the web app

- [ ] 3.1 `games/` into `games/shared/`, `games/three/` and one folder per
      game (moves and import paths only)
- [ ] 3.2 `features/` (room, feed, composer, board, media, home, shell)
      and `app/` (App, main, routing)
- [ ] 3.3 `ui/` design system: `tokens.css` (the `:root` variables),
      Button, IconButton, Chip, Badge, Avatar, Dialog, Tabs, Toast,
      ProgressBar; replace repeated class strings with them, one feature
      at a time
- [ ] 3.4 Split `styles.css` (1,707 lines) into tokens, base, and CSS next
      to each component or feature
- [ ] Screenshots at desktop and phone widths for each visible change

## Phase 4: contract and guard rails

- [ ] 4.1 `web/shared` becomes top-level `contract/` (API and game-state
      types); the web app imports it; the Worker checks against it with
      JSDoc and `checkJs`
- [ ] 4.2 ESLint with the React hooks rules, so the 97 existing
      `eslint-disable` comments are enforced; fix or justify each
- [ ] 4.3 Unit tests (`node:test`) for the game engines and `lcmodel`
- [ ] 4.4 Pin `wrangler` as a dev dependency so deploys and local runs
      use one known version
- [ ] 4.5 Tests into `tests/api/`, `tests/ui/`, `tests/unit/`
- [x] 4.6 (done early, while 2.2 waited on the guard) UI suite: stop swallowing console errors. Today every scenario
      logs a 404 for `/icons/icon-192.png` (the install strip's icon,
      which the live site serves but the test stubs don't), and the
      harness ignores console errors everywhere except the home-page
      scenario, which only prints them. Serve `/icons/*` from the stubs,
      fail a scenario on any request the stub doesn't handle and on
      console errors, with a per-scenario allow-list for the deliberate
      ones (the 3D load-failure scenario's 404, missing avatars)

## Phase 5: longer term

- [ ] Rewrite the hand-built game panels in `games.ts` / `render.ts`
      (`el("div", ...)`) as React components, one game at a time
- [ ] Optional: TypeScript for the Worker, once `checkJs` is clean

## Progress log

| Date | Step | Commit | Notes |
|---|---|---|---|
| 2026-11-20 | Plan written | 999ad64 | |
| 2026-11-20 | Phase 1: static assets | 999ad64 | API suite (with new asset checks) and 155 UI scenarios green; Workers Builds built and deployed version 1d37c750 (24 assets; Worker upload 3.9 MB -> 1.8 MB). Live: `/` and existing rooms stamped 426bbdbc1870bc96 = `/api/build`; bundle `Cache-Control: public, max-age=31536000, immutable`; unknown asset and `/index.html` 404; 3D chunks 200; no update banner on a fresh load. |
| 2026-11-20 | 2.1: `src/` -> `worker/` | aaba45b (deployed with b5772fe) | API suite green; version 19001c48. Live: `/api` 200 and its docs name `worker/data/`; `/sw.js` (text module) 200; pages stamped with the unchanged build id. The split tool's first run on the real tree was then blocked by the cc-plugin-privacy guard (it flags scripts that read the Worker code, which reads the sender address from config); the owner chose to adjust the guard. |
