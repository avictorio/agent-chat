---
name: immersive-3d-games
description: >-
  Design and build immersive, juicy 3D game arenas for the agent-chat website
  (React Three Fiber, three.js, drei, postprocessing in web/app/src/features/games/).
  Use it for ANY work on the 3D arenas - any of the sixteen (Light Cycles,
  Battleship, the rock-paper-scissors Duel, Frontlines, Code Race, Four in a
  Row, Trust, Auction, Liar's Dice, Two Truths and a Lie, Exquisite Corpse,
  Twenty Questions, Werewolf, Letter Grid, Trivia, Sketch & Guess) or a new
  one - and whenever a task touches game feel or juice, camera shake,
  hit-stop or slow motion, haptics or phone vibration, game sound effects,
  particles and explosions, bloom or postprocessing, sky and atmosphere,
  making a game immersive, alive or beautiful, entering a game world,
  presenting async turns, reveals, replays or spectators, win and loss
  staging, or R3F/three.js performance on phones. Trigger even when the
  request only says "polish the arena", "make the game feel better", "the
  duel is boring" or "add some effects", and before editing any
  *Arena3D.tsx, arena3d.tsx, juice.tsx, sfx.ts, atmos.tsx, fire.tsx,
  ocean.tsx, ships.tsx, cycles.tsx or lcmodel.ts.
---

# Immersive 3D game arenas

The project's research on 3D web game design and feel, turned into working
guidance for the arenas in `web/app/src/features/games/`. This file is the
map and the rules; the references hold the detail, and
`references/research-report.md` every source (long: read the section you
need). Most numbers are **starting values derived from fighting-game, Bevy,
Android and WCAG anchors**, not measured on this app's phones: the first
guess of an on-device tuning pass. Values the code holds are cited by file.

## Ground rules

- AGENTS.md section 1 applies (pull `main` first; screenshots at desktop
  and phone before a UI change is done; never real rooms).
- Wrap every `localStorage`, audio and vibration call in try/catch: a failed
  effect must never break a game.
- **Read the current file before relying on a signature** named here or in
  a reference: they describe purpose and contract; the code is the truth.

## Which reference to read, and when

| Read | When |
|---|---|
| `references/primitives.md` | composing an arena from the shared pieces or changing one: what each shared 3D file is for and promises |
| `references/game-feel.md` | the event ladder; tuning shake, hit-stop, slow motion, flashes or haptics; the `BUZZ` vocabulary; accessibility limits and reduced-motion substitutes |
| `references/atmosphere-and-visuals.md` | the arrival sequence, idle motion, palette, lighting, bloom and fog, ambient sound and SFX design, round and match ceremony |
| `references/r3f-techniques.md` | writing R3F code: the demand loop, the juice clock, the composer, camera moves, particles, shaders, text, context loss |
| `references/mobile-audio-haptics.md` | anything that must hold up on a phone: budgets, adaptive quality, vibration, Web Audio, fullscreen, touch, wake lock, Low Power Mode |
| `references/async-presentation.md` | what the server's logs carry, catch-up replays, waiting and presence, simultaneous reveals, spectators, ceremonies and rematch |
| `references/game-playbooks.md` | changing one arena or adding one: every arena's defaults, then per game the look, the owner's calls, event tables from the viewer's seat and starting `Juice.hit` values |
| `references/research-report.md` | checking a claim, a number or a source behind any of the above |

A small change needs the relevant section here plus one reference; a new
arena, the playbooks and the primitives, skimming the rest.

## The design core

### Where feel lives in this app

Every game here is discrete-commit and asynchronous, often against agents:
a live Light Cycles tick defaults to 120 s (an async one waits for every
rider), a Duel round to 180 s, the other games' clocks run from minutes to
a day, and an agent's wake-to-act cycle runs one to two minutes (each
game's `tick_seconds` in `worker/agents/docs.txt`, served as `GET /api`;
the rules in `worker/games/`). Players spend most of a match waiting, so
feel lives in **the arrival, the replay of what the viewer missed, and the
reveal.** Input response matters least.

### Commit → anticipate → reveal → linger

1. **Commit:** a crisp, immediate acknowledgement (a `lock` click,
   `BUZZ.commit`, a sealed token). Never quantize or delay it.
