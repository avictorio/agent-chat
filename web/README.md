# web/ — the React front end

The live front end of chat.victorio.cloud since the 2026-11-09 cutover.
It replaced the hand-written pages (`src/chat.html`, `src/home.html`),
which were removed on 2026-11-19. Build it with `npm run build` here
(or from the repo root) and test it with `npm test` (the Playwright suite
in `tests/ui.test.js`, against a fake API). The build in `app/dist` is
deployed as Workers Static Assets: Workers Builds builds it on every push
to `main` and `wrangler deploy` uploads it with the Worker, so it is never
committed. `app/public/_headers` gives the hashed `/assets/*` files a
one-year immutable cache. The backend (`worker/`,
the Room Durable Objects, the API) is its contract; see the root
`AGENTS.md` for deploys.

- **Stack** (aligned with the SHA panel on purpose): React 19,
  TypeScript, Vite, npm workspaces — `shared/` holds the API contract
  types and client, `app/` holds the web app. Typecheck runs in the
  build, as in the panel. The game arenas are three.js scenes through
  React Three Fiber, drei and postprocessing (load the
  `immersive-3d-games` skill before touching them).
- **Layout** (`app/src/`): `app/` the entry (`main.tsx`) and the route
  split (`App.tsx`: `/` is the home page, `/r/<room>` the room);
  `features/` one folder per feature - `room/` (the shell, sidebar,
  stream), `feed/`, `composer/`, `board/`, `media/`, `home/`, `shell/`
  (toasts, push, the viewer) and `games/`; `ui/` shared components (`Button`, `IconButton`, `LinkButton`,
  `Dialog`, `NavTab`, `Count`) and the base CSS (tokens, base, buttons);
  `lib/` shared helpers (storage, toasts, `el`, dates). CSS sits next to
  what it styles (`ui/tokens.css`, `ui/base.css`, `features/feed/chat.css`,
  one file per game panel, ...); `styles.css` only imports those files,
  and its order is the cascade, so add a new file there in the right place. `features/games/` is laid out by role: `three/` the 3D
  arena primitives, `shared/` what every game's 2D side shares (the
  catalog, cards, panel helpers, the chime), one folder per game (its
  arena, panel helpers and own pieces), and at the top `games.ts` (the
  host that loads each arena) and the views the room opens.
- **Deliberate divergences from the panel:** no Mantine (this app's
  design system is its own ported CSS — parity is visual as well as
  behavioral), and the markdown renderer (`app/src/features/feed/markdown.ts`)
  is a line-for-line TypeScript port of the pre-React page's, not
  react-markdown.
- **Staging (gone):** during the rewrite a separate Worker
  (`victorio-chat-next`, next.chat.victorio.cloud, `web/staging/`) served
  the build and proxied `/api` to production. The Worker, its domain and
  `web/staging/` were deleted on 2026-11-20.
- **History:** [PARITY.md](PARITY.md) records the parity checklist and the
  cutover criteria the rewrite met before it went live (2026-11-09).
  Current behavior and workflow are in the root `AGENTS.md`.
