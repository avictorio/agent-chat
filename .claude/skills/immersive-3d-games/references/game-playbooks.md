# Per-game playbooks: Battleship, Light Cycles, RPS Duel

Read this before changing one specific arena or building a new one. Each
playbook gives the look, arrival, idle, the event ladder mapped from the
viewer's seat, async and spectator notes, and the current repo state. The
`Juice.hit` starting values use the `Impact` fields in
`web/app/src/games/juice.tsx` (`trauma`, `stop` ms, `slow` s, `pulse`,
`flash`/`flashA`, `buzz`, `sound`, `title`); check that file for the current
contract before relying on a field. All values are derived starting points.

What shipped (2026-11-13) and where to tune it: Battleship's `shotImpact()`
(the shell falls 0.85 s; the impact fires on its frame from `ShotFx`, a
sinking adds `SinkFx`), Light Cycles' `useLcMoments()` (derez on a crash),
and the Duel's `Reveal` (count-in → flip → matchup at contact → verdict →
KO; `planFor()` holds the timings; forfeits and catch-up replays of missed
rounds, remembered per game in localStorage, run through the same path). Buzz values
use the named `BUZZ` patterns in `sfx.ts`, not inline arrays. Under reduced
motion each arena skips the flight and calls `juice.hit` at once: title,
sound and buzz stay.

## Contents

1. Reading an event from the viewer's seat
2. Battleship
3. Light Cycles
4. RPS Duel
5. Frontlines
6. Code Race
7. Four in a Row
8. Trust
9. A new arena

## 1. Reading an event from the viewer's seat

Every event has three possible viewers, and the treatment differs:

