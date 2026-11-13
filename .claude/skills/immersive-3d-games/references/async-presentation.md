# Async presentation: catch-up, waiting, reveals, spectators, rematch

Read this when you decide what a viewer sees on opening a match that moved
while they were away, how waiting looks, how a simultaneous reveal is
staged, how spectators are framed, or how a match ends. All three games are
asynchronous and often agent-paced (a Light Cycles tick defaults to 120 s, a
Duel round waits up to 180 s, an agent's wake-to-act cycle runs one to two
minutes), so players spend most of a match waiting. Feel lives in the
**arrival**, the **replay of what was missed**, and the **reveal**.

## Contents

1. What the server gives you
2. Replay what the viewer missed
3. Waiting: honest presence and a late fuse
4. Simultaneous reveals: lock, prime, flip, verdict
5. Spectators: director camera, both sides, readouts, ticker
6. Ceremonies, highlights and rematch

## 1. What the server gives you (AGENTS.md, games sections)

- **Light Cycles:** a tick resolves when every living rider moved or the
  clock expired; a miss goes straight; a rider carried by the clock three
  ticks running is taken out (absence rule). The full state carries
  `move_log` (per tick and rider: direction, source `(submitted)` /
  `(clock default)`, `pending_at`, resolution time), `awaiting`, and running
  `moves` totals. Several deaths on one tick credit nobody.
- **Duel:** rounds resolve the moment both throws are in; throws are
  **secret until resolution** (summaries and frames carry only `thrown`
  booleans); resolved throws and arrival times become public in `rounds`.
  A lone throw wins its round by forfeit at the deadline; a fully unthrown
  round ends the match (round 1: called off).
- **Battleship:** turn-based; an untrimmed, timestamped `shots` array;
  `last_move`. `BsArena3D.tsx` replays a shot animation from `last_move`
  diffs during an open session, deliberately never on mount.
- **Stream frames** (`event: game`) carry `from`, `kind` and `targets`. In
  simultaneous games every submitted move sends its own frame (`from` the
  mover, `targets` who still owes) and the frame that opens the next round
  or tick, or ends the match, speaks as the `Referee`. That is your signal
  for "X locked in" versus "the reveal is ready".
- **Rematch:** one tap, same game, players and settings
  (`rematchRow`/`sendRematch`). The games list carries a per-game-type room
  `record` of all-time wins and losses per player (`listGames` in
  `src/worker.js`); a pairwise head-to-head is not there yet.

## 2. Replay what the viewer missed

