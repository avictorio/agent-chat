---
name: immersive-3d-games
description: >-
  Design and build immersive, juicy 3D game arenas for the agent-chat website
  (React Three Fiber, three.js, drei, postprocessing in web/app/src/games/).
  Use this skill for ANY work on the 3D arenas - Light Cycles, Battleship, the
  rock-paper-scissors Duel, or a new game arena - and whenever a task touches
  game feel or juice, camera shake, hit-stop or slow motion, haptics or phone
  vibration, game sound effects, particles and explosions, bloom or
  postprocessing, sky and atmosphere, making a game immersive, alive or
  beautiful, entering a game world, presenting async turns, reveals, replays
  or spectators, win and loss staging, or R3F/three.js performance on phones.
  Trigger even when the request only says "polish the arena", "make the game
  feel better", "the duel is boring" or "add some effects", and before editing
  any *Arena3D.tsx, arena3d.tsx, juice.tsx, sfx.ts or atmos.tsx.
---

# Immersive 3D game arenas

This skill turns the project's research on 3D web game design and feel into
working guidance for the arenas in `web/app/src/games/`. The full research
report, with every source link, is `references/research-report.md` (long:
read the section you need); the references below distill it. Most numbers here are **starting values derived from fighting-game,
Bevy, Android and WCAG anchors**, not measurements on this app's phones:
treat them as the first guess of an on-device tuning pass.

## Ground rules (from AGENTS.md)

Read `AGENTS.md` before changing anything. The rules that bite hardest here:

- **Target the website only.** The Android app is deprecated. Mobile web
  means Android Chrome and iOS Safari. Skip anything that needs a native
  plugin or an APK.
- Pull `main` first (other sessions push); pushing to `main` deploys.
- **UI changes are not done until screenshots at desktop and phone widths
  have been looked at** (AGENTS.md section 10). The verification workflow
  at the end of this file is how.
- Test against stubbed APIs or throwaway rooms, never real rooms. No
  secrets, tokens or invite links in code, commits or reports.
- Wrap every `localStorage`, audio and vibration call in try/catch: a failed
  effect must never break a game.
- The primitives below are being actively built. **Read the current file
  before relying on a signature named here**; this skill describes purpose
  and contracts, the code is the truth.

## Which reference to read, and when

| Read | When |
|---|---|
| `references/game-feel.md` | tuning shake, hit-stop, slow motion, flashes or haptic patterns; deciding how big a moment is; accessibility limits and the reduced-motion substitutes |
| `references/atmosphere-and-visuals.md` | arrival sequence, idle motion, palette, lighting, bloom and fog, ambient sound and SFX design, round and match ceremony |
| `references/r3f-techniques.md` | writing R3F code: the demand loop, the juice clock, the composer, camera moves, particles, shaders, text, context loss |
| `references/mobile-audio-haptics.md` | anything that must hold up on a phone: budgets, adaptive quality, vibration, Web Audio, fullscreen, touch, wake lock, Low Power Mode |
| `references/async-presentation.md` | catch-up replays, waiting and presence, simultaneous reveals, spectators, ceremonies and rematch |
| `references/game-playbooks.md` | changing one specific arena or adding a new one: per-game look, event tables from the viewer's seat, starting `Juice.hit` values |
| `references/research-report.md` | checking a claim, a number or a source behind any of the above |

For a small change, the relevant section of SKILL.md plus one reference is
usually enough. For a new arena, read the playbooks and skim the rest.

## The design core

### Where feel lives in this app

All three games are discrete-commit and asynchronous, often against agents:
a Light Cycles tick defaults to 120 s, a Duel round waits up to 180 s, and
an agent's wake-to-act cycle runs one to two minutes. Moment-to-moment
steering never drives the feel. Players spend most of a match waiting, so
feel lives in three places: **the arrival, the replay of what the viewer
missed, and the reveal.** Input response matters least.

### Commit → anticipate → reveal → linger

Every loop shares one arc. Design each beat on purpose:

1. **Commit:** a crisp, immediate acknowledgement (a `lock` click, a 20 ms
   buzz, a sealed token). Never quantize or delay this one.
2. **Anticipate:** a reticle tightening, a shell arc with a falling whistle,
   lock pips filling, a four-beat chant. Decelerate and land the deciding
   element last.
3. **Reveal:** the emotional peak. Sound, haptic and flash fire on the
   impact frame (the start of hit-stop), together.
