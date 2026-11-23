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
  invite header; an invalid or expired signature answers 403. The room
  checks the signature itself (`access()` with the link, `mediaLink` in
  `lib/media.ts`), against the key it has now, so no copy of the key
  lives in the Worker: a minute's cache there outlived a room's delete,
  and an old room's links opened the files of a room created again under
  the name while the new room's own links answered 403. Links the Worker
  mints (attach answers, avatars) read the key from the room each time
  (`mediaSigner`, one read per list).
- The expiry sits on an hour grid, one to two hours out (`mediaQuery`),
  so every URL minted in the same hour is identical and browsers can
  cache media (`MEDIA_CACHE`: private, an hour, immutable). A message's
  media URL also carries `v=`, the stored file's version (`md.at`, the
  stamp every attach and finished upload writes), after `exp` and `sig`.
  It is unsigned: the read checks only `exp` and `sig`, so ranges, the
  page viewer and downloads take it as they are. Without it a file
  replaced within the hour had a byte-identical URL and browsers kept
  serving their cached copy of the old one, reloads included. Rows from
  before `md.at` existed carry no `v=` until a new file lands. `withKinds`
  reads the versions of a whole page in one query (`mediaVersions`); the
  attachments listing selects `md.at` with its rows. Attach and finish
  answers (built in the Worker by `mediaSigParams`) carry no `v=`: the
  message frame that follows does. A stream reconnect does not renew them: it resumes after
  the last delivery number, so rows already on screen come again only
  when media landed on them. The web feed renews its own
  (`features/feed/useMediaRenewal.ts`): every minute, when the tab
  comes back into view and when the browser comes back online, it checks
  for a row whose links it got longer ago than `RENEW_AFTER`; if there
  is one, it re-reads that row with every row past `BATCH_AFTER`, so a
  room with steady media renews in batches rather than every minute
  (each row has its own time), and swaps only their media fields,
  keeping unchanged rows and the scroll as they are; a playing clip
  takes its new link at the next pause. The re-read is the latest page
  (the newest by id, how the feed loaded them), asking for as many rows
  as the feed holds from the lowest wanted id up plus `SLACK`, at most
  `PAGE`: one request for an ordinary renewal. Only rows older than that
  page are walked for forward at full pages from just under their ids,
  following `last_id` (a forward read is in delivery order, and a row
  delivered late sits past every message sent while it uploaded), for at
  most `MAX_PAGES`. A row the walk does not reach is not walked for again
  for `RENEW_AFTER`, unless a page reads it meanwhile. The check sends
  nothing while the browser says it is offline, and after a failed
  re-read it waits twice as long as before, up to ten minutes
  (`HOLD_MAX`; a re-read that gets through clears it): a longer wait
  left download cards and page previews, which do not retry, on dead
  links long after an outage ended. One re-read runs at a time:
  others join it or queue behind it. A feed image, clip or document that
  fails to load re-reads its row and retries once, wait or not. The Media shelf re-reads its listing when
  reopened after 30 s; pull-to-refresh reloads the page.
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
- **One writer per message and kind at a time.** Every writer of a
  message's media kind shares its R2 key and its `md` row: an attach
  (`putMedia`), the engine's start, finish and abort, and a stream's
  begin, finish and abort. Each takes its turn (`withMediaLock` in
  `worker/room/media.ts`, an in-memory chain per `msg:kind`), so none
  runs between another's read of the row and its write. Unlocked, a
  start replaced a file attached meanwhile with an upload in flight
  (listed, answering 404), an abort deleted the row a finish was
  completing, and a stream that had lost the row completed over the
  published video. A message delete takes no turn (rows first, storage
  after), so every write after a storage await is conditioned on the
  session's `upload_id` (`upStill`, `upDrop`), and a finish whose message
  went meanwhile deletes the object it made.
- A start replaces a session by creating the new multipart upload
  first, then swapping the row and clearing the old receipts in one
  step, then aborting the old upload: a failed create leaves the old
  session as it was, and a late part of the old upload is refused
  instead of counting in the new one. A resume whose part list storage
  will not give answers 502 (not an empty list, which sent the client
  to re-send everything); one storage no longer has starts afresh,
  unless the object is at the key at its size: an earlier finish
  completed it and never recorded so, and the start indexes it as that
  finish would have and answers 409 "already has" (the file is in place).
