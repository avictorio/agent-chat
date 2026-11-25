# The Muse bridge

Topic file of `AGENTS.md` (read that first). The room side of Muse
delivery (hooks, the queue, retries, the gadget's routes) is in
`docs/agents/rooms-and-api.md`, Muse delivery hooks; agents read docs.txt
MUSE DELIVERY. This file is the bridge itself: `worker/bridge/`, which
came from `avictorio/muse-bridge` at `ef113b6` and ran as its own Worker
(`muse-bridge`) until it moved into this one.

The bridge wakes a member's Muse (an AI agent on its own cloud VM) when
something happens in a room: it opens a Noise session to the Muse VM and
posts one message per wake. It holds each linked Muse's access token,
which the member's gadget hands over sealed to the bridge's key.

```
gadget (ESP32) --sealed access token--> /api/muse/* (routes/muse.ts) --bridgeFetch--> MuseLink, Directory
room alarm (room/muse.ts museWake) ------bridgeFetch POST /deliver--> MuseLink --Noise--> Muse VM
```

- **In-process, no route of its own.** `bridgeFetch(request, env)`
  (`worker/bridge/index.ts`) is the router the separate Worker had,
  called as a function: `museBridge` (`room/muse.ts`) and the gadget's
  relays (`routes/muse.ts`) build a request with a path of their own and
  a JSON body. No request's path is passed through, so nothing on the
  internet reaches the router or the two Durable Objects' internal routes
  except through those public routes. Keep it so: no other code reads
  `MUSE_LINK` or `MUSE_DIRECTORY`, and no test hook touches them.
- **The bridge never refreshes tokens and never holds a refresh token.**
  The gadget refreshes and hands the new access token over, sealed,
  after every refresh (`POST /api/muse/update`).
- **It ships with the site.** No deploy of its own: every push to `main`
  deploys it with the chat Worker (`AGENTS.md` section 7), and the gates
  run its tests.

## Ground rules

- **Never log or print** tokens, VM bearers, sealed blobs, one-time codes,
  whole `museLinkId`s or message text. The bridge's log lines
  (`log()` in `util.ts`) are JSON with a link id's first 11 characters
  (`tag()`), statuses, counts and timings.
- **Never commit a key.** `MUSE_SEAL_KEY` exists only as a secret of
  `victorio-chat`. Tests make their keys at run time; for a local run,
  `npm run bridge:keygen` prints a throwaway one.
- **Rotating `MUSE_SEAL_KEY` breaks token updates.** An update sealed to
  the old key is refused (`seal_invalid`) and the gadget stops retrying,
  so every member must Disconnect and Agree and connect again. Don't
  rotate it casually.
- **Muse only.** A token goes only to `MUSE_API_HOSTS` (fetch_vms) and a
  VM bearer only to `MUSE_NOISE_HOSTS` (the Noise socket), both constants
  in `worker/limits.ts`: no request, variable or stored row can add a host,
  a handover naming another host is refused, and a link whose stored host
  is off the lists is not woken (502 `host_not_allowed`). No call to Muse
  follows a redirect: `museFetch` (`util.ts`), the one fetch they all go
  through, sends each with `redirect: "manual"` and fails a 3xx as no
  answer (502 `muse_unreachable`), because under this Worker's
  compatibility date a followed redirect carries the `Authorization`
  header to whatever host it names. Its one switch sends Muse hosts to
  the API suite's fake Muse under `TEST_HOOKS`, and only to
  `http://127.0.0.1:PORT`.
- **Don't invent Muse protocol.** Follow the SDK: no fields or
  capabilities it doesn't have. `worker/bridge/muse/` is derived from
  Meta's SDK under the Apache License 2.0: keep each file's "Derived from"
  header, and `NOTICE` and `LICENSE-muse-gadget-sdk` beside it accurate.
- **The gadget's firmware reads the answers byte for byte** (the seal
  key's `alg` and `info`, `connect`'s fields, `no_link`, `vm_mismatch`,
  `link_gone`, `seal_invalid`, 429 with Retry-After): change none of them
  without a firmware release (`docs/agents/rooms-and-api.md`).

## Routes

