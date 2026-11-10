# Parity checklist — React front-end rewrite

The replacement front end (this directory) is done when every item below is
proven, not when it looks close. The current app (`src/`) is the control: it
is not modified by this project, and every behavior it has today is the spec.

## How parity is proven

1. **Ported scenarios.** `tests/ui.test.js` (~45 scenario runs against a fake
   API) is ported so the same assertions run against the new app with the
   same fixtures. A scenario counts only when its port passes. If a ported
   scenario fails against the *old* app too, the scenario was wrong — fix
   the scenario, note it here.
2. **Screenshot pairs.** For every scenario that takes screenshots, the new
   app's shots are compared with the old app's, side by side, at desktop
   and mobile sizes, light and dark (AGENTS.md section 10). Parity means
   behavior-identical and visually equivalent; every visible delta is
   either fixed or written down in the Deltas section below and accepted
   by the owner.
3. **Contract suite.** `tests/api.test.js` (151 checks) keeps passing
   unchanged — the backend is frozen, and this suite is the machine-checked
   proof that the client-visible contract did not move.
4. **On-device pass.** The Capacitor bridge behaviors (section N) are
   proven on the owner's phone in a throwaway room before cutover, not
   inferred from desktop tests. (Deferred with the native pause,
   owner's word 2026-11-09 — see section N.)

## Ground rules

- **Feature freeze on `src/`** while this project runs: bugfixes only, and
  every bugfix adds or updates a parity item here and a scenario in the
  suite, so the target does not move silently.
- The markdown renderer is **ported** (a TypeScript module with the same
  behavior), not replaced with react-markdown. Revisit only after parity,
  behind the same tests.
- The design system is the current CSS, ported — no Mantine, no visual
  redesign. (SHA's panel uses Mantine; this app's surfaces are bespoke
  and parity is the bar.)
- Stack matches the SHA panel: React 19, TypeScript, Vite, npm workspaces
  (`shared` = API contract types + client, `app` = the web app).

## Milestones

- [x] M1 Parity harness: this checklist + the ported suite running against
      a skeleton app (all red), staging worker serving it
      — 2026-11-09: workspaces scaffolded (@chat/shared types + client,
      @chat/app Vite + React 19 + TS skeleton; typecheck and production
      build green, versions matching the SHA panel). Ported suite lives
      at web/tests/ui.test.js (npm test in web/): the fake-API core and
      scenarios are verbatim from tests/ui.test.js. Baseline: the M1
      smoke scenario passes (invite stored + scrubbed, fixture messages
      render through the typed client); the five ported parity scenarios
      (duel-card, markdown-light/dark/mobile, agent-gate) all fail, as
      expected — the features do not exist yet. Staging is LIVE at
      https://next.chat.victorio.cloud (Worker victorio-chat-next:
      serves the build with /api proxied to production; verified —
      /api/build answers production's build id, the shell and bundle
      serve correctly). Redeploy after any build with
      `python3 web/staging/deploy.py` (Workers Scripts API via the
      stored connector credential; the build rides as text modules).
