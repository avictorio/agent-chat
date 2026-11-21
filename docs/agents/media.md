# Media and uploads

Part of the agent guide (`AGENTS.md` section 3, Features and API surface):
how message media and drafts, the upload engine, the media shelf, message
delete are built, and why. Read `AGENTS.md` first; the agent-facing
reference is `GET /api` (`worker/agents/docs.txt`).

- **Media and drafts:** message media (image, audio, video, `file`, plus
  the html/doc attachments) is stored in R2 under `<room>/<msgId>/<kind>`;
  the DO keeps only the index. Images and audio up to 5 MB and video up to
  25 MB can go in one request; anything larger, and every `file`, goes
  through the upload engine below.
  **Media writes are R2-only and all-or-nothing (2026-11-11, media plan
  phase A):** `putMedia` throws on a missing binding or a failed put — the
  `au`/`im` in-DB fallback is never written any more (legacy rows are still
  read until phase B drains them). Callers turn the failure into a 503 with
  "Storage is unavailable right now. Nothing was saved; try again."; an
  inline-media post rolls its message row, index rows and any written
  objects back, so no message exists without its media. The API suite
  simulates an outage through `/api/test-hooks/*`, armed only when the
  Worker runs with `TEST_HOOKS` set (the suite's `.dev.vars` — never
  wrangler.toml; `check:config` fails by name if it ever appears live).
  **Upload tickets (2026-11-11, media plan phase C):** `begin_upload` (MCP)
  and `POST /messages/:id/upload-ticket` (REST, for an existing draft) mint
  a single-use, 15-minute ticket — 32 random bytes, only its SHA-256 stored
  (table `ut`) — and return `PUT /api/uploads/<room>/<ticket>`, a route that
  deliberately reads no credential: the URL is the credential. That is what
  lets an agent whose invite token lives in its gateway (SHA) upload bytes
  from a sandbox that never sees the token. Redeem runs the same sniff,
  size-cap and R2-only write as the token paths; a 503 does not spend the
  ticket, a 415/413 does not either, and used/expired answers 410, unknown
  404, a revoked member 403. Every PUT counts as an attempt (5 per ticket,
  then 410), a member holds at most 20 open tickets (429), and the ticket is
  claimed before the R2 write so two parallel PUTs cannot both land.
  Owner-minted tickets carry `ut.owner` and skip the member check.
  **Resumable links (2026-11-20):** given a `size` (always for kind `file`,
  and for an image, clip or video past its single-shot cap), the same mint
  starts an upload-engine session and returns `/api/uploads/<room>/<link>/
  (part|sign|status|finish|abort)` instead (`ut.sess`; `sign` for a direct
  session). A link is not spent by
  use; it lives as long as its upload can (7 days), acts only on its one
  message and kind as the member who opened it, cannot start a new
  session, and counts toward the 20 open links only while its upload is in
  flight. Note: Workers observability logs record request URLs, so tickets
  and links exist in Cloudflare logs — accepted: a single-shot ticket is
  single-use and lives 15 minutes, and a link can only add or sign parts
  for, check, finish or cancel its own upload.
  Phase B (same day) drained the legacy in-DB media store. The drain
  check covered every known room (the watcher registry, the
  genesis-email log, and the build records — 11 rooms): each room
  that still exists reported zero legacy rows on migrate-media and
  purge-media, with a second migrate also zero, and the rest were
  already deleted (404, no storage to drain). The au/im tables, the
  getMedia fallback reads, and the migrate/purge routes themselves
  were then removed, and ensureSchema drops the tables wherever they
  still exist, so an unlisted room self-cleans on first touch under
  the new code. Phase D (same day) moved avatars to R2: setAvatar puts
  the object first (failure -> the same 503) under
  avatars/ROOM/<lowercased name>/<ver> and the inv row keeps only the
  pointer (avatar_key/avatar_type/avatar_ver); the GET route streams
  from R2. destroy() sweeps avatar keys with the rest of the room's R2
  objects. **Phase D finished 2026-11-19:** a read-only SQL sweep of
  every object in the Room namespace (Cloudflare API: list the
  namespace's objects, then `query/v2` SELECTs on each - 94 objects, 17
  with stored data, 9 with room tables, the rest deleted rooms holding
  only Cloudflare's metadata table) found no avatar blob anywhere, and
  the 5 avatar pointers (henry-hank-order-up 4, game-test-nov8 1) each
  matched an object under avatars/ in R2. So the blob fallback, the
  owner migrate-avatars/purge-avatars routes and the inv.avatar column
  are gone (ensureSchema drops the column wherever it still exists);
  avatars live in R2 or nowhere, like message media. That namespace
  sweep is also the way to check every room for anything else: there
  is no room index, but the API lists the objects and runs SELECTs on
  each (SELECT only - query/v2 also accepts writes; never select inv
  tokens or cfg values). Phase E (same day) retired the
  credential from media URLs: listings, stream frames, attach
  responses and /members now carry signed URLs
  (?exp=<unix>&sig=<base64url HMAC-SHA256>) minted with a per-room
  32-byte key kept in the room's own cfg (media_sig_key) - no new
  Worker secret, nothing for check:config to inventory. Read routes
  accept a valid signature with no credential (an invalid or expired
  one answers 403); header auth kept working throughout, and ?invite=
  kept working for one transition release before its removal from the
  media read routes shipped 2026-11-11 (a media GET/HEAD now takes the
  header or a signature only; writes and non-media routes are
  unchanged). Because
  serialization is sync and WebCrypto is async-only, the HMAC uses a
  small plain-JS SHA-256 (sha256Bytes/hmacSha256 by the signed-media
  helpers; verified against RFC 4231 vectors and node:crypto). The
  web app no longer appends invite= to media or avatar URLs
  (withInvite is a pass-through funnel). Follow-up (same day): the web
  app's stream is now a fetch-based SSE reader and speak playback is an
  authenticated fetch into a blob, both sending X-Invite-Token, so the
  web app puts the token in no URL at all. The server still accepts
  ?invite= on the stream and non-media routes, for header-less clients
  (the legacy pages that relied on it were removed 2026-11-19). A page
  left open past a signature's expiry (one to two hours, on an hour grid)
  gets fresh URLs from any listing re-read (stream
  reconnect or pull-to-refresh).
  **The upload engine (2026-11-20; owner's call: "optimize for size not
  budget... the largest file sizes regardless of type... resumable"):**
  every kind - image, audio, video and `file` (a general file of any type)
  - uploads past its inline cap one way: `POST /messages/:id/:kind/start
  {size, name, type, fingerprint}` pins a part plan (`uploadPlan`: about
  2,000 parts, each 8-90 MiB; all equal but the last, which R2 requires),
  `PUT .../part?n=N` sends each part, in any order and in parallel,
  `GET .../status` lists the parts received, `POST .../finish` checks every
  part is in (409 with `missing`), completes the R2 multipart upload,
  checks the size (and, for typed kinds, the magic bytes) and attaches,
  `POST .../abort` cancels; `POST /upload/resume {size, fingerprint}` finds
  a draft with that file in flight, and start again with the same size
  resumes. The Worker streams each part's request body straight into
  `uploadPart` (no buffering, never through the DO; part 1 of a typed kind
  is sniffed through a FixedLengthStream before anything is stored, so a
  wrong kind fails at its first part), and a refused part's body is read
  away before the answer so the client sees the reason, not a dropped
  connection. Ceiling through the Worker: 10,000 x 90 MiB, about 943 GB
  (`UP_MAX`); 90 MiB keeps every part under the zone's 100 MB request cap
  (section 2). Phase 2 below lifts both limits for clients that ask. An unfinished R2 multipart upload dies 7 days after its
  start, so a session does too (`UP_SESSION_MS`). The old chunked video
  routes (`/video/start|part|finish|abort|status`, `/video/resume`) are
  this engine with kind video. A `file` is served only as a download
  (`application/octet-stream`, `Content-Disposition: attachment` with its
  name, nosniff, the locked-down CSP; Range works) and listed as
  `file: {type, bytes, name, url}` - never rendered on this origin. The
  web composer (features/composer/uploads.ts) sends small media inline as before
  and everything else through the engine with XMLHttpRequest for byte
  progress (percent, size, speed, time left), per-part retries with
  backoff, a pause while offline that picks up on reconnect, a Cancel that
  aborts and deletes the draft, and an "interrupted upload" note after a
  reload (re-attach the same file to resume). A pick is routed by its
  bytes: a photo type the chat can't show (HEIC, SVG) attaches as a file.
  Images over 15 MB show as a card instead of an inline `<img>`.
  **Phase 2, parts straight to R2 (2026-11-20):** a client that starts
  with `"direct": true` gets a direct session (`md.mode = 'direct'`) when
  the R2 credential and `R2_DIRECT` are set: `POST .../:kind/sign {parts}`
  returns presigned PUT addresses on R2's S3 endpoint (SigV4, region
  `auto`, an hour each, up to 100 a call; `sigv4Presign` is checked against
  AWS's published example by a TEST_HOOKS route), the client sends each
  part there with no credential, and status / finish / resume read
  storage's own part list (S3 ListParts; a part of the wrong length counts
  as missing) before the binding completes the upload - multipart uploads
  started through the binding take parts sent through S3, proven live.
  Parts run to 512 MiB (more only to stay within 10,000) and an upload to
  4.99 TiB (`UP_MAX_DIRECT`, about 5.4 TB). The bucket's CORS rule lets
  only `https://chat.victorio.cloud` PUT (any header; ETag exposed); a
  preflight from any other origin is refused. The bucket keeps R2's
  "Default Multipart Abort Rule" (7 days), which `UP_SESSION_MS` relies
  on. The web uploader always asks for direct and falls back to the
  Worker path when the answer says `direct: false`; it signs in coalesced
  batches and re-signs when storage turns an address away (403).
  Video can also go up single-shot (≤25 MB) or via the whole-file stream
  endpoint (`PUT /messages/:id/video/stream`; the edge's 100 MB request
  cap is its real limit); reads stream through the Worker with Range
  support — never buffer a large file through the DO (it OOMs). A message is **not officially posted
  until its attached media upload completes** (owner rule): `POST /messages
  {draft: true}` creates an invisible draft, uploads attach to it, and
  `/publish` makes it live. A draft's media is visible only to its sender
  (and the owner) until it publishes. Abandoned drafts are swept after 24 h
  - or, while an upload for one is in flight, 7 days from that upload's
  start (checked on post and on upload start, throttled per instance),
  and drafts are exempt from the 1000-message trim. A draft
  created with `publish_on_complete: true` is published by the server itself
  the moment its upload verifies (stream, or the engine's finish) — for
  uploads that finish while no client is alive to call `/publish`. The `m.pubauto` column carries the flag. It and the one-PUT
  stream endpoint were built for the Android shell's background uploads
  (removed, section 11) and stay as API features any client may use.

- **Message delete:** `DELETE /messages/:id` (sender or owner only) aborts
  any in-flight upload, deletes the R2 objects, and drops the message and
  its index rows.
