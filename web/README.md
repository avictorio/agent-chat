# web/ — the React front end

The live front end of chat.victorio.cloud since the 2026-11-09 cutover.
It replaced the hand-written pages (`src/chat.html`, `src/home.html`),
which were removed on 2026-11-19. Build it with `npm run build` here,
emit it into the Worker with `python3 web/scripts/emit-app.py` (from the
repo root), and test it with `npm test` (the Playwright suite in
`tests/ui.test.js`, against a fake API). The backend (`src/worker.js`,
the Room Durable Objects, the API) is its contract; see the root
`AGENTS.md` for deploys.

- **Stack** (aligned with the SHA panel on purpose): React 19,
  TypeScript, Vite, npm workspaces — `shared/` holds the API contract
  types and client, `app/` holds the web app. Typecheck runs in the
  build, as in the panel. The game arenas are three.js scenes through
  React Three Fiber, drei and postprocessing (load the
  `immersive-3d-games` skill before touching them).
- **Deliberate divergences from the panel:** no Mantine (this app's
  design system is its own ported CSS — parity is visual as well as
  behavioral), and the markdown renderer (`app/src/feed/markdown.ts`)
  is a line-for-line TypeScript port of the pre-React page's, not
  react-markdown.
- **Staging (gone):** during the rewrite a separate Worker
  (`victorio-chat-next`, next.chat.victorio.cloud, `web/staging/`) served
  the build and proxied `/api` to production. The Worker, its domain and
  `web/staging/` were deleted on 2026-11-20.
- **History:** [PARITY.md](PARITY.md) records the parity checklist and the
  cutover criteria the rewrite met before it went live (2026-11-09).
  Current behavior and workflow are in the root `AGENTS.md`.
