# The shared 3D primitives: purpose and contract

Read this before composing an arena from the shared pieces or changing
one of them. **Re-read the file before relying on a signature named
here:** this page records what each piece is for and what it promises;
the code is the truth, and tunable values (rates, caps, defaults) are
cited by file on purpose. Paths are under `web/app/src/features/games/`.

## Layout

`three/` holds the primitives every arena builds on; `shared/` what every
game's 2D surfaces share (the catalog, cards, panel helpers, the chime);
each game has its own folder with its arena (`*Arena3D.tsx`), its 2D
panels and any pieces only it uses. `games.ts` (the host that loads each
arena) and the views the room opens stay at the top.

## `three/arena3d.tsx`: the Canvas frame

- `useQuality(still)` → `Quality { lite, dpr, ambientFps, msaa }`. `lite`
  is a coarse pointer (a phone or tablet): a lower DPR cap, a lower
  ambient rate and no composer MSAA; `still` (reduced motion) stops the
  ambient rate. The numbers are in the function. Keep new expensive
  features behind `q.lite` rather than inventing a second profile.
- `Ticker({ fps })` paces ambient frames under `frameloop="demand"`;
  nothing else may assume frames will come.
- `FirstFrame({ onReady })` calls `onReady` once `compileAsync` has built
  every program and a frame is drawn: the ready signal that hides
  "Loading the 3D arena…". (three.js skips objects whose shaders are
  still compiling, so the first frames can be empty.)
- `fitHome(spanW, spanD, elevDeg, vfovDeg, aspect, margin)` → `Home` fits a
  board into the host aspect (perspective makes the near edge widest).
  `Framer` re-applies home when the host's shape changes by more than a
  little (a phone rotating) and ignores small nudges; `goHome(ctl, home,
  smooth)` returns the camera.
- `TouchControls({ ctl })` + Move mode: on touch screens the camera
  ignores touch by default (one finger scrolls the page or taps the
  board); the frame's **Move** button hands touch to the scene (one finger
  turns, two pinch-zoom and pan, `touch-action: none`, iOS page zoom held
  off) until **Done**. Do not bring back two-finger camera gestures
  outside Move mode: a first finger that drifts hands the gesture to the
  browser, so they only worked when both fingers landed at once (and iOS
  zoomed the page). The mouse keeps drag-to-orbit.
- `ArenaFrame`: the box around a Canvas. The wheel scrolls the page unless
  Ctrl/Cmd is held (a trackpad pinch arrives as Ctrl+wheel); Reset view,
  the Move button, and overlay and tool slots.
- `useReducedMotion()` (live), `useCoarsePointer()`; types `Ctl`, `Home`,
  `Quality`.

## `three/juice.tsx`: the impact layer

- The `Juice` store: `useJuiceStore(still)` per arena, `JuiceProvider`,
  `useJuice()` inside the Canvas.
- `juice.hit(impact)`, with `Impact` fields `trauma` (added, capped at 1),
  `stop` (hit-stop, ms), `slow` (slow motion, s), `pulse` (bloom and fringe
  swell), `flash` / `flashA`, `buzz` (a `BUZZ` pattern), `sound` (one name
  or several), `soundDelay`, `title` (`{ big, small, tone: "good" | "bad" |
  "neutral", hex }`), `titleDelay`. Flashes go through `juice.flash`,
  which refuses a fourth within a second (WCAG 2.3.1).
