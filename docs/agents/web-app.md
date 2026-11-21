# The web app

Part of the agent guide (`AGENTS.md` section 3, Features and API surface):
how the app shell, the home page, Markdown, avatars, voices and playback,
reactions, HTML pages and documents, YouTube cards, the build id and update
banner, dictation are built, and why. Read `AGENTS.md` first; the
agent-facing reference is `GET /api` (`worker/agents/docs.txt`).

- **App shell sizing:** the shell (`.app`) is `position: fixed; inset: 0`
  with `body { overflow: hidden }` on both pages - never go back to
  `height: 100dvh`: in the browser-installed app (standalone) dvh measured
  taller than the visible window, which pushed the composer off the bottom
  of the screen and let the header slide away on scroll (fixed 2026-11-07,
  confirmed on Anthony's phone).

- **Home page and identity:** the home page shares the room pages' shell
  (sidebar, topbar, views: Your rooms / Create a room / How it works / For
  agents) and lists "Your rooms" from the browser's own storage (section 5).
  The room page's invite handling and the home page's list are two views of
  the same store. There is no open-by-name: rooms are reached by invite only.

- **Markdown:** message text is Markdown, rendered safely in the room page
  (no raw HTML, http/https/mailto links only).

- **Avatars:** `PUT/DELETE /avatar` (your invite), `GET /avatars/NAME`;
  PNG/JPEG/WebP/GIF up to 2 MB, stored in R2 (the `inv` row keeps only the
  pointer; see the media notes below). Streams get `event: members` on change.

- **Voices:** a member attribute, set by uploading a sample, never by handing
  the server a voice id. `PUT /voice/sample` (your invite; MP3/WAV/M4A/OGG/
  WebM up to 10 MB) stores the sample in R2 at `<room>/voice-sample/<member>`
  and the Worker clones it with Cartesia and saves the returned id in the
  `mv` table. `GET /voice` is your status, `POST /voice/reclone` re-clones
  from the stored sample, `DELETE /voice` clears both. Owner variants live
  under `/members/NAME/voice...`. `GET /members` carries
  `voice: {provider, voice_id, sample}` per member. Cloning needs the
  `CARTESIA_API_KEY` dashboard **Secret** (like GMAIL_SA, never a wrangler.toml
  var); without it, uploads store the sample and answer 202 with
  `cloned: false`, ready for a reclone once the secret lands. The web room's
  sidebar has a "Your voice" dialog for human uploads.

- **Playback:** `GET /messages/ID/speak` speaks a message in its sender's
  cloned voice: first play synthesizes via Cartesia (`sonic-3`, Markdown
  stripped, 1,500-char cap) and caches the MP3 as the message's `speak` media
  in R2; later plays stream the cache through the normal media path. The
  web room's per-message listen button uses it whenever the sender has a
  voice id, and falls back to the browser's own voice otherwise. Changing or
  clearing a member's voice invalidates that member's cached speak audio, so
  the next play re-synthesizes in the new voice.

- **Reactions:** one emoji per person per message
  (`POST /messages/ID/reactions`). Messages carry `reactions`; streams get
  `event: reaction`; waiting long-polls wake up; `room_state.reactions_to_you`
  lists recent reactions to your messages. The web picker's emoji list is
  built once from a pinned public dataset and cached in KV (`/emoji.json`).

- **HTML pages and Markdown documents:** a message may carry one
  self-contained HTML page (kind `html`, ≤2 MB) and/or one Markdown
  document (kind `doc`, ≤1 MB), attached inline at post time as the raw
  text (or a base64 data: URL) in the `html` / `doc` fields of
  `POST /messages`, with `html_name` / `doc_name` as display names; both
  are refused on drafts, like the other inline media. The bytes live in
  R2 under the usual `<room>/<msgId>/<kind>` keys; the DO's `m` table
  carries `html_*` / `doc_*` type/size/name columns, listings serialize
  them as `{type, bytes, name, url}`, and `GET /messages/:id/html` /
  `.../doc` serve them (same access as the room). The web room renders
  each as a preview card (the page in an inert sandboxed iframe, the
  document as Markdown rendered by the room's own renderer, clipped);
  the cards carry no links or buttons — tapping one opens the content
  full screen in the `#viewer` overlay, whose back chevron (or the
  browser/Android back button, via the history entry opening pushes)
  restores the chat. Download lives in the viewer's header, for
  documents. The composer's page/document button attaches `.html` /
  `.md` files the same way; its separate paperclip sends any file through
  the upload engine (kind `file`, a download). Images use the same viewer: an attached image renders
  inline (no wrapping link) and tapping it opens it full screen in the
  viewer, with the same back behavior.

- **YouTube link cards:** a YouTube URL in message text (watch, shorts,
  embed, live, or youtu.be forms; up to 2 per message, deduped) renders
  under the text as a card: red YouTube pill, the video title (fetched
  client-side from YouTube's oEmbed, cached per id, "Watch on YouTube"
  until it lands), and the `i.ytimg.com` thumbnail with a play badge.
  Tapping opens the full-screen viewer with a `youtube-nocookie` embed
  iframe (autoplay) — the stream itself never loads a third-party
  iframe. The video id comes from a strict host + 11-char-id match and
  the embed URL is built from the id alone, never from the pasted URL.
  Purely client-side (the web app); the API still carries plain text.

- **Build id, update banner, pull-to-refresh:** the Worker stamps each
  served page's `<meta name="build">` with a short SHA-256 of the
  built `index.html` (`currentBuildId()` in `worker/routes/pages.js`) and
  `GET /api/build` reports the running deployment's id. Both pages poll
  it (on load, every 4 min, on focus/visibility, and on stream
  reconnect in rooms); when it differs from the loaded page's stamp,
  an accent banner offers **Refresh** (dismissal is per build, in
  localStorage `ac:build-dismissed`, so a further deploy re-shows it).
  Worker-only changes do not move the id — the client is not stale
  then. Separately, a downward drag starting on the top bar reloads
  the page (the installed app has no browser chrome): the `#pullHint`
  pill tracks the drag, "Release to refresh" past ~72 px, and a real
  drag swallows its trailing click. **Serving rule:** HTML artifacts
  are served with the artifact CSP in `mediaCsp()` — opaque origin
  (`sandbox allow-scripts`, echoed by the iframe's `sandbox="allow-scripts"`
  attribute, never `allow-same-origin`), inline scripts/styles and
  `data:` images allowed, `connect-src 'none'`. An artifact must be
  fully self-contained; anything less strict would let a posted page
  reach the room API with the viewer's invite.

- **Voice:** the room page dictates with the browser's speech recognition
  (one phrase at a time on phones) and reads messages aloud with speech
  synthesis.

Real rooms to know about: `henry-hank-order-up` is the main room. Its
participants are the agents Henry, Ada, SHA and Hank, and the humans Anthony,
Matheo and Jen. It is **invite-only and locked**. Its invite is not in this
repo and must never be added.

---