4. **Linger:** permanence. Scorch marks, burning wrecks, trail scars, round
   chips that stay. They are juice *and* the record a latecomer reads.

### Spend effects on the reveal, gated on decisiveness

Routine events get small, fast, consistent feedback. Slow motion, camera
push-ins and long hit-stop are reserved for moments the game can detect as
decisive, exactly as Smash's Finish Zoom (game-winning KO only) and Tekken
7's slow-motion camera (both low, simultaneous trade) do. The reason is
fatigue: an effect that delights once becomes tiresome when it plays every
turn. Stage rising tension instead of escalating every hit: "last ship",
"match point", "two riders left".

### One signature per meaning

The same event always produces the same sound, visual and haptic, so a
glance or a buzz in a pocket reads the outcome. "You hit them" and "you
were hit" get different signatures; so do your ship sinking and theirs.
Never reuse a pattern for the opposite outcome.

## The event ladder

Starting values (derived). Trauma feeds `Juice.hit`; hit-stop and slow
motion act on the juice clock; haptics are Android Chrome only.

| Tier | Events | Trauma | Hit-stop | Slow motion | Haptic (ms) | Screen layer |
|---|---|---|---|---|---|---|
| Tick | hover, aim, UI tap | 0 | 0 | none | none (10–15 only if rare) | none |
| Small | miss, own lock-in, RPS round won or lost | +0.15–0.25 | 0–60 ms | none | 20 | local flash at the cell |
| Medium | hit, Light Cycles near-miss | +0.3–0.4 | 80–130 ms (≈ SFV light) | none | 30–40 | bloom pulse |
| Large | ship sunk, rider derezzed | +0.6–0.8 | 200–270 ms (≈ SFV medium–heavy) | none unless decisive | `[40,60,40]` | pulse + ring + title card |
| Decisive | last ship, last rider, match-winning throw | +0.8, once | 200–270 ms, then slow | 0.2–0.35× for 0.5–1 s | win `[60,80,120]` | one rate-limited flash, stinger |

- **Shake the 3D camera only,** never the HUD, the selected cell or the turn
  indicator. On a perspective camera over a grid, rotation swings far cells
  hard: keep roll ≤ 1–2°, yaw/pitch ≤ 0.5–1°, a small translation, and decay
  fast enough (≈1.0–1.6 trauma/s in the research) that the board reads again
  within a second. Shake is trauma², smooth noise per axis.
- Small and medium sequences finish in under a second. A match-end sequence
  may run 2–4 s and accepts a tap to skip.
- The authoritative state is readable during every effect (the cell is
  marked "hit" while it burns), and no effect gates input.

### Losses that happen to the viewer must be clearly noticeable

The owner explicitly wants a loss that happens **to the viewer** (their
ship sunk, their rider killed, their duel lost) to land: **a phone buzz, a
real shake and a visible animation**, with a "bad"-tone title card. The
research's "dignified defeat" (a desaturated side, a single soft 30 ms buzz)
is overridden here. Tune toward **noticeable but brief**:

- Treat every viewer loss as at least the Large tier, whatever its tier for
  a spectator. A viewer's decisive loss gets the full Decisive tier.
- Give it its own haptic so it never feels like a win. The vocabulary lives
  in one place, `BUZZ` in `sfx.ts`: `lostOne` `[90, 50, 50]` for your ship
  sunk or rider derezzed, `lostMatch` `[120, 80, 60]` (the win's contour
  reversed, equal weight), `hitYou` `[30, 40, 30]` for "you were hit" or a
  lost round. Use the names, never inline arrays. These are derived
  starting values; tune them on a real Android phone.
- Keep it short: no long losing animation, no lingering wreck-cam. After the
  hit, go straight to the result card and a prominent Rematch.
- Spectators and other players' fates keep the neutral ladder, and only
  decisive moments buzz a spectator.

Full haptic vocabulary and the reasoning: `references/game-feel.md` §4–5.
Per-game tables from the viewer's seat: `references/game-playbooks.md`.

## Entering the world, and idle breathing

**Arrival needs three ingredients at once:** the camera travels into the
space, light or fog uncovers it, and a sound swells on the same beat. A page
load has none of them, which is why a scene that merely appears feels like a
web page rather than a place.

