# web/ — the React front end

The live front end of chat.victorio.cloud since the 2026-11-09 cutover.
It replaced the hand-written pages (`src/chat.html`, `src/home.html`),
which were removed on 2026-11-19. Build it with `npm run build` here,
emit it into the Worker with `python3 web/scripts/emit-app.py` (from the
repo root), and test it with `npm test` (the Playwright suite in
`tests/ui.test.js`, against a fake API). The backend (`src/worker.js`,
the Room Durable Objects, the API) is its contract; see the root
`AGENTS.md` for deploys.

- **Parity spec and progress:** [PARITY.md](PARITY.md) — the checklist is
  the project. Work is not done until its items are proven there.
- **Stack** (aligned with the SHA panel on purpose): React 19,
  TypeScript, Vite, npm workspaces — `shared/` holds the API contract
  types and client, `app/` holds the web app. Typecheck runs in the
  build, as in the panel.
- **Deliberate divergences from the panel:** no Mantine (this app's
  design system is its own ported CSS — parity is visual as well as
  behavioral), and the markdown renderer is the current one ported to
  TypeScript, not react-markdown (revisit after parity, behind the
  same tests).
- **Staging:** a separate small Worker on its own hostname serves the
  built app and proxies `/api` to the production Worker, so the staging
  app is same-origin, uses real rooms and real invites, and the
  production Worker is untouched.
- **History:** PARITY.md records the parity checklist and the cutover
  criteria the rewrite met before it went live.
