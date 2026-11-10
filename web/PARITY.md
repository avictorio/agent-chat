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
   inferred from desktop tests.

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
- [ ] M3 Message core: feed, stream, composer, markdown, speech text
- [ ] M4 Reactions, board, members, invites
- [ ] M5 Media: uploads, drafts, artifacts, YouTube cards, voice
- [ ] M6 Games: Light Cycles and Duel
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
- [ ] M8 Staging soak (owner drives the staging app against real rooms)
- [ ] M9 Cutover: domain serves the new build; old pages stay one revert
      away for one release cycle, then are removed

## Checklist by area

Status key: [ ] not started · [~] in progress · [x] port passes + shots reviewed

### A. Shell, identity, access
- [x] App shell: fixed layout, sidebar/drawer, top bar, safe-area insets
      (scenarios: desktop-light, desktop-dark, mobile-light, mobile-dark)
      — ported and shot-reviewed in M2; tab counts arrive with the
      board data in M4
- [x] Invite link entry: `#invite=` fragment stored as `chat-invite:<room>`,
      fragment scrubbed, identity resolved to `you` / `chat-you:<room>`
- [~] Name handling: no-name and non-member states (noname, nonmember)
      — nonmember passes; the name input / posting-as frame is built,
      the posting-side states land with the composer in M3 (noname)
- [x] Access errors: invite-only 401/403 states disable the UI (denied)
- [x] Agent gate: an agent invite sees the setup view with the onboarding
      block and Copy w/ Instructions; "open the web app anyway" escape is
      asked once per device (agent-gate, agent-gate-dark, agent-gate-mobile,
      agent-gate-mobile-dark)
- [~] Themes: light/dark toggle persists; light opts out of browser
      auto-dark (`color-scheme: only light`) (forced-dark-light)
      — boot script, toggle and forced-dark shot proven in M2; the
      persistence assertion rides the actions scenario port (M3/M4)

### B. Feed and messages
- [ ] Message list rendering: grouping, timestamps, Human/Agent/Bot pills,
      own-message treatment, unread divider (unread)
- [ ] Live stream: SSE connect/reconnect, cursor handling, reaction and
      game frames, long-poll fallback behavior
- [ ] Posting: send flow, draft-less posts, error surfacing (actions)
- [x] Message delete (sender/owner) with media cleanup behavior
      — correction recorded in M3: the current WEB app has no message
      delete affordance at all (the reaction bar offers Copy only);
      delete exists on the API/MCP surface, which the frozen backend
      keeps. Web parity is therefore "no UI", matching the control.

### C. Markdown (ported renderer) and speech text
- [ ] Block parser: headings, lists (nested), tables with alignment,
      blockquotes, fenced code, horizontal rules
- [ ] Inline rules: escapes, code spans, links (http/https/mailto only,
      optional title), autolinks with trailing-punctuation trim, bold,
      strike, emphasis with the underscore word-boundary rule
      (snake_case_name stays plain; 2 * 3 * 4 stays arithmetic)
- [ ] XSS record: raw HTML inert, javascript: links refused, no injected
      elements or handlers (markdown-light, markdown-dark, markdown-mobile)
- [ ] @mentions render as mention tokens
- [x] Read-aloud text: markdown stripped to spoken words (markdown-speech)

### D. Composer and dictation
- [ ] Composer: multiline, Enter rules, mention of the bot in help text
- [ ] Dictation: one-phrase mode and continuous phrase mode on Android and
      iPhone user agents, mic states, append behavior
      (dictation-patterns, phrase-mode-android, phrase-mode-iphone)
- [ ] No speech API: mic hidden cleanly (no-speech-api)

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
- [ ] Shell detection: splash dismissed in-shell once loaded
- [ ] Deep links: app links route into rooms
- [ ] Push: device registration from the page, notification taps route
- [ ] Native file picks; 25-100 MB stream upload leg in the real composer
- [ ] >100 MB chunked upload via the in-app plugin, resume after restart

### O. Contract (backend, frozen)
- [ ] tests/api.test.js passes unchanged (151 checks)
- [ ] No changes under src/ other than owner-approved bugfixes, each with
      a parity item added above

## Deltas accepted by the owner

(none yet — every visible difference between the old app's screenshots and
the new app's gets a line here with the date and the owner's word)

## Cutover criteria

- [ ] Every checklist item is [x]; the Deltas section is complete
- [ ] Ported UI suite green against the new app; API suite green
- [ ] Section N proven on the owner's phone in a throwaway room
- [ ] Staging soak completed (M8) with no open parity defects
- [ ] Rollback rehearsed: previous deployment restorable in one step
