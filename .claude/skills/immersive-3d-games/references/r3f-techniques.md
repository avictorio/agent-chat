# R3F techniques: loop, clock, postprocessing, camera, particles, shaders, text

Read this when you write or change R3F code in `web/app/src/games/`: anything
that animates under `frameloop="demand"`, touches the `EffectComposer`, moves
the camera, spawns particles or writes a shader. Facts were checked against
the installed sources (three 0.187.0, @react-three/fiber 9.8.2, drei 10.7.9,
@react-three/postprocessing 3.2.2, postprocessing 6.39.6, camera-controls
3.1.2, maath 0.10.8, troika-three-text 0.52.5). Bundle sizes are esbuild
min+gzip measurements with three/react/R3F external.

## Contents

1. The demand loop and its traps
2. One game clock (the juice clock)
3. Postprocessing: tone mapping, live props, merging, bursts
4. Postprocessing cost tiers
5. Camera: shake, choreography, framing
6. Particles and destruction
7. Effect recipes
8. Shaders for the neon look
9. Animation helpers
10. Text, drei animators and demand mode
11. WebGL context loss

## 1. The demand loop and its traps

- R3F 9's loop does `let delta = state.clock.getDelta()` and passes it to
  every `useFrame` **unclamped**. In demand mode it renders only while
  `internal.frames > 0`, so the first frame after idle carries seconds of
  delta and any `p += v * delta` jumps
  ([loop.ts](https://github.com/pmndrs/react-three-fiber/blob/master/packages/fiber/src/core/loop.ts)).
  Clamp, or read the juice clock.
- `invalidate()` only requests a frame; several calls in one cycle make one
  render. Inside `useFrame` it sets `frames = 2`. Direct mutations (a ref, a
  uniform, a camera) need an explicit `invalidate()`; React prop changes on
  RPP effects call it for you, **mutating an effect through a ref does not**
  ([RPP util.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/util.tsx)).
- `useFrame(cb, priority)`: only priority > 0 takes over rendering. RPP's
  composer uses +1; drei `CameraControls` uses −1; negative priorities only
  order callbacks ([scaling-performance](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/scaling-performance.mdx)).
- `THREE.Clock` is `@deprecated since r183`; use `performance.now()` or the
  juice clock, never a new `Clock`
  ([Clock.js r187](https://github.com/mrdoob/three.js/blob/r187/src/core/Clock.js)).
- Mutate in `useFrame`, never `setState` per frame; reuse vectors; toggle
  `visible` instead of remounting (remounting recompiles buffers and
  materials) ([pitfalls](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/pitfalls.mdx)).
- R3F `<Canvas>` defaults: `dpr [1,2]`, `frameloop "always"`,
  `antialias: true`, `powerPreference: "high-performance"`, ACES Filmic tone
  mapping ([canvas.mdx](https://github.com/pmndrs/react-three-fiber/blob/master/docs/API/canvas.mdx)).
  The arenas override dpr, frameloop and MSAA via `useQuality`.

Rule of thumb: **every animator that is still moving calls
`state.invalidate()` that frame, and stops calling it when it settles.** The
`Ticker` (`arena3d.tsx`) supplies the ambient rate; nothing else may assume
frames will come.

## 2. One game clock (the juice clock)

The research recommended one shared mutable clock, updated first each frame,
that clamps delta and owns hit-stop and slow motion. The repo's version is
`Juice` + `JuiceRig` (`juice.tsx`):

- `Juice.hit(impact)` adds trauma, extends a hit-stop (`stop`, ms), starts
  slow motion (`slow`, s, at 0.25× easing back over the last 40%), kicks the
  post pulse, flashes (rate-limited), buzzes, plays SFX and raises a title.
- `JuiceRig` (inside the Canvas) advances `juice.t` by clamped real delta ×
  `juice.scale` (0 in hit-stop, 0.25 in slow motion), decays trauma and
  pulse, applies the shake, and invalidates while anything runs.
- `useJuice()` gives Canvas children the store; `useJuiceStore(still)`
  creates it per arena with the reduced-motion flag.

Which clock to read:

| Reads `juice.t` (slows and freezes) | Keeps real time |
|---|---|
| ship sinking, debris, particle `uTime`, derez voxels, tick-replay motion, `SkyDome`/`HorizonGrid`, `Burst`/`Shockwave`/`LightPillar` | camera moves and shake, UI flashes, title cards, the bloom/fringe impact pulse |
| ShockWave `speed = base * juice.scale` (the composer advances ShockWave, Glitch and Noise on raw delta) | drei `CameraControls` (fed raw delta: the camera keeps real speed through hit-stop, which is the desired feel) |

**Write scripted beats as functions of `juice.t − eventStart`,** not as
accumulated per-frame state. Pausing, skipping, replaying for spectators and
the "while you were away" catch-up then reuse the same code
deterministically. A 20-line tween array ticked from the clock covers fixed
beats (300 ms flashes, 2.5 s sinks, derez) with zero dependencies.

Hit-stop vs slow motion: hit-stop is a full freeze of game time on impact
(80–270 ms by tier) while shake and flash continue; slow motion eases to
0.2–0.35× for the decisive beat and eases back.

## 3. Postprocessing: tone mapping, live props, merging, bursts

**Tone mapping must be the last effect.** While `<EffectComposer>` is
mounted, RPP sets `gl.toneMapping = NoToneMapping` through a ref-counted
guard; postprocessing wants a `ToneMappingEffect` at the end of the chain
([EffectComposer.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/EffectComposer.tsx);
[README](https://github.com/pmndrs/postprocessing#readme)). Without it, the
arena loses tone mapping whenever the composer is mounted and looks different
from any no-composer tier. Modes: LINEAR 0, REINHARD 1, REINHARD2 2,
REINHARD2_ADAPTIVE 3, UNCHARTED2 4, CINEON 5, ACES_FILMIC 6, AGX 7, NEUTRAL 8.
`ArenaPost` uses NEUTRAL.

**Animate only Bloom's `intensity`.** In RPP `<Bloom>`, `luminanceThreshold`,
`luminanceSmoothing`, `mipmapBlur`, `radius`, `levels` and `resolution*` are
constructor args in a `useMemo`: changing any **rebuilds the BloomEffect and
its render targets**. Only `intensity`, `blendFunction` and `opacity` are
live ([Bloom.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/effects/Bloom.tsx)).
`ArenaPost` pulses `intensity` and the ChromaticAberration `offset` through
refs each frame.

**Set threshold and smoothing explicitly.** RPP's docs list 0.9 / 0.025, but
it passes `undefined` to the constructor, so the effective defaults are the
core's 1 / 0.03 ([BloomEffect.js](https://github.com/pmndrs/postprocessing/blob/main/src/effects/BloomEffect.js)).
Core defaults otherwise: `mipmapBlur` true, `radius` 0.85, `levels` 8;
`resolutionScale` is ignored with mipmapBlur.

**Merge rules decide the pass count.** `mergeMode="auto"` (default) packs
consecutive effects into one `EffectPass` and starts a new pass when a
convolution effect meets another convolution effect, or meets a
UV-transforming one, in either order.

- Convolution: ChromaticAberration, SMAA, Bokeh, RealisticBokeh.
- UV-transforming (`mainUv`): ShockWave, Glitch, Pixelation, LensDistortion.
- `mergeMode="all"` with ChromaticAberration plus ShockWave or Glitch throws
  "Effects that transform UVs are incompatible with convolution effects"
  ([EffectPass.js](https://github.com/pmndrs/postprocessing/blob/main/src/passes/EffectPass.js)).

So only one convolution effect fits per pass. `ArenaPost` already carries
ChromaticAberration; adding SMAA or a screen-space ShockWave/Glitch costs a
second full-screen pass. Prefer the geometry `Shockwave` ring from
`atmos.tsx`, or drop CA on the tier that gets the screen-space wave. A chain
like `[ShockWave, Glitch, Bloom, Vignette, Noise, ToneMapping]` merges into
one pass.

**Burst effects stay mounted.** Mounting or unmounting an effect rebuilds
passes and recompiles.

- Glitch: keep `<Glitch ref={g} active={false} />`; on a hit set
  `g.current.mode = GlitchMode.CONSTANT_WILD`, restore `DISABLED` after
  200–300 ms. Modes: DISABLED 0, SPORADIC 1, CONSTANT_MILD 2, CONSTANT_WILD 3.
- ShockWave: keep one mounted (`speed` 1.6, `maxRadius` 0.9, `waveSize`
  0.15, `amplitude` 0.04 as a start); on impact
  `sw.current.position.copy(p); sw.current.explode(); invalidate()`, then
  invalidate while `sw.current.active`. One instance = one epicentre, and the
  wave shows only while that point is in front of the camera
  ([ShockWaveEffect.js](https://github.com/pmndrs/postprocessing/blob/main/src/effects/ShockWaveEffect.js)).

Other composer facts: `multisampling` defaults to 4 on HalfFloat targets
(bandwidth-heavy; 0 on phones, and 0 with SMAA); the composer passes raw
delta to `composer.render(delta)`. three r187 also has
`WebGLRenderer.setEffects()` (built-in chain with automatic tone mapping),
not evaluated against RPP.

## 4. Postprocessing cost tiers

Reasoned from pass and texture-tap counts; no per-device timings exist.

| Cost | Effects | Tier |
|---|---|---|
| near-free once merged | Vignette, Noise, Scanline, BrightnessContrast, HueSaturation, ToneMapping | all |
| cheap UV warps | ShockWave, Glitch (perturbation map) | all, as impact pulses |
| moderate | Bloom with `mipmapBlur` (levels 4–5 on phones; level count barely matters with mipmapBlur) | all, or off on the lowest rung |
| pass-splitting | ChromaticAberration (3 taps, convolution) | desktop; `ArenaPost` keeps a tiny fringe on all tiers today, so mind the merge rule |
| heavy | SMAA (3 passes), DepthOfField, GodRays (60 samples), SSAO/N8AO, Outline, SelectiveBloom | desktop only, or never |
| bandwidth trap | `multisampling` on HalfFloat targets | 0 on phones (repo: 0 lite, 2 otherwise) |

Plain `Bloom` beats `SelectiveBloom` on cost; select by material instead.
Bundle: `EffectComposer + Bloom + Vignette` ≈ 28 KB gzip; adding CA, Noise,
ShockWave, Glitch, ToneMapping and SMAA ≈ 92 KB (mostly SMAA's textures).

## 5. Camera: shake, choreography, framing

**Never mount drei `<CameraShake>` with `<CameraControls>`.** CameraShake
overwrites `camera.rotation` with `initialRotation + noise` every frame and
refreshes `initialRotation` only on the default controls' `'change'` event.
camera-controls dispatches `controlstart`, `control`, `controlend`,
`transitionstart`, `update`, `wake`, `rest`, `sleep`, and **never `change`**.
After the user orbits, the shake snaps the camera back to its mount-time
orientation. It is also rotation-only and does not invalidate
([CameraShake.tsx](https://github.com/pmndrs/drei/blob/master/src/core/CameraShake.tsx);
[camera-controls](https://github.com/yomotsu/camera-controls#readme)).

Shake through `setFocalOffset`: it moves the camera and its look point
together without moving the orbit pivot and fires `update`, on which drei
invalidates ([CameraControls.tsx](https://github.com/pmndrs/drei/blob/master/src/core/CameraControls.tsx)).
`JuiceRig` does this. Untested: per-frame `setFocalOffset` during a user
drag (the official shake example offsets the target instead:
[effect-shake](https://github.com/yomotsu/camera-controls/blob/dev/examples/effect-shake.html),
presets 500 ms/freq 10/strength 0.5 and 1000 ms/10/1).

Choreography with camera-controls:

- Methods: `setLookAt`, `lerpLookAt`, `dollyTo`, `rotateTo`,
  `fitToBox(box, true, {paddingTop…})`, `fitToSphere`, `setFocalOffset`,
  `saveState`, `reset`, `stop`. Every method with `enableTransition`
  returns a Promise that **resolves on `rest`** (governed by
  `restThreshold`; `sleep` fires seconds later).
- Transitions are critically damped with `smoothTime` ("approximate time in
  seconds to reach the target"), not fixed-length tweens.
- In demand mode, schedule a render before starting a move:
  `invalidate(); requestAnimationFrame(() => ctl.dolly(1, true))`.
- **Race each await against a timer** so beats stay on schedule.
- For exact-duration eased moves (a 1.8 s orbit), drive
  `lerpLookAt(A…, B…, ease(t), false)` from the clock instead of damping.
- Let a tap skip: `stop()`, then restore the saved home.
- Disable input (`ctl.enabled = false`) during a scripted shot; restore after.

Intro recipe shape (research): snap to a high, far vista; one rAF; raise
`smoothTime` (~1.1) for the fly-in; `fitToBox` the arena; `saveState()` as
home. The repo's `Intro` does a lighter version: start high, far and swung
~50° round, then glide to the `Framer`-computed home with `smoothTime` 0.55.

Framing in `arena3d.tsx`: `fitHome(spanW, spanD, elevDeg, vfovDeg, aspect,
margin)` fits a board into the host aspect (perspective makes the near edge
widest); `Framer` re-applies home when the host's shape changes by more than
~8% (a phone rotating) but ignores small nudges; `goHome` returns the camera;
`TouchControls` makes one finger scroll the page or tap the board and two
fingers pinch/turn; `ArenaFrame` lets the wheel scroll the page unless
Ctrl/Cmd is held, and hosts Reset view and tool buttons.

## 6. Particles and destruction

Each mesh is a draw call; keep "no more than 1000 as the very maximum, and
optimally a few hundred or less"; instancing draws thousands in one call
([scaling-performance](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/scaling-performance.mdx)).
Pick by job:

- **`Points` + custom shader:** sparks, spray, embers, bubbles, in thousands.
- **Raw `<instancedMesh>`:** lit debris, hull shards, derez voxels (hundreds
  to ~2,000); `setColorAt` for tint. Avoid drei `<Instances>` at these counts
  (every instance is a React component).
- **Sprites:** a handful of billboards at most (one draw each).

Material for glowing particles: additive blending, `depthWrite={false}`,
`toneMapped={false}`, colour above 1 so threshold-1 bloom catches it.

GPU ballistic burst: bake `aDir`, `aDelay`, `aLife` (and `aSpin`, `aSeed`)
once; only `uT` changes per frame, fed from `juice.t − start` so it slows
and freezes with the clock:

```glsl
float t = max(uT - aDelay, 0.0);
float k = clamp(t / aLife, 0.0, 1.0);
vec3 p = uOrigin + aDir * t + vec3(0.0, -0.5 * uGravity * t * t, 0.0);
p.y = max(p.y, 0.0);                              // crude floor
vec4 mv = modelViewMatrix * vec4(p, 1.0);
gl_Position = projectionMatrix * mv;
gl_PointSize = uSize * (1.0 - k) * (300.0 / -mv.z);
vFade = step(0.0001, t) * (1.0 - k);
// frag: d = length(gl_PointCoord - 0.5); discard if d > 0.5; colour * vFade * (1 - 2d)
```

Repo primitives (`atmos.tsx`, all on the juice clock, all one draw, all
invalidate while alive and hide themselves at the end):

- `Burst` — derez into glowing voxels (`at`, `hex`, `box`, `count` 70,
  `power`, `piece`, `dur` 1.7 s, `rise`, `onDone`). CPU-integrated instanced
  boxes; fine at its default counts.
- `Shockwave` — a ring racing out over the floor (`radius`, `dur` 0.9 s,
  cubic ease-out, fading).
- `LightPillar` — a column of light where a rider fell or a duel was won.

Mount them per event (keyed), and cap simultaneous instances on phones.

Libraries only past these recipes: three.quarks (~35 KB gzip: emitters,
flipbooks, soft particles; soft particles need a depth texture, desktop
only). `@react-three/rapier` is **~843 KB gzip** of WASM: unjustified unless
debris must collide with real geometry.

## 7. Effect recipes

Starting values from the research; tune by eye.

| Effect | Recipe |
|---|---|
| Explosion | core flash: additive icosphere/billboard, colour ≈ (6,3,1), scale 0→1 over ≈120 ms ease-out, fade ≈250 ms. 150–400 `Points` sparks. 30–120 instanced debris with ballistic motion, spin, bounce. 6–20 soft smoke billboards. Screen layer: pulse, ring, trauma ≈0.6 |
| Shockwave ring | `RingGeometry` or a plane with `alpha = smoothstep(r-w,r,d)*(1-smoothstep(r,r+w,d))*(1-uProgress)`, additive, expo ease-out over 400–700 ms; flat on water/floor. Screen-space ShockWave only on big hits |
| Tron derez | 400–1,500 voxel centres precomputed (`MeshSurfaceSampler`, three r187 `examples/jsm`) in a hidden `InstancedMesh`. On death: 150 ms noise-threshold dissolve with a hot emissive edge ([Codrops dissolve](https://tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/)), then voxels at the cycle's matrix pushed outward with noise, upward drift and spin, shrinking to 0 over 0.8–1.5 s in team colour > 1. Stagger by `aDelay` from the impact point for a sweep. Collapse the trail wall by scaling Y to 0 |
| Ship sinking | hull group: sink Y with ease-in, pitch 15–35°, slight roll, over 2–4 s. Hide the underwater part with `material.clippingPlanes` + `gl.localClippingEnabled`, or tinted water. Splash: 300–800 upward `Points`, a ring, an expanding foam disc, then a bubble column for 1–2 s |
| Debris without an engine | semi-implicit Euler `v += g*dt; p += v*dt`; on contact `v.y *= -0.35; v.xz *= 0.7`; sleep below an epsilon. ~20 lines for ≤200 chunks |
| Light flash | one `pointLight` always mounted at intensity 0; pulse intensity |

## 8. Shaders for the neon look

Scrolling Tron floor, one material, no textures (`uPower` drives the
power-on):

```glsl
vec2 g = vUv * uDensity + vec2(0.0, uTime * uSpeed);
vec2 a = abs(fract(g - 0.5) - 0.5) / fwidth(g);   // anti-aliased lines
float line = 1.0 - min(min(a.x, a.y), 1.0);
gl_FragColor = vec4(uBase + uLine * line * 3.0 * uPower, 1.0);  // >1 blooms
```

- drei `<Grid infiniteGrid fadeDistance>` covers static grids;
  `HorizonGrid` (`atmos.tsx`) covers the endless outer grid.
- **Fresnel rim:** `pow(1.0 - max(dot(N, V), 0.0), 3.0)` added to emissive
  (patch `totalEmissiveRadiance` via `onBeforeCompile`, or drei
  `shaderMaterial()`).
- **Hologram:** rim + `0.5 + 0.5*sin(worldY*120.0 - uTime*8.0)` scanlines,
  additive, `depthWrite={false}`.
- **Heat haze:** a custom postprocessing `Effect` with `mainUv` offsetting UVs
  by scrolling noise inside a screen-space mask; merges with ShockWave/Glitch
  (and splits from CA).
- **Phone water:** 64×64 plane, 3–4 summed sines or Gerstner waves in the
  vertex shader, normals from `normalize(cross(dFdx(p), dFdy(p)))`, Fresnel
  sky tint, glints > 1. Evaluate the same wave on the CPU so hulls bob in
  agreement. Avoid `objects/Water.js` on phones (it re-renders the scene).
- **Gate by tier:** `MeshReflectorMaterial` renders the scene again from a
  mirrored camera (resolution 256 default); `MeshTransmissionMaterial`
  "causes an additional render pass of the scene". The repo skips the
  reflector on touch devices; a fake reflection or the scrolling grid
  replaces it.
- TSL/NodeMaterials belong to WebGPURenderer, which postprocessing 6 does not
  drive, and R3F 10 is alpha. Stay on GLSL `ShaderMaterial` /
  `onBeforeCompile`.

## 9. Animation helpers

| Tool | Gzip | Demand-mode behaviour | Use for |
|---|---|---|---|
| maath `easing.damp/damp3/dampC/dampE` | 0.9 KB (already via drei) | returns `true` while moving: `if (damp3(...)) invalidate()` | anything chasing a target: emissive colour, hover labels, ship pitch |
| `@react-spring/three` | 15.6 KB | self-invalidates (`Globals.assign({frameLoop:'demand'})`) | interruptible state-to-state transitions |
| GSAP core | 27.7 KB | manual: `timeline({ onUpdate: invalidate })` | only long multi-track intro timelines |
| framer-motion-3d | — | deprecated, React 18 only | ruled out on React 19 |
| tween array on `juice.t` | 0 | invalidates while any tween is active | fixed beats; deterministic for replays |

## 10. Text, drei animators and demand mode

- drei `<Text>` (troika, ~44 KB gzip) renders SDF glyphs in a worker and
  invalidates after syncing. **Without a self-hosted `font` it resolves
  fallback fonts from the jsdelivr CDN** (`unicode-font-resolver` data URL),
  so always pass a self-hosted `font` and a `characters` set, keep a pool of
  mounted labels and change their `text` rather than mounting new ones
  ([Text.tsx](https://github.com/pmndrs/drei/blob/master/src/core/Text.tsx);
  [troika](https://github.com/protectwise/troika/tree/main/packages/troika-three-text)).
- Title cards ("ROUND 1", "SUNK", "DEREZZED") belong in the DOM above the
  canvas: crisp at any DPR, outside postprocessing. `ImpactLayer` does this.
- drei `Float` has `autoInvalidate`; `Sparkles` never invalidates and only
  animates when something else renders; `Trail` updates in `useFrame`.

## 11. WebGL context loss

Mobile Safari loses contexts on quick backgrounding and under memory
pressure (iOS 17 reports; an R3F texture case on iPadOS 17.5.1)
([forum](https://discourse.threejs.org/t/context-lost-when-backgrounding-safari-on-ios-17-developer-beta-8/55772);
[R3F case](https://discourse.threejs.org/t/texture-is-causing-loss-of-context-in-ipados-ios-17-5-1-when-using-react-three-fiber/68643)).
In `onCreated`, listen for `webglcontextlost` / `webglcontextrestored` on
`gl.domElement`: `preventDefault()` on loss, pause the ticker and audio, show
"tap to resume"; remount the `<Canvas>` with a new `key` as the robust
fallback. Never keep game state only in GPU buffers. Reduce memory pressure:
dispose on unmount, one renderer per page, not one per game card. The 3D
host's error path (`fail3d` in `games.ts`) already turns a WebGL failure into
a message with a Reload button.
