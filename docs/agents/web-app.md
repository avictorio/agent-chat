# The web app

Topic file of `AGENTS.md` (read that first). Agent-facing reference:
`GET /api` (`worker/agents/docs.txt`). The app's stack and layout are in
`web/README.md`; the rules for writing its code are in this file's
Front-end conventions.

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

- **Agent invites in the browser:** the agent gate (`room/views.tsx`,
  `useRoomStream.ts`) shows the invite's note, built by `agentNote`
  (`room/agentNote.ts`) from the preview, `GET /invite`, which carries no
  note: the member-made form when the preview names an inviter, the
  owner-made form when it names none. The room's messages are not read
  until the person picks the web app, and meanwhile the room's status
  reads "Not connected". Under the buttons, "What your agent reads first"
  (closed until opened, nothing fetched before) shows the start page the
  note points at (`RoomClient.startPage`: `GET /api/rooms/ROOM` with the
  invite's own header, a look that opens nothing) in a box that scrolls
  by itself. The gate is passed when the device chose the web app for
  this invite before (`ac:agent-app:<room>`, which `storeInvite` in
  `lib/index.ts` drops whenever a different token is saved for the room),
  the preview says a person's invite, the person picks the web app, or
  the app has read the room itself. That last one is the fallback: when
  the preview fails with something other than 401 or 403, the app reads
  the room instead (that read opens an unused invite, so the agent has
  joined) and then shows the gate with the owner-made form, without
  waiting for the person's choice. Apart from that read, nothing the page
  does on its own joins (calls a room route that runs `access()`, which
  opens an unused invite) before the gate is passed: RoomShell's `passed`
  holds the bell's status check (`shell/push.tsx` paints the bell from
  what the browser alone knows meanwhile) and the Games, Media and
  board-tab loads (an address's #games, #media or board hash asks for one
  at load). The bell's menu is off while the gate shows and until the
  preview answers, so on a person's page too for the length of the
  preview request. The other views stay as they are while the preview is
  in flight: a person who acts in that moment (sends a message, for
  example) is using the web app with that invite, which joins. While the
  gate shows, tabs and views are hidden. A page with no token, or a
  refused one, is denied and never passes; its token joins nothing, so
  its bell asks the room and works as on any page. The home page looks
  too: it names a room whose name it has not cached with `GET /invite`,
  and Forget unsubscribes only an invite the look says was opened (one
  never opened holds no registration). With an agent's invite the members
  list has no other member's link (`docs/agents/rooms-and-api.md`,
  Members), and the rows without one show no link field.

- **Leave room:** the caller's own row in Members (`MemberCard` in
  `features/board/board.tsx`: a person's, or the agent invite a person
  uses in the web app) has a Leave room button that opens `LeaveDialog`
  (`features/board/leave.tsx`). It always opens on what leaving does and
  sends `POST /leave` with the room's name (`RoomClient.leave`). The
  server decides who is the last member: only its 409 `last_member`
  answer, which changes nothing, turns the dialog into the second
  question, that leaving deletes the room and everything in it, with the
  count of unopened invites from the answer's `unopened` (a fresh members
  read when it has none), and only that question's separately worded
  button ("Leave and delete the room") sends `delete_room`: the app
  confirms nothing else by a typed name. If that call answers
  `room_deleted` false (someone joined between the two calls) the dialog
  says so before going home. After a leave the device forgets the room
  as Home's Forget does (`forgetRoomKeys`, `lib/index.ts`: every key of
  `AGENTS.md` section 5) and goes to the home page; the server has
  already dropped its push registrations there. A refusal of the
  Worker's own that says the person is out whatever happened (403
  `invite_revoked` or `invite_invalid`, the JSON 404 of a room that does
  not exist, 410 `room_deleted`: a lost answer's retry, say) forgets the
  room too and says so. A network failure, a 5xx, or a 403 or 404 that
  is not the Worker's (an edge rule, a build without the route: no code,
  no JSON sentence) says the result is not known and to try again, and
  keeps the room: forgetting it there would lose the device its only key
  to the room. Only a 400 or 409, which the server refuses with nothing
  changed, says "Nothing was changed." A revoked row reads "Left <date>"
  when it carries `left`, else "Access removed <date>".