- [x] M2 Shell: layout, identity, themes, install strip, update banner,
      pull-to-refresh
      — 2026-11-09: the current app's stylesheet is ported wholesale
      (tokens, base, shell and every component block; markup lands per
      milestone), and the shell is built: fixed layout, sidebar/drawer,
      top bar, tab views with hidden-toggle routing and hash sync,
      identity (invite intake, you, chat-you cache, name/posting-as
      frame), status line, themes (pre-render boot script, Light/Dark
      seg toggle persisted as chat-theme, color-scheme: only light),
      agent gate, locked view on 401/403, install strip (shared 30-day
      dismissal ac:install-hide-2), update banner (per-build dismissal),
      pull-to-refresh from the top bar. Suite: desktop-light/dark,
      mobile-light/dark, update-banner x3, pull-refresh-mobile, denied,
      nonmember, agent-gate x4 and forced-dark-light all pass and their
      shots were reviewed against the current app's — the remaining
      visual deltas are exactly the unbuilt surfaces (message rendering
      M3, board content and tab counts M4, composer tools M3, push and
      voice sidebar rows with their features). markdown-dark/mobile
      pass on screenshots only; the markdown assertions live in
      markdown-light, still red until M3. duel-card still red (M6).
      Staging redeployed: the deploy now stamps production's current
      build id into the page (so the banner stays quiet until
      production next deploys) and proxies /icons/* and the manifest.
- [x] M3 Message core: feed, stream, composer, markdown, speech text
      — 2026-11-09 (commit b71ca1d): feed with the control's msgNode
      logic, SSE stream with recheck-on-close and add() semantics,
      the markdown renderer ported line-for-line to TS, composer
      (name flow, mention highlight + menu, Ctrl+Enter), read-aloud.
- [x] M4 Reactions, board, members, invites
      — 2026-11-09 (commit 0918bfd): reactions with the hold-open
      discipline, the full board (constitution, decisions, questions,
      stakes, memory), members, invites, avatars.
- [x] M5 Media: uploads, drafts, artifacts, YouTube cards, voice
      — 2026-11-09 (commit 4dccb06): feed media (YouTube cards,
      image/video/audio, HTML page cards, doc cards), the viewer,
      composer uploads with the draft-first big-video engine, the
      voice recorder and Your voice dialog.
- [x] M6 Games: Light Cycles and Duel
      — 2026-11-09 (commit 803b9ff): the games store, cards and the
      duel arena; duel-card verified pixel-identical to production.
- [x] M7 Home page + push + native bridges (on-device proof at M9)
      — 2026-11-09: the home page is built (your rooms with live
      identity resolution and the Forget confirmation, the invite-link
      entry, the create-a-room form with its full validation ladder and
      status-mapped results, how-it-works and for-agents views, its own
      stylesheet ported and scoped so it cannot bleed into the room
      shell); push is built on both paths — Web Push with the quiet
      re-register and the mode menu, and the shell's device-token flow
      with the same modes and discipline; the Capacitor bridges are
      built as guarded native paths (splash dismissal, app links,
      notification taps, native file picks, the 25-100 MB stream leg
      and the >100 MB chunked leg with listener-plus-poll settling).
      home-page passes; the suite stays fully green (48 scenarios).
      Area N's on-device proof remains, by its own terms, a cutover
      (M9) activity on the real phone.
- [x] M8 Staging soak (owner drives the staging app against real rooms)
      — started 2026-11-09: staging redeployed at HEAD after the
      pre-M8 refactors (feature folders, contexts, RoomShell hook
      decomposition); the owner drives real rooms on
      next.chat.victorio.cloud and reports defects, each of which
      gets a fix plus a parity case.
      Pre-soak inspection (2026-11-09): all 82 shared screenshot pairs
      reviewed against production. Nine findings, eight of them real
      divergences, all fixed with a parity assertion each:
      F1 sidebar counts (stakes window is 7 days, not 30; the "!"
      suffix and the decisions edge case matched production only by
      accident — the old counts probe was log-only and never compared;
      the desktop scenario now asserts the exact counts);
      F3 board Delete is the borderless quiet variant and its confirm
      text matches production's wording;
      F4 rel() rewritten to production semantics ("5 hr ago", never
      pluralized; no "never"/"yesterday"; short-date fallback);
      F5 reaction bar (sixth quick reaction is 😡 Angry; your current
      reaction rides as an extra highlighted button when it is not
      one of the six; plus is a plain-plus "More reactions"; Copy is
      text-only and closes immediately; focus behavior matches);
      F6 the picker highlights your current reaction's cell wherever
      it renders (Recent row and home category both);
      F7 avatar lightbox puts name and kind pill on one title row;
      F8 board edit forms use .field columns with full-width controls
      and the shared actions row (a bare label left textareas at
      intrinsic width, floating over their labels);
      F9 home.css carried three doubled scope selectors from the
      scoping pass, which silently unstyled the brand block, a view
      and the install strip. F2 (sidebar lock glyph) was investigated
      and cleared as code-equivalent. Suite green at 48 scenarios with
      all assertions in force; post-fix pairs re-reviewed.
      Soak defect S1 (owner report, 2026-11-09): "hold brings up the
      bar, but I have to click twice for the selection to take." The
      hold's swallow flag outlived the gesture: a release that
      produces no click (the touch long-press case) left the flag
      set, and the port's document click guard swallowed the next
      tap wherever it landed. Production carries two guards the port
      missed - the swallow exempts clicks inside the popover, and
      pointerup schedules the flag's clearing after 120ms ("don't
      let the flag outlive it"). Both ported; the new
      reactions-hold-noclick scenario models the no-click release
      with synthetic pointer events and fails on the pre-fix code,
      passes after. Suite green at 49 scenarios.
      Soak defect S2 (owner screenshots, 2026-11-09): no notification
      bell anywhere on staging. Two stacked causes: the staging
      Worker SPA-fell-back /sw.js and /emoji.json to index.html -
      a text/html service worker is rejected, so registration failed
      (and the emoji picker would have failed the same way) - and
      the port only painted the bell at the end of the async
      subscription check, which waits on serviceWorker.ready and so
      never completed; production paints visibility from the support
      rule, independently of that check. Fixes: the staging proxy
      now passes /sw.js and /emoji.json to production, and usePush
      paints the support-based state at boot before refining it.
      The new push-bell scenario (permission stubbed to "default",
      the harness's /sw.js broken like staging's was) fails on the
      pre-fix port and passes after. Suite green at 50 scenarios.
      Note the suites missed S2 because headless Chromium's denied
      permission takes the early paint branch.
      Soak closed 2026-11-09 on the owner's word. Defects found: S1
      and S2, both fixed above with a parity case each; the owner
      verified push notifications live on staging in Chrome after
      the S2 fix. No open parity defects; suite green at 50
      scenarios.
- [x] M9 Cutover: domain serves the new build; old pages stay one revert
      away for one release cycle, then are removed
      — 2026-11-09: DONE. The build is emitted into src/app/ as text
      modules (web/scripts/emit-app.py) and the Worker serves it at /
      and /r/:room with /assets/* from the emitted map; old pages stay
      imported, so the build id never moved (a5e6053f9e98b6f8 before,
      during and after). Commits: cutover a144653, rollback rehearsal
      revert 4447aac (old app verified live), reapply 7ce9c83 (new app
      verified live). All gates green pre-push: web suite (50), API
      suite, src UI suite, check, check:config. Old-page removal is a
      later cleanup, after one release cycle.

## Checklist by area

Status key: [ ] not started · [~] in progress · [x] port passes + shots reviewed

### A. Shell, identity, access
- [x] App shell: fixed layout, sidebar/drawer, top bar, safe-area insets
      (scenarios: desktop-light, desktop-dark, mobile-light, mobile-dark)
      — ported and shot-reviewed in M2; tab counts arrive with the
      board data in M4
- [x] Invite link entry: `#invite=` fragment stored as `chat-invite:<room>`,
      fragment scrubbed, identity resolved to `you` / `chat-you:<room>`
- [x] Name handling: no-name and non-member states (noname, nonmember)
      — nonmember passes; the name flow landed with the composer in
      M3 (noname scenario green)
- [x] Access errors: invite-only 401/403 states disable the UI (denied)
- [x] Agent gate: an agent invite sees the setup view with the onboarding
      block and Copy w/ Instructions; "open the web app anyway" escape is
      asked once per device (agent-gate, agent-gate-dark, agent-gate-mobile,
      agent-gate-mobile-dark)
- [x] Themes: light/dark toggle persists; light opts out of browser
      auto-dark (`color-scheme: only light`) (forced-dark-light)
      — boot script, toggle and forced-dark shot proven in M2;
      persistence asserted by the actions scenario (M3/M4), green

### B. Feed and messages
- [x] Message list rendering: grouping, timestamps, Human/Agent/Bot pills,
      own-message treatment, unread divider (unread)
      — ported in M3; scenarios green; shots reviewed in the
      pre-soak inspection
- [x] Live stream: SSE connect/reconnect, cursor handling, reaction and
      game frames, long-poll fallback behavior
      — ported in M3; the control has no long-poll fallback and
      neither does the port (parity is the absence)
- [x] Posting: send flow, draft-less posts, error surfacing (actions)
- [x] Message delete (sender/owner) with media cleanup behavior
      — correction recorded in M3: the current WEB app has no message
      delete affordance at all (the reaction bar offers Copy only);
      delete exists on the API/MCP surface, which the frozen backend
      keeps. Web parity is therefore "no UI", matching the control.

### C. Markdown (ported renderer) and speech text
- [x] Block parser: headings, lists (nested), tables with alignment,
      blockquotes, fenced code, horizontal rules
      — renderer ported line-for-line in M3; scenarios green
- [x] Inline rules: escapes, code spans, links (http/https/mailto only,
      optional title), autolinks with trailing-punctuation trim, bold,
      strike, emphasis with the underscore word-boundary rule
      (snake_case_name stays plain; 2 * 3 * 4 stays arithmetic)
      — ported in M3; scenarios green
- [x] XSS record: raw HTML inert, javascript: links refused, no injected
      elements or handlers (markdown-light, markdown-dark, markdown-mobile)
      — the ported renderer builds DOM nodes only; assertions pass
      (M3)
- [x] @mentions render as mention tokens (feed and composer, M3)
- [x] Read-aloud text: markdown stripped to spoken words (markdown-speech)

### D. Composer and dictation
- [x] Composer: multiline, Enter rules, mention of the bot in help text
      — M3: Ctrl+Enter posts, Enter alone does not; mention menu
- [x] Dictation: one-phrase mode and continuous phrase mode on Android and
      iPhone user agents, mic states, append behavior
      (dictation-patterns, phrase-mode-android, phrase-mode-iphone)
      — both modes ported in M3; scenarios green
- [x] No speech API: mic hidden cleanly (no-speech-api)

### E. Reactions and emoji
- [x] One reaction per person per message: set, replace, remove; chips
      with counts and mine-highlighting; who-reacted titles (reactions)
- [x] Emoji picker: dataset sections, search, recents, the quick bar,
      Esc closes (reactions-picker, reactions-picker-mobile)
- [x] Touch: long-press opens the bar, drag does not (reactions-touch)

### F. Board (room memory)
- [x] Constitution: view, edit, version history
- [x] Decisions: add, sign/unsign, edit, delete
- [x] Open questions: add, claim/unclaim, resolve, edit, delete; resolved list
- [x] Stakes: add, mark done, due dates
- [x] Digests: write (3/day cap surfaced), list, edit, delete
      (board actions ride the actions scenario and the fake-API routes)

### G. Members, invites, avatars
- [x] Members list: kinds, statuses, last seen, voice badges
      — the current app's member cards carry no voice badge; the
      checklist item resolves to the cards as they are
- [x] Invites: create (human/agent), Copy w/ Instructions on the creation
      card and on agent rows, revoke; member-created invite limits
      (invites, invite-card-mobile-dark, invites-dark-mobile)
      — revoke is owner-side (REST/owner key), not a web affordance,
      in the current app too
- [x] Avatars: upload (validated types), change, remove, initials fallback,
      member avatar dialog (avatars, avatars-dark-mobile, avatar-dialog,
      avatar-dialog-dark-mobile)

### H. Media and uploads
- [x] Attachments: image (5 MB), audio (5 MB), video; magic-byte and size
      errors surface as toasts
- [x] Drafts: a message is not posted until its media upload completes;
      draft media private to the sender until publish
- [x] Video paths: single-shot (<=25 MB), chunked multipart with resume,
      whole-file stream PUT; publish-on-complete drafts
      — the whole-file stream PUT is the native shell's leg and lands
      with the bridges in M7; the web paths are complete
- [x] Speak audio: per-message listen button, cloned voice when present,
      browser voice fallback

### I. Artifacts and viewer
- [x] HTML artifact cards: inert sandboxed preview, no links/buttons in
      the card, full-screen viewer, back restores scroll
- [x] Markdown document cards and viewer; download in the viewer header
- [x] Image attachments inline; tap opens the viewer (artifacts,
      artifacts-mobile)
- [x] YouTube link cards: strict id match, oEmbed title, thumbnail with
      play badge, nocookie embed in the viewer (max 2 per message)

### J. Voice
- [x] Your voice dialog: sample upload, status, reclone, delete
- [x] Speak playback caching behavior (voice, voice-mobile-dark)

### K. Games
- [x] Light Cycles: card with live SVG board, arena viewer, direction pad
      (reverse disabled), queued move through the API, awaiting badges,
      move log, Rematch (game-card, game-card-mobile)
- [x] Duel: own-color pips and score numerals, locked/thinking state line,
      last-round face-off with named verdict (tie = CLASH), YOUR THROW /
      LOCKED pill, round-clock bar (duel-card, duel-finished, duel-mobile)
- [x] Duel viewer: face-off arena, plain-words status line, throw tiles
      with beats microcopy, verdict banner, round-chip strip, Rematch
- [x] Cancelled matches render as cancelled and offer Rematch to players
- [x] Lobby (post-cutover, 2026-11-10): matches open in a lobby - card
      meta names who is still to accept, an invited player answers
      Accept / Decline right on the card or in the arena, the clock
      starts only when everyone is in (duel-lobby, duel-lobby-mobile)

### L. Home page
- [x] Your rooms: rows from on-device storage, letter tiles, identity
      resolved live, Forget pill with confirmation (home-page)
- [x] Create a room form and its validation errors
- [x] How-it-works and For-agents views; room link preview

### M. Update and install affordances
- [x] Build polling: banner on mismatch, per-build dismissal, Refresh
      reloads (update-banner, update-banner-mobile, update-banner-current)
- [x] Pull-to-refresh from the top bar (pull-refresh-mobile)
- [x] Install strip: native prompt on Android, Share steps on iOS, one
      shared 30-day dismissal across home and rooms (home-page)
      — room side built in M2, home side in M7 with the same
      ac:install-hide-2 key; home-page proves the strip on the home
      page and the room shots prove it in the shell

### N. Native (Capacitor) bridges — on-device proof required
      DEFERRED 2026-11-09 on the owner's word: the native app
      concept is paused and the web app is the sole focus. These
      items are not a cutover gate. The guarded bridge code stays
      in the port, inert on the web. (The owner's 2026-11-09 upload
      tests ran in the installed staging PWA, which has no native
      bridges — they exercised the web upload engine instead: an
      87 MB and a 135 MB video both completed byte-exact in the
      foreground; a lock-screen freeze aborts a page-driven upload
      silently, as on production. Real-world Area H evidence, not
      Area N proof.)
- [ ] Shell detection: splash dismissed in-shell once loaded
- [ ] Deep links: app links route into rooms
- [ ] Push: device registration from the page, notification taps route
- [ ] Native file picks; 25-100 MB stream upload leg in the real composer
- [ ] >100 MB chunked upload via the in-app plugin, resume after restart

### O. Contract (backend, frozen)
- [x] tests/api.test.js passes unchanged (151 checks)
      — verified 2026-11-09: API suite, all checks passed
- [x] No changes under src/ other than owner-approved bugfixes, each with
      a parity item added above
      — since the freeze: one owner-approved wake-recipe text
      update (aba9ed3, 2026-11-09); no app-code changes

## Deltas accepted by the owner

(none yet — every visible difference between the old app's screenshots and
the new app's gets a line here with the date and the owner's word)

## Cutover criteria

- [x] Every checklist item is [x]; the Deltas section is complete
      — all areas except N (deferred, above) are [x]
- [x] Ported UI suite green against the new app; API suite green
- [ ] Section N proven on the owner's phone in a throwaway room
      — DEFERRED with the native pause (owner's word, 2026-11-09);
      waived as a cutover gate
- [x] Staging soak completed (M8) with no open parity defects
- [x] Rollback rehearsed: previous deployment restorable in one step
      — 2026-11-09: cutover a144653 reverted in one step (4447aac);
      the old app verified live (old home markup, build id unchanged),
      then the cutover was reapplied (7ce9c83) and re-verified.
