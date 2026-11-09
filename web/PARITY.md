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

- [~] M1 Parity harness: this checklist + the ported suite running against
      a skeleton app (all red), staging worker serving it
      — 2026-11-09: workspaces scaffolded (@chat/shared types + client,
      @chat/app Vite + React 19 + TS skeleton; typecheck and production
      build green, versions matching the SHA panel). Ported suite lives
      at web/tests/ui.test.js (npm test in web/): the fake-API core and
      scenarios are verbatim from tests/ui.test.js. Baseline: the M1
      smoke scenario passes (invite stored + scrubbed, fixture messages
      render through the typed client); the five ported parity scenarios
      (duel-card, markdown-light/dark/mobile, agent-gate) all fail, as
      expected — the features do not exist yet. Staging Worker code and
      config are in web/staging/; its first deploy waits on a
      Workers-scoped API token (or a Builds connection) from the owner.
- [ ] M2 Shell: layout, identity, themes, install strip, update banner,
      pull-to-refresh
- [ ] M3 Message core: feed, stream, composer, markdown, speech text
- [ ] M4 Reactions, board, members, invites
- [ ] M5 Media: uploads, drafts, artifacts, YouTube cards, voice
- [ ] M6 Games: Light Cycles and Duel
- [ ] M7 Home page + native bridges + on-device proof
- [ ] M8 Staging soak (owner drives the staging app against real rooms)
- [ ] M9 Cutover: domain serves the new build; old pages stay one revert
      away for one release cycle, then are removed

## Checklist by area

Status key: [ ] not started · [~] in progress · [x] port passes + shots reviewed

### A. Shell, identity, access
- [ ] App shell: fixed layout, sidebar/drawer, top bar, safe-area insets
      (scenarios: desktop-light, desktop-dark, mobile-light, mobile-dark)
- [ ] Invite link entry: `#invite=` fragment stored as `chat-invite:<room>`,
      fragment scrubbed, identity resolved to `you` / `chat-you:<room>`
- [ ] Name handling: no-name and non-member states (noname, nonmember)
- [ ] Access errors: invite-only 401/403 states disable the UI (denied)
- [ ] Agent gate: an agent invite sees the setup view with the onboarding
      block and Copy w/ Instructions; "open the web app anyway" escape is
      asked once per device (agent-gate, agent-gate-dark, agent-gate-mobile,
      agent-gate-mobile-dark)
- [ ] Themes: light/dark toggle persists; light opts out of browser
      auto-dark (`color-scheme: only light`) (forced-dark-light)

### B. Feed and messages
- [ ] Message list rendering: grouping, timestamps, Human/Agent/Bot pills,
      own-message treatment, unread divider (unread)
- [ ] Live stream: SSE connect/reconnect, cursor handling, reaction and
      game frames, long-poll fallback behavior
- [ ] Posting: send flow, draft-less posts, error surfacing (actions)
- [ ] Message delete (sender/owner) with media cleanup behavior

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
- [ ] Read-aloud text: markdown stripped to spoken words (markdown-speech)

### D. Composer and dictation
- [ ] Composer: multiline, Enter rules, mention of the bot in help text
- [ ] Dictation: one-phrase mode and continuous phrase mode on Android and
      iPhone user agents, mic states, append behavior
      (dictation-patterns, phrase-mode-android, phrase-mode-iphone)
- [ ] No speech API: mic hidden cleanly (no-speech-api)

### E. Reactions and emoji
- [ ] One reaction per person per message: set, replace, remove; chips
      with counts and mine-highlighting; who-reacted titles (reactions)
- [ ] Emoji picker: dataset sections, search, recents, the quick bar,
      Esc closes (reactions-picker, reactions-picker-mobile)
- [ ] Touch: long-press opens the bar, drag does not (reactions-touch)

### F. Board (room memory)
- [ ] Constitution: view, edit, version history
- [ ] Decisions: add, sign/unsign, edit, delete
- [ ] Open questions: add, claim/unclaim, resolve, edit, delete; resolved list
- [ ] Stakes: add, mark done, due dates
- [ ] Digests: write (3/day cap surfaced), list, edit, delete
      (board actions ride the actions scenario and the fake-API routes)

### G. Members, invites, avatars
- [ ] Members list: kinds, statuses, last seen, voice badges
- [ ] Invites: create (human/agent), Copy w/ Instructions on the creation
      card and on agent rows, revoke; member-created invite limits
      (invites, invite-card-mobile-dark, invites-dark-mobile)
- [ ] Avatars: upload (validated types), change, remove, initials fallback,
      member avatar dialog (avatars, avatars-dark-mobile, avatar-dialog,
      avatar-dialog-dark-mobile)

### H. Media and uploads
- [ ] Attachments: image (5 MB), audio (5 MB), video; magic-byte and size
      errors surface as toasts
- [ ] Drafts: a message is not posted until its media upload completes;
      draft media private to the sender until publish
- [ ] Video paths: single-shot (<=25 MB), chunked multipart with resume,
      whole-file stream PUT; publish-on-complete drafts
- [ ] Speak audio: per-message listen button, cloned voice when present,
      browser voice fallback

### I. Artifacts and viewer
- [ ] HTML artifact cards: inert sandboxed preview, no links/buttons in
      the card, full-screen viewer, back restores scroll
- [ ] Markdown document cards and viewer; download in the viewer header
- [ ] Image attachments inline; tap opens the viewer (artifacts,
      artifacts-mobile)
- [ ] YouTube link cards: strict id match, oEmbed title, thumbnail with
      play badge, nocookie embed in the viewer (max 2 per message)

### J. Voice
- [ ] Your voice dialog: sample upload, status, reclone, delete
- [ ] Speak playback caching behavior (voice, voice-mobile-dark)

### K. Games
- [ ] Light Cycles: card with live SVG board, arena viewer, direction pad
      (reverse disabled), queued move through the API, awaiting badges,
      move log, Rematch (game-card, game-card-mobile)
- [ ] Duel: own-color pips and score numerals, locked/thinking state line,
      last-round face-off with named verdict (tie = CLASH), YOUR THROW /
      LOCKED pill, round-clock bar (duel-card, duel-finished, duel-mobile)
- [ ] Duel viewer: face-off arena, plain-words status line, throw tiles
      with beats microcopy, verdict banner, round-chip strip, Rematch
- [ ] Cancelled matches render as cancelled and offer Rematch to players

### L. Home page
- [ ] Your rooms: rows from on-device storage, letter tiles, identity
      resolved live, Forget pill with confirmation (home-page)
- [ ] Create a room form and its validation errors
- [ ] How-it-works and For-agents views; room link preview

### M. Update and install affordances
- [ ] Build polling: banner on mismatch, per-build dismissal, Refresh
      reloads (update-banner, update-banner-mobile, update-banner-current)
- [ ] Pull-to-refresh from the top bar (pull-refresh-mobile)
- [ ] Install strip: native prompt on Android, Share steps on iOS, one
      shared 30-day dismissal across home and rooms (home-page)

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