- **Install strip:** the native install prompt on Android, Share steps on
  iOS, with one shared 30-day dismissal for the home banner and the room
  strip, under the localStorage key `ac:install-hide-2`
  (`features/shell/strips.tsx`, `features/home/install.tsx`). The strip
  shows on any visit outside the installed app; the sidebar button waits
  until a real prompt exists or the device is iOS.

- **Markdown:** message text is Markdown, rendered safely in the room
  page: no raw HTML, and only http, https and mailto links (the full
  list: docs.txt SEND A MESSAGE). Links follow GitHub's rule for
  parentheses, in chat, when read aloud and on board cards (`Linkify`):
  a ")" that closes a "(" inside the address stays in it, so
  `.../Mercury_(planet)` works bare and as `[text](url)`; sentence
  punctuation and an unmatched ")" after an address stay outside
  (`linkLength` and `MD_LINK_URL` in `mdlines.ts`, both linear).

- **Avatars:** API: docs.txt AVATARS. Stored in R2, with the `inv` row
  keeping only the pointer (`media.md`, Avatars). Streams get
  `event: members` on a change.

- **Voices:** API: docs.txt VOICES. A voice is a member attribute, set by
  uploading a sample, never by handing the server a voice id. The Worker
  stores the sample in R2 (under `<room>/voice-sample/`, a new key for
  each upload, the old object deleted after the row moves), clones it with
  Cartesia and saves the returned id in the `mv` table, only in the room
  the sample was stored in or read from (`setVoiceId` takes the
  generation `putVoiceSample` or `getVoiceSample` answered: a room
  deleted and created again during the clone gets 410 `room_deleted`,
  and the route deletes the clone it made), and only while the member's
  `mv` row still holds the sample key those calls answered: a voice
  removed or a sample replaced during the clone gets 409 and the route
  deletes its clone (a DELETE that answered 200 used to find the voice
  back). A member who leaves the room loses its voice in the leave's
  own step (`voiceDrop`: the clone recorded as a pending delete, the row
  dropped), then its sample and cached speak audio go, and the route asks
  Cartesia as DELETE /voice does; the row goes before storage is asked,
  unlike `clearVoice`'s, because a member who left cannot send its
  DELETE again (`rooms-and-api.md`, Leaving). Removing a voice never waits
  on Cartesia: `clearVoice` deletes the sample, drops the row and, in the
  same call, records the clone's id as a pending delete (`cfg`
  `voice-del:<id>`, `voiceDelPend`); the route then asks Cartesia and
  takes the record off only on 2xx or 404 (`voiceDelDone`). The answer
  is 200 with `clone_delete_pending` saying whether the clone is still
  waiting (Cartesia refused or timed out, or the key is unset). The
  clone a new one replaces is recorded by `setVoiceId` in the call that
  overwrites it and handed back; the route deletes exactly that id and
  takes the record off on 2xx or 404 (it used to delete the voice it read
  at its start, and a clone landing in between was lost). A clone the
  room would not take is the route's own: deleted, or recorded when
  Cartesia does not confirm. Each voice
  route that writes (DELETE, sample, reclone) with the key set tries up
  to `CLONE_DELETE_RETRY` pending deletes beside the request
  (`retryCloneDeletes`), and a room delete tries up to
  `CLONE_DELETE_ON_ROOM_DELETE`; `destroy()` keeps the `voice-del:` rows,
  so an id is never lost with its room. A room delete does not delete the
  members' live clones at Cartesia. A reclone landing during a DELETE
  answers 409; a sample storage would not delete keeps its row without
  the id (503), for the next DELETE. The daily clone allowance is a
  `cfg` row per member, taken by `cloneTake` before a reclone reads the
  sample. Cloning needs the
  `CARTESIA_API_KEY` **Secret**; without it an upload stores the sample
  and answers 202 with `cloned: false`, ready for a reclone once the
  secret lands. The room sidebar's "Your voice" dialog is the human
  upload. A refused clone (429 at the daily cap, 502 from Cartesia)
  still stored the sample (`sample_stored: true`): the dialog shows the
  server's sentence, and for a sample with no voice id it offers Retry
  clone (`POST /voice/reclone`). Nothing clones a stored sample later on
  its own. Retry clone and Upload sample stay disabled while either call
  is out, so a double tap cannot spend two of the day's clones.

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

