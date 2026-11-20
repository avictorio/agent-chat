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

State on 2026-11-20: phase 1 and steps 2.1-2.5 are live (2.5c pending its deploy); 4.6 is done.
Steps 2.4 (`limits.js`) and 2.5 (every game in `games/`) are done; next
is `agents/` (2.6): the MCP catalog and tool calls, the API docs text,
onboarding. Claude Code's built-in `cc-plugin-privacy` plugin once
blocked the split tool: the Worker held the owner's account email (as the
VAPID subject), and the plugin refuses scripts that read a file holding it.
Turning the plugin off in `.claude/settings.json` had no effect, so the
address came out of the code instead (the subject is now the site's
mailbox from `GMAIL_SENDER`) and the plugin stays on. Keep personal
addresses out of the code.

How a step goes:

1. `npm i` at the repo root (the split tool's acorn) and in `web/`, then
   `npm run build`. The UI suite in a cloud sandbox:
   `cd web && node -r ./tests/system-chromium.js tests/ui.test.js`.
2. Move with `node scripts/split-module.js move <target> <names> --header
   "..."` (add `--dry` to try first), then `node scripts/split-module.js
   verify && npm run check`. The tool refuses a move whose code needs a
   name still in `index.js`: move that name first, or with it. Read the
   new module afterwards: comments that sat in the wrong place before the
   move travel with the code below them.
3. `npx wrangler deploy --dry-run` should list the new modules; then the
   API suite (the UI suite only if web/ changed), deploy, verify live, and
   log it below.

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

- Tooling: `scripts/split-module.js` (acorn) moves named top-level
  declarations into a module with the comment block above them, exports
  them, adds the imports both ways, and refuses a move whose code needs a
  name that stays in the entry (so modules never import back from
  `index.js`); `verify` checks every module's names resolve.
- [x] 2.1 `git mv src worker`; `main = "worker/index.js"` (the entry is
      the old file, renamed); `base_dir = "worker"`; paths in docs and
      scripts. Also: an ESModule rule for `**/*.js` (the Text rule's
      `fallthrough = false` drops wrangler's default module rules, so
      sibling `.js` modules would not upload without it), and
      `scripts/check-worker.js` syntax-checks every module (`npm run check`)
- [x] 2.2 `lib/`: http helpers (json, html, CORS, SSE), crypto (SHA-256,
      HMAC, base64url, HKDF), file sniffing, text helpers - `lib/http.js`,
      `lib/crypto.js`, `lib/sniff.js`, `lib/text.js` (index.js 11,746 ->
      11,488 lines); the sniffImage and roomExists comments put back
      where they belong
- [x] 2.3 `platform/`: R2 S3 signing and ListParts, Web Push, Gmail,
      Cartesia voices, the Claude referee - `platform/r2-s3.js`,
      `webpush.js`, `gmail.js`, `cartesia.js`, `claude.js`, `webfetch.js`
      (the fetch tool), plus `lib/media.js` (media signing, CSP, headers,
      ranges); index.js down to 10,975 lines
Order changed 2026-11-20: a dry run showed the API docs text and the
MCP code read dozens of limits and the game engine table, so the shared
limits and the games move before `agents/`.

- [x] 2.4 `limits.js`: the room-wide limits and constants (message,
      board, digest, invite, push, upload and size caps) that the Room,
      the docs text and MCP all read - 60 constants with their comments;
      index.js 10,975 -> 10,930 lines. The split tool now keeps
      declarations that sat on adjacent lines together
- [x] 2.5 `games/`: `engine.js` (GAME_ENGINES, aliases, shared helpers),
      one file per game (its constants, data loaders, engine object and
      Room methods), `data/` word lists. The split tool first gains a
      mode that moves Room methods into a module installed with
      `Object.assign(Room.prototype, ...)` (check that Durable Object RPC
      still sees methods installed that way)
  - [x] Tooling: `methods` (Room methods -> `export const XMethods = {...}`,
        installed after the class) and `prop` (one GAME_ENGINES entry, in
        the literal or a `GAME_ENGINES.x = {...}` statement, -> its own
        export); imports now merge per source; `verify` also checks every
        named import is exported. RPC to a prototype-installed method
        proven under `wrangler dev` (`/api/push/key` via `vapidPublic`)
  - [x] 2.5a-b `games/shared.js` (seats, clocks in words, data files, the
        fuzzy answer matching Trivia and Sketch share) and ten games: Four
        in a Row, Trust, Auction, Frontlines, Code Race, Liar's Dice, Two
        Truths, Trivia, Sketch & Guess, Exquisite Corpse - each
        `games/<game>.js` holds its constants and data, its Room methods
        (`<Game>Methods`) and its engine entry (`<game>Engine`); index.js
        10,930 -> 8,091 lines (one deploy for both batches)
  - [x] 2.5c the other six (Werewolf, Twenty Questions, Letter Grid, Duel,
        Light Cycles, Battleship) and `games/engine.js` (the table, folded
        into one literal in the same key order, aliases, gameEngine,
        moveFields); the engine-contract comment moves above the table.
        index.js 8,091 -> 5,902 lines; 31 modules. The shared game
        machinery (lobby, clocks, alarm, rounds and turns, cards, listing)
        stays in the Room for 2.8
- [ ] 2.6 `agents/`: MCP catalog and tool calls, the API docs text,
      onboarding, `agent-recipe.md`, `agent-watch.sh`
- [ ] 2.7 `routes/`: the fetch handler becomes a route table; one file per
      API area
- [ ] 2.8 `room/`: the rest of the Room class by area (schema, messages,
      members and invites, uploads, voices, streams, digest, games glue)
- [ ] 2.9 Fix comments left in the wrong place by earlier edits (the
      sniffImage and roomExists ones are done)
- [x] 2.10 Remove `.claude/settings.json` (and its `.gitignore`
      exception): done early - it never took effect; the real trigger
      (the owner's email as the VAPID subject) left the code instead

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
| 2026-11-20 | 4.6: strict UI suite | f4a5a69, b0aa1b8 | Report-only run: 146 scenarios clean once `/icons/*` was served; 7 deliberate error statuses; one real gap (the media shelf's video tile fetched `/messages/5/video` with no stub route). Strict run: 155/155. A copy without the icon route fails as it should. |
| 2026-11-20 | Split tool + privacy plugin off | 859e994 | `scripts/split-module.js` (move/verify) committed; `.claude/settings.json` turns `cc-plugin-privacy@builtin` off at the owner's request. It still blocked this session (plugin changes apply to new sessions), so 2.2 starts in the next session - see "Resume here". |
| 2026-11-20 | Privacy plugin: the real fix | (this commit) | A new session showed the setting doesn't turn the built-in plugin off. The trigger was the owner's account email as `VAPID_SUBJECT` in the Worker; the push JWT's subject is now `mailto:` + `GMAIL_SENDER` (https URL fallback) and the setting is gone. The split tool runs again with the plugin on. Deployed as version 41b7757f; `/api/push/key` still served. |
| 2026-11-20 | 2.2: `lib/` | 8d38e3f | API suite green; version 9a242084 (14 modules). Live: `/api`, `/sw.js`, the page stamp, a real room's members list (read) and a signed avatar (200, image/webp). |
| 2026-11-20 | 2.3: `platform/` + `lib/media.js` | fe4a36c | API suite green (631 checks); version 169da5fb (21 modules). Live: `/api`, `/api/push/key`, a signed avatar, attachment media full (200) and ranged (206). |