2. **Anticipate:** a reticle tightening, a shell's falling whistle, lock
   pips filling, a four-beat chant. Decelerate; land the deciding element
   last.
3. **Reveal:** the emotional peak. Sound, haptic and flash fire together on
   the impact frame (the start of hit-stop).
4. **Linger:** permanence (scorch marks, burning wrecks, trail scars, round
   chips that stay): juice *and* the record a latecomer reads.

### Spend effects on the reveal, gated on decisiveness

Routine events get small, fast, consistent feedback. Slow motion, push-ins
and long hit-stop are for moments the game can detect as decisive, as
Smash's Finish Zoom (game-winning KO only) and Tekken 7's slow-motion
camera (both low, simultaneous trade) do: an effect that delights once
tires when it plays every turn. Stage rising tension instead of escalating
every hit: "last ship", "match point", "two riders left".

**One signature per meaning:** the same event always produces the same
sound, visual and haptic, so a glance or a buzz in a pocket reads the
outcome. "You hit them" and "you were hit" differ; so do your ship sinking
and theirs. Never reuse a pattern for the opposite outcome.

## The event ladder

Five tiers, with starting trauma, hit-stop, slow-motion, haptic and
screen-layer values in **`references/game-feel.md` §4** (the one ladder):
**Tick** (hover, aim, UI tap: nothing), **Small** (a miss, your lock-in, an
RPS round), **Medium** (a hit, a near-miss), **Large** (a ship sunk, a rider
derezzed: pulse, ring, title card), **Decisive** (last ship, last rider,
the match-winning throw: the only tier with slow motion).

- **Shake the 3D camera only,** never the HUD, the selected cell or the turn
  indicator, and small enough that the board reads again within a second
  (rotation swings far cells hard; limits: `game-feel.md` §3).
- Small and medium sequences finish in under a second; a match end may run
  2–4 s and a tap skips it. The state stays readable during every effect
  (the cell is marked "hit" while it burns), and no effect gates input.

### Losses that happen to the viewer must be clearly noticeable

The owner explicitly wants a loss that happens **to the viewer** (their
ship sunk, their rider killed, their duel lost) to land: **a phone buzz, a
real shake and a visible animation**, with a "bad"-tone title card. The
research's "dignified defeat" (a desaturated side, a single soft 30 ms buzz)
is overridden here. Tune toward **noticeable but brief**:

- Treat every viewer loss as at least the Large tier, whatever its tier for
  a spectator. A viewer's decisive loss gets the full Decisive tier.
- Give it its own haptic so it never feels like a win: `BUZZ.hitYou`,
  `BUZZ.lostOne`, `BUZZ.lostMatch` (names and meanings: `game-feel.md` §5;
  values: `BUZZ` in `sfx.ts`). Use the names, never inline arrays.
- Keep it short: no long losing animation, no lingering wreck-cam. After the
  hit, go straight to the result card and a prominent Rematch.
- Spectators and other players' fates keep the neutral ladder; only
  decisive moments buzz a spectator.

## Entering the world, and idle breathing

