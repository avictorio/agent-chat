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

State on 2026-11-21: phases 1-4 are done and live (4.1c moved to 5.4);
5.1 (error boundaries) is done. What is left, in order:

- Phase 5, in its order: 5.2 the game registry, 5.3 the UI suite,
  5.4 response types, 5.5 the docs text, 5.6 AGENTS.md as an index.
- When those are done, fold the final layout into AGENTS.md and README.md
  and delete this file.

Verifying a step: `npm run check`, `npm run lint`, `npm run test:unit`,
`npm run test:api`, and for web changes `npm run build` and the UI suite.
A move-only web change should build byte-identical output (compare the
`web/app/dist` hashes before and after); otherwise check the UI suite's
screenshots against run-to-run noise (clocks, relative times and the 3D
scenes differ between two runs of the same build). After a deploy, the
live build id (`/api/build`) is the SHA-256 prefix of the tested
`index.html`, and every `/assets/*` file should hash the same as the
tested build's. Claude Code's built-in `cc-plugin-privacy` plugin once
blocked the split tool because the Worker held the owner's account email;
the address came out of the code (the VAPID subject is the site's mailbox
from `GMAIL_SENDER`). Keep personal addresses out of the code.

How a step goes:

1. `npm i` at the repo root (the split tool's acorn) and in `web/`, then
   `npm run build`. The UI suite in a cloud sandbox:
   `cd web && node -r ./tests/system-chromium.js tests/ui/run.js`.
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
  (149 scenarios, `npm test` in `web/`), and desktop + phone screenshots when anything visible
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
- [x] 2.6 `agents/`: MCP catalog and tool calls, the API docs text,
      onboarding, `agent-recipe.md`, `agent-watch.sh` - `agents/docs.js`,
      `mcp.js`, `onboarding.js` and the two text files (`git mv`); what
      MCP needed came along: `lib/reactions.js`, `uploads/plan.js` (part
      sizes and kind checks) and `routes/uploads.js` (the upload request
      helpers, ahead of 2.7). index.js 5,902 -> 4,449 lines
- [x] 2.7 `routes/`: the fetch handler becomes a route table; one file per
      API area - 2.7a moved the helpers the routes call (`routes/pages.js`
      page shell and icons, `room/state.js` room_state, `lib/errors.js`,
      `room/voices.js`, `routes/rooms.js` genesis email and roomExists);
      2.7b moved 48 routes into handlers with the tool's `route` mode
      (body verbatim, the context destructured from `rc`, routeRequest
      keeps each test and delegates, order and fall-through unchanged):
      routeRequest ~1,400 -> 132 lines, 14 files under `routes/`.
      index.js 4,449 -> 2,863 lines.
      Found on the way: the tool's scope analysis folded block scopes into
      the function, so a `const page` in one route block hid the imported
      `page()` elsewhere and an import was dropped (caught by `verify` in
      the rehearsal, never deployed). Scoping is now block-accurate; a
      re-verify of everything already deployed found nothing. `prune`
      drops imports a module no longer uses (150 in the entry)
- [x] 2.8 `room/`: the Room class by area with the tool's `methods` mode
      (each area one object of methods, installed with
      `Object.assign(Room.prototype, ...)`): `room/members.js`, `voices.js`,
      `media.js`, `uploads.js`, `push.js`, `board.js`, `state.js`,
      `messages.js`, `games.js` (the machinery every game shares) and
      `test-hooks.js`; Light Cycles' tick resolver joined
      `games/lightcycles.js`. 146 methods moved. The class core
      (constructor, schema, lifecycle, access, fetch, the alarm, the
      stream) is `room/Room.js`, which installs all 27 method objects at
      its end (no name collides across them or with the class: checked,
      so install order cannot matter); `index.js` re-exports the class
      (a Durable Object class must be exported from the main module).
      index.js 2,863 -> 198 lines; 61 modules
- [x] 2.9 Fix comments left in the wrong place by earlier edits: two
      reviewers read every module (26 findings). The biggest pattern was a
      split-tool bug: in a new module the imports went in after every
      leading comment line, so the first declaration's comment ended up
      above the import block, reading as a second header (22 modules;
      the tool now puts imports after the header's blank line). The rest:
      comments above the wrong function (postSystem, uploadLinkRoute,
      room_ttTally), the signed-URL scheme note in lib/crypto.js (now
      above mediaSig in lib/media.js), Light Cycles' rules heading the
      shared machinery (now lightcycles.js's header, with legalMoves and
      safeMoves, which only Light Cycles calls), and stale "above",
      "below", "in index.js" and module-header wording
- [x] 2.10 Remove `.claude/settings.json` (and its `.gitignore`
      exception): done early - it never took effect; the real trigger
      (the owner's email as the VAPID subject) left the code instead

## Phase 3: reorganize the web app

- [x] 3.1 `games/` into `games/shared/`, `games/three/` and one folder per
      game (moves and import paths only): 43 files moved with the new
      `scripts/move-files.js` (git mv, then every relative import that
      names a moved file, or that a moved file makes, rewritten - 152
      specifiers in 40 files). `three/` holds the arena primitives
      (arena3d, juice, atmos, sfx, fire), `shared/` the 2D side every game
      shares (catalog, render, gamecard, WinnerBanner, chime), and each of
      the 16 games has a folder with its arena, its panel helpers and its
      own pieces (battleship/ ocean and ships, lightcycles/ cycles and
      lcmodel). `games.ts` and the views RoomShell opens stay at the top.
      The skill, AGENTS.md and web/README.md name the new paths
- [x] 3.2 `features/` (room, feed, composer, board, media, home, shell,
      and games) and `app/` (App, main, routing); `lib.ts` and `dates.ts`
      into `lib/`. 88 files moved with `scripts/move-files.js`; the build
      is byte-identical
- [x] 3.3 `ui/` design system: `tokens.css` (the `:root` variables),
      Button, IconButton, Chip, Badge, Avatar, Dialog, Tabs, Toast,
      ProgressBar; replace repeated class strings with them, one feature
      at a time. Each component renders exactly the markup the call sites
      wrote by hand (same element, classes and attributes; no `type` added
      to a button), so the check is the UI suite plus a screenshot diff
      against run-to-run noise (two runs of the old build: clocks,
      relative times and the animated 3D scenes differ; anything outside
      that is flagged and looked at).
  - [x] 3.3a `Button` (variant, size, danger, icon), `IconButton`,
        `LinkButton`; `Dialog` (the .av-dlg modal, closeOnBackdrop);
        `NavTab` and `Count`. 81 buttons in 18 files (75 by a codemod over
        the parsed TSX - rolldown's parser, since TypeScript 7 has no JS
        API - and 6 with computed classes by hand), five dialogs, the
        sidebar and home tabs. UI suite 155/155; the screenshot flags were
        all clock drift and 3D animation
  - [x] 3.3b `Page` and `PageHead` (the board's six pages and the home
        page's four views), `Card` with `CardTitle`, `CardMeta`,
        `CardText`, `CardActions` (40 elements; forms, `<details>` and span
        titles keep their element)
  - [x] 3.3c `Pill` (tone warn, muted, danger): the board's 8 status
        pills. Not made components, on purpose: the attachment chips
        (`.clip-chip`, only the composer has them), the avatar (two uses)
        and the upload progress bar (one) - a shared component pays once
        a pattern repeats across features. The 2D game panels are built
        with `el()` in `games.ts`/`render.ts`, not JSX; they move to
        components with Phase 5
- [x] 3.4 Split `styles.css` (1,707 lines) into tokens, base, and CSS next
      to each component or feature (done before 3.3, so the components can
      take their CSS with them): 27 files in the original order -
      `ui/tokens.css`, `base.css`, `button.css`, `late.css`; `features/room/`
      layout, sidebar, drawer; `features/feed/` chat, markdown,
      attachments; `features/board/`, `features/media/`; under
      `features/games/` the kinds, one file per game panel, `games.css`
      (the host and arenas, still interleaved) and `new-game.css`.
      `styles.css` is now only the ordered `@import` list, which is the
      cascade. The production build is byte-identical (same CSS asset)
- [x] Screenshots at desktop and phone widths for each visible change:
      phase 3 made none (3.1, 3.2 and 3.4 built byte-identical output; 3.3
      was checked with the UI suite's screenshots against run-to-run noise)

## Phase 4: contract and guard rails

- [x] 4.1 `web/shared` becomes top-level `contract/` (API and game-state
      types); the web app imports it (`@chat/contract`, still a workspace
      of `web/` - npm accepts a workspace outside its root - so the build
      command is unchanged; the dev server's fs.allow names it)
  - [x] 4.1b The Worker typechecks: `npm run check` runs `tsc -p
        tsconfig.worker.json` (allowJs + checkJs, TypeScript 7 pinned at the
        root) over `worker/`. `types/worker-env.d.ts` declares the text
        modules, `cloudflare:workers` and `FixedLengthStream`;
        `types/room-methods.d.ts` merges the 27 installed method objects
        into the Room class. The first run found 21 gaps, all typing
        (methods installed by Object.assign, `concatBytes` reading
        `arguments`, union returns), fixed with JSDoc and a rest parameter
  - [ ] 4.1c (now 5.4) Type the Worker's responses with the contract: JSDoc
        `@returns` on route handlers and Room methods naming
        `@chat/contract` types, so a response that drifts from what the
        web app expects fails the check
- [x] 4.2 Lint with the React hooks rules, so the existing
      `eslint-disable` comments are enforced. ESLint's TypeScript parser
      needs TypeScript's JS API, which TypeScript 7 (this build) no longer
      has, so it is oxlint (the oxc project, like the bundler's parser):
      `npm run lint`, `web/.oxlintrc.json` - rules-of-hooks and
      no-explicit-any as errors, exhaustive-deps as a warning, unused
      disable directives reported. First run: 4 dead disable comments
      (removed), 6 unchecked `any`s (two disable comments with reasons:
      lcmodel's match JSON, Battleship's loose `GL` alias), and one real
      bug - `MediaBlocks` called `useRef` after an early return, so a
      message that gained media after its first render (an upload
      publishing) would throw React's hook-order error and, with no error
      boundary, blank the room (fixed in its own commit)
  - [x] 4.2b The 39 exhaustive-deps warnings, to zero; lint now fails on
        warnings too (`--deny-warnings`). 26 were the arenas'
        `(g && g.players) || []`: a fresh empty list each render, so the
        memos over it recomputed every render - a shared `NO_ITEMS` (the
        arenas never mutate these lists; checked). 4 were stable refs and
        the games store missing from deps (added; their identity never
        changes). The rest are deliberate and say why in a scoped disable:
        the composer's unload guard keyed on `!!up`, the Duel cleanup
        reading its refs at cleanup time, and two scene effects keyed on
        values (`hexes.join`, the vectors' numbers) instead of arrays
        rebuilt each render
- [x] 4.3 Unit tests (`node:test`) for the game engines and `lcmodel`:
      `npm run test:unit`, 22 tests (see AGENTS.md section 9)
- [x] 4.4 Pin `wrangler` as a dev dependency so deploys and local runs
      use one known version: 4.166.0, and the build command gains a root
      `npm ci`
- [x] 4.5 Tests into `tests/api/`, `tests/ui/`, `tests/unit/`: api and
      unit at the root; the UI suite stays in `web/tests/` (it runs on the
      web workspace's Playwright); `tests/fixtures/` is shared
- [x] 4.6 (done early, while 2.2 waited on the guard) UI suite: stop swallowing console errors. Today every scenario
      logs a 404 for `/icons/icon-192.png` (the install strip's icon,
      which the live site serves but the test stubs don't), and the
      harness ignores console errors everywhere except the home-page
      scenario, which only prints them. Serve `/icons/*` from the stubs,
      fail a scenario on any request the stub doesn't handle and on
      console errors, with a per-scenario allow-list for the deliberate
      ones (the 3D load-failure scenario's 404, missing avatars)

## Phase 5: what the refactor turned up

Agreed with the owner on 2026-11-21, in this order:

- [x] 5.1 Error boundaries (`ui/ErrorBoundary.tsx`). There were none: any
      render error unmounted the whole page. Now each feed row (keyed to
      its message, so a richer copy retries), each room view, each board
      page and each dialog has one, with a full-page "Reload" as the last
      resort; the 3D arenas already caught their own (`onUncaughtError`
      on each arena root). UI scenarios `error-boundary-row` (+ phone,
      dark): a message with malformed reactions blanked the whole page on
      the old build; now only that row shows a notice
- [x] 5.2 A client-side game registry. `createGameStore` in
      `features/games/games.ts` is one 2,987-line function with 78
      `g.type === "..."` branches; each game's folder should register its
      panels, card, history rows and catalog entry (the 1,020-line
      `shared/catalog.tsx`) and the host dispatch through the registry -
      the server's `GAME_ENGINES` pattern. Moves first, game by game
  - [x] 5.2a The arena views: 14 games' `render<Game>View` move out of
        `createGameStore` into `<game>/view.ts`, listed in `registry.ts`
        (`GAME_VIEWS`); the store hands each a `GameViewCtx`
        (`shared/viewctx.ts`: the 15 helpers they use, the open view and
        `claimRender`, the render-dedupe check they all repeated).
        `scripts/extract-renderer.mjs` does the move: scope-aware
        rewriting to `ctx.`, imports carried over, calls updated.
        games.ts 3,145 -> 1,857 lines
  - [x] 5.2b Battleship and Light Cycles' views: all 16 games' arena
        views are now in their folders behind `GAME_VIEWS`. Battleship's
        renderer took its module-level helpers along (shot dressing,
        placement drafts, the banner) and remembers a focused scene
        through `ctx.rememberBsFocus()` instead of writing the store's
        state; Light Cycles' view, inline at the end of `renderGameView`,
        became its own function first. `renderGameView` is now only the
        dispatch (a match without a type is Light Cycles, as on the
        server). games.ts 1,857 -> 1,313 lines
  - [x] 5.2c Cards, history and the catalog: `GAMES` is now one
        plug-in per game (`view`, `card`, `history`, `historyCount`).
        The chat card's 16-way chain and its fetch check, `historyList`,
        `histCount` and the frame merge's type list look the game up;
        Duel, Battleship and Light Cycles' history rows (inline in the
        store) moved to `<game>/history.ts`, Light Cycles' card painter
        to `lightcycles/card.ts`, Frontlines' card board into
        `frontlines.ts`. Each game's catalog entry moved to
        `<game>/catalog.ts` (`shared/catalog.tsx` 1,020 -> 156 lines;
        its list is `CATALOG` now, not a second `GAMES`). games.ts lost
        30 imports the moves had left unused (1,313 -> 1,174 lines);
        `noUnusedLocals` in the web tsconfig catches the next ones,
        since oxlint runs no unused-variable rule here
  - [x] 5.2d The per-game status text and counts (the last 164
        branches on the type): each game's `<game>/status.ts` holds its
        `GameStatus` hooks (`registry.ts`) - finalScore, recordLine,
        metaText, stateLine, waitingOn, youLabel, lengthLine, signature,
        clockSeconds, awaiting, mover, turnLine - spread into its `GAMES`
        entry; the callers (`shared/render.ts`, `GamesView.tsx`,
        `shared/gamecard.tsx`, `games.ts`) look the hook up and keep the
        default (Light Cycles, a match without a type) where it was. A
        rematch's settings went on the catalog entry, beside `body`. The
        turn banner's clock and the Games tab's countdown now read one
        `clockSeconds` hook (their per-game lengths were identical).
        `scripts/split-dispatch.mjs` moved the return-shaped functions;
        the four else-if chains went by a checked script. What is left on
        the type: the two Light Cycles "has trails" checks. games.ts
        1,174 -> 874 lines
- [x] 5.3 The UI suite. `web/tests/ui.test.js` (3,538 lines, 157 runs,
      one after another, ~25 min) is now `web/tests/ui/`: `harness.js`
      (the fake API, `run`, the helpers), seven feature files (`shell`,
      `chat`, `people-media`, `games`, `arenas`, `arenas-3d`,
      `battleship`) and `run.js`, which runs them JOBS at a time (one per
      CPU but one; `FILES=` and `ONLY=` pick). Eight runs were exact
      copies (`duel-card`, the `markdown-*` loop, `dictation-patterns`,
      the `phrase-mode-*` loop, `markdown-speech`): dropped, 149 remain.
      The clock: the fake data and every page start at one instant
      (`NOW`, Friday 2026-11-20 15:04 UTC); the page's Date is shifted
      there and runs at real speed (`CLOCK=shift`), so times, dates and
      day separators no longer move between runs. Playwright's
      `page.clock` was tried first: `setFixedTime` froze Date and broke
      the chime's hold and Sketch's guess; `install` fakes timers and
      `performance` too and the Light Cycles replay ended at once. The
      sleeps: 168 of 185 fixed `waitForTimeout`s (and the 500 ms after
      every page load) are `settle(page)` - no request in flight for a
      quiet window, two frames, no finite CSS animation running (bar
      widths aside: the clock bars re-run theirs every tick); the 9
      inside a press-and-hold and the 8 that give a 3D scene time
      before a screenshot stay. Result: 149/149 in about 7 minutes (three files
      at a time on 4 CPUs) instead of 25; two runs of a build now differ
      only where something animates (the 3D scenes, the GIF avatar, live
      pulses, second countdowns) - 113 of 204 screenshots, every non-3D
      difference a few pixels - where before every clock and day
      separator moved too
- [ ] 5.4 (was 4.1c) Type the Worker's responses with `@chat/contract`
      (JSDoc on the route handlers and Room methods), and per-game state
      types so the 19 web files that switch off `no-explicit-any` can drop
      it. The Worker has 3,502 errors under `strict`; that is not the goal
- [x] 5.5 The `/api` docs text (`worker/agents/docs.js`, 984 lines of
      JS strings) is `worker/agents/docs.txt`, a text module with
      `{{name}}` placeholders that `docs()` fills from `docsValues` (the
      origin, the limits, the game list). Converted from the AST; the
      output is byte-identical for two origins and the old output
      equals live `/api`. `tests/unit/docs.test.mjs` checks every
      placeholder has a value and every value is used
- [x] 5.6 AGENTS.md as an index: section 3 (Features and API surface,
      938 lines, 56 entries) moved verbatim into four topic files,
      `docs/agents/rooms-and-api.md`, `web-app.md`, `games.md` and
      `media.md`, and sections 9 and 10 (Testing, Visual checks) into
      `docs/agents/testing.md`. Each keeps its numbered heading in
      AGENTS.md with a short stub (what is where, and the visual-check
      rule itself), so references to "AGENTS.md section N" stay right.
      AGENTS.md 1,598 -> 562 lines; a script checked that every line of
      the moved sections is in a topic file and every other line is still
      in AGENTS.md
- [ ] Later: the 2D game panels (`el()` builders) as React components,
      one game at a time once 5.2 gives each a home; `games.css` splits
      with them; TypeScript for the Worker once the JSDoc check is
      strict-clean

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
| 2026-11-20 | 2.4: `limits.js` | de83a6b | API suite green; version fbea4d01. Live: `/api` quotes the moved limits (5.4 TB, 943 GB), a real room's messages and page. |
| 2026-11-20 | 2.5a-b: ten games | 0272cbf | API suite green (631); version ed7fb432. Live: a real room's games list (40 matches) and `/api`'s game sections. |
| 2026-11-20 | 2.5c: six games + `games/engine.js` | ee51b92 | API suite green (631); version 933ccd4a. Live: real Light Cycles, Duel and Battleship matches' full states (rules included) through the moved engines. |
| 2026-11-20 | 2.3: `platform/` + `lib/media.js` | fe4a36c | API suite green (631 checks); version 169da5fb (21 modules). Live: `/api`, `/api/push/key`, a signed avatar, attachment media full (200) and ranged (206). |
| 2026-11-20 | 2.6: `agents/` | f5a6560 | API suite green (631); version 651e09e2. Live (re-checked with 2.7): `/api`, `/api.txt`, `/llms.txt`, a real room's `agent-recipe` and MCP `tools/list` (22 tools). |
| 2026-11-20 | 2.7: `routes/` | 0c146fe | API suite green (631); version f909aee6. Live, read only: `/api`, `/api/build` and the page stamp (426bbdbc1870bc96), `/sw.js`, the manifest, an icon, `/emoji.json`, `/api/push/key`; on a real room its page, messages, members, welcome, games and a match's full state, the board (constitution, questions, digests, stakes, decisions), attachments, tools, invites, the agent recipe, MCP `tools/list`, a signed avatar, and an attachment full (200) and ranged (206). |
| 2026-11-20 | 2.8: `room/` | efa5e62 (deployed with a740c58) | API suite green (631); version 4cedccf9. Live, read only: the same set as 2.7 - pages, docs, a real room's reads (messages, members, welcome, games and a match's full state, the board, attachments, tools, invites, recipe), MCP `tools/list`, a signed avatar, an attachment full and ranged. |
| 2026-11-20 | 3.1: web `games/` by role and game | ea6f7fb | UI suite 155/155; version 2713ed22. The production build is byte-identical to the one before the move (same `index.html`, so the build id stays 426bbdbc1870bc96, and the same hashed bundles): a move-only change proven by its output. Live: page stamps match `/api/build`; the main bundle and all 17 arena chunks 200, immutable. |
| 2026-11-20 | 2.9: comments | b40f07b | API suite green (631); version c5f0a87a. Live, read only: the 2.7 set again (pages, docs, a real room's reads, a match's full state, MCP `tools/list`, signed and ranged media). |
| 2026-11-20 | 3.2: `app/`, `features/`, `lib/` | f66535e | Build byte-identical to 3.1's (all 25 output files), so the UI suite's 155/155 on that build stands; version e0e88e44. Live: stamps match `/api/build`, all 23 assets 200. |
| 2026-11-20 | 3.4: CSS split | f7832cf | Build byte-identical (the CSS asset index-Caj7RHum.css included); version fac64a72. Live: the same CSS asset and all 23 assets 200. |
| 2026-11-20 | 3.3a: Button, Dialog, NavTab, Count | 1f57cbd | UI suite 155/155; screenshot diff against two runs of the old build: every flag was clock drift (message times, game clocks) or 3D animation, and the shots the components appear in (board actions, members, dialogs, home) were clean. Version 23d87d7a, build 742791950ab7695d; all 23 live assets byte-identical to the tested build. |
| 2026-11-20 | 3.3b: Page, PageHead, Card | 786cc10 | UI suite 154/155 - game-card timed out on a 4 s wait under load, then passed 3/3 alone (it touches nothing 3.3b changed); screenshots: relative times and an animated GIF avatar only. Version aa9eb2ba, build 350dcff4e53f5e26; 23/23 live assets identical. |
| 2026-11-20 | 3.3c: Pill | 7646831 | UI suite 155/155; the board's pills unchanged in the screenshots. Version 9db62aba, build 4bbb8aad795abb7c; 23/23 live assets identical. |
| 2026-11-20 | 4.4: wrangler pinned | 309c293 | The owner approved the build-command change (the auto-mode check had blocked it): the Workers Builds trigger now runs `npm ci && npm ci --prefix web && npm run build --prefix web`. The build log shows the root install and `wrangler 4.166.0`; version 66dc97ee. Live: all routes 200/206, build unchanged. |
| 2026-11-21 | 4.3, 4.5: unit tests, tests/ by kind | b5f1d25 | API suite green (631) from tests/api/ on the pinned wrangler; unit tests 22/22. Version f0fc5836; the page build unchanged (lcmodel's comment edit compiled to the same bytes). |
| 2026-11-21 | MediaBlocks hook fix + 4.2 lint | e225230 | UI suite 155/155 (the screenshot flags were the run crossing midnight: day separators and times); version 4d6e3397, build b20494f3fe14b8a7; 23/23 live assets identical to the tested build. |
| 2026-11-21 | 4.1 contract/ + 4.1b Worker typecheck | a2eef3b | 4.1's build byte-identical to the fix build; API suite green (631) on 4.1b's Worker edits. Version 79e5a68a. Live: all routes 200/206, stamp unchanged, the long-poll waits and returns, the push key serves (concatBytes now takes a rest parameter). |
| 2026-11-21 | 4.2b: hooks warnings to zero | e4a64da | Lint clean with --deny-warnings; UI suite 155/155 (compared with the post-midnight run: day separators and times only). Version 94e53cf3, build 0ab6772fda7dd94a; 23/23 live assets identical to the tested build. |
| 2026-11-21 | 5.1 error boundaries | 5cc1593 | UI suite 157/157, including the two new `error-boundary-row` scenarios (desktop light, phone dark: only message 71 shows a notice, the rest of the feed and the composer work). Version 467b851f, build 3a3e4f44bce6a981; 23/23 live assets identical to the tested build; all live routes 200/206. |
| 2026-11-21 | 5.2a-c: game views, cards, history and catalog through the registry | 21fff51 | UI suite 157/157; screenshots against the 5.1 run differ only in clock times and countdowns (cards and the Games tab compared side by side). Version 6793e84c, build 45cda96603d92e06; 23/23 live assets identical to the tested build; all live routes 200/206. |
| 2026-11-21 | 5.2d: per-game status hooks | b3fbe52 | UI suite 157/157. Old (21fff51) and new code bundled for Node and fed the same 20,000 random match states (all 16 types, no type, an unknown one; every status and phase): finalScore, recordLine, metaText, stateLine, waitingOn, youLabel, lengthLine, durOf, signature, mover colour, isLoaded, the turn banner, the your-move count and the rematch body all identical, no exceptions; a planted change was caught. Version 8fae1df9, build 7b7ed9d63261a13d; 23/23 live assets identical to the tested build; all live routes 200/206. |