- `juice.word(text, hex)`: one beat word (the Duel's count-in, Twenty
  Questions' YES/NO).
- `JuiceRig({ ctl, reach })` advances the clock `juice.t` (clamped delta ×
  `juice.scale`: 0 in hit-stop, a slow factor in slow motion that eases
  back), decays trauma and pulse, shakes through
  `CameraControls.setFocalOffset` (trauma², smooth value noise, amplitude
  scaled by camera distance so it reads the same on every board), and
  invalidates while anything runs. Its constants live in the file: tune
  there, not per arena.
- `ArenaPost({ q, bloom, threshold, smoothing, vignette, fringe })`: Bloom
  (intensity pulsed) → ChromaticAberration (offset pulsed) → Noise (not on
  lite) → Vignette → ToneMapping (last). Each arena passes its own bloom
  and threshold.
- `ImpactLayer({ juice, intro, ready })` (DOM over the canvas,
  `aria-hidden`): the flash, title cards, beat words and the entry iris
  (the world's colour until the scene is ready, then it opens and raises
  the world's name).
- `Intro({ ctl, homeRef, enabled, ready })`: the camera fly-in, placed
  after `Framer`. It plays on the first visit per game per page session
  (`useFirstVisit(key)`, sessionStorage `ac-intro:<key>`); a tap or click
  skips it and snaps home before the scene handles the press; reduced
  motion: no flight. Pose and timings are in the function.
- `SoundToggle`: sound and vibration share one toggle (`ac-sfx-muted`).
- Under `still`, shake, hit-stop, slow motion and the post pulse drop and
  flashes soften; titles, sound and buzz stay.

## `three/sfx.ts`: sound and vibration

- `sfx(name | name[], delay)`: synthesized Web Audio through a master gain
  and compressor, silent until the shared context is unlocked. The names
  are the `SfxName` type: boom, bigboom, splash, whistle, ping, derez,
  lock, charge, clash, shatter, win, lose, enter, beat (count-in kick),
  shoot, snip, tear, wrap, smash (RPS matchups, table thumps), buzzer
  (time ran out, wrong), whoosh (sprint, level, reveal), zap (sparks).
- `buzz(pattern)`: `navigator.vibrate` only when the toggle is on, the API
  exists and the page has sticky activation, all in try/catch.
- `BUZZ`: the named vibration patterns. Names and meanings:
  `game-feel.md` §5; values: the constant itself. Use the names, never
  inline arrays.

## `three/atmos.tsx`: sky, grid and transients

- `SkyDome({ spec, radius })` draws a `SkySpec` in one shader, no textures:
  a gradient (`top`, `mid`, `horizon`, `ground`), a horizon glow, stars,
  aurora, a swirl nebula, an optional striped synthwave `sun` and an
  optional soft `moon` disc with a halo (Battleship's setting sun).
- `HorizonGrid`: an endless additive grid fading to the horizon with an
  outward pulse, leaving a `hole` over the board.
- Transients: `Burst` (instanced voxel derez), `Shockwave` (a floor ring),
  `LightPillar` (a column where a rider fell or a match was won). Mount
  them keyed per event; each invalidates while alive and hides itself at
  the end; cap simultaneous ones on phones. Props and defaults: the file.
- Everything here runs on the juice clock, so it freezes in hit-stop and
  crawls in slow motion.

## `three/fire.tsx`: shader fire

`FireSystem({ fires, lite, still })` draws every fire on the board in
three instanced GPU draws (flames additive, smoke alpha, sparks additive),
animated in shaders from the juice clock. Used by Battleship's hits and
wrecks, the Two Truths campfire, the Corpse candle and the Werewolf
bonfire. A `FireSpec` spreads along a hull (`dir`, `spread`), has a
`kind` (`ship`: tall, from the deck; `water`: low, wide, half the smoke;
`wreck`: big, smoky) and a `heat` 0..1 that cools a fire to embers. The
recipe and why it is built that way: `r3f-techniques.md` §7, "Fire".

## `battleship/ocean.tsx`: Battleship's water

One sinh-spaced mesh from the boards to the horizon displaced by
travelling waves, with a CPU twin `oceanHeight()` so ships ride the same
swell; calm zones over the boards so the grid and markers stay crisp
above `OCEAN_Y`; Fresnel sky reflection, a desktop mirror pass
(oblique-clipped; objects with `userData.noMirror` are hidden from it),
sun or moon glitter (`OceanLook.moonDir`), crest foam, impact ripples
(`OceanStore.ripple`) and oil slicks (`setSlicks`). Runs on the juice
clock; reduced motion freezes it.

## `battleship/ships.tsx`: Battleship's fleet

Lofted hulls (flare, sheer, transom, boot-top and anti-fouling paint),
class silhouettes, canvas-drawn decks, merged parts (a handful of draws a
ship), night lights, radar, waterline foam, and a shared patched shader
for damage (`uHitX` scorched holes with glowing rims, `uChar` charring).
`BsArena3D`'s `ShipModel` floats them and stages the deaths: big ships
break in two (clipping planes), cruisers and destroyers capsize,
submarines sink to the sail.

## `lightcycles/cycles.tsx`: Light Cycles' pieces

- `CycleModel`: an extruded glossy shell hooding wheel drums whose faces
  are rings of light, a prone rider, merged into one geometry per
  material; reflections from a shared PMREM `RoomEnvironment` (no
  download).
- `TrailSystem`: every trail in one draw. Walls carry their arc length
  `aS` and the shader hides everything past each rider's `uHead`, so
  trails grow with the sprint and rewind for replays; a white-hot top
  edge, energy flowing to the bike, the winner's wave.
- `GridFloor` (cell-exact grid, data pulses, the Zones tint from a
  `DataTexture`), `EdgeWall`, `Ridges`.

## `lightcycles/lcmodel.ts`: Light Cycles as a timeline

No three.js. `riders(g, me)` rebuilds every rider's path (cells, an index
offset `k0` aligning paths to match ticks, and how it went out - wall,
trail, head-on, timed out - from the log's "is out at tick N");
`poseAt(rider, T)` for any float tick; `impactAt`, `nearMisses`,
`territory`; the viewer's `options` (the server's `safe_moves`, or the
same test client-side); `seenTick` / `setSeenTick` for the catch-up.

## `shared/chime.ts`: the audio context

Owns the page's single `AudioContext`: `unlockChime()` runs on the first
pointer or key press (`RoomShell`), and `audioContext()` returns null
until then. Also the your-move chime (`ac-chime-muted`).

## `games.ts`: the 3D host

- `KIND3D` maps a game type to its host class and a dynamic import, so
  three.js stays in lazy chunks; Light Cycles, Battleship and the Duel
  have their own loaders beside it. A scene takes `Arena3dProps`
  (`shared/viewctx.ts`: `g`, `me`, `aspect`, `onReady`, `registerCommit`,
  and a few game-specific callbacks). `registerCommit` lets the page's tap
  fire the scene's commit beat (`lock` + `BUZZ.commit`).
- The host shows "Loading the 3D arena…" until `onReady`. Without WebGL
  (`webglOk()`), or on a WebGL error from the scene (`fail3d`), a one-line
  note replaces the scene; a chunk-load or other error gets a Reload
  button (a deploy usually deleted the chunk the page was built against).
  `fail3d` then rebuilds the view, and a view adds its flat panels when
  `ctx.flat()` says so (no WebGL 2, or the host failed), never on
  `webglOk()` alone.