- 0–0.3 s: the cover lifts from the world's colour, never white, and only
  after shaders compiled (`FirstFrame` → `onReady`; `ImpactLayer`'s iris).
- 0.3–2.5 s: ease-out flight from a high, wide vista to the play camera
  (`Intro`); fog eases from thick to normal; the ambient bed swells
  (`sfx("enter")`).
- 1.0–2.5 s: emissive light lines power on outward from the focal point
  (ramp a uniform you own; do not rely on renderer exposure under the
  composer).
- 2.5–4 s: the arena name card (DOM), then the HUD; input unlocks.
- A tap skips; repeat entries in a session use a ~1 s version; reduced
  motion cross-fades with the same light and sound reveal.

**Idle breathes; events answer.** Slow, large, low-contrast motion (swell,
sky drift, emissive ±10–20% over 3–8 s) reads as breathing. Medium motion
(embers, motes) stays in the periphery. Fast or bright motion happens only in
answer to an event: a ripple from a placed ship, a grid pulse from a turn,
lights flicking toward whoever locked in. Reactive beats cost nothing while
nothing happens, which suits demand rendering. The `Ticker` rate (30 fps, 24
on touch, 0 under reduced motion) is the ceiling for the breathing layer.

## Visual grammar

1. **Near-black value hierarchy.** Background 5–10% luminance, play surface
   a step brighter, team light lines brightest, the HTML HUD brightest and
   outside postprocessing. A grayscale screenshot must still show every
   critical shape.
2. **One hue per side, plus a second channel.** Team colours come from the
   server (`players[].hex`); cyan vs amber survives common colour-vision
   deficiencies. Add pattern, shape or label so identity never rests on
   colour alone.
3. **Light lines as silhouette.** Tron: Legacy's cycle is one line from rider
   through both wheels. Rim/Fresnel light instead of fill light.
4. **Selective bloom.** Threshold ≈ 1 so nothing glows unless chosen:
   emissive or colour above 1 with `toneMapped={false}`. A low threshold
   (Battleship once used 0.72) blooms pegs and specular nobody chose.
5. **One reserved accent** for danger or decisiveness: white or hot magenta,
   never a red strobe. Fog colour equals the horizon colour.
6. **"Trippy" means hue drift, flowing particles and 1–2 Hz beat pulses,**
   never strobing.

## The primitives (`web/app/src/games/`)

| File | Purpose and contract |
|---|---|
| `arena3d.tsx` | The Canvas frame. `useQuality(still)` → `{lite, dpr, ambientFps, msaa}` (lite = coarse pointer: dpr `[1,1.5]`, 24 fps, MSAA 0; else `[1,1.75]`, 30 fps, MSAA 2; 0 fps when still). `Ticker` paces ambient frames under `frameloop="demand"`. `FirstFrame` calls `onReady` once `compileAsync` has built every program and a frame is drawn: the ready signal that hides "Loading the 3D arena…". `fitHome`/`Framer`/`goHome` compute and re-apply the home framing per host aspect. `TouchControls` + Move mode: on touch screens the camera ignores touch by default (one finger scrolls the page or taps the board); a **Move** button on the frame hands touch to the scene (one finger turns, two pinch-zoom and pan, touch-action none, iOS page zoom held off) until **Done**. Do not bring back two-finger camera gestures outside Move mode: a first finger that drifts hands the gesture to the browser, so they only worked when both fingers landed at once (and iOS zoomed the page). `ArenaFrame`: wheel scrolls the page unless Ctrl/Cmd, Reset view, overlay and tool slots. `useReducedMotion`, `useCoarsePointer`. |
| `juice.tsx` | The impact layer. A `Juice` store (`useJuiceStore(still)`, `JuiceProvider`, `useJuice`) with `hit(impact)` taking trauma, hit-stop ms, slow-motion s, post pulse, flash (≤ 3/s, WCAG 2.3.1), buzz, sound and a title card. `JuiceRig` advances the clock `juice.t` (clamped delta × scale: 0 in hit-stop, 0.25 in slow motion), shakes via `CameraControls.setFocalOffset` scaled by camera distance, and invalidates while anything runs. `ArenaPost`: Bloom (intensity pulsed) → ChromaticAberration (fringe pulsed) → Noise (not on lite) → Vignette → ToneMapping last. `ImpactLayer` (DOM): flash, title cards, the entry iris. `Intro`: the camera fly-in (first visit per game per page session, `useFirstVisit`; a tap or click skips it and snaps home before the scene handles the press). `SoundToggle`. Under `still`, motion channels drop and flashes soften; titles, sound and buzz stay. |
| `sfx.ts` | Synthesized Web Audio SFX (`sfx(name, delay)`: boom, bigboom, splash, whistle, ping, derez, lock, charge, clash, shatter, win, lose, enter) through a master gain and compressor, plus `buzz(pattern)` (`navigator.vibrate` after sticky activation) and the `BUZZ` pattern vocabulary, both behind one toggle (`ac-sfx-muted`). |
| `atmos.tsx` | `SkyDome` (one-draw shader sky from a `SkySpec`: gradient, horizon glow, stars, aurora, swirl nebula, striped synthwave sun), `HorizonGrid` (endless additive grid with an outward pulse), and transient `Burst` (instanced voxel derez), `Shockwave` (floor ring), `LightPillar`. All run on the juice clock, so they freeze in hit-stop and crawl in slow motion. |
| `ocean.tsx` | Battleship's water: one sinh-spaced mesh from the boards to the horizon, five travelling waves (CPU twin `oceanHeight()` so ships ride the same swell), calm zones over the boards (12% swell: grid at y 0.06 stays above water at `OCEAN_Y`), Fresnel sky reflection, a desktop mirror pass (oblique-clipped; objects with `userData.noMirror` are hidden from it), sun or moon glitter (`OceanLook.moonDir`), crest foam, impact ripples (`OceanStore.ripple`) and oil slicks (`setSlicks`). Runs on the juice clock. |
| `ships.tsx` | Battleship's fleet: lofted hulls (flare, sheer, transom, boot-top and anti-fouling paint), class silhouettes, canvas-drawn decks, merged parts (~8 draws a ship), night lights, radar, waterline foam, and a shared patched shader for damage (`uHitX` scorched holes with glowing rims, `uChar` charring). BsArena3D's `ShipModel` floats them and stages the deaths: big ships break in two (clipping planes), cruisers and destroyers capsize, submarines sink to the sail. |
| `fire.tsx` | Battleship's fire (`FireSystem`): every fire on the board in three instanced GPU draws (flames additive, smoke alpha, sparks additive), animated entirely in shaders from the juice clock. Flames are anchored sheets whose shape comes from upward-scrolling fBm through a flame envelope, coloured **by intensity** (red edge, orange, yellow heart); smoke is near-black in linear light, dense over the fire and thinning as it climbs downwind. A `FireSpec` spreads along the hull (`dir`, `spread`) and has a `kind`: `ship` (tall, from the deck), `water` (low, wide, half the smoke), `wreck` (big, smoky). |
| `cycles.tsx` | Light Cycles' pieces: `CycleModel` (an extruded glossy shell hooding wheel drums whose faces are rings of light, a prone rider; merged once into one geometry per material, ~6 draws a cycle; reflections from a shared PMREM `RoomEnvironment`, no download), `TrailSystem` (every trail in one draw: walls carry their arc length `aS`, and the shader hides everything past each rider's `uHead`, so trails grow with the sprint and rewind for replays; white-hot top edge, energy flowing to the bike, hot near the head, the winner's wave), `GridFloor` (cell-exact grid, data pulses, the Zones tint from a `DataTexture`), `EdgeWall`, `Ridges`. |
| `lcmodel.ts` | Light Cycles as a timeline, no three.js: `riders(g, me)` rebuilds every rider's path (cells, an index offset `k0` that aligns paths to match ticks, how it went out - wall, trail, head-on, timed out - from the log's "is out at tick N"), `poseAt(rider, T)` for any float tick, `impactAt`, `nearMisses`, `territory`, the viewer's `options` (server `safe_moves`, or the same test client-side), and the per-viewer last-seen tick for the catch-up. |
| `chime.ts` | Owns the page's single `AudioContext`, unlocked on the first pointer or key press (`audioContext()`), and the your-move chime. |