**Arrival needs three ingredients at once:** the camera travels into the
space, light or fog uncovers it, and a sound swells on the same beat; a
scene that merely appears feels like a web page, not a place. The cover
lifts from the world's colour, never white, only once shaders compiled
(`FirstFrame` → `onReady`, `ImpactLayer`'s iris); `Intro` holds on the
horizon while the name card rises, then cranes home; a tap skips; reduced
motion cross-fades. Timeline and targets: `atmosphere-and-visuals.md` §1.

**Idle breathes; events answer.** Slow, large, low-contrast motion (swell,
sky drift, emissive ±10–20% over 3–8 s) is breathing; embers and motes stay
in the periphery; fast or bright motion only answers an event (a ripple, a
grid pulse, lights flicking toward whoever locked in), which costs nothing
while nothing happens. The `Ticker`'s rate (`useQuality`) is the ceiling
for the breathing layer.

## Visual grammar

1. **Near-black value hierarchy:** background 5–10% luminance, the play
   surface a step brighter, team light lines brighter, the HTML HUD
   brightest and outside postprocessing. A grayscale screenshot still shows
   every critical shape.
2. **One hue per side** (`players[].hex`; cyan vs amber survives common
   colour-vision deficiencies) **plus a second channel** (pattern, shape or
   label): identity never rests on colour alone.
3. **Light lines as silhouette** (Tron: Legacy's cycle is one line from
   rider through both wheels); rim/Fresnel light instead of fill light.
4. **Selective bloom:** threshold ≈ 1, so only emissive or colour above 1
   with `toneMapped={false}` glows. Why: `atmosphere-and-visuals.md` §5;
   each arena's value: its `ArenaPost` props.
5. **One reserved accent** for danger or decisiveness, white or hot
   magenta. Fog colour equals the horizon colour. "Trippy" is hue drift,
   flowing particles and 1–2 Hz beat pulses, never strobing.

## The primitives (`web/app/src/features/games/`)

`three/` holds what every arena builds on; a game's folder, its arena and
the pieces only it uses. Contracts: **`references/primitives.md`**.

| File | Purpose |
|---|---|
| `three/arena3d.tsx` | the Canvas frame: quality profile, demand-loop `Ticker`, ready signal, home framing, touch Move mode, the frame box |
| `three/juice.tsx` | the impact layer: the juice store and clock, shake, the post stack, title cards and iris, the entry fly-in, the sound toggle |
| `three/sfx.ts` | synthesized SFX, `buzz` and the `BUZZ` vocabulary, behind one toggle |
| `three/atmos.tsx` | the shader sky (`SkyDome`), `HorizonGrid`, and the transients `Burst`, `Shockwave`, `LightPillar` |
| `three/fire.tsx` | every fire on a board in three instanced shader draws |
| `battleship/ocean.tsx` | Battleship's water: waves with a CPU twin, calm boards, reflections, ripples |
| `battleship/ships.tsx` | Battleship's fleet: lofted hulls, the damage shader, death staging |
| `lightcycles/cycles.tsx` | Light Cycles' cycle model, one-draw trails, the grid floor |
| `lightcycles/lcmodel.ts` | Light Cycles as a timeline (no three.js): paths, poses, impacts, the catch-up tick |
| `shared/chime.ts` | the page's one `AudioContext`, unlocked on the first gesture |
| `games.ts` | the 3D host: lazy-loads each arena (`KIND3D`), loading and error states, the no-WebGL note |

Extend these shared files rather than adding parallel machinery in one
arena.

## The arenas

| Arena | World | Playbook |
|---|---|---|
| `battleship/BsArena3D.tsx` | a dusk sea with real waves, light-painted warships, lasting damage | §2 |
| `lightcycles/LcArena3D.tsx` | Tron: Legacy's Grid: glossy cycles, trails as walls of light, a black mirror floor | §3 |
| `duel/DuelArena3D.tsx` | rock-paper-scissors on a glass stage in a nebula; the four-beat reveal and the KO | §4 |
| `frontlines/FrontlinesArena3D.tsx` | five hills at dusk, glowing armies, a hill-by-hill reveal | §5 |
| `coderace/CodeRaceArena3D.tsx` | a cryptex vault under a synthwave sun, a lock pillar per racer | §6 |
| `fourinarow/FourArena3D.tsx` | a glass board over a dark lake at rose dusk | §7 |
| `trust/TrustArena3D.tsx` | a round table under an aurora, the round as a web of threads | §8 |
| `auction/AuctionArena3D.tsx` | an indigo-and-gold hall, the lot a turning gem | §9 |
| `liarsdice/LiarsArena3D.tsx` | a crimson felt table under one lamp, a cup per seat | §10 |
| `twotruths/TwoTruthsArena3D.tsx` | a campfire clearing, three statement cards, the lie burns | §11 |
| `corpse/CorpseArena3D.tsx` | a candlelit desk, the story a pile of folded pages | §12 |
| `twenty/TwentyArena3D.tsx` | a sealed box ringed by twenty candles | §13 |
| `werewolf/WerewolfArena3D.tsx` | a village square with a bonfire, by night and by day | §14 |
| `lettergrid/LetterArena3D.tsx` | ivory letter tiles on an obsidian plinth, words as ribbons of light | §15 |
| `trivia/TriviaArena3D.tsx` | a quiz stage: a big screen, podiums with chip stacks | §16 |
| `sketch/SketchArena3D.tsx` | a night gallery, the drawing in a gilt frame | §17 |

Read an arena's playbook section (`references/game-playbooks.md`) before
changing its look: it carries the owner's calls. Every arena is 3D only; every move works from the page controls under it;
without WebGL a one-line note replaces the scene and the flat panels return
(fallbacks per game: docs/agents/games.md). Nothing under a scene repeats
it: what a game needs to read goes into the scene or the frame caption
(`.arena3d-caption`).

## Implementation rules and pitfalls

1. **Under `frameloop="demand"`, anything that moves calls `invalidate()`
   every frame until it settles.** The Ticker covers only ambient motion;
   mutating an effect or uniform through a ref does not invalidate.
2. **Clamp delta, or read `juice.t`:** R3F's delta is unclamped, so the
   first frame after idle jumps. Never create a `THREE.Clock` (deprecated).
3. **Scripted beats are functions of `juice.t − start`,** so hit-stop, slow
   motion, skip and every replay share one deterministic path. Camera,
   shake, flashes and titles keep real time.
4. **`ToneMapping` stays the composer's last child** (RPP forces
   `NoToneMapping` while it is mounted). **Animate only Bloom's
   `intensity`** (its other props rebuild the effect); set threshold and
   smoothing explicitly (the docs' defaults are not the effective ones).
5. **Never mount drei `<CameraShake>` beside `<CameraControls>`:** it
   snaps the camera back to its mount-time rotation after the user orbits.
   Shake through `JuiceRig`.
6. **One convolution effect per pass** (ChromaticAberration, SMAA); next to
   a UV-transforming one (ShockWave, Glitch) it splits the pass, and
   `mergeMode="all"` throws. `ArenaPost` holds ChromaticAberration: prefer
   the geometry `Shockwave` ring.
7. **Nothing that recompiles at runtime:** keep postprocessing bursts
   mounted and toggle them, pulse a light mounted at intensity 0 instead of
   adding one, toggle `visible` instead of remounting (short-lived keyed
   transients are fine).
8. **One instanced draw per particle family;** glowing particles are
   additive, `depthWrite={false}`, `toneMapped={false}`, colour > 1.
9. **The lite profile (`useQuality`):** no reflector or transmission
   material (each renders the scene again), no MSAA, no grain, a lower DPR
   cap, capped particles.
10. **drei `<Text>` fetches fonts from a CDN unless self-hosted;** title
    cards go in the DOM (`ImpactLayer`).
11. **drei `PerformanceMonitor` reads every demand-rendered scene as slow**
    and walks quality to zero: time rendered frames instead. Skip
    `AdaptiveEvents` (it swallows taps). `Sparkles` never invalidates.
12. Handle `webglcontextlost`/`restored` (iOS drops contexts on
    backgrounding); keep game state outside GPU buffers.

Details, recipes and sources for each: `references/r3f-techniques.md`.

## Accessibility

- **`prefers-reduced-motion` substitutes; it never deletes.** No shake, slow
  motion or fly-ins; a colour pulse on the cell, a cut or cross-fade, soft
  fades, fewer particles. Keep the information: the colour change, the
  title, the sound and the buzz (a brief freeze is not motion). The
  substitutes and limits: `references/game-feel.md` §7–8.
- **WCAG 2.3.1: at most three flashes in any second.** Any full-canvas flash
  or bloom pulse on a phone counts as large: route it through
  `Juice.flash`, keep it low-contrast, never strobe saturated red.
- **Never carry meaning in sound or vibration alone** (iOS has no web
  vibration, the ringer switch mutes Web Audio, an untapped spectator hears
  nothing): every cue has a visual twin.
- **Announce in an `aria-live="polite"` ticker** ("Cyan fires at C4: hit");
  `ImpactLayer` is `aria-hidden`, so a title card is never the
  announcement. Keep keyboard play working.
- Shake should become a 0–100% setting (XAG 117); flashes, sound and
  haptics get their own toggles where they diverge.

## Mobile web

- **Haptics are an Android Chrome extra** and need sticky activation
  (`buzz` checks it).
- **Web Audio needs a gesture unlock** (`chime.ts`). Respect the iOS ringer
  switch: never set `audioSession.type = 'playback'`. Resume after
  backgrounding.
- **Low Power Mode caps iOS rAF at 30 fps:** use delta time everywhere;
  treat a sustained ≤ 31 fps as low power and stay on lite.
- **Budget fill rate and heat, not triangles,** for the sustained clock
  after 15–30 minutes. Degrade cheapest first: DPR → bloom → ambient fps →
  particle cap → shadows.
- The canvas stays `touch-action: pan-y` except in Move mode. iPhone has
  no element fullscreen: a fixed overlay with safe-area padding. Details
  and numbers: `references/mobile-audio-haptics.md`.

## Async presentation

- **Replay what the viewer missed,** compressed and in order, then hand
  over the turn: a per-viewer "last seen" marker in localStorage plus the
  server's logs. Cap it at a few seconds with Skip, leave a resting
  last-move marker, land on "your move". A missed loss of the viewer's own
  replays with the full viewer-loss beat. What each arena replays today:
  `references/async-presentation.md` §2.
- **Honest presence:** lock pips from `awaiting`/`targets`, the Duel's
  `thrown` booleans, "waiting since 1 m"; a fuse only in a clock's last
  10–25%; "all locked" as a visible beat.
- **Simultaneous reveal: lock → prime → flip → verdict.** Update the HUD on
  the impact frame, not when the server frame arrives, and keep throws
  secret from spectators too.
- **Spectators get a director camera** (rule-based, tap to follow, back
  after a few idle seconds), both sides and an honest, toggleable readout.
- **End on the deterministic deciding moment,** a stat line, the record
  and a one-tap Rematch. Details: `references/async-presentation.md`.

## Adding a new arena

The game-wide checklist (catalog, engine, panels, registry, tests):
"Adding a game" in docs/agents/games.md. The arena's own steps:

1. Pick the world and write the event table from the viewer's seat,
   starting from every arena's defaults (`game-playbooks.md` §1, §18).
2. Compose from the primitives (`references/primitives.md`): a demand
   Canvas with `useQuality`, `FirstFrame`, `Ticker`, `CameraControls` +
   `Framer` + `TouchControls`, `JuiceProvider` + `JuiceRig` + `ArenaPost`,
   `Intro`, `SkyDome`, the board; `ArenaFrame` with `ImpactLayer` and
   `SoundToggle`.
3. Register it in `KIND3D` in `games.ts` (`Arena3dProps`; `registerCommit`
   lets the page's tap fire the scene's `lock` + `BUZZ.commit`): it then
   lazy-loads and gets the loading and error states.
4. A `useFirstVisit("<key>:" + id)` intro key and an `ac-<key>-seen:`
   catch-up key.
5. The live-region ticker, keyboard play and the reduced-motion path.
6. UI scenarios at desktop and phone sizes, and a `no-webgl-*` one that
   plays a move from the page controls.

## Verification

Gates: AGENTS.md section 7. UI checks: docs/agents/testing.md section 10
(`shot()` waits for a loading arena and its entry iris). What arenas add:

- **Skip the entry** when not testing it: preset
  `sessionStorage["ac-intro:<key>:<id>"] = "1"` (keys: `lc bs duel fl cr c4
  tr au ld tt ec tq ww lg tv sg`, from the `useFirstVisit` calls).
- **Variants:** the harness's `noGl` (no WebGL); a scenario's
  `reducedMotion: 'reduce'` (or `UI_REDUCED_MOTION=1`); a phone is
  `w: 390, h: 844, touch: true`.
- **An effect mid-flight:** software WebGL draws few frames a second, so
  wall-clock captures miss effects. In a throwaway script (scratchpad),
  add an init-script virtual clock (`performance.now` and
  `requestAnimationFrame` advance 33.3 ms a frame, paused during a
  screenshot; wait for `performance.now() >= start + t`) and force
  `preserveDrawingBuffer: true` in a patched `getContext`, or an undrawn
  canvas captures blank. Neither is in the harness; DOM layers keep real
  time. Change state by mutating the fake API and awaiting the next poll.
- **Look at every screenshot** at both widths: value hierarchy, the board
  legible under effects, bloom not washing out, nothing clipped at 390 px.
- **Report what headless cannot show:** vibration, real audio and the iOS
  silent switch, Low Power Mode, heat, real frame rates, Android auto-dark;
  ask the owner to try it on a phone (Android Chrome for the buzz, an
  iPhone for sound and the switch).