| Seat | Treatment |
|---|---|
| **The viewer did it** (your hit, your sink, your winning throw) | the ladder tier as written, triumphant tone (`tone: "good"`), outgoing haptic |
| **It happened to the viewer** (your ship hit or sunk, your rider derezzed, your duel lost) | **at least the Large tier**: clear buzz, real shake, visible animation, a `"bad"`-tone title card; brief, never muted (owner's direction) |
| **Spectator, or other players' fates** | the ladder tier, neutral tone, no buzz except decisive moments |

Decisive moments (last ship, last rider, match-winning throw) get the
Decisive tier for everyone; the viewer's own decisive loss uses the "match
lost" haptic `[120, 80, 60]` and the `lose` stinger, then goes straight to
the result card and Rematch.

## 2. Battleship: neon-noir naval warfare where the board is the record

| Aspect | Recommendation |
|---|---|
| Look | dark navy sea and sky; hulls as dark silhouettes with emissive deck and waterline light lines (cyan one side, amber the other); a violet-to-magenta horizon band with a low striped moon behind fog; the grid as thin emissive lines on the water; bloom threshold ~1 (it was 0.72, which bloomed pegs and moon specular) |
| Arrival | start above a mist layer, descend through fog to the waterline, the moon breaks through, searchlights sweep on, then the grid is painted onto the sea; vista landmarks: both fleets and the horizon |
| Idle | sum-of-sines swell with hulls bobbing on the same CPU-side function; moon glint path; a searchlight sweep every 6–10 s; fog banks at two speeds; distant lightning as a soft sky brighten (never a white flash); embers rising from wrecks; ocean-wash bed with a bell every 20–40 s |
| Shot | reticle tightens, the shell arcs with a falling `whistle` (300–600 ms) |
| Miss | Small tier: band-passed `splash` + "bloop", a flat ring, a persistent peg |
| Hit | Medium tier: core flash, sparks, fire and smoke that keep burning on the cell |
| Sink | Large tier: the whole hull surfaces, its light lines flicker out one by one, it pitches 15–35° and goes under in 2–4 s through a clipping plane, with spray, a foam disc and bubbles; neighbouring cells auto-mark (GamePigeon); a "Destroyer sunk" ticker line |
| Decisive | last ship: slow motion ~0.25×, a push-in, a ring/ShockWave, a stinger, then Reflect. When both fleets are down to one ship, shift the music layer and lighting instead of escalating every shot |
| Async | replay each missed shot in full; open on "your damaged ships" (the current threat) |
| Spectate | both grids; director: shell, then hit cell, then sink; readout: ships remaining |

The Hasbro adaptation was criticised for "not much animation"
([Pure Nintendo](https://purenintendo.com/?p=132307)): the sink is where the
animation budget pays off.

Starting impacts:

| Event (seat) | trauma | stop | slow | buzz | sound | title |
|---|---|---|---|---|---|---|
| your miss | 0.15 | 0 | – | – | `splash` | – |
| your hit | 0.35 | 100 | – | 35 | `boom` | – |
| your ship hit (incoming) | 0.45 | 120 | – | `[30,40,30]` | `boom` | – |
| you sank theirs | 0.7 | 230 | – | `[40,60,40]` | `bigboom` | "SUNK" good |
| **your ship sunk** | 0.75 | 250 | – | `[90,50,50]` | `bigboom` | "SUNK" + ship name, bad |
| last ship (you win) | 0.8 | 250 | 0.8 | `[60,80,120]` | `bigboom`, then `win` | "VICTORY" good |
| **last ship (you lose)** | 0.8 | 250 | 0.8 | `[120,80,60]` | `bigboom`, then `lose` | "FLEET LOST" bad |

Repo notes: on phones the arena shows one ocean with a swap control (the
enemy's on your turn), a tap only aims and a **Fire at X** button fires
(`battleship-3d-phone-aim-fire` in `web/tests/ui.test.js`); the frame takes
keyboard focus and arrow keys aim. The arena replays shots from `last_move`
diffs during an open session but never on mount. Earlier code skipped the
shot animation entirely under reduced motion: keep the colour change, the
peg, the title and the sound instead.

## 3. Light Cycles: a Tron grid where each tick plays as a sprint

| Aspect | Recommendation |
|---|---|
| Look | canonical Tron: Legacy: desaturated metallic-blue floor with a circuit-board pattern and the scrolling grid shader; trails as solid emissive ribbons; each cycle reads as one glowing line. For 2–4 riders pair each hue (cyan, orange, pink, lime from the server) with a trail pattern (solid, dashed, chevron, double) and a HUD label |
| Arrival | from near-black the grid draws outward from the vanishing point, then the walls, then the cycles fill from wireframe to solid, under a synth drone rising with the sweep |
| Idle | data-flow shimmer along grid lines, slow pulses in distant circuit silhouettes, trails humming with a slight flicker, idling cycles; sub drone, slow arpeggio pad, electrical hum |
| Tick | lock pips from `awaiting`; when the tick resolves, all riders sprint their new segments together over ~0.5–0.8 s on the juice clock, with floor streaks and a slight FOV kick instead of a teleport. Extend one trail segment per straight run, add one only on turns ([BlenderArtists](https://blenderartists.org/t/blender-tron-light-cycle-game/494631)) |
| Near-miss | a head within one cell of a wall: proximity glow and a small whoosh (Medium tier at most; no buzz unless it is the viewer's rider) |
| Crash | Large tier: an instant closer-camera slow-motion replay, then the derez (dissolve, voxel `Burst`, trail collapse, floor `Shockwave`, a `LightPillar` where the rider fell). A head-on draw gets its own staging; several deaths on one tick play in sequence |
| Decisive | last rider standing: 0.5–1 s slow motion; the winner's trail flares |
| Camera | default high three-quarter or top-down (the arcade framing, [StrategyWiki](https://strategywiki.org/wiki/TRON)); an optional per-rider chase cam toggle ([Armagetron](https://armagetron.sourceforge.net/doc/commands.html)); a low angle only for crash replays |
| Async | fast-forward missed ticks (~3–4×), slowing for crashes; open on where each rider goes next |
| Spectate | director: the pair with the smallest gap to a wall, plus any imminent head-on; readout: territory share |

Speed must come from trails, streaks and the sprint beat: Tron: Evolution's
reviewers praised the "neon lights trailing out from behind"
([Push Square](https://www.pushsquare.com/reviews/2010/12/tron_evolution_ps3))
and panned scripted races with "little sense of speed"
([GameWatcher](https://www.gamewatcher.com/tron-evolution/review)).

Starting impacts:

| Event (seat) | trauma | stop | slow | buzz | sound | title |
|---|---|---|---|---|---|---|
| your lock-in | 0 | 0 | – | 20 (only if turns are rare) | `lock` | – |
| another rider derezzed | 0.6 | 220 | – | – | `derez` | "DEREZZED" neutral |
| **your rider derezzed** | 0.75 | 250 | – (0.8 if it decides the match) | `[90,50,50]` | `derez` (+`lose` if decisive) | "DEREZZED" bad |
| last rider: you | 0.8 | 250 | 0.8 | `[60,80,120]` | `derez`, then `win` | "LAST RIDER" good |

## 4. RPS Duel: a spotlit duel scored like music

| Aspect | Recommendation |
|---|---|
| Look | a dark stage with two pools of light, hands or avatars in player colours, holographic motes in the spotlight cones, a low-contrast silhouetted crowd, slowly pulsing banners; the round history built into the floor or banners as physical chips (the pattern record) |
| Arrival | overhead spotlights snap on one by one with a heavy "clunk", ending on the two pools; Present follows immediately |
| Waiting | breathing bob, fists slowly priming; a sealed glowing token appears the moment `thrown` turns true and the arena lights flick toward that side; room tone and a heartbeat pulse |
| Reveal | lock → chant (four beats, 100–120 BPM) → same-frame flip → 300–500 ms hold → clash → named verdict; each throw has its own quantized timbre (rock low drum, paper filtered swoosh, scissors bright stab) and a particle burst in the winner's colour; `charge` under the prime, `clash` on impact |
| Stakes | at match point the reveal lengthens and staggers, lights darken, heartbeat quickens; the final round gets a FINISH treatment; sudden death its own look |
| Async | replay only the last round's reveal, then the score line |
| Spectate | fixed two-shot; readout: pips plus streak; throws stay secret until the server resolves the round |

RPS is the best fit for the full synesthetic Rez / Tetris Effect treatment:
short, discrete, already musical. Beat-locked pulses at 1–2 Hz keep it
psychedelic without strobing.

Starting impacts:

| Event (seat) | trauma | stop | slow | buzz | sound | title |
|---|---|---|---|---|---|---|
| your throw locked | 0 | 0 | – | 20 | `lock` | – |
| rival locked | 0 | 0 | – | – | a soft cue (none in `sfx.ts` yet) | – |
| round won (yours) | 0.2 | 60 | – | 20 | `clash` | "ROUND" good |
| round lost (yours) | 0.3 | 80 | – | `[30,40,30]` | `clash` | "ROUND" bad |
| tie | 0.15 | 60 | – | – | `clash` | "CLASH · AGAIN" neutral |
| match won (yours) | 0.8 | 250 | 0.8 | `[60,80,120]` | `clash`, then `win` | "VICTORY" good |
| **duel lost (yours)** | 0.8 | 250 | 0.8 | `[120,80,60]` | `clash`, then `lose` | "DEFEAT" bad |

Repo notes: the 2D duel (AGENTS.md, Duel UX redesign) already has win pips
and a big score numeral in each player's colour, a locked/thinking state
line, the last face-off with a named verdict, a YOUR THROW / LOCKED pill, a
draining round-clock bar, large throw tiles whose microcopy teaches the cycle
("crushes scissors / covers rock / cut paper"), an animated verdict banner
and a round-chip strip. A 3D arena keeps every one of those meanings (in the
scene or the DOM HUD) and must not let the HUD update before the 3D reveal
lands. Elements that sit on the page background carry their own dark panel.

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
| you lock in | `lock` + `BUZZ.commit` at the tap, your front line lights |
| rival locks in (seen live) | a soft `ping`, their line lights |
| each hill resolves | `zap` (`whoosh` if level), trauma 0.08–0.12, stop 30 |
| round won | trauma 0.25, stop 80, `BUZZ.scored`, "ROUND n" good |
| round lost | trauma 0.4, stop 120, `BUZZ.hitYou`, "ROUND n" bad |
| level round | trauma 0.12, "LEVEL" neutral |
| match won / lost | trauma 0.8, stop 250, slow 0.8, `wonMatch`/`lostMatch`, `win`/`lose`, "VICTORY"/"DEFEAT", then a `LightPillar` behind the winner's line and a `Shockwave` |

**Catch-up.** The rounds seen are kept per game (`ac-fl-seen:<path>:<id>`);
on open, only the latest unseen round replays (the History tab has the
rest). A first look at a match shows it as it stands. A tap skips to the
verdict; under reduced motion a missed round lands at once with its title.

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
| you guess | `lock` + `BUZZ.commit` at the tap, your foot ring lights |
| a rival guesses (seen live) | a soft `ping`, their foot ring lights |
| a round, nobody cracks it | your feedback as the title ("Closer · 2 right place · 1 right colour" good when it beats your best, with `ping` and a commit buzz; else neutral `beat`); a missed guess `buzzer`, bad |
| you crack it | trauma 0.55, stop 180, `BUZZ.sankTheirs`, `shatter` + `win`, "CRACKED" good |
| a rival cracks it (you haven't) | trauma 0.4, stop 120, `BUZZ.hitYou`, `shatter`, "CRACKED" bad, "keep racing" |
| race won / lost | VICTORY (`wonMatch`, `win`) / DEFEAT (`lostMatch`, `lose`), trauma 0.8, stop 250, slow 0.8; cracked but not first: "#2" neutral with `scored`; nobody cracked it: "THE CODE HOLDS" |

**Catch-up.** `ac-cr-seen:<path>:<id>` keeps the rounds seen; the latest
unseen round replays on open; a tap skips; reduced motion lands it at
once with its title and opens the vault without the spin.

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
| you drop | `lock` + `BUZZ.commit` at the tap |
| the rival's disc lands on your board | trauma 0.12, stop 40, `lock`, `BUZZ.commit` (it's your turn) |
| a disc lands (spectator) | trauma 0.08, `lock` |
| you win / lose | VICTORY / DEFEAT, trauma 0.8, stop 250, slow 0.8, `wonMatch` / `lostMatch`; the four glow, a beam runs through them, a burst at each, then a `LightPillar` and a `Shockwave` |
| a draw | "DRAW" neutral, `whoosh` |

**Catch-up.** `ac-c4-seen:<path>:<id>` holds the moves seen; on open the
latest unseen move drops in (any earlier ones are placed at once); a tap
skips; reduced motion places it with its title and sound.

## 8. Trust: the round table

**World.** A dark round table on an open plain under a teal and violet
aurora (`TR_SKY`); each player's seat glows in their colour around it,
the viewer nearest the camera; name plates and scores sit outward from
the table so they never cover the threads.

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
| you lock in | `lock` + `BUZZ.commit`, your seat lights |
| a rival locks in | a soft `ping`, their seat lights |
| someone betrayed your trust | "BETRAYED by …" bad, trauma 0.4, stop 120, `BUZZ.hitYou`, `tear` |
| all your trust returned | "TRUST HELD" good, `BUZZ.scored`, `win` |
| any other round | "ROUND n · +pts" neutral, `clash` |
| match won / lost | VICTORY / DEFEAT (2nd of 3+ gets "#2"), the winner's pillar and shockwave |

**Catch-up.** `ac-tr-seen:<path>:<id>`; the latest unseen round replays on
open; a tap skips; reduced motion lands it at once.

## 9. A new arena

1. Pick the world: palette (`SkySpec`), team hues from `players[].hex`, a
   second identity channel, the arrival vista and its three ingredients.
2. Write the event table from the viewer's seat (§1) before writing code.
3. Compose from the primitives (see SKILL.md, "The primitives"): a
   `<Canvas frameloop="demand">` with `useQuality`, `FirstFrame` → `onReady`,
   `Ticker`, `CameraControls` + `Framer`/`fitHome` + `TouchControls`,
   `JuiceProvider` + `JuiceRig` + `ArenaPost`, `Intro`, `SkyDome`, then the
   board; `ArenaFrame` around it with `ImpactLayer` as overlay and
   `SoundToggle` in tools.
4. Lazy-load it from `games.ts` like `LcArena3D`/`BsArena3D` (a dynamic
   import so three.js stays in its own chunk; the 3D host shows "Loading the
   3D arena…" until `onReady`, or an error with Reload).
5. Add an `aria-live` ticker, keyboard play, and the reduced-motion path.
6. Add a UI-suite scenario that opens the arena at desktop and phone sizes
   and screenshots it after the ready signal.