The strongest pattern replays what happened while the viewer was away,
compressed and in order, then hands over control. Draw Something replays the
partner's drawing stroke by stroke with the pauses cut
([Wikipedia](https://wikipedia.com/wiki/Draw_Something)); Frozen Synapse
Prime runs five seconds of simultaneous action and then replays the kills
([Softpedia](https://www.softpedia.com/reviews/games/pc/Frozen-Synapse-Prime-Review-472808.shtml)).
Where games skip it, players complain: the last move is hard to see on
Lichess correspondence
([forum](https://lichess.org/forum/lichess-feedback/are-notifications-possible-in-correspondence-chess)),
and BGA users ask for last-move highlights because "it can be hard to figure
out what your opponent just did" ([BGA](https://uk.boardgamearena.com/bug?id=14183)).

- **Client-side catch-up needs one addition:** a per-viewer "last seen
  event" marker in localStorage keyed by game id (try/catch). Everything
  else is in the logs above.
- **Scale the replay to what was missed:** Battleship plays each missed shot
  in full; Light Cycles fast-forwards missed ticks (~3–4×) with slow motion
  only on crashes and near-misses (Frozen Synapse's kills-only replay); the
  Duel plays only the last round's reveal, then the score line.
- Cap the whole catch-up at a few seconds with a visible **Skip**.
- Leave a **resting marker** (the last shot's cell glowing, the rival's last
  trail segment brighter), then land on a clear "your move".
- **Open on the current threat,** Into-the-Breach style ("literally show the
  player what the enemy will do next",
  [Game Developer](https://gamedeveloper.com/game-platforms/road-to-the-igf-subset-games-i-into-the-breach-i-)):
  your damaged ships in Battleship; where each cycle will go next tick.
- If the viewer missed their **own** loss (their ship sunk, their rider
  derezzed), the catch-up replays it with the full viewer-loss treatment
  (`game-feel.md` §4) on the first viewing; a buzz needs prior sticky
  activation, which an arena opened by a tap already has.
- Notification and ticker copy says what happened: "B7: hit. Your move."
  Lichess users valued pushes that show the move.
- Because beats are functions of `juice.t − start` (see `r3f-techniques.md`
  §2), live play, catch-up, spectating and the end-of-match replay share
  one code path.

## 3. Waiting: honest presence and a late fuse

- Hearthstone's rope appears with ~20 s left of a 75 s turn; idling a whole
  turn earns a ~7 s fuse next time; deliberate roping is a known irritant
  ([Out of Games](https://outof.games/realms/hearthstone/guides/553-hearthstone-why-do-people-rope-explained/)).
  Showing which cards an opponent hovers "add[s] life to the game"
  ([MOOgiwara #49](https://www.github.com/BAA-Studios/MOOgiwara/issues/49)).
  Backstabbr fast-adjudicates when everyone is ready and puts no-order
  countries into civil disorder ([FAQ](https://backstabbr.com/faq)). Marvel
  Snap removes the wait with simultaneous turns and ~3-minute games
  ([GameSpot](https://www.gamespot.com/articles/marvel-snap-is-a-new-fast-paced-collectible-card-game-from-ex-hearthstone-devs/1100-6503602/)).
- **Presence must be honest** (backed by the server, never a fake
  "thinking…" spinner): lock-in pips from `awaiting`/`targets`; the duel's
  `thrown` booleans (a lock without its content); the absence rule; "waiting
  since 1 m" as calm elapsed time.
- **Burn a visible fuse only in the last 10–25%** of a tick or round clock
  (Hearthstone's ratio). The duel's existing draining clock bar should switch
  to that treatment near its end.
- Keep the arena breathing while the player waits, and give them something
  to do: orbit, inspect the board, replay the last turn.
- Light Cycles and the Duel already resolve the moment everyone has moved
  (Backstabbr's "everyone ready"). Make it a visible beat ("all locked"),
  not a silent jump.

## 4. Simultaneous reveals: lock, prime, flip, verdict

Precedents: Marvel Snap reveals the leading player's cards first, marked by
a glowing name tag that "takes some time to appear"
([GINX](https://www.ginx.tv/en/marvel-snap/reveal-first)), and doubles stakes
on the final turn; WRPSA rules reveal gestures at the same time
([Xataka](https://www.xatakaon.com/magnet/the-rock-paper-scissors-world-cup-actually-exists-its-no-joke));
Alex Kidd's janken bosses were called "essentially random" without an item
that shows the rival's thought
([Nintendo Wire](https://nintendowire.com/reviews/alex-kidd-in-miracle-world-dx/)).

The RPS reveal script:

1. **Lock.** Each commit shows only a sealed token (a glowing clenched fist)
   the moment `thrown` turns true; the arena lights flick toward that side.
2. **Prime.** When both are locked, a four-beat chant at 100–120 BPM, a
   fist-pump squash and a drum on each beat, ambient ducked.
3. **Flip.** Both throws flip on the same frame.
4. **Hold** 300–500 ms of silence.
5. **Clash** with squash/stretch, a flash and a burst in the winner's colour.
6. **Verdict:** a named line (the duel UI already says "Scissors cut paper ·
   X takes it"); a tie gets its own CLASH "again!" beat.

- **The HUD must not spoil the reveal:** update the 2D scoreboard and round
  chips on the impact frame, not when the server frame arrives. Input for the
  next round stays open throughout.
- At match point the reveal lengthens and staggers, lights darken, the
  heartbeat quickens; the final round gets a FINISH treatment.
- **Keep throws secret from spectators too.** Dramatic irony would need the
  server to stop hiding throws, and a chat room makes leaking trivial.
- **Light Cycles ticks** are mini Frozen Synapse turns: lock pips, then all
  new trail segments advance together as one short sprint (0.5–0.8 s on the
  juice clock), then an instant closer-camera slow-motion replay of any
  crash before the derez. Several deaths on one tick play in sequence.

## 5. Spectators: director camera, both sides, readouts, ticker

Dota 2's Directed Camera "anticipates what is about to happen"; clicking a
hero follows it, and the camera returns to directed mode after a delay
([Game Informer](https://gameinformer.com/games/dota_2/b/pc/archive/2011/10/06/a-new-way-to-play-like-the-pros)).
Riot patented a camera that follows "interest values"
([Engadget](https://www.engadget.com/2014-02-06-riot-allegedly-patents-spectator-mode-camera-element.html)).
Clash Royale replays show both sides at slow/normal/fast
([TouchArcade](https://toucharcade.com/2016/01/14/clash-royale-elite-players-head-to-head)).
A chess eval bar shown to an arena crowd drew roars "at every wrong move like
at a boxing match" (Lit & Chess newsletter, 2024 world championship coverage; Norway Chess calls its version the "Magical Bar": [Norway Chess](https://norwaychess.no/spillteori/)),
while other fans find it pulls attention from the board.

| Game | Director rule (rule-based is enough) | Readout (honest, toggleable) |
|---|---|---|
| Battleship | shell in flight, then the hit cell; a sink always wins | ships remaining per side |
| Light Cycles | the rider pair with the smallest gap to a wall, plus any imminent head-on | reachable-area "territory" share |
| Duel | a fixed two-shot | round pips plus streak |

- Tapping a player follows them; return to the director after a few idle
  seconds.
- Spectators see both sides: Battleship shows both grids (the repo's
  spectator view does; phones show one ocean with a swap control).
- **A text ticker** ("Cyan fires at C4: miss", "Round 3: paper covers rock,
  Cyan leads 2-1") in an `aria-live="polite"` region gives agents, chat and
  screen readers the same narrative. `BsArena3D.tsx` already has an `sr-only`
  live region; `ImpactLayer` is `aria-hidden`, so title cards are never the
  only announcement.

## 6. Ceremonies, highlights and rematch

- Replay the **deterministic deciding moment** (final shot, final crash,
  deciding throw), not a clever highlight picker: Call of Duty's final
  killcam was missed enough that players pushed for its return, and its
  algorithmic replacement split opinion
  ([GameSpot](https://www.gamespot.com/articles/call-of-duty-ww2-beta-replaces-match-ending-killca/1100-6452867/);
  [ESTNN](https://estnn.com/cod-final-killcam-to-return-to-black-ops-cold-war)).
- Result card: the replay, a stat line (shots and accuracy; ticks survived
  and moves submitted; throws), the head-to-head, and a big **Rematch** with
  a smaller "Back to chat". Lichess shows a crosstable players enjoy
  "building up" ([forum](https://af.lichess.org/forum/redirect/post/6ye7I3uW))
  and hides Rematch once the opponent leaves; some players resent rematch
  pressure, so keep it an offer, not a modal.
- Show "waiting for opponent to accept" with the same presence states as the
  game; agents may accept automatically if their policy allows.
- Persist per-pair records and show them on the VS card before the match as
  well as after; a rivalry gets the heavier intro.
- Keep loops short for "one more": best-of-3/5 duels, short Light Cycles
  rounds. Battleship is long; a quick-board variant suits rematches.
- Defeat ceremonies are quick (no long losing animation), but when the
  viewer lost, the moment itself already landed with buzz, shake and a
  title card: see `game-feel.md` §4.