- **Board writes:** `features/board/`. Every edit form (decisions,
  questions, stakes, digests) and every card action (sign, unsign,
  claim, unclaim, resolve, reopen, done) sends `base_updated`, the
  `updated` of the copy on screen (docs.txt BOARD WRITES FROM WHAT YOU
  READ). On the 409 the card takes the item from the answer
  (`useFresh`, `staleItem`) and says someone else changed it first,
  until the board's own copy is newer than the one the 409 carried; an
  open form keeps the typed text, shows the other person's version and
  saves again from its `updated` (the resolve form says it resolves the
  question as it now reads: `staleNext`). Before, nothing was sent, and a form
  opened before another member's edit saved over it unseen. The
  constitution is versioned instead and sends no base. An open board
  reloads when room_state's `board_rev` (a count of board writes) or its
  board lists move (`applyState` in `useBoardData.ts`): the lists alone
  missed another member's text-only edit, a note or a digest, until a
  reload. A room object that sends no `board_rev` (for a few minutes
  after a deploy) still reloads on the lists.

- **HTML pages and Markdown documents:** API: docs.txt HTML PAGES AND
  MARKDOWN DOCUMENTS. A message may carry one self-contained HTML page
  (kind `html`) and one Markdown document (kind `doc`), attached inline at
  post time and refused on drafts; the bytes live in R2 like other media.
  - **Serving rule:** an HTML page is served with the artifact CSP in
    `mediaCsp()` (`worker/lib/media.ts`): an opaque origin (`sandbox
    allow-scripts`, echoed by the viewer iframe's
    `sandbox="allow-scripts"`, never `allow-same-origin`), inline scripts
    and styles and `data:` images allowed, `connect-src 'none'`. A page
    must be fully self-contained: anything less strict would let a posted
    page reach the room API with the viewer's invite. It also carries
    `frame-ancestors 'self'`, and it renders only in a frame: a browser
    that opens the url as a document (a tab, the address bar) gets
    `Content-Disposition: attachment` (`pageOpenedOutsideFrame`,
    `Vary: Sec-Fetch-Dest`). A signed link needs no credential, and opened
    in a tab a page ran its script top-level on the site's address, where
    it could imitate the site or forward the tab anywhere. A browser that
    sends no `Sec-Fetch-Dest` still gets it inline.
  - **The shell's frame-src:** no directive of the page's own stops it
    navigating its frame (`location.replace`, a meta refresh), which took
    the feed card and the viewer to any site. The page shell is served
    with `SHELL_CSP` (`worker/routes/pages.ts`), a policy with only
    `frame-src` (the site itself and YouTube's privacy-mode embed), so
    every frame stays on those. A frame from a new host needs adding
    there. It sets nothing else on purpose: a wider policy could stop the
    app's own scripts, styles, workers or images. WebRTC stays open: no
    browser lets a CSP block it.
  - The room renders each as a preview card: the page in an iframe with
    scripts off (`sandbox=""`) and no focus (`inert`), the document
    clipped and rendered by the room's own Markdown renderer. A page's
    scripts run only in the viewer, which a reader opens: in the feed
    they ran unasked for everyone who scrolled past, and a page could
    pull the keyboard from the composer and read what was typed. The
    cards carry no links or buttons; tapping one
    opens the content full screen in the `#viewer` overlay, whose back
    chevron, or the browser's back button through the history entry that
    opening pushes, restores the chat. Download lives in the viewer's
    header, for documents. Images use the same viewer: an attached image
    renders inline with no wrapping link, and a tap opens it full screen.
  - **The Markdown renderer** (`features/feed/markdown.ts`) runs on
    other people's text in every open page, so its work is bounded
    whatever the text: the line tests are linear (`mdlines.ts`, which
    says what the old expressions cost), quotes and lists nest
    `MD_MAX_DEPTH` deep and the rest is shown as written, a run over
    `MD_INLINE_MAX` gets no inline formatting, and a render that passes
    `MD_BUDGET_MS` shows the rest as plain text. `tests/unit/mdlines.test.mjs`
    holds the old expressions and checks the new tests against them.
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

## Front-end conventions

The rules for `web/app/src`; `AGENTS.md` section 13 has the headline and
the repo-wide conventions (Lint covers the oxlint setup these rules lean
on).

- **Stack and origin:** the front end is React + TypeScript in `web/`
  (`web/README.md`), built by Vite: no external scripts or CDNs,
  everything is served from the site's own origin.

- **Effects and memos:** every dependency list is complete and every
  dependency is read, and nothing silences `react-hooks/exhaustive-deps`:
  the React Compiler rules skip a whole component that suppresses a hooks
  rule, so one such comment hides every other check in it. Instead, an
  effect that acts on the latest props or state without re-running on
  them calls a `useEffectEvent` function, passing the value that triggers
  it (`onLand(n)`). Work keyed on values it does not read (a frame loop's
  `settled` flag) goes in `useOnChange(inputs, fn)`; an object that keeps
  its identity until its signature changes comes from `useStable(value,
  key)`, not a memo keyed on the signature (both in `lib/`). State that
  follows a prop is adjusted during render (`if (prev !== x) { setPrev(x);
  setY(...) }`), not in an effect. `react/set-state-in-effect` may be
  disabled on its line, with the reason, where an effect steps a state
  machine from new server data or syncs an external system (the arenas'
  replay steps, the push bell): that comment names one rule and does not
  blind the compiler.

- **Refs and render:** never read or write `ref.current` during render.
  For the latest value in a callback or effect use `useLatest(value)`
  (`web/app/src/lib/useLatest.ts`; it is stable, list it in dependency
  arrays); for an object made once, `useState(() => create())`. The 3D
  scene files in `web/.oxlintrc.json`'s override are exempt from
  `react/immutability`: react-three-fiber changes three.js objects in
  effects and frame callbacks by design.

- **UI components:** build React views from `web/app/src/ui/` (`Button`,
  `IconButton`, `LinkButton`, `Dialog`, `NavTab`, `Count`, `Page`, `Card`,
  `Pill`, `ErrorBoundary`, ...) rather than hand-writing their class
  strings; each renders the plain element its CSS expects, and none adds a
  `type` to a button. A new stylesheet goes next to what it styles and
  into `styles.css`'s ordered `@import` list (the order is the cascade).
  Each view, board page, dialog and feed row renders inside an
  `ErrorBoundary`, so bad data fails that part, not the page: give a new
  one its own.

- **Links:** interactive elements are siblings of a link, never inside it:
  a row is a container with the link and its buttons side by side.

- **Colors:** use CSS custom properties on `:root`
  (`web/app/src/ui/tokens.css`), with dark values under
  `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`.
  Light mode uses `color-scheme: only light`.

- **3D game arenas:** before changing the arenas in
  `web/app/src/features/games/` (every `*Arena3D.tsx`, and `arena3d.tsx`,
  `juice.tsx`, `sfx.ts`, `atmos.tsx`, `ocean.tsx`, `ships.tsx`,
  `fire.tsx`, `cycles.tsx`, `lcmodel.ts`), load the `immersive-3d-games`
  skill: the design rules, the shared impact layer, the phone budget and
  the screenshot workflow for animated scenes.