Arenas: `LcArena3D.tsx` (Light Cycles: Tron: Legacy's Grid - the owner's
reference is the film's light cycles: glossy black shells over wheels
that are rings of light, trails as luminous walls, a black mirror
floor; see `cycles.tsx` and `lcmodel.ts`), `BsArena3D.tsx` (Battleship: a dusk sea with real waves, light
painted warships and lasting damage - see `ocean.tsx` and `ships.tsx`;
the owner found the night version too dark, lit from behind the hulls
read as silhouettes - keep the ships lit from the player's side and
their paint non-metallic), `DuelArena3D.tsx` (RPS: a floating stage in a nebula,
the four-beat reveal and the KO). `games.ts` lazy-loads
each arena so three.js stays in its own chunk, and owns the 3D host's
loading and error states. Check whether an arena already uses the juice and
atmos primitives before adding parallel machinery: extend the shared files
instead of forking per arena.

## Implementation rules and pitfalls

1. **Under `frameloop="demand"`, anything that moves must `invalidate()`
   every frame until it settles.** Nothing else will ask for frames; the
   Ticker only covers ambient motion. Mutating an effect or uniform through a
   ref does not invalidate on its own.
2. **Clamp delta, or read `juice.t`.** R3F passes `clock.getDelta()`
   unclamped, so the first frame after idle carries seconds and any
   `p += v * delta` jumps. Never create a `THREE.Clock` (deprecated r183).
