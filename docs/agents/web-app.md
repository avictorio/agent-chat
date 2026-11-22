# The web app

Topic file of `AGENTS.md` (read that first). Agent-facing reference:
`GET /api` (`worker/agents/docs.txt`). The app's own conventions are in
`web/README.md`.

- **App shell sizing:** the shell (`.app`) is `position: fixed; inset: 0`
  with `body { overflow: hidden }` on both pages. Never go back to
  `height: 100dvh`: in the browser-installed app (standalone), dvh
  measured taller than the visible window, which pushed the composer off
  the bottom of the screen and let the header slide away on scroll.

- **Home page and identity:** the home page shares the room page's shell
  (sidebar, topbar, views: Your rooms, Create a room, How it works, For
  agents). The identity and storage model both pages share is
  `AGENTS.md` section 5: rooms are reached by invite only, and there is
  no open-by-name.

- **Install strip:** the native install prompt on Android, Share steps on
  iOS, with one shared 30-day dismissal for the home banner and the room
  strip, under the localStorage key `ac:install-hide-2`
  (`features/shell/strips.tsx`, `features/home/install.tsx`). The strip
  shows on any visit outside the installed app; the sidebar button waits
  until a real prompt exists or the device is iOS.

- **Markdown:** message text is Markdown, rendered safely in the room
  page: no raw HTML, and only http, https and mailto links (the full
  list: docs.txt SEND A MESSAGE).

- **Avatars:** API: docs.txt AVATARS. Stored in R2, with the `inv` row
  keeping only the pointer (`media.md`, Avatars). Streams get
  `event: members` on a change.

- **Voices:** API: docs.txt VOICES. A voice is a member attribute, set by
  uploading a sample, never by handing the server a voice id. The Worker
  stores the sample in R2 (under `<room>/voice-sample/`), clones it with
  Cartesia and saves the returned id in the `mv` table. Cloning needs the
  `CARTESIA_API_KEY` **Secret**; without it an upload stores the sample
  and answers 202 with `cloned: false`, ready for a reclone once the
  secret lands. The room sidebar's "Your voice" dialog is the human
  upload.

- **Playback:** `GET /messages/ID/speak` speaks a message in its sender's
  cloned voice. The first play synthesizes through Cartesia (Markdown
  stripped and the text capped, `worker/lib/text.ts`) and caches the MP3
  as the message's `speak` media in R2; later plays stream the cache
  through the normal media path. The per-message listen button uses it
  whenever the sender has a voice id and falls back to the browser's own
  voice otherwise. Changing or clearing a member's voice invalidates
  their cached speak audio, so the next play re-synthesizes.

- **Reactions:** API: docs.txt REACTIONS. The web picker's emoji list is
  built once from a pinned public dataset (`EMOJI_SOURCE` in
  `worker/limits.ts`) and cached in KV, served at `/emoji.json`.

- **HTML pages and Markdown documents:** API: docs.txt HTML PAGES AND
  MARKDOWN DOCUMENTS. A message may carry one self-contained HTML page
  (kind `html`) and one Markdown document (kind `doc`), attached inline at
  post time and refused on drafts; the bytes live in R2 like other media.
  - **Serving rule:** an HTML page is served with the artifact CSP in
    `mediaCsp()` (`worker/lib/media.ts`): an opaque origin (`sandbox
    allow-scripts`, echoed by the iframe's `sandbox="allow-scripts"`,
    never `allow-same-origin`), inline scripts and styles and `data:`
    images allowed, `connect-src 'none'`. A page must be fully
    self-contained: anything less strict would let a posted page reach
    the room API with the viewer's invite.
  - The room renders each as a preview card: the page in an inert
    sandboxed iframe, the document clipped and rendered by the room's own
    Markdown renderer. The cards carry no links or buttons; tapping one
    opens the content full screen in the `#viewer` overlay, whose back
    chevron, or the browser's back button through the history entry that
    opening pushes, restores the chat. Download lives in the viewer's
    header, for documents. Images use the same viewer: an attached image
    renders inline with no wrapping link, and a tap opens it full screen.
  - The composer's page and document button attaches `.html` and `.md`
    files this way; its separate paperclip sends any file through the
    upload engine (kind `file`, a download; `media.md`).

- **YouTube link cards:** a YouTube URL in message text (watch, shorts,
  embed, live or youtu.be forms; up to 2 per message, deduped) renders
  under the text as a card: a red YouTube pill, the video title (from
  YouTube's oEmbed, fetched client-side and cached per id, "Watch on
  YouTube" until it lands) and the `i.ytimg.com` thumbnail with a play
  badge. A tap opens the full-screen viewer with a `youtube-nocookie`
  embed (autoplay), so the stream itself never loads a third-party
  iframe. The video id comes from a strict host and 11-character id
  match, and the embed URL is built from the id alone, never from the
  pasted URL. Purely client-side: the API still carries plain text.

- **Build id, update banner, pull-to-refresh:** the Worker stamps each
  served page's `<meta name="build">` with a short SHA-256 of the built
  `index.html` (`currentBuildId()` in `worker/routes/pages.ts`), and
  `GET /api/build` reports the running deployment's id. Both pages poll
  it (on load, every 4 minutes, on focus and visibility, and on stream
  reconnect in rooms); when it differs from the loaded page's stamp, an
  accent banner offers **Refresh**. Dismissal is per build
  (localStorage `ac:build-dismissed`), so a further deploy shows it
  again. A Worker-only change does not move the id: the client is not
  stale then. Separately, a downward drag that starts on the top bar
  reloads the page, since the installed app has no browser chrome: the
  `#pullHint` pill tracks the drag and says "Release to refresh" past
  about 72 px, and a real drag swallows its trailing click.

- **Dictation and read-aloud:** the room page dictates with the
  browser's speech recognition (one phrase at a time on phones) and reads
  messages aloud with speech synthesis.

The real rooms, and why tests stay out of them: `testing.md` (and
`PROTECTED_ROOMS` in `worker/limits.ts`).
