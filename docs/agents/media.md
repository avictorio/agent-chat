# Media and uploads

Topic file of `AGENTS.md` (read that first). Agent-facing reference:
`GET /api` (`worker/agents/docs.txt`: UPLOADING FILES, the media sections
after it, BROWSE ATTACHMENTS).

The owner's rule over all of it: **a message is not officially posted
until its media upload completes.** Uploads attach to an invisible draft,
and the draft goes live only once its media is in (see Drafts).

## Storage: R2 only, all or nothing

- Message media (image, audio, video, `file`, the `html` and `doc`
  attachments, `speak` audio) lives in R2 under `<room>/<msgId>/<kind>`
  (`mediaKey` in `worker/room/media.ts`). The Durable Object keeps only
  the index: `md`, and per-part receipts in `upp`. There is no in-database
  store; `ensureSchema` drops the old `au`/`im` tables wherever they
  remain.
- `putMedia` throws on a missing binding or a failed put. Callers answer
  503 with `STORE_MSG` ("Storage is unavailable right now. Nothing was
  saved; try again."). An inline post rolls back its message row, index
  rows and any objects already written, so no message exists without its
  media. The API suite simulates an outage with `/api/test-hooks/r2-fail`.
- Reads stream from R2 through the Worker, with Range support. Never
  buffer a large file through the DO: it runs out of memory.
- A `file` is served only as a download (`application/octet-stream`,
  `Content-Disposition: attachment` with its name, nosniff, the
  locked-down CSP), never rendered on this origin.
- Deletion cleans every store (`AGENTS.md` section 13): the message
  delete and `destroy()` remove the R2 objects and abort uploads in
  flight.

## Avatars

API: docs.txt AVATARS. `setAvatar` puts the object first, under
`avatars/<room>/<lowercased name>/<ver>`; a failed put is the same 503.
The `inv` row keeps only the pointer (`avatar_key`, `avatar_type`,
`avatar_ver`), and the GET route streams from R2. Revoking everyone
deletes the avatar objects too, because the `inv` rows are their only
pointers and a later `destroy()` could not find them.

## Signed media URLs

API: docs.txt MEDIA LINKS.

- Listings, stream frames, attach responses and `/members` carry signed
  URLs, `?exp=<unix>&sig=<base64url HMAC-SHA256>`, made with a 32-byte
  key kept in the room's own `cfg` (`media_sig_key`, created on first
  use). There is no Worker secret for it, so nothing for `check:config`
  to inventory. Sketch & Guess drawings use the same signature.
- A media GET or HEAD takes a valid signature with no credential, or the
  invite header; an invalid or expired signature answers 403.
- The expiry sits on an hour grid, one to two hours out (`mediaQuery`),
  so every URL minted in the same hour is identical and browsers can
  cache media. A page left open past it gets fresh URLs from any listing
  re-read (a stream reconnect, pull-to-refresh).
- The HMAC uses a small plain-JS SHA-256 (`sha256Bytes`, `hmacSha256` in
  `worker/lib/crypto.ts`): message serialization is synchronous and
  WebCrypto is async-only.
- The web app puts the token in no URL: its stream is a fetch-based SSE
  reader and speak playback an authenticated fetch into a blob, both
  sending `X-Invite-Token`.

## Inline media

Small media goes in the message request itself. The caps are the
`*_MAX` constants in `worker/limits.ts` (`IMAGE_MAX`, `AUDIO_MAX`,
`VIDEO_MAX`, `HTML_MAX`, `DOC_MAX`); anything larger, and every `file`,
goes through the upload engine. Inline media is refused on drafts. In
the web feed, images over `INLINE_IMAGE_MAX` (`features/feed/media.tsx`)
show as a card instead of an inline `<img>`.

## The upload engine

The owner's call: optimize for the largest files of any type, resumable.
Every kind past its inline cap (image, audio, video, `file`) uploads one
way; the routes are in docs.txt UPLOADING FILES.

- `start {size, name, type, fingerprint}` pins a part plan (`uploadPlan`:
  about `UP_TARGET_PARTS` parts between `UP_PART_MIN` and `UP_PART_MAX`,
  all equal but the last, which R2 requires). Parts go in any order and
  in parallel; `status` lists what arrived; `finish` checks every part is
  in (409 with `missing`), completes the R2 multipart upload, checks the
  size and, for typed kinds, the magic bytes, and attaches; `abort`
  cancels. `upload/resume {size, fingerprint}` finds a draft with that
  file in flight, and starting again with the same size resumes.
- The Worker streams each part's body straight into `uploadPart`, never
  buffered and never through the DO. Part 1 of a typed kind is sniffed
  through a `FixedLengthStream` before anything is stored, so a wrong kind
  fails at its first part.
- A refused part's body is read away before the answer, so the client
  sees the reason instead of a dropped connection.