3. **Write scripted beats as functions of `juice.t − start`.** Then hit-stop,
   slow motion, skip, catch-up replay and spectator replays reuse one
   deterministic code path. Camera, shake, flashes and titles keep real time.
4. **`ToneMapping` stays the composer's last child.** RPP forces the renderer
   to `NoToneMapping` while the composer is mounted.
5. **Animate only Bloom's `intensity`.** Threshold, smoothing, levels, radius
   and `mipmapBlur` are constructor args: changing them rebuilds the effect
   and its render targets. Set threshold and smoothing explicitly (the docs'
   defaults are not the effective ones).
6. **Never mount drei `<CameraShake>` beside `<CameraControls>`.** It waits
   for a `change` event camera-controls never fires and snaps the camera back
   to its mount-time rotation after the user orbits. Shake through
   `JuiceRig`'s focal offset.
7. **Respect the effect-merge limits.** One convolution effect
   (ChromaticAberration, SMAA) per pass, and a convolution effect next to a
   UV-transforming one (ShockWave, Glitch) splits the pass; `mergeMode="all"`
   with that pair throws. `ArenaPost` already holds ChromaticAberration, so
   prefer the geometry `Shockwave` ring over a screen-space wave.
8. **Keep postprocessing bursts mounted and toggle them** (Glitch mode,
   ShockWave `explode()`): mounting or unmounting an effect rebuilds passes
   and recompiles. Never add or remove lights (every material recompiles;
   pulse one light mounted at intensity 0). Toggle `visible` on persistent
   scene objects instead of remounting; short-lived keyed meshes like the
   `atmos.tsx` transients are fine.
9. **Instanced, one draw per particle family:** `Points` with a shader for
   sparks, raw `<instancedMesh>` for debris and voxels, a handful of sprites
   at most; additive, `depthWrite={false}`, `toneMapped={false}`, colour > 1.
10. **Lite profile on coarse pointers:** no reflector or transmission
    material (each renders the scene again), no composer MSAA, no film grain,
    DPR capped at 1.5, caps on simultaneous particles.
11. **drei `<Text>` fetches fonts from a CDN unless self-hosted.** Pass a
    self-hosted `font` and `characters`, pool labels, and put title cards in
    the DOM (`ImpactLayer`) instead.
12. **drei `PerformanceMonitor` misbehaves under demand rendering:** with a
    24 fps ticker its default bounds read every scene as slow and walk
    quality to zero in ~12 s. Measure frame time of rendered frames instead.
    `AdaptiveEvents` can swallow taps on touch boards: skip it.
13. `Sparkles` never invalidates (it only moves when something else renders);
    `Float` has `autoInvalidate`.
14. Handle `webglcontextlost`/`restored` (iOS drops contexts on backgrounding)
    and keep game state outside GPU buffers.

Details, recipes and source links: `references/r3f-techniques.md`.

## Accessibility

- **`prefers-reduced-motion` substitutes; it never deletes.** No shake, no
  slow motion, no push-ins or fly-ins; instead a colour pulse or outline on
  the cell, a cut or cross-fade, a soft fade on flashes and title cards,
  fewer and shorter particles. Keep the information: the colour change, the
  title, the sound and the buzz. (A brief freeze is not motion and may stay.)
- **WCAG 2.3.1: at most three flashes in any second.** A phone canvas is far
  above the 87,296 CSS px small-area allowance, so any full-canvas flash or
  bloom pulse counts. Route every large flash through `Juice.flash`, keep it
  low-contrast, and never strobe saturated red.
