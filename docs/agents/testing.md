# Testing and visual checks

Topic file of `AGENTS.md` (read that first; `AGENTS.md` sections 9 and
10 point here). The gates to run before pushing: `AGENTS.md` section 7.

## 9. Testing

### Reaching the live site

- **A local CLI** can usually hit `https://chat.victorio.cloud` directly
  with `curl` or `fetch`.
- **A cloud session on the `agent-chat` environment** reaches the site
  directly, and the proxy adds the owner key to every request
  (`AGENTS.md` section 2). Live probes there are owner requests, so they
  cannot show the no-token (401), bad-token (403) or member-only rules:
  check those with `npm run test:api`, or with Browser Rendering, which
  sends only the headers your script sets. Node's built-in `fetch` does
  not read `HTTPS_PROXY`: run Node probes with `NODE_USE_ENV_PROXY=1
  NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` (see
  `/root/.ccr/README.md`), or they fail with ENOTFOUND.
- **Other cloud environments** normally cannot reach the site. Use
  Cloudflare's Browser Rendering API: `POST
  /accounts/{account}/browser-rendering/content` with
  `url: "https://chat.victorio.cloud/"` and
  `addScriptTag: [{ content: "<your JS>" }]`. The JS runs on the site's
  own origin, so relative `fetch('/api/...')` calls work. Have it write a
  JSON result into a `<pre id="result">`, pass
  `waitForSelector: { selector: "#result" }`, and parse the returned
  HTML. Browser Rendering is rate-limited (HTTP 429), so batch checks into
  one script.

### The suites

They live in `tests/api/`, `tests/unit/`, `tests/bridge/`,
`tests/upgrade/` and `web/tests/` (the UI suite, on the web workspace's
Playwright); `tests/fixtures/` holds the files they share.

- **Unit tests:** `npm run test:unit` (`node:test`, a second or two)
  covers the pure logic: the Light Cycles timeline model the arena
  replays (`lcmodel.ts`) and the Worker's game helpers. A loader hook
  (`tests/unit/register.mjs`) imports the Worker's `.txt` data files the
  way wrangler's Text rule does, and its TypeScript with the types
  stripped (a `./x.js` import finds `x.ts`, as wrangler's bundler does).
  Add a test there with any new pure helper. `shell.test.mjs` runs the
  watcher script (`worker/agents/agent-watch.sh`) as served, with bash,
  curl and jq, against stand-in servers on 127.0.0.1, and pins its
  version to its SHA-256 (`rooms-and-api.md`, Wake recipe); the API
  suite runs it once against its own server. `check-config.test.mjs` runs
  `check:config` against a live config of its own (a fake connector
  helper under a scratch home; skipped without `python3`). The agent
  key's tests (`agent-*.test.mjs`) run its routes over a Room namespace of
  harness objects (`agent-world.mjs`: every name a `Room` on node:sqlite,
  a bare one, `makeRoom({bare: true})`, where no room was made, each behind
  a stub that answers as RPC does and records every method asked):
  the key and its sealing (`agent-key`), the identity object and its
  guards (`agent-object`), what it stores (`agent-sealing`), real rooms
  through the key (`agent-rooms`), every answer reached with a key
  scanned for a room's token, link or note, and the owner key sent beside
  one (`agent-answers`), the REST routes' order
  (`agent-route`), the MCP address and the same calls asked of a room
  through either address (`agent-mcp`, which also runs `muse_register`, the
  disconnect's and the take-off's wakes against the Muse bridge in the
  same process: `bridge-world.mjs`, and the record of those wakes: a set
  that throws (not sent again), a Worker that stops before its own write,
  two registrations at once, one gadget's link recorded twice in every
  order of the two sets and the two writes, two gadgets whose earlier set
  writes last, a set the room holds past another's write (at its
  deadline and one millisecond after), a refused first registration and
  its tidy, a take-off and a disconnect right after a finished
  registration (no wait), an outstanding recording at the skew margin's
  edge, a registration whose own write never goes through, a set whose
  answer is lost (after and before it ran), a link longer than a key
  records, two DELETEs of one key at once (and a write on the last try
  that finds the record gone, or a list that keeps moving: the 503 that
  says the key is cut), a settling write that loses
  its compare-and-set and looks again,
  the two clocks seconds apart either way, an answer with no clock, the
  bound, an older room whose invites' names fold alike and that room put
  back on the key by each of the three adds, the cut key (refused
  everywhere as an unknown key, its record after a disconnect that left
  wakes, a Worker that stops after the cut or between two rooms, the
  second DELETE), and the work registered with `waitUntil` before its
  first write, which `agent-world.mjs` records as `waitedBeforeWrite`; a
  room's clock is set there by replacing that room object's `museNow`,
  which its three hook methods read, so no variable is needed), a leave
  through the key (`agent-leave`: every refusal before the leave asks no
  room and writes nothing, `delete_room` refused in every form, what the
  leave does in the room with Cartesia stood in for, the wake off in a
  room whose invites' names fold alike, a wake not confirmed off kept for
  a take-off, the last member and a protected room, a seat never opened,
  the key's list changed under the leave, a room deleted meanwhile, and
  `waitUntil` registered before the room is asked to leave, read off the
  order `agent-world.mjs` records; and, for each of the four REST routes of
  the key that take a body, a body held back past the key's disconnect:
  `agent_key_invalid`, and nothing asked of a room), the catalog and its pinned
  (version, digest) pairs (`agent-catalog`), the size of
  `whats_waiting` on `AGENT_ROOMS_MAX` full rooms and the sealed list
  with every entry at the wake bound (`agent-glance-size`), a
  key a person makes (`agent-person`: the order of the checks, a `check`
  that is not a boolean refused before anything is asked, a check
  that writes nothing and tells a refused inviter nothing about its room,
  the seats reused or not, the room's caps and the day's retry time from
  the room, two calls at once, what a failure leaves, an invite whose
  answer was lost, a check with no inviter that reads no counter), the
  three hook methods (`agent-hooks`: the member's `inv` row the same
  before and after, a gone seat in a room whose invites' names fold
  alike, a set's deadline kept by the room's clock and that clock in
  every answer, the drop saying which link is on after it; and the
  holders: each writer's rule, the untagged look and drop answering every
  untagged state as pinned literals, the two holder methods, schema step
  10 run twice and cut short, none on an identity object), the record's
  guard, its three writes as pure functions and a bounded exhaustive
  model over them, and the holder model (`holders-model.mjs`: the
  holders of a member's Muse hook beside the record, identities tagged,
  untagged and the member's own registration on one seat; its room a pure
  function that `agent-hooks` shows equal to the real Room on every state
  and call; the unit suite runs its variants that must break and its
  smaller cases, `npm run test:model` every case at full size) (`agent-wakes`: the guard refusing a write that drops
  another call's recording, or prunes one not expired, and letting a mark
  and a person's add's rollback through, which take nothing off; two registrations
  of one link or two,
  sets taken, refused, thrown or never run, own writes, tidies and a
  take-off in every order, lost compare-and-sets; at every state a hook
  that is on has its link recorded) and the Agent keys view's
  name check against the server's (`agent-name`).
- **The sign-in's tests** (`docs/agents/rooms-and-api.md`, Sign-in) run
  over `signin-world.mjs`: the agent key's harness world under
  `TEST_HOOKS`, stand-in apps put on the `__oauth-quota` object as the
  test hook puts them, and the OAuth client's side done by hand (PKCE,
  ES256 and PS384 client assertions, DPoP proofs, every key made in the
  test with Web Crypto). The documents (`oauth-metadata`), the authorize
  page's checks in order, its fixed pages, their bytes and headers, and
  their light or dark (`oauth-authorize`, with RFC 6749 3.1's empty
  parameters and an exact HTTPS redirect's near misses, a parameter sent
  twice with one value empty, and Muse's own request as it sent it, with
  `TEST_HOOKS` off and nothing fetched, its address's and Client ID's near
  misses, its redirects' `state` and `iss`), the approval
  (`oauth-decide`), the token endpoint (`oauth-token`: each assertion
  refusal, the claims judged before any key or signature, the key set
  per isolate and `jwks_uri` against a stand-in key-set host in place of
  `fetch` and a stand-in `caches.default` playing the data centre on the
  test's clock (a burst on an isolate holding no set and at a set's
  expiry, the counter's read taking time: one fetch, all taken; an own
  fetch lacking the `kid`: no second fetch in the window; one app's
  failed fetch holding back no other; 200 unknown kids one after another:
  one fetch, one counter read, no store call, no place; the data centre's
  copy by when it was fetched, and an older one never adopted over a
  newer set; a just-published key; the fetch handed to `waitUntil`, also
  with a first attempt cut off and a second that answers; a rejected
  fetch fetched once more, and so a first body broken off mid-stream;
  each failure of the host's at a first attempt, with no second; both
  attempts within one `OAUTH_FETCH_TIMEOUT_MS`; a removed key; failed
  fetches (a status, a connection refused twice) and the last set's
  bound; a fetch that never settles), the
  failed-authentication limit one per network and app, filled only by a
  signature that matched no key, with the quota object's calls and the
  signature checks counted per case, and refusing before any fetch or
  signature, an unknown client refused before its DPoP proof and logged
  `oauth.token_unknown`, a public app named only in a Basic header with
  an empty password (and refused with a password, an undecodable header
  or another id; an app that signs its requests unchanged by it; a lax
  client's unpadded base64 and unencoded URL id still taken), a token
  request naming no resource given the grant's own, Muse's
  code exchange and its code refused to Claude's client and the reverse,
  a watched app's refresh line for each standing of its token, the code
  exchange and a redeemed code's copy, the refresh's rotation, grace and
  reuse, idle, DPoP and `jwkThumbprint` against RFC 9449's and RFC 7638's
  published values),
  the revocation and every way a sign-in ends (`oauth-revoke`, a cut
  sign-in's credentials opening no room list), the disconnect-only code
  (`oauth-disconnect`), the sign-in address (`signin-mcp`), the identity
  object and an app's store (`signin-object`), and the page's pinned copy
  and each page kind's warning (`signin-page`). A test server compares no
  pinned app's document:
  `compareDocument` runs only without `TEST_HOOKS` (its own test runs
  with `TEST_HOOKS` removed and `fetch` replaced), so nothing asks an
  outside host. On a local server the issuer is `TEST_SIGNIN_ORIGIN`
  (`AGENTS.md` section 2), its own address. The API suite's
  `tests/api/signin.js` runs Muse first, the pinned app, with plain
  requests as its connector sends them (the authorize page, the approval,
  the code exchange, a tool call, a refresh naming no resource, a revoke;
  then a sign-in
  refreshed twice, once naming the client only in a Basic header, whose
  first refresh token presented again after `OAUTH_REFRESH_GRACE_S` ends
  it, checked at the end of the file so the wait overlaps the rest), and
  two stand-in apps against a real local
  Worker, registered with `POST /api/test-hooks/oauth-app` (a public one
  with a loopback redirect, a poppy one with its key set inline): the
  authorize page, the approval with a person's invites, the code
  exchange, the address's tools, a post as the invited agent, a refresh, a
  revoke, the wakes two connections and a key hold on one seat, and the
  times of an approval of `AGENT_ROOMS_MAX` rooms; then poppy stand-ins
  whose `jwks_uri` is a key-set host of the suite's own on 127.0.0.1 (the
  one case where the Worker connects to a loopback address for a key
  set, `TEST_HOOKS` only), which counts every fetch: a burst of
  assertions at once on a server holding no set makes one fetch and all
  are taken, and a request dropped while its fetch is under way leaves
  the next one taken with no second fetch; `tests/api/mcp-clients.js`
  runs the official client libraries with an OAuth provider set (K1 to
  K8): they sign in only where the sign-in address's 401 asks, and a key,
  no credential or a room's token never meets a 401 anywhere. The UI file
  `web/tests/ui/signin.test.js` runs the approval page and the
  connections section on a fake API of its own that answers every
  request of the browser (the apps' callbacks are stand-ins, anything
  else is refused), with the authorize page served with the Worker's own
  `AUTHORIZE_HEADERS`: each app's page (Claude's, Claude Code's, Muse's)
  with its screenshots, and the Worker's two fixed pages as its own
  `authorizeRoute` serves them (`signin-fixed-*`), in light and dark; at
  the end of every scenario it requires the
  site's `localStorage` as seeded but for an expected connection record,
  no cookie, and in every tab, at its last address on the site (a tab
  that left the site is taken back to that entry, one never on it to a
  blank page of the site), no fragment on the approval page (any other
  page keeps the one it was opened with), no history state, and
  `sessionStorage` holding only the harness's seeding flag. Its scenarios
  of a record the browser cannot keep run the page on Playwright's clock
  (`fakeClock`) and move it on an hour at their end (`laterStill`), so a
  redirect followed later, on any timer, is seen too.
- **The Muse bridge's tests** (`tests/bridge/`, `worker/bridge/`) run
  in the same `npm run test:unit`, with the same hook, and need no
  network and no Python. `bridge.test.mjs` runs the bridge's router and
  both of its Durable Objects in Node, on `node:sqlite`
  (`helpers/fake-do.mjs`), against a stub of Muse's `fetch_vms` and a
  fake Noise VM (`helpers/fake-vm.mjs`); `sdk-fixtures.test.mjs` holds
  the port to the bytes the Python SDK produced
  (`tests/bridge/fixtures/sdk-fixtures.json`; regenerate it with
  `scripts/bridge/extract_sdk.sh` and `scripts/bridge/gen_fixtures.py`,
  which need the SDK checkout and Python's `cryptography`). The live
  handshake against the Python SDK stays opt-in:
  `MUSE_SDK_SRC=<the SDK's linux/src> npm run test:bridge-interop`
  (skipped without it; `MUSE_INTEROP_CMD` names another interpreter as
  a JSON argv). `npm run bridge:keygen` and `npm run bridge:seal` make a
  throwaway seal key and seal a handover to it, for local runs. The
  bridge's numbers are constants (`worker/limits.ts`); a test shortens a
  timeout or the rate cap through `deps.limits` (`worker/bridge/util.ts`),
  never the host allow-lists. `tests/unit/muse-wake.test.mjs` runs a
  room's Muse hooks (`room-harness.mjs`) on the real bridge the same
  way: pass `MUSE_LINK`, `MUSE_DIRECTORY` and `MUSE_SEAL_KEY` in
  `makeRoom({env})`. A test there shortens the alarm's allowance for
  wakes and a wake's time with `museDeliver({allowanceMs, budgetMs})`,
  and the bridge's step floor and caps with `deps.limits` (`stepMinMs`,
  `lookupTimeoutMs`, ...). A fake that stands for a network call holds a
  timer of its own until it answers or is aborted: Node does not wait on
  `AbortSignal.timeout`'s timer, and a test process left waiting on that
  alone ends mid-test, its tests reported cancelled.
