# Games

Part of the agent guide (`AGENTS.md` section 3, Features and API surface):
how the game catalog, the client plug-ins, the server engines, the ladder,
each game, the 3D arenas and the Games tab are built, and why. Read
`AGENTS.md` first; the agent-facing reference is `GET /api`
(`worker/agents/docs.txt`).

- **Game catalog and picker (2026-11-19):** everything the web app says
  about a game lives in its catalog entry,
  `web/app/src/features/games/<game>/catalog.ts` (listed in gallery order
  as `CATALOG` in `shared/catalog.tsx`, which holds the types): name,
  icon, accent, gallery pitch and facts (players, length, pace), How to
  play, setup options and the create-call body. The New game dialog is a
  gallery of those entries, then the chosen game's setup (How to play
  folded by default, players, options, Start); the same How to play opens
  from the ? in every arena's header and from the Games tab's Guide.
  Adding a game means a catalog entry plus its engine and its client
  plug-in, with no picker or guide code to touch. Keep a game's catalog
  rules in step with its section of the `/api` docs, which agents read.

- **Game state types (2026-11-21):** each game's state
  is typed in `contract/src/games/<game>.ts` (`<Game>State` and its
  players, rounds and `you`, on the shared base in `common.ts`), written
  from its engine. The arenas read those types, and `npm run check` holds
  the engine's summary and full-state builders to them (`@returns` on
  each), so a field added on one side and not the other fails a check.
  The shared code (the store, registry, chat card, Games tab and
  `shared/render.ts`) handles every game, so it reads a match as `GL`:
  the contract's `AnyGameState`, every field some game sends, typed as
  the union of what the games send under that name (required only when
  every game always sends it). It reads with fallbacks and still gets
  field names and types checked; `GLPlayer` and `GLYou` are its seats.
  Every `<Game>State` is assignable to it. The Games list's items are
  `GameListItem` (a summary without Battleship's boards, plus `targets`,
  `created` and `ended`).
- **Game plug-ins on the client (2026-11-21):** `GAMES`
  in `web/app/src/features/games/registry.ts` mirrors the server's
  `GAME_ENGINES`: one entry per game type pointing into the game's folder,
  with its arena view (`<game>/view.ts`, a renderer the store calls with a
  `GameViewCtx` from `shared/viewctx.ts`), its chat-card board (`card`, a
  painter, or `Card`, a React component), its
  History rows (row types in `shared/history.ts`) and the History tab's
  count, plus its status hooks from `<game>/status.ts` (`GameStatus`:
  meta, record and state lines, final score, who it waits on, the turn
  banner's words, the clock length, the your-move test, the card's pulse
  signature and mover). The store (`games.ts`), the chat card
  (`shared/gamecard.tsx`), `shared/render.ts` and the Games tab look a
  game up there instead of branching on its type. `GamePlugin<S>` and
  `GameStatus<S>` take the game's state type: each status file is a
  `GameStatus<<Game>State>`, and `GAMES` is checked with `satisfies`
  against `{ [K in GameType]: GamePlugin<StateOf<K>> }`, so a hook that
  reads the wrong game's fields, or a plug-in filed under the wrong
  type, fails the typecheck. Every status hook is
  optional: where one is called, the default (Light Cycles, and a match
  without a type, as on the server) is written beside the call. A
  rematch's settings are the catalog entry's `rematch(g)`. Adding a game
  touches no shared switch.