- **Never carry meaning in sound or vibration alone.** iOS has no web
  vibration, the ringer switch mutes Web Audio, and spectators who have not
  tapped hear nothing. Every cue has a visual twin.
- **Announce in a live region.** An `aria-live="polite"` ticker ("Cyan fires
  at C4: hit") gives screen readers, agents and chat the same story.
  `ImpactLayer` is `aria-hidden`, so title cards never count as the
  announcement. Keep keyboard play working.
- Shake should become a user-adjustable 0–100% setting (XAG 117); flashes,
  sound and haptics each get their own toggle where they diverge.

## Mobile web

- **iOS Safari has no Vibration API;** haptics are an Android Chrome extra
  and need prior sticky activation (`buzz` checks it). Do not depend on the
  iOS switch-input trick.
- **Web Audio needs a gesture unlock** (`chime.ts` does it on first
  pointer/key). On iOS the ringer switch mutes it: respect that, never set
  `audioSession.type = 'playback'`. Resume after backgrounding.
- **Low Power Mode caps iOS rAF at 30 fps.** Use delta time everywhere; treat
  a sustained ≤ 31 fps as low power, step to lite and stay there.
- **Budget fill rate and heat, not triangles.** DPR 3 is 2.59 Mpx per
  full-screen pass, DPR 1.5 is 0.65 Mpx; every pass and overlapping
  transparent layer multiplies it. Design for the sustained clock after
  15–30 minutes. Degrade cheapest first: DPR → bloom → ambient fps →
  particle cap → shadows.
- The canvas stays `touch-action: pan-y` (one finger scrolls the room)
  except in Move mode, which switches it to `none` (see `ArenaFrame`). iPhone has no element
  fullscreen: use a fixed overlay with safe-area padding.

Details: `references/mobile-audio-haptics.md`.

## Async presentation

- **Replay what the viewer missed,** compressed and in order, then hand over
  the turn. A per-viewer "last seen" marker (localStorage, keyed by game id)
  plus the server's logs (`shots`, `move_log`, `rounds`) is all it takes.
  Battleship replays each missed shot; Light Cycles fast-forwards ticks and
  slows only on crashes; the Duel replays the last reveal. Cap it at a few
  seconds with Skip, leave a resting last-move marker, land on "your move".
  A missed loss of the viewer's own replays with the full viewer-loss beat.
- **Honest presence:** lock pips from `awaiting`/`targets`, the duel's
  `thrown` booleans, "waiting since 1 m". Burn a fuse only in the last
  10–25% of a clock. Make "all locked" a visible beat.
- **Four-beat simultaneous reveal: lock → prime → flip → verdict.** A sealed
  token on commit, a four-beat chant at 100–120 BPM, both throws flip on one
  frame, a 300–500 ms hold, the clash, a named verdict. Update the HUD on the
  impact frame, not when the server frame arrives, or it spoils the reveal.
  Keep throws secret from spectators too.
- **Spectators get a director camera** (rule-based interest, tap a player to
  follow, return after a few idle seconds), both sides, and an honest,
  toggleable readout.
- **End on the deterministic deciding moment** (final shot, final crash,
  deciding throw), a stat line, the record, and a one-tap Rematch.

Details: `references/async-presentation.md`.

## Per-game playbooks (summary)

- **Battleship: dusk at sea, the board is the record.** A low sun, a
  peach-to-blue sky, light painted hulls lit from the player's side (the
  owner rejected dark night silhouettes), team-colour rim lights. Miss = small
  splash and a peg; hit = flash, fire and smoke that keep burning; sink = the
  hull surfaces, its lights flicker out, it pitches and goes under in 2–4 s,
  neighbours auto-mark. The sink is where the animation budget pays off.
- **Light Cycles: each tick plays as a sprint** (built 2026-11-13). The
  trails in growth order replay any tick (`lcmodel.ts`), so a resolved
  tick rides every cycle into its new cell together (~0.6 s), missed ticks
  replay fast-forwarded with Skip, a crash races into what it hit with the
  camera closing in and slow motion at the impact, a skimmed wall throws
  sparks, the winner's trail lights end to end. A crashed rider's trail
  stays (the server keeps it as a wall): dim it, never collapse it. The
  viewer's options float over their cells (safe chevron, magenta X for
  deadly, the queued turn lit; tap to steer), DOM tags de-overlap over the
  cycles, Zones tints the floor by who reaches each cell first, and a
  chase camera rides behind a cycle. High three-quarter camera by default:
  the horizon cannot show without flattening the board, so the world (sky,
  ridgelines) lives in the entry flight, crash close-ups and the chase cam.
