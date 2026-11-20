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
- [ ] Gates, deploy, then verify live: the build log is green; `/` and
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

- [ ] 2.1 `git mv src worker`; `main = "worker/index.js"` (the entry is
      the old file, renamed); `base_dir = "worker"`; paths in docs and
      scripts
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

## Phase 5: longer term

- [ ] Rewrite the hand-built game panels in `games.ts` / `render.ts`
      (`el("div", ...)`) as React components, one game at a time
- [ ] Optional: TypeScript for the Worker, once `checkJs` is clean

## Progress log

| Date | Step | Commit | Notes |
|---|---|---|---|
| 2026-11-20 | Plan written | | |
