# Atmosphere and visuals: arrival, breathing, neon grammar, sound, ceremony

Read this when you design how an arena *looks and sounds*: the first seconds
after opening it, what moves while nobody acts, palette and lighting, glow,
the ambient bed and SFX, and the round/match ceremony. Timelines here are
inferences built from shipped-game patterns; no source gave a frame-by-frame
recipe.

## Contents

1. Arrival: the first ~3 seconds
2. Idle: breathing, reactive beats, permanence
3. Visual grammar for the neon look
4. Palettes and references
5. Glow, fog and lighting in practice
6. Sound is half of the world
7. Ceremony: Present, Count, Release, Resolve, Reflect

## 1. Arrival: the first ~3 seconds

Shipped games treat the opening view as a composed establishing shot: the
"vista" is a wide shot right after the start that shows the main landmarks
([Tuts+](https://code.tutsplus.com/level-design-views-and-vistas--cms-25036a);
[TV Tropes](https://TVTropes.org/pmwiki/pmwiki.php/Main/VideoGameVista)).
Loading counts as part of the intro: "a long, boring loading will hurt the
user's experience as much as a bad tutorial would"
([Game Developer](https://www.gamedeveloper.com/design/how-to-create-immersive-game-intros)).
Psychedelic games grow the world in front of the player: Rez levels start as
flat wireframe and grow ([Giant Bomb](https://giantbomb.com/rez/3030-17578/));
Tetris Effect builds a metronome before light-particle rays sweep the screen
([New Game Network](https://newgamenetwork.com/article/2181/tetris-effect-review));
Journey's palette follows an authored emotional curve
([CGW](https://www.cgw.com/Publications/CGW/2012/Volume-35-Issue-4-June-July-2012/Mysterious-Journey.aspx)).

**Arrival needs three ingredients at once:** the camera travels into the
space, light or fog uncovers it, and a sound swells on the same beat. A page
load has none of them.

| Time | Visual | Audio | In this repo |
|---|---|---|---|
| 0–0.3 s | the DOM cover fades from the scene's fog/background colour, never white | the tap that opened the arena has unlocked audio | `FirstFrame` (`arena3d.tsx`) runs `compileAsync` and reports ready only after shaders are built; `ImpactLayer`'s iris holds the world colour until then |
| 0.3–2.5 s | ease-out flight from a high, wide vista to the play camera; fog eases from thick to normal | filter sweep / swell on the ambient bed (`sfx("enter")`) | `Intro` (`juice.tsx`) starts high, far and swung round, then `setLookAt(..., true)` with a short `smoothTime` |
| 1.0–2.5 s | emissive light lines power on outward from the focal point | swell peaks as the camera settles | ramp a shared `uPower`-style uniform on grid/trim materials and light intensities |
| 2.5–4 s | arena name card, then the HUD slides in and input unlocks | short sting | DOM title card via `ImpactLayer` (the iris already raises the world's name) |
| any time | a tap skips to the end; repeat entries in a session use a ~1 s version; reduced motion gets a cross-fade with the same light and sound reveal | | `games.ts` decides "first open this page session" |

Caveat: while the composer is mounted the renderer runs `NoToneMapping`, and
no note verified that the `ToneMapping` effect honours
`renderer.toneMappingExposure`. Ramp uniforms, lights and fog you own rather
than exposure.

Per-arena arrival ideas: Battleship descends through mist to the waterline,
the moon breaks through, searchlights sweep on, then the grid is painted on
the sea. Light Cycles draws the grid outward from the vanishing point, then
the walls, then the cycles fill from wireframe to solid under a rising synth
drone. The Duel snaps overhead spotlights on one by one with a heavy "clunk",
ending on two pools of light, then goes straight into the Present beat.

## 2. Idle: breathing, reactive beats, permanence

Rez's environments "move and fluctuate with the beat"
([Giant Bomb](https://giantbomb.com/rez/3030-17578/)). Tetris Effect built most
visuals from particles because they respond well to music, alternated
excitement and relaxation, kept visuals out of gameplay's way and offered an
option to "see less"
([Unreal Engine interview](https://www.unrealengine.com/en-US/developer-interviews/how-tetris-effect-became-a-modern-work-of-art)).

Layer idle motion by frequency and size:

- **Slow, large, low-contrast = breathing.** Sea swell, sky drift, emissive
  intensity oscillating ±10–20% over 3–8 s.
- **Medium motion** (embers, motes, sparks) lives in the periphery.
- **Fast or bright motion happens only in answer to an event.**

**Reactive beats busy.** A ripple from a placed ship, a grid pulse from a
Light Cycles turn, arena lights flicking toward whoever just locked in. These
cost nothing while nothing happens, which suits `frameloop="demand"`.

**Permanence tells the story to latecomers.** Burning wrecks, scorch marks,
dim trail scars and a tally built into the arena let a spectator who joins
halfway read the match from the scene alone.

Pacing ceiling: the repo's `Ticker` invalidates at 30 fps (24 on touch, 0
under reduced motion). That is the right rate for the breathing layer; event
animations request every frame while they run. `SkyDome` and `HorizonGrid`
(`atmos.tsx`) advance on the juice clock and freeze under reduced motion.

Hard ceilings on idle motion: nothing flashes above 3 Hz; no full-bright or
saturated-red flash over ~20% of the screen; idle motion never crosses or
sits behind game-critical information (targeting grid, cycle heads, throw
tiles).

## 3. Visual grammar for the neon look

Tron: Legacy reduces to a few rules. Light is the one unifying element:
"light lines" wrap interiors, streets and buildings (the production designer,
[NPR](https://www.npr.org/transcripts/132211816)). The light cycle's
silhouette is a single line from the rider through both wheels
([Fast Company](https://www.fastcompany.com/1707968/how-tron-legacy-light-cycle-designers-made-sexiest-coolest-vehicle-ever)).
Two colours dominate, "very desaturated metallic light blue and heavy
orange", the orange ranging from saturated yellow to darker red
([Pushing Pixels](https://www.pushing-pixels.org/?p=3196)). The Tron: Ares
Grid was inspired by circuit boards (ILM interview with the film's VFX supervisor).
Beat Saber's lights are hand-authored events in two semantic colours that
resolve to each environment's primary and secondary
([BSMG wiki](https://bsmg.wiki/mapping/basic-lighting.html)). Rez's graphics
are spare wireframe ([LABoral](https://laboralcentrodearte.org/?p=15590));
Thumper's speed forced clear cues
([Game Developer](https://gamedeveloper.com/design/how-i-thumper-i-uses-striking-visuals-to-complement-gameplay-at-every-turn)).
Simple geometry plus audiovisual sync carries the "trippy" feel, not polygon
count.

The shared grammar:

1. **Value hierarchy first.** Background darkest (5–10% luminance), play
   surface a step brighter, team light lines brightest, HTML HUD brightest of
   all and outside postprocessing. A grayscale screenshot must still show
   every critical shape.
2. **One hue per side.** Cyan vs amber is complementary and survives the
   common red-green deficiencies. The repo's player colours come from the
   server (`players[].hex`: cyan `#22d3ee`, orange `#fb923c`, pink
   `#f472b6`, lime `#a3e635`).
3. **A second channel for identity.** Never colour alone: solid vs dashed
   trails, different hull light patterns, HUD labels.
4. **Rim or Fresnel light instead of fill light** to separate silhouettes from
   the dark. One cool key (moonlight) + emissive lines + a rim term.
5. **One reserved accent for danger or decisiveness,** white or hot magenta,
   not red.

"Trippy" means hue drift, flowing particles and pulses on the beat (1–2 Hz at
60–120 BPM). It does not mean strobing; even Polybius was called "sensory
overload" ([Push Square](https://www.pushsquare.com/news/2017/05/hands_on_polybius_is_a_playstation_vr_sensory_overload_befitting_urban_legend)).

## 4. Palettes and references

Synthwave (trend pages, not art-direction postmortems): midnight-navy base,
electric magenta, cyan, violet, sunset orange, chrome highlights, a magenta
or cyan perspective grid ([daisyUI Trends](https://trends.daisyui.com/trend/synthwave-outrun/)).
Sample values: **#1A0B33** deep violet, **#8E2470** magenta, **#FF7A3C**
sunset orange, **#FF4FA3** grid pink, horizon ~70% down the frame
([SlideSpeak](https://slidespeak.co/slide-design-prompts/prompts/outrun)); a
horizontally striped yellow-to-red sun on the horizon.

`SkyDome` (`atmos.tsx`) takes a `SkySpec`: `top`, `mid`, `horizon`, `ground`,
`glow`/`glowAmt`, `stars` (0..~0.12), `aurora` with `auroraA/B`, `swirl`
(nebula), and an optional striped synthwave `sun {size, az, el, a, b}`. One
draw, no textures. `HorizonGrid` adds an endless additive grid that fades to
the horizon with a slow outward pulse, leaving a `hole` over the board.

Per-arena looks (full detail in `game-playbooks.md`): Battleship is
neon-noir naval (dark navy, hulls as silhouettes with emissive deck and
waterline lines, violet-to-magenta horizon band, low striped moon behind
fog). Light Cycles is canonical Tron: Legacy (desaturated metallic-blue
floor, circuit pattern, scrolling grid, trails as solid emissive ribbons).
The Duel is a spotlit stage with two pools of light and a silhouetted crowd.

## 5. Glow, fog and lighting in practice

- **Bloom is selective.** A `luminanceThreshold` of 1 means nothing glows by
  default; only materials you choose glow (emissive intensity or colour
  above 1 with `toneMapped={false}`)
  ([RPP bloom docs](https://github.com/pmndrs/react-postprocessing/blob/master/docs/effects/bloom.mdx);
  [three.js forum](https://discourse.threejs.org/t/what-does-the-threshold-in-unrealbloompass-means-and-how-to-make-a-color-just-pass-that-threshold-a-bit-how-to-calculate-the-threshold-for-a-color/60984)).
  `LcArena3D.tsx` used threshold 1; `BsArena3D.tsx` used 0.72 with smoothing
  0.3, so any bright lit surface (pegs, moon specular) bloomed whether or not
  anyone chose it. `ArenaPost` takes `threshold` per arena: prefer ~1.
- With `<ToneMapping>` last in the composer, HDR highlights compress; expect
  to retune emissive intensities after adding it. The atmos effects multiply
  team colours by ~1.8–2.6 so bloom catches them.
- **Fog colour = horizon colour,** so far geometry dissolves into the sky and
  the arena edge disappears. Emissive lines should never fog out completely.
- **Never add or remove lights at runtime** (every material recompiles).
  Keep one point light mounted at intensity 0 and pulse it.
- On phones, glow budget is one mipmap bloom (levels 4–5) or none, with
  emissive colour, additive halo sprites or a Fresnel term carrying the look.

## 6. Sound is half of the world

Autoplay: since Chrome 71 a context created before a gesture starts
"suspended" and must be resumed in a tap handler
([Chrome autoplay](https://developer.chrome.com/blog/autoplay);
[Web Audio and games](https://developer.chrome.com/blog/web-audio-autoplay)).
iOS also wants a real (silent) sound inside the gesture
([Cinevva](https://app.cinevva.com/tutorials/web-audio-api-games), lower authority).
In the repo, `chime.ts` owns the one `AudioContext` (unlocked on the first
pointer or key press; `audioContext()`), and `sfx.ts` plays named,
synthesized effects through a master gain into a compressor.

Practice that shapes the SFX layer:

- **Layer impacts:** transient (says WHEN), body (WHAT), tail (HOW BIG),
  optional sweetener. Small offsets between transient and body change
  perceived size ([Lior Tega](https://www.liortega.com/post/first-person-shooter-gun-sound-design)).
- **Duck** music and ambience by about −6 to −9 dB on important cues (attack
  ~20–50 ms, release 300–800 ms) with `setTargetAtTime` on bus gains
  ([mdskills](https://www.mdskills.ai/skills/game-audio), lower authority).
  Today `sfx.ts` has one master bus; add music/ambience buses before ducking.
- **Quantize like Rez:** Rez played every shot and explosion in time and in
  key ([Giant Bomb wiki](https://giantbomb.com/wiki/Games/Rez); PlayStation Blog "Classic Levels Deconstructed: Rez Infinite Area 5").
  Schedule non-critical musical flourishes (lock-ins, placements, grid
  pulses) on the next 8th/16th of a 100–120 BPM clock from
  `ctx.currentTime`, pitched to a pentatonic scale. The input-acknowledgement
  click stays immediate.
- **Synthesize instead of downloading** (recipes; `sfx.ts` already has
  `boom`, `bigboom`, `splash`, `whistle`, `ping`, `derez`, `lock`, `charge`,
  `clash`, `shatter`, `win`, `lose`, `enter`):

| Sound | Recipe |
|---|---|
| impact transient | 5–20 ms high-passed noise |
| thump body | sine dropping 180 → 50 Hz over 150 ms |
| rumble tail | low-passed noise, cutoff falling over 0.5–2 s |
| splash | band-passed noise plus a downward "bloop" |
| cycle engine | two detuned saws through a low-pass; pitch and cutoff track speed |
| derez | noise burst plus a falling arpeggio |
| RPS throws | rock a low drum, paper a filtered swoosh, scissors a bright stab |

- **Ambient beds:** Battleship: ocean wash (noise with a slow LFO on cutoff)
  and a foghorn or bell every 20–40 s. Light Cycles: sub drone, slow arpeggio
  pad, electrical hum. Duel: room tone and a heartbeat pulse that quickens
  through the countdown.
- **Spatial:** `PannerNode` with `panningModel = "HRTF"` on desktop,
  `equalpower` or `StereoPannerNode` on phones, for off-screen events; tie
  the listener to the camera, keep roll-off gentle
  ([tproger](https://tproger.ru/translations/web-audio-intro)).
- Suspend on `visibilitychange` hidden and resume on visible; pool voices;
  pre-generate noise buffers so the first hit has no allocation hitch.
- Stingers: rising major arpeggio for a win, falling minor or detuned figure
  for a loss.

## 7. Ceremony: Present, Count, Release, Resolve, Reflect

"Round 1, Fight!" dates to Street Fighter II
([Game Informer](https://gameinformer.com/feature/2022/12/16/returning-to-round-one-the-history-of-street-fighter));
Street Fighter 6 makes its versus screens interactive
([Destructoid](https://vip-develop.destructoid.com/?p=328372)); Pokémon Red/Blue
pick the battle transition from stakes flags
([pokered](https://v10.next.forgejo.org/foster/pokered/src/branch/master/engine/battle/battle_transitions.asm)),
so intro weight can scale with stakes.

| Beat | Duration (inferred) | Content |
|---|---|---|
| Present | 1–2 s, match start, skipped on rematches | VS split, name cards in team colours, head-to-head; a heavier "woosh" for rivalries and deciding rounds |
| Count | 2–3 s | beats on the clock, a light pulse per beat (never full-screen), ambient ducked; in RPS the chant is the count |
| Release | instant | GO, music drops in, a burst in both colours, input unlocks on the downbeat |
| Resolve | 200–270 ms hit-stop, then 0.5–1 s slow motion | the decisive moment with a camera push (dropped under reduced motion) |
| Reflect | 2–4 s, skippable | winner's colour floods the arena lights, loser's lines dim; stinger; result card with the deterministic replay, a stat line, head-to-head and a big Rematch |

Keep ceremony short on repeats: the first round gets the full intro, later
rounds Count and Release only, rematches skip Present. Ceremony doubles as
information for late-joining spectators.

When the viewer is the loser, Reflect still dims their side, but the defeat
itself has already landed loudly (see `game-feel.md` §4): buzz, shake, a
"bad"-tone title card, then straight to the result card and Rematch.