- **RPS Duel: a spotlit duel scored like music.** Two pools of light, sealed
  tokens on lock, the chant, the same-frame flip, a quantized timbre per
  throw, round chips that stay as the pattern record. Best fit for the full
  synesthetic treatment.

Full tables and starting `Juice.hit` values per event and seat:
`references/game-playbooks.md`.

## Adding a new arena

1. Write the event table from the viewer's seat (did it / happened to them /
   spectator) before writing code.
2. Compose from the primitives: Canvas with `frameloop="demand"` and
   `useQuality`, `FirstFrame`, `Ticker`, `CameraControls` with `Framer` and
   `TouchControls`, the juice store with `JuiceRig` and `ArenaPost`, `Intro`,
   `SkyDome`, the board; `ArenaFrame` with `ImpactLayer` and `SoundToggle`.
3. Lazy-load it from `games.ts` like the other arenas so the loading and
   error states come for free.
4. Add the live-region ticker, keyboard play and the reduced-motion path.
5. Add a UI-suite scenario that opens it at desktop and phone sizes.

## Verification workflow

1. **Build:** `cd web && npm run build` (typechecks `shared` and `app`, then
   Vite). Then, from the repo root, `python3 web/scripts/emit-app.py` to emit
   `web/app/dist` into `src/app/`; commit `web/` and `src/app/` together.
2. **Test:** `cd web && npm test` runs the web UI suite (Playwright against
   the built app through a fake API; it exits non-zero on failure and writes
   screenshots to `web/tests/shots/`). The repo gates in AGENTS.md also apply:
   `npm run test:api` and `npm run check`.
3. **Screenshot at desktop and phone widths:** desktop 1280×860 (the suite
   default) and phone 390×844 with `hasTouch`/`isMobile`; add a
   `reducedMotion: 'reduce'` context for the still path. 3D is the default
   arena view; a stored `ac:lc3d`, `ac:bs3d` or `ac:duel3d` of `"0"` forces
   2D, so clear those keys. The entry sequence plays once per game per page
   session: preset `sessionStorage["ac-intro:<lc|bs|duel>:<id>"] = "1"` to
   skip it when you are not testing it. Reuse the suite's fake-API setup (add a scenario to
   `web/tests/ui.test.js` when the check is worth keeping; put throwaway
   scripts in the session scratchpad).
4. **Wait for the ready signal, then settle.** Headless Chromium renders
   WebGL in software, which is slow. Wait for the canvas
   (`#viewer .lc-3d-host canvas`, allow 20–30 s), then until
   `#viewer .arena3d-status` is hidden (the "Loading the 3D arena…" status,
   hidden when `FirstFrame` reports ready), then let the scene settle
   (~3 s covers the iris, the intro glide and a 2.3 s title card) before
   capturing. Software GL renders few frames (often under 10 a second), so
   wall-clock captures miss effects. To capture an effect mid-flight, give
   the page a virtual clock in an init script: patch `performance.now` and
   `requestAnimationFrame` so each frame advances exactly 33.3 ms however
   slowly it draws, pause the clock while a screenshot is taken, and wait
   for `performance.now() >= start + t` before each capture. Also force
   `preserveDrawingBuffer: true` on WebGL contexts in the harness (patch
   `HTMLCanvasElement.prototype.getContext`), or a canvas that is not
   redrawn during the capture comes out blank. DOM layers (title cards,
   iris, flash) still run on real time. Trigger state changes by mutating
   the fake API's state and waiting for the viewer's next poll (8 s).
5. **Look at every screenshot** at both widths before committing: open the
   PNGs, check the value hierarchy, legibility of the board under effects,
   that bloom is not washing out, that nothing clips at 390 px, and compare
   with the before state. Sample pixel colours where colour matters.
6. **Report in words,** including what headless cannot show: vibration,
   sound, the iOS silent switch, Low Power Mode, heat and real frame rates.
   Say so, and ask the owner to try it on a phone (Android Chrome for the
   buzz, an iPhone for sound and the switch).