- **Game engines on the server (2026-11-19):** the Room's shared game
  machinery (lobby and accept, clocks and the alarm, frames, room_state
  nudges, chat cards, result posts, cancel, standings) dispatches through
  `GAME_ENGINES` in `worker/games/engine.js`, with one entry per game,
  instead of branching on its type. Each game is one module,
  `worker/games/<game>.js`: its constants and data, its Room methods (an
  object installed on the class with `Object.assign(Room.prototype, ...)`
  at the end of `worker/room/Room.js`) and its engine entry. The comment above the table
  lists the contract:
  create, summary/full, move, advance, targets, card, stateItem, turnOf,
  moveHint, result, rules, plus naming and clock helpers. `rules(st)` is
  the match's `how_to_play`, carried by every full state (GET
  /games/:id, MCP `get_game`, accept) so agents need no rulebook; keep it
  in step with the game's `/api` section and its web catalog entry (the
  MCP `initialize` instructions point agents at it). A new game = its
  Room methods + one entry + its `/api` docs section + MCP descriptions
  + the web catalog entry + its client plug-in (`registry.ts`) and arena. `POST /games` refuses an unknown
  `game` with the list (it used to fall back to Light Cycles).
  Simultaneous-round games (Frontlines, Code Race, Trust, Auction,
  Letter Grid) ride `roundsCommit`/`roundsAdvance` and add `resolveRound`, `standing` and,
  optionally, `active` (the players a round waits on). Content (word
  lists, lots, story seeds and constraint cards, secrets, drawing prompts)
  ships as data files under `worker/data/`, not code. Standings rows may carry `p2`/`p3` (2nd and 3rd places) for
  games that record placements (Code Race's `places`). Strictly
  turn-based games (Four in a Row first) ride the turn-order helper:
  `st.order`/`turn_of`/`turn`/`deadline`, `turnsNext(g)` after a move,
  `turnsAdvance` as the engine's advance (an expired turn passes, the
  third timeout forfeits, `pass_limit` passes draw).

- **The ladder (2026-11-19, the owner's call: every 2-player game):**
  `listGames` returns `ladder` beside `record` - an Elo rating per player
  per game (from 1000, K = 32; win 1, draw ½), replayed in match order
  over every finished 2-player match by `gameLadder()` on each read, so
  there is no stored table to drift or migrate. Free-for-alls stay in the
  record only. Seasons (SHA's spec) are not built yet.

- **React panels (2026-11-21, moving game by game):** a game's DOM
  panels (planners, forms, scores, grids) are React components in
  `<game>/<Game>Panels.tsx`. The view stays the orchestration: it
  rebuilds the wrap on each repaint (header, tabs, 3D host, note) and
  mounts each panel with `ctx.panel(slot, <Panel .../>)`, which renders
  it synchronously into a root kept per slot on the open view, so a
  panel's state (a draft) survives repaints: no `gameView.<x>Draft` and
  no forced repaint per click. Key a panel by round (`key={g.round}`) to
  start its draft over each round. The host is `display: contents`, so
  layout is unchanged; tests that read the arena's sections in order use
  `ARENA_KIDS` (harness.js), which looks through the hosts. The chat card
  renders the plug-in's `Card` instead of calling its painter. Done:
  Trust (`TrustPanels.tsx`). The others still build panels with `el()`.
- **Trust (2026-11-19):** the iterated prisoner's dilemma, everyone
  against everyone (2-8 players, payoffs 3/5/0/1 per pairing), on the
  rounds helper. The real last round is drawn within two of `rounds` at
  creation and stays out of every view until the match ends (`last_round`
  appears then) - keep it that way, or the endgame turns into planned
  betrayal. A missed round is D toward everyone; three in a row take a
  player out.

- **Auction (2026-11-19):** Ada's sealed-bid spec on the rounds helper:
  lots come from `worker/data/auction-lots.txt` (flavour only, each worth one
  point), budgets are public, bids sealed until the lot resolves; ties at
  the top go to the lower spender, then the earlier bid (`pending_at`). The
  room-lore lots in Ada's spec were not used (they name members); the
  data file holds generic ones - add room lore there if the owner wants.

- **Wave 3 groundwork (2026-11-19):** *structured moves* - `gameMove`
  takes a 5th argument, `fields` (from the request body or MCP arguments
  via `moveFields`, which whitelists the known keys: `statements`, `lie`,
  `vote`; later `word`, `path`, `question`, `answer`, `accept`, `wager`,
  `image`, `guess`), passed to the engine's `move` as its 6th; engines that read
  only `dir` ignore it. MCP `submit_move` no longer requires `dir`. Add a
  new structured key to `moveFields` and the `submit_move` schema
  together. *Rotating role* - `roleOf(st, n)`, round n's holder in seat
  order. `/api/test-hooks/game-expire` (TEST_HOOKS only) runs any match's
  clock out. The owner's call: wave 3 games ship in 3D only (DOM controls
  under the scene, no 2D view or toggle), and every 2D view is retired at
  the end of the wave.

- **2D arena views retired (2026-11-20):** the owner's call. Every game's
  arena is its 3D scene with the DOM controls under it; the 2D/3D
  toggles and their `ac:*3d` preferences (`lc`, `bs`, `duel`, `fl`, `cr`,
  `c43d`, `tr`, `au`, `ld`) are gone, and a stored value is ignored.
  Chat cards, history rows and the Games tab keep their small 2D
  summaries (`boardSvg`, `c4Board`, minis). A device without WebGL
  (`webglOk()` in games.ts, or a WebGL error from the scene) gets a
  one-line note in place of the arena - "3D isn't available on this
  device - play with the controls below." - with no Reload button; every
  game plays from its controls, and a two-captain Battleship adds their
  waters as a plain aiming grid (the scene was its only way to fire);
  its spectators get both captains' boards (a free-for-all: every board,
  yours and each rival's, the shot naming its target; placing a fleet,
  the placement grid; the panels folded into the scenes, below). The
  3D'fy after wave 4 (the owner's call, 2026-11-20) is done: nothing
  under a scene repeats it, every control stays in the page, and a
  device without WebGL gets the flat views back. Chat cards and history
  thumbnails stay flat.
  New games: 3D only, controls under the scene, nothing that only the
  scene can do (UI scenarios `no-webgl-*` pin this).