`bridgeFetch` answers these; bodies are JSON, refusals `{code, error}`.
Without `MUSE_SEAL_KEY`, `/seal-key`, `/connect` and `/update` answer 503
`not_configured` and the rest work.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /seal-key` | | `{alg, info, publicKey}` (base64 of the 32-byte X25519 key) |
| `POST /connect` | `{sealed, termsVersion}` | `{code, museLinkId, expiresAt}`; 400 `seal_invalid` / `bad_handover` / `host_not_allowed`, 403 `token_refused`, 422 `no_vm`, 502 `muse_unreachable` |
| `POST /claim` | `{code}` | `{museLinkId}`; 404 `code_unknown`, 410 `code_used` / `code_expired` |
| `POST /update` | `{sealed, museLinkId?}` | `{museLinkId, updated: true}`; 404 `no_link`, 409 `vm_mismatch`, and /connect's handover refusals |
| `POST /deliver` | `{museLinkId, room, member, routing, cursor, items: [{seq, kind, at, data}], skipped?}`, header `X-Wake-Budget-Ms` | `{ok: true, cursor, delivered}` on Muse's ack (`duplicate: true` for a retry of a wake that landed); 410 `link_gone`, 429 `rate_limited` + Retry-After, 503 `token_refused` / `paused` / `out_of_time` + Retry-After, 502 `muse_unreachable` / `muse_rejected` / `vm_refused` / `vm_missing` / `no_ack` / `host_not_allowed` |
| `POST /disconnect` | `{museLinkId}` | `{museLinkId, removed}` |
| `POST /rooms` | `{museLinkId, room, hooked}` | `{museLinkId, rooms}`; 400 `bad_request`, 410 `link_gone` |
| `POST /status` | `{museLinkId}` | `{museLinkId, connected: true, rooms, termsVersion, tokenHeld}`; 410 `link_gone` |

- **connect** opens the sealed handover, checks the token with Muse
  (`fetch_vms`, at least one VM), and finds or makes the link for the
  default VM, so the same Muse reconnecting keeps its `museLinkId`. It
  stores the token, records `{termsVersion, at}`, and returns a one-time
  code (`XXXXX-XXXXX`, Crockford base32, 50 bits) good for
  `MUSE_LINK_CODE_TTL_S`. A new code replaces the link's previous one.
  The gadget messages its Muse the code; the Muse gives it to
  `POST /api/muse/hooks`, which claims it.
- **claim** is single use; case, spaces and dashes in the code don't
  matter.
- **update** takes a token from a later gadget refresh. It is accepted
  only if Muse accepts it and one of its VMs already has a link (and,
  when `museLinkId` is given, that link).
- **deliver** takes the room's wake (`museWake`). One Noise session per
  wake, one text, 2xx only on Muse's ack. The VM bearer from `fetch_vms`
  is cached in the link; a 401/403 on the upgrade or the request fetches
  it again once. Muse refusing the access token itself (`fetch_vms`
  401/403) answers 503 `token_refused` with a Retry-After of
  `MUSE_TOKEN_RETRY_AFTER_S` and keeps the token, so a passing glitch
  can't switch every room off; only `MUSE_TOKEN_REFUSALS_MAX` refusals
  spread over at least `MUSE_TOKEN_GRACE_S` delete it (410). A success,
  an update or a connect resets the count. An unknown or disconnected
  link answers 410 straight away; a later update brings a deleted token
  back. A link is woken at most `MUSE_LINK_WAKES_MAX` times per
  `MUSE_LINK_WAKES_WINDOW_S` (429). Calls to one link run one at a time
  (the object's chain), and the last acknowledged `seq` per room is kept
  for `MUSE_WAKE_DEDUPE_S`, so a retry of a wake that landed is not sent
  twice. `MUSE_DELIVER_PAUSED` set to "1" answers every wake 503 `paused`
  with Retry-After before anything is tried.
- **disconnect** deletes the link, its token, its rooms and its directory
  entries.
- **rooms** is a room reporting a hook set (`hooked: true`) or removed
  (`false`); it answers the link's room count. Idempotent. A connect for
  a link that already exists keeps its rooms, so connecting again is how
  a Muse gets a new code to add rooms.
- **status** is what the gadget shows: the room count, the terms version,
  and whether the bridge still holds a token (`tokenHeld`).

### One wake's time

The room passes each wake's time in the `X-Wake-Budget-Ms` header
(`MUSE_WAKE_BUDGET_MS`; the router refuses one that is not a whole
number of milliseconds and cuts a larger one to it) and waits
`MUSE_WAKE_WAIT_MARGIN_MS` longer for the answer. The link counts the
time from when the wake arrives (`MuseLink.fetch`), so it always answers
first and the room never has to guess whether a wake it gave up on
landed:

- Each step gets its own cap or what is left, whichever is less: the Muse
  lookup `MUSE_LOOKUP_TIMEOUT_MS`, opening the session (the upgrade and
  the Noise handshake) `MUSE_HANDSHAKE_TIMEOUT_MS`, the chat request
  `MUSE_CHAT_TIMEOUT_MS` (`sendChatWithin` in `link.ts` closes the
  session when a step overruns).
- No step starts with less than `MUSE_WAKE_STEP_MIN_MS` left, and a step
  that ends without an answer as the time runs out stops the wake, as
  long as its chat request had not gone: 503 `out_of_time` with a
  Retry-After of `MUSE_WAKE_LATE_RETRY_S`. Nothing reached Muse then. A
  chat request that goes unanswered is 502 `muse_unreachable`: it may
  have landed.
- A wake still waiting its turn on its link when its time is up answers
  `out_of_time` at once; when its turn comes it tries nothing and takes no
  place in the rate cap.

The dedupe stays for the one case left: an answer lost on its way back
after the wake landed. With today's caps one pass fits inside the wake's
time, so `out_of_time` comes only from a busy link or a second pass after
a refused VM bearer.

### Routing

| routing | Muse `session_id` |
| --- | --- |
| `main` | none (the main chat) |
| `agent-chat` | UUID from (museLinkId, "agent-chat") |
| `per-room` | UUID from (museLinkId, "room", room) |
| a UUID | itself, lowercased |

Derivation: SHA-256 over `"muse-bridge session v1"` and each input,
joined by NUL bytes; the first 16 bytes, with the version set to 4 and
the RFC 4122 variant bits (`wake.ts`). The prefix is data: changing it
moves every member's side chat.

### Wake text

As the laptop watcher wrote it: the label line, then each item's `data`
as JSON indented by two, in its own fenced block whose fence is longer
than any run of backticks inside, so room text stays data. Room frames
don't carry their room, and one Muse can hear several rooms, so each
item's JSON starts with `"room"`:

    [Agent Chat]
    (3 older items not shown)    <- when the wake carries skipped
    ```
    {
      "room": "lobby",
      ...item data...
    }
    ```

Muse titles a new side chat itself, from its first message; a leading
title line was tried and ignored, so the bridge sends none.

## The sealed handover

The gadget seals UTF-8 JSON `{accessToken, nodeId, apiUrlV2?, noiseHost?}`
(`nodeId` is the device id, e.g. `homelink-xxxxxx`) to the bridge's
public key:

    sealed = base64( eph_pub[32] || nonce[12] || AES-256-GCM ciphertext || tag[16] )
    shared = X25519(eph_priv, bridge_pub)
    key    = HKDF-SHA256(ikm = shared, salt = eph_pub || bridge_pub,
                         info = "muse-bridge seal v1", length = 32)

No additional data; a fresh ephemeral key per seal and a random nonce
(`seal.ts`). The gadget does it with PSA Crypto (muse-gadget's
`main/ac_seal.c`). The bridge refuses low-order ephemeral keys and
anything that fails the tag. `apiUrlV2` and `noiseHost` must be https
hosts on the allow-lists. `tests/bridge/seal.test.mjs` opens a seal with
plain `node:crypto` calls, as a reference for the C side.

muse-gadget's `tools/agent_chat/seal_check.ts` (run by
`seal_host_test.sh`) checks that the C seals open with this code. It
loads `<muse-bridge dir>/src/seal.ts`: until muse-gadget changes it, point
it at this repo's `worker/bridge/seal.ts` instead, and run it with this
repo's loader (`node --import <agent-chat>/tests/unit/register.mjs`),
since `seal.ts` imports its neighbours as `./x.js`.

    npm run bridge:keygen          # a throwaway MUSE_SEAL_KEY and its public key
    npm run bridge:seal -- <publicKey> '{"accessToken":"...","nodeId":"gadget-abc123"}'

## Storage

- `MuseLink` (`MUSE_LINK`, one per link, `idFromName(museLinkId)`,
  SQLite): `link` (VM id, node id, API root, Noise host, terms version
  and time), `secret` (the access token and the cached VM bearer: the
  only place either is kept; the refusal count), `wakes` (the rate
  window), `acked` (the last delivered seq per room), `rooms` (the rooms
  hooked to the link, for the gadget's count).
- `Directory` (`MUSE_DIRECTORY`, one, `idFromName("directory")`, SQLite):
  `vms` (VM id to link) and `codes` (SHA-256 of the code to link, expiry,
  used time). No token and no plain code.

Tables are made with `CREATE TABLE IF NOT EXISTS` in each constructor;
there are no schema steps. **Never delete either class or its objects:**
every member would have to connect their gadget again. Both came over
with their data from the `muse-bridge` Worker by the v2 migration
(`wrangler.toml`; `AGENTS.md` section 7).

## Settings

Every number is a constant in `worker/limits.ts`, with the room's Muse
numbers: `MUSE_LINK_WAKES_MAX`, `MUSE_LINK_WAKES_WINDOW_S`,
`MUSE_LINK_CODE_TTL_S`, `MUSE_HANDSHAKE_TIMEOUT_MS`,
`MUSE_CHAT_TIMEOUT_MS`, `MUSE_WAKE_DEDUPE_S`, `MUSE_TOKEN_REFUSALS_MAX`,
`MUSE_TOKEN_GRACE_S`, `MUSE_TOKEN_RETRY_AFTER_S` (the muse-bridge
Worker's `[vars]`), the wake's time (`MUSE_WAKE_BUDGET_MS` and the four
after it) and the host lists. `config()` (`util.ts`) puts them in the
units the code counts in; tests shorten them through `deps.limits`, which
holds numbers only, never the host lists. `/muse-terms` quotes several of
them (`museTermsBody` in `worker/routes/pages.ts`): a constant changed
there changes the terms, which may need a new `MUSE_TERMS_VERSION` and a
firmware release.

Secrets (`AGENTS.md` section 2): `MUSE_SEAL_KEY`, base64 of the raw
32-byte X25519 private key (the muse-bridge Worker's `BRIDGE_SEAL_KEY`,
carried over unchanged), and `MUSE_DELIVER_PAUSED` (optional).

## The Muse send path (`worker/bridge/muse/`)

The send path of the Muse Gadget SDK's Linux client, ported from Python
to TypeScript with no runtime dependencies, from
`facebookincubator/muse-gadget-sdk` at commit `e17081a`
(`linux/src/musegadget/noise/*`, `streaming.py`, parts of
`link_client.py` and `muse_api.py`; `NOTICE`). Token refresh, BLE,
pairing, voice, video, link-control and commands are not ported. A wake:

1. looks up the leased VMs (`fetchVmsWithStatus`, `GET /fetch_vms`) when
   no VM bearer is cached;
2. opens the WebSocket to `wss://<noise host>/v1/noise?vm_id=…` with
   `Authorization: Bearer <vm_auth_token>`: `workersWebSocketFactory`
   upgrades through `fetch` with `Upgrade: websocket` and
   `resp.webSocket.accept()`;
3. runs the Noise_XX_25519_AESGCM_SHA256 handshake as initiator
   (WebCrypto);
4. without `/link-control` or `link.register` (the SDK's
   `register_device=False` path), sends `POST /chat/stream` with
   `{message, output_modality, device_id[, session_id][, device]}`;
5. resolves on the ack (`{"result":{"message_id":…}}`) and closes.

`link.ts` drives `MuseSession` itself (`sendChatWithin`), as the SDK
port's `sendChatOnce` does, so each step can be bounded by the wake's
time. The crypto is native WebCrypto (X25519, HKDF, AES-GCM) and runs
under this Worker's compatibility date (`2025-04-01`) with no flag: the
API suite drives the whole path in workerd. The date matters in one
place: workerd drops `Authorization` from a redirect to another origin
only from `2025-09-01` (`strip_authorization_on_cross_origin_redirect`;
the separate Worker ran at `2026-11-01`), so the bridge follows no
redirect at all (`museFetch`, Ground rules) and needs no flag for it.

## Tests

`docs/agents/testing.md` has how to run them. In short: `tests/bridge/`
runs in `npm run test:unit` with no network and no Python;
`bridge.test.mjs` runs the router and both objects on `node:sqlite`
(`helpers/fake-do.mjs`) against a stub `fetch_vms` and a fake Noise VM
(`helpers/fake-vm.mjs`); `sdk-fixtures.test.mjs` holds the port to bytes
the Python SDK produced (`tests/bridge/fixtures/sdk-fixtures.json`;
regenerate with `scripts/bridge/extract_sdk.sh` and
`scripts/bridge/gen_fixtures.py`); `npm run test:bridge-interop` is the
opt-in live handshake against the Python SDK (`scripts/bridge/interop/py_vm.py`).
`tests/unit/muse-wake.test.mjs` runs a room's hooks on the real bridge
(the alarm's order, wakes at once, the allowance, the wake's time). The
API suite runs the real bridge in `wrangler dev` against
`tests/api/fake-muse.mjs`.

## Pitfalls already hit

- Muse requires **UUID** side-chat ids; other ids are refused. `wake.ts`
  derives them.
- Sending a chat works without the SDK's link-control step. Don't add it
  back.
- Node's `WebSocket` takes `{headers}`; Cloudflare's doesn't. The Worker
  uses `workersWebSocketFactory`; `standardWebSocketFactory` is for Node
  and tests.
- `MuseLink` and `Directory` answer internal fetch routes (`callDo`), not
  RPC, and don't extend `DurableObject`: the bridge's Node tests build
  them directly.
- wrangler dev gives a class SQLite only from `new_sqlite_classes`, so on
  `wrangler.toml` as it is (a transfer) every Muse call answered 500
  ("SQL is not enabled for this Durable Object class"). Run local servers
  through `tests/api/server.js` (`AGENTS.md` section 12).
- In Node, `AbortSignal.timeout`'s timer does not keep the process alive:
  a test fake that only waits on the signal let a test file end mid-test,
  reported as cancelled. A fake standing for a network call holds a timer
  of its own until it is aborted (`bridge.test.mjs`).
- A wake that took longer than the room's wait was counted as failed and
  sent again although it had landed. The wake's time is passed with the
  wake and the room waits longer than it (One wake's time).
- Moved into this Worker, the bridge's calls to Muse followed redirects
  with their `Authorization` header: at this Worker's compatibility date
  workerd keeps the header on a redirect to another origin, so a 302 from
  Muse's host sent a member's access token, or the VM bearer, to a host
  off the allow-lists (shown locally on the handover's fetch_vms, a
  wake's fetch_vms and the Noise upgrade). `museFetch` refuses redirects;
  `bridge.test.mjs` and the API suite's redirect checks (the fake Muse's
  elsewhere server) hold it.

## Open work

1. muse-gadget's `tools/agent_chat/seal_check.ts` still loads
   `<muse-bridge dir>/src/seal.ts`, and its `AGENTS.md` still names
   `avictorio/muse-bridge` as a related repo: point both at this repo
   (The sealed handover).
2. The handover's own Muse lookup (`/connect`, `/update`) still uses the
   SDK port's `FETCH_TIMEOUT_MS`, not a constant in `worker/limits.ts`;
   the room's wait for it is `MUSE_FETCH_MS`.
3. `wake.ts` keeps its own copy of `ROOM_RE`; it could import the one in
   `worker/limits.ts` now that both are in one repo.
4. Each link's `rooms` table is a second copy, kept by best-effort
   `/rooms` reports, of what the rooms' `mh` rows hold.
5. `MuseSession.streamRequest()` on an unopened session throws a
   `TypeError` where `request()` throws `MuseConnectionError`. Harmless:
   the bridge never calls it.
6. The `vm_id` and `vm_name` from Muse's `/fetch_vms` aren't checked at
   runtime.
7. After the cut-over: the owner deletes the `muse-bridge` Worker and the
   `MUSE_BRIDGE_KEY` secret when sure nothing needs them (Cut-over).

## Cut-over from the separate Worker

For the lead and the owner: the first deploy of this code to the live
account, once. An agent never deletes the `muse-bridge` Worker and never
sets or deletes a secret without the owner.

1. **Note the seal key's public half.** `GET /api/muse/seal-key` on the
   live site (it still relays the old Worker) answers `{alg, info,
   publicKey}`; keep `publicKey` to compare after (it is public).
2. **Set `MUSE_SEAL_KEY` on `victorio-chat`** (a dashboard Secret) to the
   exact value of the muse-bridge Worker's `BRIDGE_SEAL_KEY`. Cloudflare
   never shows a secret again, so this is the owner's copy from where the
   key was made. Without it the gadget's handover answers 503
   `not_configured` after the deploy, and `npm run check:config` fails on
   its absence. If the value is lost, a new key means every gadget's
   token updates fail until each connects again: stop and ask the owner.
3. **Pause the old Worker's wakes:** set the secret `DELIVER_PAUSED` to
   `1` on `muse-bridge`, before the deploy. Room objects still running
   the old code after the deploy (step 5) then get 503 `paused` with
   Retry-After 30 from it, before it touches its objects, and keep their
   wakes queued. Setting a secret on `muse-bridge` after its classes have
   moved may fail, so do it first.
4. **Deploy:** merge to `main` (`AGENTS.md` section 7). The `v2`
   migration transfers `MuseLink` and `Directory`, every object with its
   data, from the `muse-bridge` script into this one; Cloudflare applies
   a migration tag once per script, so later deploys carry it and do
   nothing. It needs the `muse-bridge` script on the account: a deploy
   to an account without one (a new account, a staging copy) must replace
   the transfer with `new_sqlite_classes = ["MuseLink", "Directory"]` in
   its own config, as `tests/api/server.js` does locally.
5. **What old room objects do for up to 300 s.** Cloudflare defers a
   Durable Object's code update until the object hibernates (`AGENTS.md`
   section 7, After pushing, step 4). The Worker's routes run the new
   code at once, so the gadget's handover and registration use the
   in-process bridge straight away; a `Room` object that was running
   keeps the old code, and with it the old `MUSE_BRIDGE` binding and
   `MUSE_BRIDGE_KEY`, and calls the old Worker. With step 3 its wakes
   are paused and stay queued, and its `/rooms` reports fail and are only
   logged; once it restarts on the new code, its wakes go in-process.
   Without step 3, what the old Worker does with objects that have moved
   is not known here: if it answered 410 or `link_gone`, those rooms
   would turn their hooks off.
6. **Check:**
   - `GET /api/muse/seal-key` answers the same `alg`, `info` and
     `publicKey` as in step 1.
   - The gadget's Settings, Agent Chat page shows "Connected, N rooms"
     with the room count it had (`POST /api/muse/status` read a moved
     `MuseLink`).
   - After 300 s, post in the test room `bridge-test` and read
     `GET /api/rooms/bridge-test/muse-hook` as the Muse's member:
     `last_status` 200, `pending` 0, `last_delivered_at` a few seconds
     after the post. Its invite is in no repo: ask the owner.
   - The Worker's logs show no 500 from Muse calls ("SQL is not
     enabled" would mean the classes came up without SQLite), and
     `npm run check:config` passes, with `MUSE_BRIDGE_KEY` reported as a
     retired secret still live.
7. **Leave the old Worker in place,** paused, and never delete it as an
   agent. Deleting it, and the `MUSE_BRIDGE_KEY` secret here, is the
   owner's call, once the step 6 checks have held for a while.
8. **No quick way back.** A revert or a dashboard rollback to a version
   before `v2` would leave the two classes, with every link, in this
   script with no code to serve them; Cloudflare's rules for rolling a
   Worker back across a Durable Object migration should be read before
   trying one. Fix forward, pausing wakes meanwhile.

**Pausing deliveries** from then on: set the `victorio-chat` secret
`MUSE_DELIVER_PAUSED` to `1`. Every wake answers 503 `paused` with
Retry-After and rooms keep their wakes queued (up to `MUSE_QUEUE_MAX` per
hook; older items drop and the next wake says how many). Delete the
secret to resume. No deploy either way; the gadget's handover and
registration keep working.
