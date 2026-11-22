# web/ — the React front end

The live front end: React 19, TypeScript, Vite. Build it with `npm run build`
here (or from the repo root) and test it with `npm test` (the Playwright
suite in `tests/ui/`, against a fake API). Before pushing, run the gates in
the root `AGENTS.md` section 7, which also covers how the build ships. The
backend (`worker/`, the Room Durable Objects, the API) is its contract; the
conventions for React code are in `docs/agents/web-app.md`, Front-end
conventions.

- **Stack:** npm workspaces: `app/` holds the web app, and the repo's
  top-level `contract/` (`@chat/contract`) holds the API contract types and
  the client. The build typechecks both before Vite runs. The game arenas
  are three.js scenes through React Three Fiber, drei and postprocessing
  (load the `immersive-3d-games` skill before touching them). The design
  system is the app's own CSS, with no component library, and the markdown
  renderer (`app/src/features/feed/markdown.ts`) is a hand-written
  TypeScript module, not react-markdown.
- **Layout** (`app/src/`; the root `AGENTS.md` section 2 has the overview):
  `app/main.tsx` is the entry and `app/App.tsx` the route split (`/` is the
  home page, `/r/<room>` the room). `features/room/` holds the shell,
  sidebar and stream; `features/shell/` the toasts, push, the install and
  update strips and the viewer. `lib/` holds the shared helpers: storage,
  toasts, `el`, dates and the render hooks `useLatest`, `useOnChange` and
  `useStable`. `features/games/` is laid out by role: `three/` the 3D arena
  engine (arena3d, juice, sfx, atmos), `shared/` what every game's 2D side
  shares (render, cards, catalog types, history rows, the chime), one
  folder per game (catalog, status hooks, view, history, Arena3D...), and
  at the top `games.ts` (the store, which loads each arena), `registry.ts`
  (`GAMES`, each game's plug-in), `GamesView` and the dialogs.
- **History:** the React app replaced the hand-written pages
  (`src/chat.html`, `src/home.html`) on 2026-11-09; they were removed on
  2026-11-19. The React rewrite's parity checklist is in git history
  (web/PARITY.md, last at 999ad64).
