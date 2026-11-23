# Per-game playbooks: every arena

Read this before changing one specific arena or building a new one. Each
playbook gives the look (with the owner's calls), arrival, idle, the event
table from the viewer's seat, async and spectator notes, and repo notes.
`Juice.hit` values use the `Impact` fields (`primitives.md`); buzz values
are `BUZZ` names (`game-feel.md` §5). Every value is a derived starting
point, and each section names the function that holds the shipped ones:
check it before tuning.

## Contents

1. Reading an event from the viewer's seat
2. Battleship
3. Light Cycles
4. RPS Duel
5. Frontlines
6. Code Race
7. Four in a Row
8. Trust
9. The auction
10. Liar's Dice
11. Two Truths and a Lie
12. Exquisite Corpse
13. Twenty Questions
14. Werewolf
15. Letter Grid
16. Trivia
17. Sketch & Guess
18. A new arena

## 1. Reading an event from the viewer's seat

Every event has three possible viewers, and the treatment differs:

| Seat | Treatment |
|---|---|
| **The viewer did it** (your hit, your sink, your winning throw) | the ladder tier as written, triumphant tone (`tone: "good"`), outgoing haptic |
| **It happened to the viewer** (your ship hit or sunk, your rider derezzed, your duel lost) | at least the Large tier, a `"bad"`-tone title, its own haptic: the viewer-loss rule in SKILL.md (the owner's call) |
| **Spectator, or other players' fates** | the ladder tier, neutral tone, no buzz except decisive moments |

Decisive moments (last ship, last rider, match-winning throw) get the
Decisive tier for everyone; the viewer's own decisive loss uses
`BUZZ.lostMatch` and the `lose` stinger, then goes straight to the result
card and Rematch.

### Every arena's defaults

The round arenas (§5–17) share these; each section lists only its
catch-up key and what differs.

| Event (viewer's seat) | Impact |
|---|---|
| you commit (lock in, guess, bid, drop, vote, send) | `lock` + `BUZZ.commit` at the tap (the page's tap reaches the scene through `registerCommit`); your marker lights (a ring, a lantern, a front line) |
| a rival commits (seen live) | a soft `ping`; their marker lights; what they chose stays sealed |
| match won / lost | "VICTORY" good / "DEFEAT" bad: trauma 0.8, stop 250, slow 0.8, `BUZZ.wonMatch` / `BUZZ.lostMatch`, `clash` + `win` / `lose` |
| second of 3+ / a spectator | "#2" neutral (lighter, `BUZZ.scored`, `win`) / "NAME WINS" or "DRAW" neutral |
| after the match title | the winner's `LightPillar` and `Shockwave` |

Some arenas run the match end lighter: each arena's match-end function
holds its values.

- **Catch-up:** the round arenas' rule in `async-presentation.md` §2 (the
  latest unseen round replays on open, a tap skips to the verdict), keyed
  `ac-<key>-seen:<path>:<id>` in localStorage.
- **Reduced motion:** every arena skips the flight and calls `juice.hit` at
  once (a missed round lands at once with its title); title, sound and
  buzz stay.

## 2. Battleship: dusk at sea, where the board is the record

| Aspect | Recommendation |
|---|---|
| Look | dusk: a low setting sun (`SkySpec.moon`), a peach-to-lavender-to-blue sky, light-painted hulls, team-colour rim lights, the grid as thin lines on calm water. **The owner's calls:** keep the ships lit from the player's side and their paint non-metallic; the night version was too dark, and hulls lit from behind read as silhouettes. Its bloom threshold sits below the ≈ 1 rule (its `ArenaPost` props), so pegs and specular bloom: raise it before adding glow |
| Arrival | the shared `Intro` (low on the horizon, hold while the iris opens, crane up to home); a target: rise from the waterline as the sun breaks through the dusk haze, then paint the grid on the sea |
| Idle | travelling waves with hulls riding the same CPU-side swell (`oceanHeight`), sun glitter, crest foam, fires that keep burning on wrecks; an ambient bed (a target): ocean wash (noise with a slow LFO on cutoff) and a foghorn or bell every 20–40 s |
| Shot | reticle tightens, the shell arcs with a falling `whistle` (300–600 ms) |
| Miss | Small tier: band-passed `splash` + "bloop", a flat ring, a persistent peg |
| Hit | Medium tier: core flash, sparks, fire and smoke that keep burning on the cell |
| Sink | Large tier: big ships break in two (clipping planes), cruisers and destroyers capsize, submarines sink to the sail, and the wreck stays burning; a title card names the ship. Nothing auto-marks neighbouring cells |
| Decisive | last ship: slow motion ~0.25×, a push-in, a ring/ShockWave, a stinger, then Reflect. When both fleets are down to one ship, shift the music layer and lighting instead of escalating every shot |
| Async | a target: replay each missed shot in full (today shots animate only while the view is open: `async-presentation.md` §2); open on "your damaged ships" (the current threat) |
| Spectate | both grids; director: shell, then hit cell, then sink; readout: ships remaining |

The Hasbro adaptation was criticised for "not much animation"
([Pure Nintendo](https://purenintendo.com/?p=132307)): the sink is where the
animation budget pays off.

Shipped impacts (`shotImpact` in `BsArena3D.tsx`; check it before tuning):

| Event (seat) | trauma | stop | slow | buzz | sound | title |
|---|---|---|---|---|---|---|
| your miss | 0.06 | 0 | – | – | `splash` | – |
| a miss near your fleet | 0.12 | 0 | – | `nearMiss` | `splash` | – |
| your hit | 0.35 | 100 | – | `scored` | `boom` | – |
| your ship hit (incoming) | 0.45 | 110 | – | `hitYou` (+ red flash) | `boom` | – |
| you sank theirs | 0.6 | 200 | 1 if final | `sankTheirs` (`wonMatch` if final) | `bigboom` | "<ship> sunk" good |
| **your ship sunk** | 0.85 | 240 | 0.8 | `lostOne` (`lostMatch` if final) | `bigboom` | "Your <ship> is down" bad |
| free-for-all: your fleet gone | 0.85 | 260 | 1 | `lostMatch` | `bigboom` | "Your fleet is gone" bad |
| free-for-all: a rival out | 0.55–0.7 | 200–220 | – | `sankTheirs` if you sank them | `bigboom` | "X is out" |

The match end is a separate hit ~2.6 s later: "Victory" / "Fleet lost"
with `win` / `lose`.

Repo notes: a narrow host (or fleet placement) shows one ocean with a swap
control (the enemy's on your turn); a free-for-all lays out 3-6 oceans
with a ‹ name n/N › cycler; placement shows a hologram hull (layout and
placement: docs/agents/games.md). A tap only aims and a **Fire at X**
button fires (`battleship-3d-phone-aim-fire` in
`web/tests/ui/battleship.test.js`); the frame takes keyboard focus and
arrow keys aim. Shots replay from `last_move` diffs while the view is
open, never on mount; under reduced motion a shot lands at once with its
colour change, peg, title and sound.

## 3. Light Cycles: a Tron grid where each tick plays as a sprint

| Aspect | Recommendation |
|---|---|
| Look | **the owner's reference is Tron: Legacy's light cycles:** glossy black shells over wheels that are rings of light, trails as luminous glass walls with a white-hot top edge, a black mirror floor (`MeshReflectorMaterial`, desktop only) under a cell-exact `GridFloor`; each rider's hue from the server plus a DOM name tag (no per-rider trail patterns) |
| Arrival | the shared `Intro` today; a target: from near-black the grid draws outward from the vanishing point, then the walls, then the cycles fill from wireframe to solid, under a synth drone rising with the sweep |
| Idle | data-flow shimmer along grid lines, slow pulses in distant circuit silhouettes, trails humming with a slight flicker, idling cycles; an ambient bed (a target): sub drone, slow arpeggio pad, electrical hum |
| Tick | lock pips from `awaiting` and a fuse ring in the tick's last quarter; a resolved tick rides every cycle into its new cell together (the sprint, on the juice clock), trails pouring out behind, instead of a teleport. Extend one trail segment per straight run, add one only on turns ([BlenderArtists](https://blenderartists.org/t/blender-tron-light-cycle-game/494631)) |
| Near-miss | a head skimming a wall: sparks with `zap` (Medium tier at most; no buzz unless it is the viewer's rider). `whoosh` belongs to the tick sprint |
| Crash | Large tier: the cycle races into what it hit, the camera closes in, slow motion at the impact, then the derez (voxel `Burst`, floor `Shockwave`, a `LightPillar` where the rider fell). The trail stays as a dim scar - the server keeps it as a wall; never collapse it. A head-on gets its own staging; several deaths on one tick play in sequence |
| Decisive | last rider standing: 0.5–1 s slow motion; the winner's trail lights end to end |
| Play aids | the viewer's options float over their cells (a safe chevron, a magenta X for a deadly turn, the queued turn lit; tap to steer); DOM tags over the riders are pushed apart so they never overlap; Zones tints the floor by who reaches each cell first |
| Camera | high three-quarter by default (the arcade framing, [StrategyWiki](https://strategywiki.org/wiki/TRON)): the horizon cannot show without flattening the board, so the world (sky, ridgelines) lives in the entry flight, crash close-ups and the chase camera (a per-rider toggle, [Armagetron](https://armagetron.sourceforge.net/doc/commands.html)); a low angle only for crash replays |
| Replay | a finished match offers ▶ Replay race: the whole match from tick 0 in about 16 s plus its crashes, with no vibration (the viewer asked to watch) |
| Async | the catch-up fast-forwards missed ticks, slowing for crashes (`async-presentation.md` §2; `seenTick` in `lcmodel.ts`); open on where each rider goes next |
| Spectate | director: the pair with the smallest gap to a wall, plus any imminent head-on; readout: territory share |

Speed must come from trails, streaks and the sprint beat: Tron: Evolution's
reviewers praised the "neon lights trailing out from behind"
([Push Square](https://www.pushsquare.com/reviews/2010/12/tron_evolution_ps3))
and panned scripted races with "little sense of speed"
([GameWatcher](https://www.gamewatcher.com/tron-evolution/review)).

Shipped impacts (`crash()`/`finish()` in `LcArena3D.tsx`'s `Director`; the sprint's timings are its constants; buzz never during a replay):

| Event (seat) | trauma | stop | slow | buzz | sound | title |
|---|---|---|---|---|---|---|
| your lock-in | 0 | 0 | – | – | `lock` | – |
| another rider derezzed | 0.45 | 170 | 0.35 | – | `derez` | "<name> derezzed" neutral |
| **your rider derezzed** | 0.9 | 230 | 1 | `lostOne` | `derez` + `lose` | "Derezzed" bad |
| head-on | 0.9 (yours) / 0.6 | 240 | 1 / 0.6 | `lostOne` if yours | `derez` + `lose` / `clash` | "Head-on" (+ white flash) |
| timed out | – | – | – | `lostOne` if yours | – | "Timed out · Three ticks without a move" |
| you win | – | – | – | `wonMatch` | `win` (after 1.5 s if a crash just played) | "Victory · Last rider standing" good |
| a rival wins | – | – | – | `lostMatch` if you just lost | `lose` | "<name> wins · Better luck next race" |
| draw | – | – | – | – | – | "Draw · No rider survived" |

## 4. RPS Duel: a duel scored like music

| Aspect | Recommendation |
|---|---|
| Look | a glass stage in a turning nebula (`DUEL_SKY` swirl); a pedestal and an orb per duellist in their colour that rings when they throw; plates carry the win pips and streak flame; a hologram plaque holds the round record (the pattern record) |
| Arrival | the shared `Intro` today; a target: overhead spotlights snap on one by one with a heavy "clunk", ending on the two pools, and Present follows immediately |
| Waiting | breathing bob, fists slowly priming; a sealed glowing token appears the moment `thrown` turns true and the arena lights flick toward that side; an ambient bed (a target): room tone and a heartbeat pulse that quickens through the count-in |
| Reveal | lock → chant (four beats, 100–120 BPM) → same-frame flip → 300–500 ms hold → clash → named verdict; each throw has its own quantized timbre (rock low drum, paper filtered swoosh, scissors bright stab) and a particle burst in the winner's colour; `charge` under the prime, `clash` on impact |
| Stakes | at match point the reveal lengthens and staggers, lights darken, heartbeat quickens; the final round gets a FINISH treatment; sudden death its own look |
| Async | the catch-up (`ac-duel-seen:`) replays every missed round, earlier ones quickly: `async-presentation.md` §2 |
| Spectate | fixed two-shot; readout: pips plus streak; throws stay secret until the server resolves the round |

RPS is the best fit for the full synesthetic Rez / Tetris Effect treatment:
short, discrete, already musical. Beat-locked pulses at 1–2 Hz keep it
psychedelic without strobing.

Shipped impacts (`Reveal` in `DuelArena3D.tsx`, timed by `planFor()`;
forfeits and catch-up replays run through the same path; the contact sound
is the matchup - snip, wrap, smash + shatter - and `clash` only on a tie):

| Event (seat) | trauma | stop | slow | buzz | sound | title |
|---|---|---|---|---|---|---|
| your throw locked | 0 | 0 | – | `commit` | `lock` (+ pulse 0.2) | – |
| rival locked | 0 | 0 | – | – | `lock` | – |
| round won (yours) | 0.32 | 120 (220 at match point) | 0.9 at match point | `scored` | matchup | "Round n yours" good |
| round lost (yours) | 0.5 (0.7) | 140 (220) | 0.9 at match point | `hitYou` (+ red flash) | matchup | "Round n to X" bad |
| tie | 0.2 | 80 | – | – | `clash` | "Clash" neutral |
| forfeit | – | – | – | – | `buzzer` | "Time!" then the round title |
| match won (yours) | 0.5 | – | – | `wonMatch` | `bigboom` + `win` | "Victory" good |
| **duel lost (yours)** | 1 | 200 | – | `lostMatch` (+ red flash) | `bigboom` + `lose` | "Defeated" bad |

Repo notes: with WebGL the scene carries the score (pips and streak flame
on the plates, the rounds on the plaque); the DOM scoreboard shows only in
the lobby or without WebGL. The round clock sits in the turn banner at the
top; under the scene are the large throw tiles (microcopy teaches the cycle:
"crushes scissors / covers rock / cut paper") and the animated verdict
banner. The page must not update before the 3D reveal lands. Elements that
sit on the page background carry their own dark panel.

## 5. Frontlines: troops over hills at dusk

**World.** Five low hills (A–E) in an arc on a dark plain under a warm
dusk horizon, far ridges and low downs in the haze, each commander's camp
(tents, a few campfires) behind their front line. Lit warm from the
viewer's side so the hills read as shapes. The viewer holds the near side;
a spectator sees the match's order.

**Board.** One unit per 5 troops, in rows of five on each side's slope:
standing units in one glowing instanced draw per side, the losers of a
hill toppled and dim in a second draw (the record a latecomer reads). A
banner on each crest and a ring at each foot in the holder's colour; the
hill letters (and, Valued hills, the points) as canvas sprites. A front
line behind each army breathes while that commander plans and lights
when they commit. A pending split is never drawn.

**Reveal** (`FrontlinesArena3D.tsx`, all on the juice clock): deploy
(0–0.6 s, both armies rise), then hill by hill from 0.95 s every 0.55 s:
both formations push up the slope, the loser's units topple in a `Burst`
of their colour, the banner rises and the ring takes the holder's colour
(a level hill: both fall back, a whoosh, no banner). Verdict at ~3.85 s.
The ring stays grey until its own clash so the outcome is not given away.

| Event (viewer's seat) | Impact |
|---|---|
| each hill resolves | `zap` (`whoosh` if level), trauma 0.08–0.12, stop 30 |
| round won | trauma 0.25, stop 80, `BUZZ.scored`, "ROUND n" good |
| round lost | trauma 0.4, stop 120, `BUZZ.hitYou`, "ROUND n" bad |
| level round | trauma 0.12, "LEVEL" neutral |

Commit marker: your front line; the match's pillar rises behind the
winner's line. Catch-up key `ac-fl-seen`.

## 6. Code Race: the vault

**World.** A violet grid floor running to a striped synthwave sun, and in
the middle distance the vault: a cryptex of rings (one per peg or letter)
on a plinth, above the racers. In front stands one lock pillar per racer
(the viewer's in the middle, nearest; a spectator sees the match's order),
a spine of camera-facing coins with a name plate on the floor.

**Board.** A pillar's coins are that racer's latest feedback, top down:
Colors - a solid white coin per right-place peg, a white ring per
right-colour peg, dim for the rest (shape carries the meaning, not only
brightness); Words - green, amber or dim coins. A rival's pillar shows
only feedback, never their guess, matching the page. The foot ring lights
when a racer has guessed this round, burns once they have cracked it.
The vault's rings stay violet until the race is over, then turn to the
secret (colours, or letters for Words).

**Reveal** (`CodeRaceArena3D.tsx`, on the juice clock): every racer who
guessed spins their coins (0-0.45 s, a `charge`), then coin by coin from
the top they land on their new state with a click (`snip`, the last a
`lock`); a racer who cracked it gets a `LightPillar` and a `Burst` in
their colour; then the verdict. The last round opens the vault (rings
spin up and settle in the secret's colours), then the final title and
the winner's pillar and shockwave. Name plates and rings follow what the
scene shows, never the latest state, so nothing is told early.

| Event (viewer's seat) | Impact |
|---|---|
| a round, nobody cracks it | your feedback as the title ("Closer · 2 right place · 1 right colour" good when it beats your best, with `ping` and a commit buzz; else neutral `beat`); a missed guess `buzzer`, bad |
| you crack it | trauma 0.55, stop 180, `BUZZ.sankTheirs`, `shatter` + `win`, "CRACKED" good |
| a rival cracks it (you haven't) | trauma 0.4, stop 120, `BUZZ.hitYou`, `shatter`, "CRACKED" bad, "keep racing" |
| race end | the defaults, except that cracking it but not first gets "#n" (your place) neutral; nobody cracked it: "THE CODE HOLDS" |

Commit marker: your foot ring. Catch-up key `ac-cr-seen`; under reduced
motion the vault opens without the spin.

## 7. Four in a Row: the glass board

**World.** A tall board of glass rings in a dark frame, standing over a
dark mirror lake, a rose dusk behind (`C4_SKY`). The camera looks
straight through the board's centre (the look-at point is where that
line meets the floor, far behind), slightly from above.

**Board.** Discs are camera-facing coins in the player's colour: X solid,
O with a dark ring (the second channel). Every settled disc is one of two
instanced draws; the latest move falls on the juice clock from above the
board (0.55 s, accelerating) and settles with a small bounce. On your
turn, invisible column hit boxes show a ghost disc over the column under
the pointer and drop on a tap (the page's 1-7 buttons do the same).

| Event (viewer's seat) | Impact |
|---|---|
| the rival's disc lands on your board | trauma 0.12, stop 40, `lock`, `BUZZ.commit` (it's your turn) |
| a disc lands (spectator) | trauma 0.08, `lock` |
| you win / lose | the defaults, after the four glow, a beam runs through them and a burst lands at each |
| a draw | "DRAW" neutral, `whoosh` |

No rival-commit beat: the rival's move is the disc landing. Catch-up key
`ac-c4-seen` (moves, not rounds: the latest unseen move drops in, any
earlier ones are placed at once).

## 8. Trust: the round table

**World.** A dark round table on an open plain under a teal and violet
aurora (`TR_SKY`); each player's seat glows in their colour around it,
the viewer nearest the camera; name plates and scores sit outward from
the table so they never cover the threads. A phone with 7 or 8 seats
(`trHomeCrowded` in `trust/trframe.ts`) looks down steeper and holds every
plate at one size on screen, on a dark pill, fitted whole below the
caption and tools and clear of Move (`tests/unit/trframe.test.mjs`).

**Board.** The last round as a web: every pairing is a chord across the
table in two halves, each the choice one player made toward the other -
teal (trust), red (betrayal), dim red when both defected - all in one
instanced draw. A seat's ring lights when that player has chosen.

**Reveal.** Seats pulse (0.5 s), then pair by pair (spaced to fit ~2.2 s
whatever the table size) both halves grow from the seats and meet: `ping`
for trust kept, `snip` and a red `Burst` for a betrayal, `beat` for mutual
defection. Then scores update and the title lands:

| Event (viewer's seat) | Impact |
|---|---|
| someone betrayed your trust | "BETRAYED by …" bad, trauma 0.4, stop 120, `BUZZ.hitYou`, `tear` |
| all your trust returned | "TRUST HELD" good, `BUZZ.scored`, `win` |
| any other round | "ROUND n · +pts" neutral, `clash` |

Commit marker: your seat. Catch-up key `ac-tr-seen`.

## 9. The auction: the hall

**World.** A dark hall in indigo and gold (`AU_SKY`, a gold horizon
glow): a floor ring, a slim pedestal under a spotlight with a gold trim,
the lot floating above it as a turning gem with its name over it. The
bidders stand on an arc in front of it, the viewer nearest the camera;
each has a plinth with a ring in their colour (lit once they have bid),
a paddle, a column of coins for the budget left (a coin a tenth of the
starting budget, one instanced draw for every stack), a row of small
gems for the lots won, and a name plate. The camera (`auHome`) orbits a
point between the pedestal and the bidders and, for each distance,
centres the content's vertical extent, so the scene fills the frame
instead of sitting low under the sky.

**Bids stay sealed.** Nothing shows a pending bid: only who has bid (the
ring). A resolved lot shows every bid.

**Reveal.** The paddles rise one at a time from the lowest bid to the
highest (`beat` each; a pass stays down), then the gavel: the gem flies
in an arc to the winner's row and their coins drop by the price; an
unsold lot rises and fades. The paddles come down after the title.

| Event (viewer's seat) | Impact |
|---|---|
| you win the lot | "SOLD to you for n" good, `BUZZ.scored`, `smash` + `win`, a gold `Burst` |
| you bid and were outbid | "OUTBID" bad, `BUZZ.hitYou`, `smash` |
| someone else's lot (or you passed) | "SOLD to … for n" neutral, `smash` |
| nobody bid | "UNSOLD" neutral, `whoosh` |
| match end | the defaults; afterwards the winner's ring stays lit and their plate reads "★ winner · n lots" |

Commit marker: your ring. Catch-up key `ac-au-seen` (the latest unseen
lot).

## 10. Liar's Dice: the den

**World.** A round crimson felt table with a wooden rim under one warm
lamp (`LD_SKY`, near black with an amber glow), the room around it dark.
Each seat (turn order, the viewer nearest the camera) has a leather cup
tinted with the player's colour, a ring that pulses on their turn, and a
plate (yours toward the camera, rivals' above their cups). The standing
bid floats over the middle: a big die tipped to face the camera, the
count beside it, the bidder under it; a new bid flips it.

**Secrecy.** A rival's cup never lifts outside a reveal: the server
never sends their dice. Your own cup lies tipped beside your dice, which
sit face up in a row tipped toward the camera - for your eyes only.
Spectators see every cup down.

**Dice.** One instanced draw for every die on the table: a box whose UVs
map into a 3x2 canvas atlas of pips (opposite faces sum to 7), the value
set by rotation (`faceUp`), an optional tilt toward the camera, and a
per-instance tint (hit, dim, wild).

**Reveal.** Every cup slides aside along the table's edge and tips away
(so none stands between the camera and the dice), each seat's dice line
up face up, then the dice that count toward the called face light one at
a time while "n of N" climbs over the bid; at the verdict the count turns
green (the bid stands) or red (a lie), the loser's last die shatters in
their colour, the cups come down and shake for the next roll. A turn
that ran out skips the lift: the die just shatters.

| Event (viewer's seat) | Impact |
|---|---|
| a rival bids | the default `ping`, and the bid die flips |
| your call was right / your bid stood | "LIAR!" / "IT STANDS" good, `BUZZ.scored`, `smash` + `win` |
| you lose a die (wrong call, or caught) | "WRONG CALL" / "CAUGHT" bad, `BUZZ.hitYou`, `smash` + `shatter`; your last die: "OUT", `BUZZ.lostOne` |
| your turn ran out | "TIME" bad, `buzzer` + `shatter` |
| anyone else's round | "LIAR!" / "IT STANDS" / "TIME" neutral |
| match end | the defaults; the table then reads "★ name wins" |

Catch-up key `ac-ld-seen`.

## 11. Two Truths and a Lie: the campfire

**World.** A clearing at night under stars (`TT_SKY`), a campfire in a
ring of stones (`FireSystem` from `fire.tsx`, one fire, kind "ship") with
a warm point light, the players on log seats round it in turn order (the
viewer nearest the camera), each with a lantern in their colour. Three
parchment cards hang over the fire, tipped toward the camera: face down
("?") while the storyteller writes, the statements (wrapped, canvas
textures) once they are up. The storyteller's lantern burns bright with
a beam over a rival's seat - a ring on the ground under your own, so no
beam crosses the fire. Plates: yours toward the camera, rivals' low over
their seats so they never cover the cards.

**Secrecy.** Votes are sealed: a voter's lantern lights when they have
voted, never which card. Only the storyteller's view marks their lie.

**Reveal.** Every vote flies from its seat to its card as an ember (all
together), then the lie card turns orange, curls and burns away with a
`Burst` while the truths glow and read TRUE; the points rise over the
seats on dark pills (readable over a card or the sky).

| Event (viewer's seat) | Impact |
|---|---|
| the statements go up | `whoosh` |
| you spotted the lie | "SPOTTED IT" good, `BUZZ.scored` |
| you were fooled | "FOOLED" bad, `BUZZ.hitYou` |
| your lie fooled someone / nobody | "FOOLED n" good / "BUSTED" bad (with the round's roast) |
| your writing clock ran out | "FORFEIT" bad, `buzzer` |
| anyone else's round | "LIE #n" neutral |

Commit marker: your lantern. Catch-up key `ac-tt-seen`.

## 12. Exquisite Corpse: the writing desk

**World.** A dark study, a wide desk with a green baize top lit by one
candle (`FireSystem`, a tiny "ship" fire on a wax candle, plus a warm
point light). An inkwell and quill per writer along the near edge, in
rotation order: lit and pulsing for the writer now, dark for one out of
the rotation, steady once they have voted. The desk is sized for the
whole story from the start (seed + every turn), so the camera never
re-frames at the reveal.

**The fold.** Before the reveal the story is a pile of folded pages in
the middle - one per written segment, its edge in the author's ink,
faces down. On your turn the top page (your tail) rises off the pile,
enlarged and tipped toward the camera, so the one segment you may read
is legible; nobody else ever sees a face.

**Reveal (the deal).** The pile deals out across the desk page by page
(0.22 s apart), each flipping face up in flight: the seed, then every
segment with "n · Author" in the author's ink. At the end the favourite
votes drop on as gold stars, the honours page gets a gold border and the
winner's pillar.

| Event (viewer's seat) | Impact |
|---|---|
| the story is revealed | "THE STORY" neutral, `whoosh` + `win` |
| your segment takes the honours | "THE HONOURS" (or "SHARED HONOURS") good, `BUZZ.wonMatch` |
| someone else's does | "★ NAME" neutral, `BUZZ.scored` |
| nobody voted | "THE END" neutral |

No VICTORY / DEFEAT: the honours are the match end. Commit marker: your
inkwell. Catch-up key `ac-ec-seen`, holding flags rather than a round:
"r" (the deal seen) and "f" (the honours seen).

## 13. Twenty Questions: the sealed box

**World.** A dark round hall in violet (`TQ_SKY`), a stone dais with a
violet rim, and in the middle a wooden box with glowing gold corner
posts and a lit seam on a pedestal - the secret - with a "?" over it
while the round runs. Twenty candles in a ring round it are the budget.
The players' lanterns stand outside the ring: the answerer's behind the
box facing the table (larger, pulsing), the questioners round the front,
the asker of a waiting question lit.

**Live answers.** Each answered question snuffs the next candle (the
flame shrinks out over 0.4 s on the juice clock) and leaves an ember -
green for yes or right, red for no or wrong - with a `juice.word("YES" /
"NO")` pop; an unanswerable question spends no candle. While a question
waits, the next candle flickers fast.

**Round end.** The lid flies up and tumbles, light and a gold `Burst`
pour out, and the secret rises from the box as text; the candles show
the ended round's log until the next round relights them.

| Event (viewer's seat) | Impact |
|---|---|
| an answer lands | "YES" / "NO" word, `ping` / `snip` |
| a question is asked | `beat` |
| you named it | "YOU NAMED IT" good, `BUZZ.scored` |
| your table named it | "NAMED" good |
| you were the answerer and they named it | "FOUND OUT" bad, `BUZZ.hitYou` (a silent answerer: "FORFEIT") |
| you held it | "HELD" good |
| you questioned and it held | "STUMPED" bad |
| spectator | "IT WAS" neutral |

Commit marker: your lantern. Catch-up key `ac-tq-seen` (the latest
unseen round's end).

## 14. Werewolf: the village square

**World.** A square of packed earth with a bonfire (`FireSystem`) in a
ring of cottages - on the far side only, so none stands between the
camera and the villagers. Night: `NIGHT_SKY`, a big moon, cold blue
light, lit windows. Day: `DAY_SKY`, warm sun. Every player is a figure
(a capsule and a head in their colour) in a circle round the fire, the
viewer nearest the camera; the dead lie where they fell, grey, with the
role card over them.

**Secrecy in the scene.** The scene only draws what the viewer's own
state carries: your role badge over your own figure, the pack's red
eyes (a wolf's view), a ring under tonight's pick (a role holder's
view). A spectator or villager sees none of it. By day the votes are
public: a line from each voter to their pick in the voter's colour and
a count on each plate.

**Events.** Every dawn and every vote (`events`) plays: the sky shows
the event's time, the victim falls (0.7 s) with a `Burst` - red for a
night kill, gold for a vote - and their role card turns up; titles from
the viewer's seat. The last event adds VICTORY / DEFEAT (or the side's
name for a spectator) and pillars over the living winners.

| Event (viewer's seat) | Impact |
|---|---|
| a public vote or a line of town talk | the default `ping` |
| you were killed / voted out | "YOU WERE TAKEN" / "VOTED OUT" bad, `BUZZ.lostOne` |
| a death, seen by a wolf | "THE HUNT" good |
| a death, seen by the village | "TAKEN" (bad for a player, neutral for a spectator) |
| a guarded victim | "SURVIVED" (good for the village, bad for the wolves) |
| a wolf voted out | "A WOLF!" good for the village, "THE PACK SHRINKS" bad for the wolves |
| a tie, no votes, a quiet night | "NO ONE" / "DAWN" neutral |
| the end | the defaults (a spectator gets THE VILLAGE WINS / THE WOLVES WIN) |

Catch-up key `ac-ww-seen` (events, not rounds: the latest unseen event).

## 15. Letter Grid: the tile garden

**World.** A square of ivory letter tiles on an obsidian plinth with a
teal rim, a pool of teal light under it, `LG_SKY` (deep teal night) and a
warm lamp from the viewer's side; the camera looks down steeply
(`fitHome`, 56° desktop, 64° phone) so every letter reads. A claimed tile
takes its owner's colour, a halo under it, and the owner's first two
letters in its corner (the second channel: two players can share an
initial). Letters are canvas textures (a serif face, cached per letter
and ink) - never drei `<Text>`.

**Input.** The page's word panel is the control (typing traces the best
path, the same rule as the server); a tap on a tile in the scene extends
the path (a touching, unused tile), steps back (the last tile) or starts
over. The draft lifts its tiles and runs a white ribbon through them; your
sealed word shows to you alone as a faint ribbon. Typing repaints only
the scene - the panel updates in place so the field keeps focus.

**Reveal.** Each word draws in as a tube of light in its owner's colour
(`setDrawRange` on the tube's index buffer, so a prefix of the buffer is a
prefix of the path), lowest score first, the tiles popping as it reaches
them; on landing its claimed tiles flip to the owner with a `Burst`, a
contested tile sparks white, a shared word draws grey and claims nothing.
The last round's ribbons linger faintly (they cross the letters, so keep
them thin and dim).

| Event (viewer's seat) | Impact |
|---|---|
| a word lands | `ping` (a shared word: `lock`); 3+ cells claimed: a pulse, yours `BUZZ.scored` |
| the round, your word the best | "+N" good, "WORD - the round's best", `BUZZ.scored` |
| the round, your word | "+N" neutral |
| the round, no word from you | "NO WORD" bad, `BUZZ.hitYou` |

Catch-up key `ac-lg-seen`.

## 16. Trivia: the quiz stage

**World.** A glossy black stage with a violet neon ring under `TV_SKY`;
a big screen at the back (a canvas texture: the round, the quizmaster,
the question word-wrapped to fit) and a podium per player in a shallow
arc in front of it, edges lit in the player's colour, a name plate with
the balance (the second channel), and a chip stack on top - one chip per
10 points, eased on the juice clock. The quizmaster's podium stands in a
dim spotlight cone. A lamp over a podium says an answer is sealed, never
what it is.

**Reveal.** Beat 0 turns the screen over to the answer; then each answer
card flips in seat order (`FLIP` apart): green with the stack rising for
a right answer, red and falling for a wrong one, grey for none; a split
table adds a gold "split! +10" over the quizmaster. Balances on show are
the round before's totals plus each swing as its card lands, so the
stacks move with the reveal, not before it.

| Event (viewer's seat) | Impact |
|---|---|
| the answer goes up | `charge` |
| a right card / a wrong card | `ping` / `buzzer`; yours: `BUZZ.scored` / `BUZZ.hitYou` |
| the round, you answered | "+N" good or "−N" bad, with the answer |
| the round, you asked | "+10 · your question split the table" good, else "NO SPLIT" neutral |

Commit marker: your podium's lamp. Catch-up key `ac-tv-seen` (a forfeit
lands at once).

## 17. Sketch & Guess: the night gallery

**World.** A deep teal gallery wall with a warm picture-rail glow over a
dark oak floor (`SG_SKY`), a gilt frame holding the round's drawing (the
image loaded as a texture from its signed URL - `useImage`; a failed load
leaves the blank canvas, and the page has the image too), a brass title
plate **above** the frame (below it, the stands' reveal cards cover it from
the low camera), and a stand per player in front: a name plate with the
score (the second channel) and, at the reveal, a guess card. While the
artist draws, the frame holds a cream canvas with a slow shimmer and "X is
drawing…"; the artist's stand gets a dim spotlight cone; a lamp over a
stand says a guess is sealed.

**Reveal.** Beat 0 turns the title plate over to the prompt; each guess
card flips in seat order (`FLIP` apart): green "+2" (with "the Referee's
call" when Claude judged it), red "✗", grey "no guess"; then the artist's
card with what the drawing earned. Scores on the plates move with the
cards. Nobody got it: the round's roast is the title.

| Event (viewer's seat) | Impact |
|---|---|
| the prompt goes up on the plate | `charge` |
| a right card / a wrong card | `ping` / `buzzer`; yours: `BUZZ.scored` / `BUZZ.hitYou` |
| the round, you guessed | "+2" good or "MISSED" bad, with the prompt |
| the round, you drew | "+N · N players got your drawing" good |
| nobody got it | "NOBODY GOT IT" with the roast |

Commit marker: your stand's lamp. Catch-up key `ac-sg-seen` (a forfeit
lands at once).

## 18. A new arena

1. Pick the world: palette (`SkySpec`), team hues from `players[].hex`, a
   second identity channel, the arrival vista and its three ingredients.
2. Write the event table from the viewer's seat (§1) before writing code,
   starting from every arena's defaults and recording only what differs.

The build steps: SKILL.md, "Adding a new arena"; the game-wide checklist:
"Adding a game" in docs/agents/games.md.