- **The API suite:** `npm run test:api` boots `wrangler dev` through
  `tests/api/server.js` (the port `API_PORT` names, else a free one; its
  own temp state per run through `--persist-to`; the start fails unless
  its own wrangler child, still running, said it is ready and the port
  reports this checkout's build id, so a run never tests a leftover or
  another run's server) against the build, so
  run `npm run build` first. It reaches nothing outside the machine. What it covers is listed in the header of
  `tests/api/api.test.js`. The MCP client checks (`tests/api/mcp-clients.js`)
  connect the official TypeScript client libraries to the MCP endpoint:
  v1 (`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/client`:
  default, which opens with initialize, and "auto" and pinned to
  2026-07-28, which speak that revision); `tests/api/mcp-modern.js` sends
  that revision's requests and refusals by hand; the same libraries
  connect to the agent key's address too. `tests/api/agent-key.js` makes
  a key from throwaway rooms' invites and runs it there, the caps
  included (the per-room one at its constant; the per-network and
  site-wide ones and `whats_waiting`'s gap lowered by `POST
  /api/test-hooks/agent-limits`, which only `TEST_HOOKS` arms), leaves a
  room through the key (`POST /api/agent/rooms/leave`: the members list
  and the key after it, the two 409s, the 400s, a wrong key), and
  times `whats_waiting` over `AGENT_ROOMS_MAX` rooms; `tests/api/agent-person.js`
  makes keys with a person's invites (the check, a check that is not a
  boolean, the answer's fields, the seats the owner sees,
  reuse, the room's caps, rooms added) and runs `muse_register` and the
  disconnect's wakes against the fake Muse. The libraries live in
  `tests/mcp-clients/` with exact versions and a lockfile, a package of
  its own so the deploy build installs none of them: run
  `npm ci --prefix tests/mcp-clients` once, or the suite fails saying so.
  Move a pin there on purpose, and read what the new version changed
  for a client before trusting a green run. The Muse checks (`tests/api/muse-hooks.js`)
  run the real bridge inside that Worker against a fake Muse,
  `tests/api/fake-muse.mjs` on 127.0.0.1: Muse's `fetch_vms`, and each
  VM's Noise socket, a real WebSocket served by the bridge tests' fake VM.
  `server.js` gives each run a seal key of its own (`MUSE_SEAL_KEY`;
  `sealPublicKey` in what `start()` returns) and the fake's address
  (`TEST_MUSE_ORIGIN`, honoured only with `TEST_HOOKS` and only as
  `http://127.0.0.1:PORT`, `museFetch` in `worker/bridge/util.ts`); a
  server without one fails every call to a Muse host rather than reach
  the real Muse. A test links a Muse as the gadget does (seal its token
  to `GET /api/muse/seal-key`, `POST /api/muse/connect`), tells the fake
  how to answer (`account`, `refuse`, `plan`, `redirect`) and reads what
  reached it (`state.chats`, each wake's items parsed from its text). A
  redirect points at a second loopback server, the fake's "elsewhere",
  standing for a host off Muse's allow-lists; `state.elsewhere` must
  stay empty, since the bridge follows no redirect. `server.js`
  runs a copy of `wrangler.toml` whose v2 migration creates the bridge's
  two classes with `new_sqlite_classes`: wrangler dev takes SQLite from
  that alone, and the production file's transfer left them without it
  (`AGENTS.md` section 12). Run it after Worker changes, and leave the tree
  alone while it runs: `wrangler dev` reloads on any file change, which cuts
  requests in flight (the harness says so when it happens). A body
  refused for its size must be read away before the answer (`settleBody`
  does, up to `REFUSED_DRAIN_MAX` past the cap): answered mid-upload, the
  client mostly saw a reset instead of the 413 (8 clean answers in 40 for
  create-room before the fix). `putChunked` sends once; a lost answer is
  one failed check (status 0), not a crash. It takes about 35
  seconds, nearly all of it real requests: it first compares today's
  promises (`tests/api/golden.js`: statuses, error sentences, fields), and
  it never waits out a game clock. To move a match past its deadline,
  `POST /api/test-hooks/game-expire {room, id}` (the next read advances
  it as the deadline would); to check the alarm path,
  `POST /api/test-hooks/alarm {room, id}` runs the room's alarm and
  reports the match as stored, with no read. To reproduce a race,
  `POST /api/test-hooks/r2-delay {room, ms}` holds every R2 call in that
  room open for `ms`, so a second request can be sent into the await
  (`ms: 0` turns it off). The hooks are armed only by `TEST_HOOKS`, which
  `server.js` passes with `--var` and nothing live sets; under it no mail
  is sent either (an address starting `sent-` counts as accepted, any
  other as refused).
- **The differential check:** `node tests/api/differential.js
  OTHER_CHECKOUT` starts a local server from another checkout (an
  earlier commit's, `git archive` into a scratch folder with a link to
  this `node_modules` and a copy of `web/app/dist`) and one from this,
  sends both the same fixed list of requests (every per-room MCP request
  in each credential state and one `tools/call` per tool, the start page,
  the looks, members, messages, a Muse registration with room tokens
  against one fake Muse both bridges call, the agent key's routes and
  address with their refusals, a room that refused the key's invite, a
  leave through the key and the disconnect after it, the page shell,
  `/api/changes`, `/api`, `/llms.txt`) and compares status, type, body
  and the headers a page or an agent reads, with what differs per run
  masked (a counter window's retry time too) and this checkout's listed
  changes taken out (the doc edits, the changed sentences, the new
  notices), each named in a note where the two copies differ there. It first checks,
  on both sides, that each set-up call did what the list assumes (a room
  made, invites made, a key made, a gadget linked), so two identical
  refusals cannot pass. Run it before a push that must leave existing
  answers alone.
- **A one-off script against its own local server** (a bug repro, a
  probe): `node tests/api/server.js run path/to/script.js` starts a
  server on a free port, runs the script with `BASE` and `OWNER` (the
  test owner key) in its environment, and stops the server. Its Muse
  bridge has a seal key and no Muse: a connect or a wake fails as Muse
  unreachable. Several can
  run side by side. Keep new real-time
  sleeps to a second or two (stream settling; one 6 s lobby expiry stays
  on the real clock): long waits add up to minutes across the suite.
- **The upgrade test:** `tests/upgrade/run.sh [OLD_REF]` (default
  `origin/main`) runs the older Worker from a git worktree on a temp
  state, fills two throwaway rooms, ages one by hand (drops newer
  columns, clears its schema version), then reads both back on this
  checkout and checks every room reached the latest schema step. Both
  Workers run with the config the API suite's server writes (the Muse
  bridge's classes created with SQLite) and a seal key of the run's own
  (`tests/api/local-config.mjs`), against one fake Muse for both phases
  (`tests/api/fake-muse.mjs`, hosted by `phase.js muse`): the older Worker
  links two gadgets, a member registers its Muse hooks with its own
  tokens and an agent key sets up its wakes (`muse_register`); this
  checkout lists the key's wakes, and on its disconnect the key lets go
  of them (their one holder, `pre`), so they go while the member's hooks
  stay on; the member registers again in the aged room on a third
  gadget's link, so its hook there is held by `self` alone; then `age.py
  --version-only` clears the aged room's schema version again and a
  second start runs every step again there; `inspect.py` checks the hooks'
  holders (`mhh`): the member's hook in the room not aged held by exactly
  the holder the older Worker left, `self` when it already kept holders
  (it records a registration with the room's own token as it is made) or
  `pre` when it did not (step 10 backfills it here; `run.sh` reads which
  from the old checkout's `worker/room/Room.ts`, whether it creates
  `mhh`), and exactly `self` in the aged one (a second run of step 10 that
  gave `pre` to a hook held already would show there), no row left for the key's,
  none for a member without a Muse hook. About 3 minutes,
  port 8799 (it stops if another server holds it), local only. Run it
  before shipping a schema step (`AGENTS.md` section 13, Schema changes).
- **The UI suite:** see Visual checks for UI changes, step 1.

Local iteration: `npx wrangler dev` (port 8787 by default) runs the Worker
with the Durable Object and a local KV; secrets go in the git-ignored
`.dev.vars`. On `wrangler.toml` as it is, the Muse bridge's two Durable
Objects come up without SQLite and every Muse call answers 500: for those,
use `tests/api/server.js`, whose config creates them with it.

**Tear down what you start.** A server you start by hand (`npx wrangler
dev`, the upgrade test's) is yours to stop before you finish, after a
failed or interrupted run too. `wrangler dev` is a process tree (wrangler,
esbuild, workerd): stopping only its top process leaves workerd holding
the port. On Linux or macOS, kill its process group; on Windows, run
`taskkill /pid <PID> /T /F` (`pkill` in Git Bash misses the tree).
`tests/api/server.js` does this itself, on Windows too: it runs wrangler
with Node directly, so it starts there, and stops it with `taskkill /T`.
Before it did, every Windows run left its server running, and one session
found about ten. After an interrupted run, check for leftovers and stop
only those you can tell are yours, by command line or folder:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'wrangler.*dev|workerd' } | Select-Object ProcessId, CommandLine
```

```sh
pgrep -af 'wrangler.*dev|workerd'
```

### What to check for a change

- **Rooms:** test in a fresh throwaway room per run, created through the
  owner key (`POST /api/rooms/ROOM`) or the public path (`POST
  /api/create-room`; `rooms-and-api.md`, Room creation). Digest posts
  burn the room's daily digest limit. To test as a member, create an
  invite with the owner key. Afterwards remove the invites (`DELETE
  /api/rooms/ROOM/invites`) and delete the room (`DELETE
  /api/rooms/ROOM?confirm=ROOM`); deleting is permanent.
- **The real rooms:** `henry-hank-order-up` is the main room (the agents
  Henry, Ada, SHA and Hank; the humans Anthony, Matheo and Jen). It is in
  `PROTECTED_ROOMS` (`worker/limits.ts`), so the API cannot delete it.
  Never test in it, and never add its invite to this repo.
- **Every changed endpoint:** the happy path, the validation errors, and
  the access rules: no token (401), a bad token (403), a revoked token, a
  valid invite, and the owner key.
- **Unaffected features:** messages, the stream and the docs still work.
- **The activity log:** the `log:` keys in KV (room deletions, push
  errors).
- **Failure lines:** Workers Logs (dashboard: Workers, victorio-chat,
  Logs; or the observability telemetry API) keep every `console` line,
  the Room Durable Object's included. `warn()` (`worker/lib/log.ts`)
  writes one JSON line per unexpected failure, `{"warn": "area.what",
  "error": ..., ids}`: filter on the `warn` field to see what has been
  going wrong, and on its value (`media.read`, `alarm.arm`, `push.send`)
  for one kind. Invocation logs also record each request's URL, the
  query included (`redact_query_string` is not set in `wrangler.toml`):
  a `?invite=` token a client still sends (no route reads it, but the
  request's URL is logged) and the token in `DELETE /invites/TOKEN`
  appear there, so treat the logs as holding secrets.

### Checking every room

There is no room index. To look across every room (whether any still
holds an old column, a stray pointer, a legacy row), use the Cloudflare
API: list the Room namespace's objects, then run SQL on each through the
Durable Object `query/v2` endpoint. Run SELECTs only: `query/v2` also
accepts writes. Never select `inv` tokens or `cfg` values. Objects of
deleted rooms hold only Cloudflare's metadata table. The namespace also
holds an identity object per agent key (tables `ak` and `aks`: never
select them) and `__agent-quota` (table `aq`, its counters), beside
`__vapid` and the other quota objects; an object with no `m` table is no
room (`rooms-and-api.md`, Agent keys).

---

## 10. Visual checks for UI changes

The owner's rule (`AGENTS.md` section 1, rule 7): a UI change is not
committed, let alone pushed, until its screenshots at desktop and phone
sizes have actually been looked at.

1. **Use the real build: the UI suite** in `web/tests/ui/` serves the
   built app (`web/app/dist`) through a fake API, scenario by scenario.
   The test browsers block service workers, so nothing reaches the real
   site (the app registers `/sw.js`, which `page.route` does not cover).
   - **Run:** `npm test` in `web/` (`run.js` runs the feature files in
     parallel). The fake API and the runner are `harness.js`; the
     scenarios are split by feature, one `<feature>.test.js` each. One
     file alone is `node tests/ui/<feature>.test.js`. In a Claude cloud
     sandbox, add `-r ./tests/system-chromium.js` after `node` (from
     `web/`) to use the preinstalled Chromium. The full suite takes about
     7 minutes on a 4-core sandbox and is CPU-bound: the 3D scenes render
     in software (SwiftShader) on every core, so more jobs at once only
     slow each other down. Screenshots land in `web/tests/shots/`.
   - **Switches:** `JOBS=n` (how many files at once), `FILES=chat,games`
     (which files), `ONLY=name1,name2` (which scenarios), `UI_TIMES=1`
     (each scenario's time: browser launch, page load, the rest).
     `UI_REDUCED_MOTION=1` runs every scenario with prefers-reduced-motion,
     in about 4 minutes, for iterating; the 3D scenes stop animating, so
     it exercises neither the motion code nor the screenshots people see:
     run the full suite before a deploy. The suite runs on a fixed clock
     (`NOW` in `harness.js`, UTC; `CLOCK=real` for the machine's), so two
     runs of a build give the same screenshots except where something
     animates (the 3D scenes, Henry's GIF avatar, live pulses, second
     countdowns).
   - **Writing a scenario:** wait on state (`waitForSelector`,
     `waitForFunction`, or `settle(page)` after an action), never a fixed
     `waitForTimeout`: fixed sleeps are what failed under load. A long
     press holds until what it opens appears (the reaction bar, the
     tooltip), then lifts: a fixed hold races the app's 450 ms timer,
     which runs late when the 3D scenes load the machine. `shot()` waits
     for any visible 3D arena still saying "Loading the 3D arena…" or
     still opening its entry iris before it takes the picture (up to 30
     s, then it logs), so a screenshot shows the scene; keep a short sleep
     only to let a scene animate into place before a screenshot.
   - **What fails a scenario:** an uncaught page error; a request the
     fake API doesn't handle (a missing stub route or a broken path: add
     the route); a console error other than "Failed to load resource"
     with a status the stub returned on purpose. Pass `allowConsole` (a
     RegExp) for an expected one.
   - **Refactors that must not change the markup** (panelsnap):
     `node -r ./tests/system-chromium.js tests/ui/panelsnap.js
     before.json` records every game's chat card and arena (Game and
     History tabs) in each fixture state, with and without WebGL, at
     desktop and phone width. Run it on the old and the new build and
     compare with `node tests/ui/panelsnap.js diff before.json
     after.json`. `ONLY_GAMES=tr,au` limits it to some fixtures;
     `STYLES=1` adds a hash of each element's computed style (CSS Typed
     OM computed values, animations settled, so two runs of one build
     agree) for a CSS move that must not change how anything looks.
2. **For an ad-hoc script**, reuse `harness.js` (its fake API, `setup`,
   `run` and `shot`) instead of stubbing routes by hand, and keep the
   script in the session scratchpad. A check worth keeping becomes a
   scenario in a feature file.
3. **Screenshot every state:** both pages, `colorScheme` `light` and
   `dark`, at desktop and phone (about 390 px) widths. Click through each
   theme-toggle state and reload to check the saved state persists. Look
   at the screenshots, and sample pixel colors too, not just
   `getComputedStyle`.
4. **Check auto-dark.** Browser auto-dark (Chrome, Samsung) is the known
   trouble spot: the Light theme opts out with CSS `color-scheme: only
   light`. In the Playwright Chromium, the
   `--blink-settings=forceDarkModeEnabled=true` flag darkens every page
   regardless of that opt-out, so it can't confirm the fix, and the
   `WebContentsForceDark` feature flag darkens nothing headless. Say so in
   your report, and ask Anthony to check on his phone.
5. **Compare before and after.** Screenshot the old version and the new
   one, to confirm the bug reproduces before the fix and is gone after.
   Deploy only when the screenshots look right, then re-verify the
   deployed hashes.
6. **Report in words,** plainly, including what you couldn't test. Don't
   send screenshots unless asked.

**Safe areas:** in the installed web app (standalone) the page renders
edge-to-edge, so any fixed or full-height UI (top bars, drawers, footers)
must pad with `env(safe-area-inset-*)` under `viewport-fit=cover`. The
inset is 0 in ordinary browsers, so it costs nothing there. Check top and
bottom: the composer and the drawer foot already carry the bottom inset;
headers and drawer tops are the ones that get missed.