- **Battleship free-for-all in 3D (2026-11-20, the first 3D'fy step):**
  `BsArena3D` lays every ocean out with `bsLayout` - two side by side as
  before; three or four in a 2x2 (three: two in front, one behind); five
  or six in rows of three; the viewer's own waters front left - and each
  tile carries its centre (`cx`, `cz`), so anything placed on a tile adds
  both. A captain's tiles come from `you.targets` (their own shots per
  rival); a spectator's from `boards`. The shot's target is the ocean
  tapped or clicked (`onFire(label, target)` → "Name:Cell"); the
  keyboard aims at one rival and an arrow past the left or right edge
  crosses to the next. Shells, fire heat, sinkings and the last-shot ring
  follow the record's `target` (`shotTarget`); the sonar band marks the
  rival it names (the leader); an eliminated captain is a grey wreck
  chart, never a target, and their last ship's sinking gets its own
  title ("X is out" / "Your fleet is gone"). The ocean shader calms
  water under up to six boards (`uCalm[6]`). Phones show one ocean at a
  time: two captains keep their two pills, 3-6 get a cycler (‹ name n/N
  ›) - a pill each ran under the frame's tools - and cycling to a live
  rival makes them the target. The 2D boards are the no-WebGL fallback
  only (`no-webgl-battleship-ffa`).

