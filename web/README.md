# web/ — the React front-end rewrite

The from-scratch replacement for the current web app (`src/chat.html`,
`src/home.html`), built in parallel and cut over only when it proves full
feature and behavior parity. The backend (`src/worker.js`, the Room
Durable Objects, the API) is **not** part of this project: it is the
frozen contract the new front end is built against.

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
- **The current app stays live and frozen** (bugfixes only) until
  cutover; see PARITY.md for the freeze rule and cutover criteria.