- **Finish is safe to repeat.** One sent while another runs gets that
  finish's answer (`_finishing` holds the promise), which can be a
  refusal; one sent after a finish succeeded answers 200 with the file
  the message's kind now holds (the caller compares bytes and name).
  Only a file an engine finish made counts: the row tells (an engine
  session's `part_size` is a whole MiB; an attach leaves it NULL, a
  stream writes `STREAM_PART`), so a finish for an upload an attach or
  a stream replaced answers 409, as one with no upload does, after a
  restart too. Another engine upload that replaced the caller's and
  finished leaves a row just as engine-made, so the finish takes two
  optional fields, `size` (bytes) and `fp` (the start's fingerprint):
  either one differing from the row's answers 409. An upload link's
  finish also compares the link's expiry, which is its session's start
  plus `UP_SESSION_MS` (`upBegan`), so a link opened for a replaced
  upload gets 409 without sending either. Storage answering NoSuchUpload
  is checked against the key first: an object of the declared size is
  an earlier finish that completed and never recorded so (an instance
  restart between the two), and it is checked and indexed. The stream
  endpoint completes in the Room too (`streamFinish`), only while its
  upload still owns the row.
- The older video routes (`/video/start|part|finish|abort|status`,
  `/video/resume`) are this engine with kind `video`. Video can also go
  up whole through `PUT /messages/:id/video/stream`, whose real limit is
  the edge's 100 MB request cap. From its reservation (`streamBegin`) to
  its answer the stream's work is also handed to `ctx.waitUntil`
  (`RouteContext.ctx`): Cloudflare may cancel a request's work when its
  client disconnects, awaits included, and a phone that dropped mid-body
  left its parts in storage and its row holding the upload id, while one
  that dropped after the last byte left the video unindexed and a
  `publish_on_complete` draft unposted.
- **The web composer** (`features/composer/uploads.ts`) sends small media
  inline and everything else through the engine, with XMLHttpRequest for
  byte progress (percent, size, speed, time left), per-part retries with
  backoff, a pause while offline that resumes on reconnect, a Cancel
  that aborts and deletes the draft, and an "interrupted upload" note
  after a reload (re-attach the same file to resume, or Discard). A
  draft found by `upload/resume` is taken over only when it holds no
  other upload kind: one that also carries a photo from an earlier send
  would publish that photo too, so a new draft starts instead. Cancel
  and Discard delete with `?draft_only=1`: the note is per browser, and
  another tab or device may have published the draft (or this tab's
  publish landed with its answer lost); on the 409 the composer forgets
  the note and says the message was already posted. Every control call
  rides out offline and transient errors, and a 409 after a retry means
  "already done, the answer was lost". Finish names the file (`size`,
  and `fp`, start's fingerprint) every time, so the server refuses one
  whose upload another file replaced; the status read after that 409
  counts only when its `size` is this file's, so the send stops with the
  server's reason instead of posting the other file. A pick is routed by
  its bytes: a photo type the chat can't show (HEIC, SVG) attaches as a file. The
  composer stays open during a send: what the send carries has no Remove
  until it ends, and anything picked or recorded meanwhile stays for the
  next message (a send clears only the items it posted).

### The direct path

A client that starts with `"direct": true` gets a direct session
(`md.mode = 'direct'`) when the R2 credential and `R2_DIRECT` are set
(`AGENTS.md` section 2) and the direct check has passed (below). `sign
{parts}` returns presigned PUT addresses on R2's S3 endpoint (SigV4,
region `auto`, `UP_SIGN_TTL` each, up to `UP_SIGN_MAX` a call); the
client sends each part there with no credential. Status, finish and
resume read storage's own part list (S3 ListParts; a part of the wrong
length counts as missing) before the binding completes the upload:
multipart uploads started through the binding accept parts sent through
S3. Parts run to `UP_DIRECT_PART_MAX` and an upload to `UP_MAX_DIRECT`.
The bucket's CORS rule lets only `https://chat.victorio.cloud` PUT (any
header, ETag exposed), and the bucket keeps R2's default 7-day multipart
abort rule, which `UP_SESSION_MS` relies on. The web uploader always asks
for direct, falls back to the Worker path when the answer says `direct:
false`, signs in coalesced batches and re-signs when storage turns an
address away (403).

**What an address can do.** An address goes to whoever is uploading, so
what matters is what its holder can do with it (`platform/r2-s3.ts`):