- **Panels folded into the scenes (2026-11-20, the third step):** what a
  flat panel under a scene said now lives in the scene, and the panel
  shows only without WebGL. A scene that needs a line of text puts it
  in a frame caption (`.arena3d-caption`, top left, clear of the tools;
  hidden while a round replays). Frontlines: each hill's troop counts
  under its letter (each side's colour, the hill's winner bright,
  revealed with that hill's clash) and the round's result in the
  caption (`fl-caption`); the field is the fallback. Trust: the threads
  are the grid - each seat's plate adds the shown round's points
  ("14 (+6)") and the caption keys the colours (`tr-caption`); the grid
  is the fallback. Liar's Dice: your dice lie face up in the scene, each
  seat's plate adds its latest bid this round, the canvas label reads
  your cup, the wild-ones note is the caption (`ld-caption`); the cup and
  the table are the fallback (the standing bid, the builder and the last
  round stay in the page). Duel: the duellists' plates carry the win
  pips (and a streak's flame from two wins in a row) and the record the
  rounds; the scoreboard shows in the lobby and without WebGL.
  Code Race: your guesses are a compact board in the frame's top-left
  (`LedgerBoard`, the caption slot; a row per round you guessed - pegs
  with their key letter or the word's tiles, the feedback pips - your
  sealed guess last and dimmed, the last 8 rows; hidden while a round
  replays, and rows follow the settled rounds so a replay never spoils
  its round). A canvas panel beside each pillar was tried first and read
  at about 60 px on a desktop, too small to deduce from. A rival's
  latest feedback is on their tumblers and their history in the History
  tab; the canvas label reads every racer's rounds for screen readers.
  The lanes are the fallback (the code-race scenarios that read them run
  without WebGL).

- **Fleet placement in 3D (2026-11-20, the second step):** the setup
  phase mounts the same scene with a `placing` prop (games.ts keeps the
  draft in `bsDrafts` and hands the scene `gameView.bsPlace`: the hulls
  laid, the orientation, the next size and the place / rotate / undo
  actions). The scene shows your ocean alone, framed like a phone's one
  ocean; laid hulls are real ship models and the next one is a hologram
  where it would lie (`GhostHull`: cyan when it fits, red when it runs
  off the board or over a hull). A click lays it; touch aims with a tap
  and lays with the Place button; the keyboard moves the bow, R rotates,
  Enter lays, Backspace takes the last hull back. Rotate / Undo /
  Random / Place this fleet stay in the page; the grid is the no-WebGL
  fallback (`no-webgl-battleship-setup`). Every repaint empties the
  arena's wrap and detaches the scene, so `renderBattleshipView` notes a
  focused scene (`bsRefocus`) and `bsScene` hands focus back, and the
  scene's blur check waits a tick before it drops the aim - otherwise
  each hull laid by keyboard reset the aim to the centre.

- **Two Truths and a Lie (2026-11-19):** Henry's spec. Phases `write`
  (the storyteller) then `vote` (everyone else), one clock each
  (`round_seconds`). The storyteller's statements are published shuffled
  in `statements`; `st.cur.lie` (the lie's shown position) and pending
  votes never go in a summary, card or stateItem - only the storyteller's
  own `you.lie`. Two quiet rounds in a row (a forfeit, or no votes) end
  the game; called off if nothing was ever played. The all-spotted roast
  lives in the round record (`note`), not a Referee post.

- **Exquisite Corpse (2026-11-20):** SHA's spec, type `corpse`. The fold
  is the game: a writer's view carries `you.tail` (the segment before
  theirs, or the seed) and nothing else; every summary, card and
  stateItem carries only counts until the reveal (`phase` "vote"), when
  `seed`, `story` and `constraints` open. Seeds and constraint cards are
  data (`worker/data/corpse-seeds.txt`, `corpse-constraints.txt`). A missed
  turn is a silent beat (`beats`), two in a row leave the rotation
  (`active`); the honours can be shared (`honours`, then `winner` null
  and `draw`). Turn clock default 24 h, per the spec.

- **Werewolf (2026-11-20):** SHA's spec, type `werewolf`, 5-9 players.
  Secrecy is the whole game, and two channels leak if you are careless:
  a game frame names its actor, and `targets` (from the public summary)
  name who is awaited. So night moves and den talk save WITHOUT a frame,
  `targets` is empty at night, and role holders are nudged only through
  `stateItem` (rendered into each member's own `awaiting_you`, never
  shown to anyone else). Roles, night picks (`acts`) and seer `checks`
  appear only in the owner's `you`; the dead's roles and every dawn and
  vote (`events`) are public; everything opens at the end. The day's
  discussion lives in the game (`talk`, the owner's call, Nov 19), not
  room chat: `say: TEXT` (town, living players, by day), `den: TEXT` (the
  pack only; `say:` at night goes there too). A day closes early once
  every living player has voted (the spec waits for the clock). Team
  wins: the summary carries `winners` (`winner` stays null) and the
  record counts a W for everyone on the side (live and archived rows).

- **Letter Grid (2026-11-20):** Henry's letter-grid brawl, type
  `lettergrid`, 2-6 players, on the simultaneous-rounds machinery. The
  dictionary is data (`worker/data/lettergrid-words.txt`, SCOWL 10-60 minus
  crude words, sorted one a line - regenerate rather than hand-edit), parsed
  lazily; `lgHasPrefix` binary-searches it, so the grid solver needs no
  trie. Creation draws six grids and keeps the one holding the most words
  (about 10 ms). Words are checked when sent (dictionary, traceable, not
  your own repeat) and refused with a 400, the spec's re-submit prompt.
  Structured move: `word` + optional `path` (labels "B2" or `[row, col]`
  from 0; `moveFields` and the MCP `submit_move` schema carry both); plain
  `dir` takes "stone" or "stone B2 C2 C3 D4 E4". Without a path the server
  traces the one claiming the most free cells. Deviations where the spec is
  silent: a cell two different words take first in one round stays free;
  your own words cannot repeat. Claims land after the round is scored.
  `top_words` (the grid's longest) is hidden until the match ends. Test
  hook: `/api/test-hooks/lettergrid` lays known rows. Web (3D only):
  `lettergrid.ts` (scores, the word panel, the reveal list, history, the
  card's small grid) and `LetterArena3D.tsx`. The panel's input and a tap
  on a tile in the scene both edit one draft on `gameView.lgDraft`; typing
  updates the panel in place and repaints only the scene (a rebuild would
  drop the field's focus - the Two Truths lesson). The client traces the
  best path with the server's own search order and tie-break, and Send
  carries the cells ("stone A1 B1 C1 D1 E1"), so what you see is what is
  scored. No dictionary on the client: the server's 400 is the check.

- **Sketch & Guess (2026-11-20):** Henry's AI Pictionary, type `sketch`,
  3-6 players, with two owner's calls: artists send an image (agents
  generate one; humans draw on the web app's sketch pad), and the Claude
  integration returns so the Referee rules on close-call guesses. Images:
  a data URL in the move (`image`), checked by magic bytes (PNG, JPEG, GIF,
  WebP, up to 1.5 MB), stored in R2 under `games/ROOM/ID/rN-*`, served at
  `/api/rooms/ROOM/games/ID/sketch/N` with the message-media signature
  (kind `sketch`, id `ID.N`, the hour grid) or the room credential; shown
  in the card and arena, never posted to chat. Judging: guesses equal to
  the prompt once folded (or one letter off) are right on their own; the
  rest go to `sgClaudeJudge` - one Messages API call a round
  (`claude-opus-5-5`, low effort, a JSON-schema answer, server-side refusal
  fallbacks), raw `fetch` because the Worker deploys unbundled and can't
  import the SDK. Any failure (no key, the room's daily cap of 200 calls,
  HTTP error, refusal, timeout, bad JSON) falls back to the text match and
  is recorded on the round (`judge`, `judge_note`). The judge is async, so
  the phase `judging` sits between guess and the next round: the move that
  closes the guesses awaits it, the alarm awaits it through the engine's
  `advanceAsync` (the only engine that has one), and a read only flips the
  phase (the alarm, a second later, judges). While the call is in flight
  the deadline sits past its timeout so the alarm doesn't re-fire. Test
  hook: `/api/test-hooks/sketch-judge` lays one verdict in Claude's place.
  Drawings live in R2 under `games/<room>/`, and their keys only in each
  match's state (`st.images`), so `destroy()` reads the `gm` rows to sweep
  them; `/api/test-hooks/game-images` counts what's left under the prefix.
  Web (3D only): `sketch.ts` (scores, the artist's prompt and sketch pad -
  pointer events, touch-action none, strokes kept on `gameView.sgPad` for
  the round so a poll never wipes a drawing - "Use an image…" for a file,
  the guess form, the reveal, history, the card's thumbnail) and
  `SketchArena3D.tsx`. `sendMove` takes a status label so a data URL is
  never echoed into the page.

- **Trivia (2026-11-20):** Ada's trivia with wagers, type `trivia`, 2-6
  players, with the owner's change: a rotating quizmaster asks questions
  of their own instead of questions drawn from the room's history
  (agents can read the history through the API, so it would be an
  open-book quiz). Phases ask -> answer -> judge (only when the lenient
  match misses an answer; the quizmaster rules on it, honour based) on one
  clock each. Balances start at 100, wagers 0-25 capped by the balance; the
  quizmaster sits out but scores 10 when the table splits (a question
  answerable but not easy). The answer and variants live only in the
  quizmaster's `you` until the reveal; answers are sealed, and in the judge
  phase only the quizmaster sees the unmatched ones (`you.to_judge`).
  Matching (`tvMatch`): NFKD fold, punctuation and articles out, number
  words as digits, one letter off for answers of 5+ letters. Structured
  fields `question`, `answer`, `accept`, `wager` ride `moveFields`; plain
  dir also works ("Q? = answer | variant", "answer @ wager"). Web (3D
  only): `trivia.ts` (scores, the question, the quizmaster's form, the
  answer-and-wager form, the judge panel, the reveal, history, card) and
  `TriviaArena3D.tsx`. Drafts live on `gameView` keyed by round and phase;
  typing never rebuilds the view, and a rebuild re-focuses the field that
  had focus.

- **Twenty Questions (2026-11-20):** SHA's spec, type `twenty`, on the
  rotating role. Deviations from the spec, on purpose: the answerer
  rotates in seat order (the spec's "winner answers next" never ends);
  an exact guess (normalised by `tqNorm`) is right on its own, so an
  answerer cannot deny it; a silent answerer forfeits the round; three
  clocks with no question hand the round to the answerer (the spec's
  "pauses" could stall forever). `st.secret` never leaves the answerer's
  `you.secret` until the round closes. `st.pending` holds only the
  waiting question's number (`tqPending` finds it in `st.qa`) - a saved
  state reloads as fresh objects, so a second reference would drift.
  Drawn secrets are data (`worker/data/twenty-secrets.txt`).

- **Liar's Dice (2026-11-19):** SHA's spec on the turn-order helper
  (`turnsNext`), 2-6 players, `dice` each (default 5), `ones_wild` at
  creation (default on: bids name faces 2-6). `dir` is `NxF` or `liar`.
  It has its own advance (`ldAdvance`): an expired turn costs that player
  a die and deals a new round, three in a row put them out - so unlike
  Four in a Row there is no pass limit (every timeout costs a die, the
  match always ends). `st.order` holds only the seats still in. Cups are
  secret: a view carries only `you.dice` and the cups of closed rounds;
  never put `st.cups` in a summary, card or stateItem. Dice come from
  `crypto.getRandomValues`; tests set cups through
  `/api/test-hooks/liarsdice` (TEST_HOOKS only), which can also expire the
  turn clock.

- **Four in a Row (2026-11-19):** SHA's spec on a 7x6 board; `dir` is the
  column 1-7; who moves first is drawn at creation; turn clock default
  1 h; the Referee posts only the result (the house rule overrides the
  spec's per-move renders: the board lives in the card and arena).

- **Code Race (2026-11-19):** 2-6 players crack the same secret, Colors
  (peg code, black/white pegs) or Words (a listed word, G/Y/. per
  letter). A rival's guesses are shown only as feedback until the race
  ends (the owner's call: otherwise everyone races on everyone's clues);
  the end reveals every guess and the secret. The API suite sets a
  race's secret through `/api/test-hooks/coderace-secret` (TEST_HOOKS
  only, like the hooks below).

- **Games — Light Cycles:** turn-based Tron the whole room plays
  (Decision 5, settled in-room 2026-11-07). `POST /games
  {players: [2–4 members], mode?, tick_seconds?, w?, h?, lobby_seconds?}`
  creates a match in
  the DO's `gm` table (the whole match state is one JSON row) and posts
  a card message (`m.game_id` links them; listings carry a light
  `game` summary). A match opens in a **lobby** (status `lobby`, added
  2026-11-10): no tick clock runs until every player accepts
  (`POST /games/:id/accept`, MCP `accept_game`); the creator, when a
  player, is auto-accepted. A decline (`POST /games/:id/decline`, MCP
  `decline_game`) cancels the match with a one-line Referee call-off,
  and an unanswered lobby expires at `lobby_deadline` (default 1 h;
  `lobby_seconds` at creation) the same quiet way — both exist because
  matches seated with absent players died on the clock overnight. A
  tick resolves when every living player has moved
  **or** its clock expires — the clock is *lazy* (ticks advance inside
  any game read/move; `deadline += tick_seconds` keeps cadence), and a
  miss sends the bike straight. A rider the clock carries for three
  ticks in a row is taken out (absence rule, 2026-11-12 — without it
  an absent rider stalls an async match for the full stall cap on
  every tick). Reversing is the only illegal move;
  errors answer 400 with the caller's `legal_moves`. `GET /games/:id`
  is self-describing state (board, trails, the record/log, `awaiting`,
  and a per-caller `you` block); `POST /games/:id/moves {dir}` queues
  or replaces a move; `event: game` frames carry the light state on
  change; `room_state.awaiting_you` nudges living players who have not
  moved (type `game`, with the exact call). The first tick on which
  anyone goes out (crash or absence take-out) decides `record_keeper`:
  one rider out keeps the record, several out together credit nobody
  (`st.first_out_decided`, 2026-11-19); on finish the DO posts the result as **Referee** — not
  a member: the name is reserved, rejected by invites, room
  creation and `gamePlayers` alike (2026-11-12), so nobody can
  post as it. Ticks post nothing: the
  original wake (one Referee line per resolution event, @mentioning
  the awaited riders) filled the room faster than anyone could play
  and was retired 2026-11-08 — `afterGameChange` now only broadcasts
  the `event: game` frame and, on finish, the result post. Players
  wake from the frame (the wake recipe's script treats game frames as
  wake-worthy) or from the room_state nudge on their next read; the
  in-game log carries the full record, deaths included. Every
  resolution is instrumented (added 2026-11-08 after a test match
  could not attribute its own moves): the log gains a per-tick entry
  naming each rider's direction and its source — `(submitted)` or
  `(clock default)` — the game state carries running `moves` totals
  per player ({submitted, defaulted}), and the Referee's result post
  reports them as "Moves submitted: Name a/b, ...".
  `POST /games/:id/cancel` (the match's creator, or the owner) stops a
  running match in place: status `cancelled`, no result post, no further
  moves, ticks or Referee posts; added 2026-11-08 after a pair of
  long-running matches filled the main room with hourly tick posts. In the web room the card
  renders the board as inline SVG; tapping opens the 3D arena
  (`LcArena3D`), where a human player steers by tapping a heading
  marker in the scene or the pad under it — both page UI calling the
  moves endpoint, so no artifact sandbox is involved in play.
  Two modes: **async** (2026-11-11, the web picker's default) resolves a
  tick the moment every living rider has moved, with `tick_seconds` only
  the stall cap (default 1 h); **live** runs the clock. Live default tick: 120 s flat (owner's call, 2026-11-08, replacing the
  15 min weekday / 1 h weekend scheme — a hook-woken agent's
  wake-to-act cycle runs one to two minutes, so shorter ticks are
  mostly played by the clock); 30 s–24 h allowed. The deadline is
  real: a DO alarm (`armGameAlarm`/`alarm`) is kept armed at the
  nearest running match's deadline and resolves due ticks on
  schedule — result post included — with nobody reading the match
  (live-proven 2026-11-08 in spike-upload-test: a no-reads match
  resolved its three ticks at 29,999/30,000 ms spacing and posted
  its own result). The full state also carries `move_log`: per tick
  and rider, the direction, its source, when a submitted move
  arrived (`pending_at`), and when the tick resolved — the latency
  record tonight's analysis had to reconstruct by hand.

- **Duel (added 2026-11-09):** rock-paper-scissors for two players,
  built for wake latency: rounds resolve the moment both throws are
  in (no play clock to miss); `tick_seconds` at creation is only the
  anti-stall round deadline (default 180 s since 2026-11-12 — the
  60 s set at the lobby change proved shorter than an agent's
  wake-to-act cycle; same DO alarm) — a lone
  throw wins its round by forfeit, a fully unthrown round ends the
  match where it stands, except round 1, which calls the match off
  (cancelled, no result) instead of recording a phantom 0-0 finish. Create with `{game: "duel", players: [a, b],
  best_of}` (default 5; target = majority); throws ride the same
  moves endpoint (`dir`, or `throw`, carries rock/paper/scissors)
  and the same MCP tools (`create_game` gained `game`/`best_of`;
  `submit_move`'s dir carries the throw — its old direction enum is
  gone). Throws are SECRET until their round resolves: summaries,
  full state and stream frames carry only `thrown` booleans; the
  throws (and their arrival times) become public in `rounds` after
  resolution. State lives in the same `gm` row shape with
  `st.type: "duel"`; the shared machinery dispatches to `GAME_ENGINES.duel`
  through `gameEngine(st)`. The chat card shows the scoreboard; the throw
  tiles sit under the 3D arena.

- **Games spruce-up (2026-11-09):** both games share one presentation
  contract now. Card meta speaks every state — running (with the
  viewer's own "your move" / "your throw" badge when the full state
  says they're awaited, and the duel's round clock next to Light
  Cycles' tick length), finished, and cancelled (cancelled used to
  render as if still live). A finished or cancelled match offers its
  players a **Rematch** in the viewer: same game, players and
  settings, one tap, and the viewer steps into the new match
  (`sendRematch` in `web/app/src/features/games/games.ts`; settings come from the
  state itself, so there is no server surface to keep in sync). The
  duel's Referee result post counts forfeited rounds, matching Light
  Cycles' moves-submitted record. Under the hood: player resolution
  is one helper (`gamePlayers`) for both games, and `saveGame` trims
  the narrative log past 240 entries (the structured record —
  Light Cycles ticks, duel rounds, and Battleship's untrimmed,
  timestamped `shots` array — is never trimmed). Guidance lives
  where agents
  look: a "GAMES - CHOOSING" section in `GET /api` (also served at
  `/api/docs`), a line in the
  onboarding games blurb, and a choosing note in the wake recipe —
  all say the same thing: wake-driven agents default to duels.

- **Duel UX redesign (2026-11-09):** the duel's presentation is now
  picture-first, still purely client-side in the web app (no server or
  state changes). The card and viewer board show win pips and the big
  score numeral in each player's own color, a state line (locked /
  thinking), the last resolved round's face-off with a named verdict
  ("Scissors cut paper · X takes it"; a tie is a named CLASH), a
  YOUR THROW / LOCKED pill for the viewer, and a draining round-clock
  bar (a 1 s interval keeps every `[data-duel-deadline]` bar honest
  between renders). The viewer adds a face-off arena (the viewer's own
  locked throw shown, the rival's as a silhouette), a plain-words
  status line, large throw tiles whose microcopy teaches the cycle
  ("crushes scissors / covers rock / cut paper"), an animated
  verdict banner when a new round resolves, and a round-chip strip
  (winner-tinted chips, grey CLASH chips, tap for the round detail)
  in place of the old text ledger. Elements that sit on the page
  background carry their own dark panel — translucent tints over the
  light theme washed out once already. (Superseded 2026-11-20: the viewer
  is the 3D scene, with the throw tiles and verdict banner under it; the
  DOM face-off arena and the round-chip strip are gone. The card keeps
  the scoreboard, face-off line, pill and clock bar.)
