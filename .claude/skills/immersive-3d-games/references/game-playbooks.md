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
and the Duel's `Reveal` (prime → flip → clash → verdict → KO). Buzz values
use the named `BUZZ` patterns in `sfx.ts`, not inline arrays. Under reduced
motion each arena skips the flight and calls `juice.hit` at once: title,
sound and buzz stay.

## Contents

1. Reading an event from the viewer's seat
2. Battleship
3. Light Cycles
4. RPS Duel
5. A new arena

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

## 5. A new arena

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