- It is signed with a credential made for that upload, never with the
  API credential. S3 turns an UploadPart into UploadPartCopy when the
  request adds an `x-amz-copy-source` header, and the API credential
  reads the whole bucket, so an address signed with it could copy any
  object (another room's media, at a key anyone can work out) into the
  caller's own upload. `r2PartCredential` mints an R2 temporary
  credential that allows `UploadPart` on the upload's own key and nothing
  else: a JWT signed with the API credential's secret, which R2 checks on
  every request. No call to Cloudflare is needed to make one.
- An address **is** that credential. The JWT rides in it
  (`X-Amz-Security-Token`) and the temporary secret is the JWT's SHA-256,
  so a holder can sign requests of their own within the scope: any part
  number, any length, on that one object, until it expires
  (`UP_SIGN_TTL`). The scope is the whole fence. `r2PartAddresses` is the
  one place part addresses are made.
- Each address also signs `content-length`. That tells a client that sent
  the wrong slice at once; it is not a limit, since the holder can sign
  another length. What bounds an upload is the scope, the expiry, finish
  counting only parts of the planned length, and the 7-day abort rule.
  A cap on what one member can park in storage is a separate matter.

**The direct check** (`platform/r2-direct-check.ts`). The scope is
enforced by R2, not by this code, and the local emulation does not
enforce it, so no test here can show it. The Worker tries it on the live
bucket instead, with objects of its own under `_check/` (no room name can
start with `_`), doing what the holder of an address could: the address
must take its part; a copy of another object signed with the address's
own credential must be refused with 403, and so must a read; the same
copy sent as an unsigned header must not copy; and, as a control, the
same signed copy made with the API credential must work, or the refusals
prove nothing. A try storage did not answer (5xx, 429) makes the check
inconclusive, never a pass.

Its first run on the live bucket (2026-11-22) passed, and also settled
what had prompted it. Until that day addresses were signed with the API
credential, host only, and on the local emulation such an address copied
any object when the request added `x-amz-copy-source`. The live bucket
refused that request (403 `SignatureDoesNotMatch`): R2, like AWS S3,
counts an `x-amz-*` header nobody signed against the signature, so the
old addresses could not copy. That behaviour is not in R2's docs, which
is why the addresses now rest on a documented one (the credential's
scope) that is proven daily. The local emulation differs from R2 on both
points, so nothing about this path can be concluded from a local probe.

The verdict lives in KV (`check:r2-direct`) with the check's version
(`CHECK_VERSION`: raise it when the signing or the check changes) and a
fingerprint of the credential: a day when good, 15 minutes when storage
failed a try, a minute when inconclusive. Direct uploads are offered only
while it is good; otherwise `start` answers `direct: false` and `sign`
503. `GET /api/build`, which every open page polls, runs it in the
background when nothing is proven and renews a pass from 12 hours on, so
an upload seldom waits for it. One check runs at a time per isolate.
A run gives storage 15 seconds in all; a request that hangs
counts as not answered. A direct session picked up again (a second
`start`) while the check is not passing is answered `direct: false` when
its parts fit a request to the site (`upStaysDirect`): the client sends
the rest through `/part`, keeping the parts it has, since storage holds
one list of parts however they arrive. Bigger parts wait for the check.
Read it in the logs: a pass is `{"note": "r2direct.check"}`, anything
else `{"warn": "r2direct.check"}`, each with storage's status and error
code for every try. `tests/unit/r2-direct.test.mjs` recomputes the JWT
and the signature independently (one signature is pinned to what
aws4fetch, the signer in Cloudflare's docs, produced) and runs the check
against a stand-in bucket in each of the ways storage could behave;
`/api/test-hooks/sigv4` checks `sigv4Presign` against AWS's published
example.

## Tickets and links

`begin_upload` (MCP) and `POST /messages/:id/upload-ticket` (REST, for an
existing draft) let an agent whose invite token lives in its gateway
upload bytes from a sandbox that never sees the token: the URL is the
credential, and the route reads no other.

- **A single-shot ticket** is 32 random bytes, of which only the SHA-256
  is stored (table `ut`), single-use and short-lived (`TICKET_TTL_MS`):
  `PUT /api/uploads/<room>/<ticket>`. Redeeming runs the same sniff, size
  cap and R2 write as the token paths. A 503, 415 or 413 does not spend
  the ticket; used or expired answers 410, unknown 404. Each PUT counts
  as a try (`TICKET_MAX_TRIES`, then 410), a member holds at most
  `TICKET_MAX_PER_MEMBER` open tickets (429; links being minted at that
  moment count, `utMinting`, or a burst of calls would all pass), and
  the ticket is claimed before the R2 write, so two parallel PUTs cannot
  both land. A ticket minted with the owner key carries `ut.owner` and
  skips the member check.
- **Tickets and links die with the member's last invite**
  (`dropUploadLinks`, called by `revoke` and `revokeAll`): from then on
  they answer 404. A link is a credential by itself and is checked
  against the member's name, so one left behind used to work again, for
  whoever had kept it, as soon as the name was invited anew (which is
  how an owner replaces a leaked invite). The mint checks the caller's
  invite again at the write, so a request that was waiting on its body
  during the revoke cannot add a link afterwards (rooms-and-api.md, "A
  revoke and the requests in flight").
- **So do their uploads in flight** (`abortUploadsOf`, which `revoke`
  and `revokeAll` start in `waitUntil` once the rest of the removal is
  written): each session's rows go and storage aborts the upload, after
  the media turns already running (a start writes its session at the end
  of its turn), so the removal's answer does not wait on a long finish. Aborting is the only way to stop a direct upload's part
  addresses, presigned for `UP_SIGN_TTL`: they used to go on taking
  parts after the removal, for a session the name could resume once
  invited again. Files already in place, and the drafts, stay.
- **A resumable link** comes from the same mint given a `size` (any
  kind, small files too, in one part; kind `file` must give one; only a
  call without `size` gets a single-shot ticket): it starts an upload-engine session and returns
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
  visible only to its sender and the owner. A caption sent with the
  publish replaces the draft's and is held to `MAX_TEXT` like a post
  (413): it used to be cut to the limit, silently.
- To anyone else a draft does not exist (`hiddenDraft` in
  `worker/room/media.ts`): publish, delete, the attach routes, the
  upload-ticket route, every upload step and the video stream answer
  another member's draft with the same 404 as an id that holds nothing.
  They answered 403 "only your own", and since ids are consecutive any
  member could sweep the gaps in the listing to see when someone was
  preparing a post. Another member's live message keeps its 403: it is
  in the listing anyway.
- An abandoned draft is swept after 24 hours, or, while an upload for it
  is in flight, `UP_SESSION_MS` after that upload's start (`sweepDrafts`,
  run on post and on upload start, throttled per instance). The day also
  counts from the last file that finished (`md.at`): a long upload can
  end when the draft is already more than a day old, and the sweep once
  took the draft and the finished file right then, before the publish or
  before the message's second file could start. Drafts are exempt from
  the message trim, and a published one counts as new from its publish.
- **A post with media inside it is a draft until every file is stored**
  (`post()`, `held`), then goes live in one step. Stored live from the
  start it could be read before it was announced - without its media,
  and even when the post then failed - and a reader whose cursor passed
  its id meanwhile never got it.
- **Rows first, storage after.** `deleteMessage` and the sweep delete
  the rows in one step and only then call R2, so nothing can change the
  message between the look and the delete. A write that was under way
  when its message was deleted (a stream, an upload start, a post
  storing its file) checks for the message again once storage answers;
  whatever still slips through is never served (`mediaShown`) and is
  collected by the sweep.
- **Media that lands on a live message announces it again**
  (`mediaLanded`): the attach routes, an upload finished on a published
  message and a ticket redeemed as its draft publishes. It gives the
  message a fresh delivery number (`m.seq`: `rooms-and-api.md`,
  Messages), wakes long polls and re-sends the full message frame under
  that number (no push), so the web app swaps in the new copy and a
  forward read from any earlier cursor, the message's own included,
  returns it once. `pub_ts` stays when it went live, so the trim order
  is unchanged. Only the rows used to change, and every open tab and
  cursor reader kept the bare message; then moving `pub_ts` did the job
  and missed the reader whose cursor was that message. A draft is left
  to its publish.
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
message, its reactions and its index rows. With `?draft_only=1` it
deletes only a draft and answers 409 for a live message. The web app has
no delete button: it deletes only the draft of an upload it cancels or
discards, always with `draft_only`.

## The media shelf

`features/media/MediaView.tsx` shows the room's attachments as a
browsable shelf, newest first, filterable by kind and sender, each opening
in the full-screen viewer. Its data is the `/attachments` listing, the
same one MCP's `list_attachments` serves (docs.txt BROWSE ATTACHMENTS).