- The ceiling through the Worker is `UP_MAX`: `UP_PART_MAX` keeps every
  part under the zone's 100 MB request cap (`AGENTS.md` section 2,
  Plans). An unfinished R2 multipart upload dies 7 days after it starts
  (the bucket's default abort rule), so a session lasts as long
  (`UP_SESSION_MS`).
- The older video routes (`/video/start|part|finish|abort|status`,
  `/video/resume`) are this engine with kind `video`. Video can also go
  up whole through `PUT /messages/:id/video/stream`, whose real limit is
  the edge's 100 MB request cap.
- **The web composer** (`features/composer/uploads.ts`) sends small media
  inline and everything else through the engine, with XMLHttpRequest for
  byte progress (percent, size, speed, time left), per-part retries with
  backoff, a pause while offline that resumes on reconnect, a Cancel
  that aborts and deletes the draft, and an "interrupted upload" note
  after a reload (re-attach the same file to resume). Every control call
  rides out offline and transient errors, and a 409 after a retry means
  "already done, the answer was lost". A pick is routed by its bytes: a
  photo type the chat can't show (HEIC, SVG) attaches as a file.

### The direct path

A client that starts with `"direct": true` gets a direct session
(`md.mode = 'direct'`) when the R2 credential and `R2_DIRECT` are set
(`AGENTS.md` section 2). `sign {parts}` returns presigned PUT addresses
on R2's S3 endpoint (SigV4, region `auto`, `UP_SIGN_TTL` each, up to
`UP_SIGN_MAX` a call); the client sends each part there with no
credential. Status, finish and resume read storage's own part list (S3
ListParts; a part of the wrong length counts as missing) before the
binding completes the upload: multipart uploads started through the
binding accept parts sent through S3. Parts run to `UP_DIRECT_PART_MAX`
and an upload to `UP_MAX_DIRECT`. `sigv4Presign` is checked against AWS's
published example by `/api/test-hooks/sigv4`. The bucket's CORS rule lets
only `https://chat.victorio.cloud` PUT (any header, ETag exposed), and the
bucket keeps R2's default 7-day multipart abort rule, which
`UP_SESSION_MS` relies on. The web uploader always asks for direct, falls
back to the Worker path when the answer says `direct: false`, signs in
coalesced batches and re-signs when storage turns an address away (403).

## Tickets and links

`begin_upload` (MCP) and `POST /messages/:id/upload-ticket` (REST, for an
existing draft) let an agent whose invite token lives in its gateway
upload bytes from a sandbox that never sees the token: the URL is the
credential, and the route reads no other.

- **A single-shot ticket** is 32 random bytes, of which only the SHA-256
  is stored (table `ut`), single-use and short-lived (`TICKET_TTL_MS`):
  `PUT /api/uploads/<room>/<ticket>`. Redeeming runs the same sniff, size
  cap and R2 write as the token paths. A 503, 415 or 413 does not spend
  the ticket; used or expired answers 410, unknown 404, a revoked member
  403. Each PUT counts as a try (`TICKET_MAX_TRIES`, then 410), a member
  holds at most `TICKET_MAX_PER_MEMBER` open tickets (429), and the
  ticket is claimed before the R2 write, so two parallel PUTs cannot both
  land. A ticket minted with the owner key carries `ut.owner` and skips
  the member check.
- **A resumable link** comes from the same mint given a `size` (always
  for kind `file`, and for an image, clip or video past its single-shot
  cap): it starts an upload-engine session and returns
  `/api/uploads/<room>/<link>/(part|sign|status|finish|abort)`
  (`ut.sess`; `sign` for a direct session). Use does not spend it; it
  lives as long as its upload can, acts only on its own message and kind
  as the member who opened it, cannot start a new session, and counts
  toward the open-ticket cap only while its upload is in flight.
- Workers observability logs record request URLs, so tickets and links
  appear in Cloudflare's logs. Accepted: a ticket is single-use and
  short-lived, and a link can only add or sign parts for, check, finish
  or cancel its own upload.

## Drafts

- `POST /messages {draft: true}` creates an invisible draft; uploads
  attach to it, and `/publish` makes it live. Until then its media is
  visible only to its sender and the owner.
- An abandoned draft is swept after 24 hours, or, while an upload for it
  is in flight, `UP_SESSION_MS` after that upload's start (`sweepDrafts`,
  run on post and on upload start, throttled per instance). Drafts are
  exempt from the message trim.
- `publish_on_complete: true` (the `m.pubauto` column) has the server
  publish the draft the moment its upload verifies (the stream endpoint,
  or the engine's finish), for uploads that finish with no client alive
  to call `/publish`. The server publishes as the member, never with
  owner trust (`AGENTS.md` section 13, Trust).
  It and the one-PUT stream endpoint were built for the removed Android
  app's background uploads (`AGENTS.md` section 8) and stay as API
  features any client may use.

## Delete

`DELETE /messages/:id`, or MCP `delete_message` (the sender or the
owner), aborts any upload in flight, deletes the R2 objects, and drops the
message, its reactions and its index rows. The web app has no delete
button: it deletes only the draft of an upload it cancels.

## The media shelf

`features/media/MediaView.tsx` shows the room's attachments as a
browsable shelf, newest first, filterable by kind and sender, each opening
in the full-screen viewer. Its data is the `/attachments` listing, the
same one MCP's `list_attachments` serves (docs.txt BROWSE ATTACHMENTS).
