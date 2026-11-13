# Spend every effect on the reveal

All three arenas share one emotional arc (commit, anticipate, reveal, linger), and both the design budget and the effects budget belong on the reveal, scaled by how decisive the moment is. Routine events get small, fast, consistent feedback. Slow motion, camera push-ins and long hit-stop are reserved for moments the game can detect as match-deciding, which is how Smash's Finish Zoom and Tekken 7's slow-motion camera work. In this app the arc matters even more than usual, because all three games are asynchronous and agent-paced: a Light Cycles tick defaults to 120 s, a Duel round waits up to 180 s, and an agent's wake-to-act cycle runs one to two minutes. Players spend most of a match waiting, so the feel lives in three places: the arrival, the replay of what the viewer missed, and the reveal. Immersion needs an arrival sequence that combines camera motion, a light-and-fog "power-on" and a sound swell in the first ~3 s, then a world that breathes slowly and answers events. It should be built on a near-black, two-team-colour neon value structure in which light lines define silhouettes and bloom is selective. On three 0.187 / R3F 9 / drei 10 / RPP 3 the implementation rests on four shared primitives:

- one game clock with clamped delta, hit-stop and slow-motion scale;
- a mutable effects bus that pulses live effect uniforms and calls `invalidate()`;
- trauma shake through `CameraControls.setFocalOffset`;
- GPU-driven particle bursts at one draw call per effect family.

It also needs four repo fixes:

- add `<ToneMapping>` as the composer's last child, because the composer forces `NoToneMapping`;
- animate only Bloom's `intensity`, because its other props rebuild the effect;
- never mount drei `<CameraShake>` beside `<CameraControls>`;
- clamp R3F's unclamped delta.

Phones are bound by fill rate and heat, not triangles. iOS Safari has no Vibration API, no element fullscreen and a 30 fps cap in Low Power Mode, so haptics are an Android-only extra and every cue must also exist in light and sound. Most per-event numbers below are starting values derived from fighting-game, Bevy, Android and WCAG anchors. None were measured on this app's target phones.

## Three duels share one arc: commit, anticipate, reveal, linger

### MDA names the target, and the opponent supplies the challenge

MDA splits a game into mechanics ("the particular components of the game, at the level of data representation and algorithms"), dynamics ("the run-time behavior of the mechanics acting on player inputs and each others' outputs over time") and aesthetics, the emotional responses the player feels. Designers work from mechanics outward and players experience aesthetics first ([MDA paper](https://course.khoury.northeastern.edu/cs5150f14/readings/hunicke_mda.pdf)). The paper's eight aesthetics are Sensation, Fantasy, Narrative, Challenge, Fellowship, Discovery, Expression and Submission, and it names time pressure and opponent play as sources of Challenge ([MDA paper](https://course.khoury.northeastern.edu/cs5150f14/readings/hunicke_mda.pdf); [Wikipedia: MDA framework](https://en.wikipedia.org/wiki/MDA_framework)). For these three games the target set is clear:

- **Challenge** comes from the opponent, a human or an agent.
- **Fellowship** comes from playing inside a chat room with spectators.
- **Sensation** comes from juice.
- **Battleship also targets Discovery**, the uncovering of a hidden fleet.

Jenova Chen's flow work argues for dynamic difficulty that keeps players between anxiety and boredom ([Chen thesis abstract](https://jenovachen.info/abstract)). Difficulty tuning hardly applies to player-versus-player duels, where the matched opponent sets the difficulty. **The flow lever left is pacing**: turn clocks and round lengths short enough that nobody waits long enough to lose interest.

Raph Koster's theory locates fun in mastering learnable patterns. Boredom sets in when no pattern is visible ([Koster, A Theory of Fun](https://www.raphkoster.com/gaming/atof/theoryoffun.pdf)). That is RPS's design risk. Without visible history it collapses into coin-flipping. The fix is a permanent, physical round tally in the arena: what each player threw, round by round, so there is a pattern to read and exploit.

On feedback loops, MDA describes Monopoly's leader pulling away as positive feedback. Battleship has a mild positive loop (hits reveal more of the fleet), while Light Cycles rounds and best-of RPS have none ([MDA paper](https://course.khoury.northeastern.edu/cs5150f14/readings/hunicke_mda.pdf)). No rubber-banding is needed. Instead, stage rising tension: "last ship", "match point", "two riders left".

### Game feel here lives around discrete commits, not real-time input

Steve Swink defines game feel as "real-time control of virtual objects in a simulated space, with interactions emphasized by polish". Researchers point out that this definition excludes turn-based games ([Wikipedia: Game feel](https://en.wikipedia.org/wiki/Game_feel); [Pichlmair & Johansen](https://arxiv.org/pdf/2011.09201)). In this codebase, all three games are discrete-commit games, so moment-to-moment steering never drives the feel:

- **Light Cycles** is "turn-based Tron the whole room plays". A tick resolves when every living rider has moved or its clock expires (default 120 s, allowed 30 s–24 h). A missed move sends the bike straight.
- **Duel** rounds resolve the moment both throws are in, with a 180 s anti-stall deadline. The throws stay secret until resolution.
- **Battleship** is turn-based, with a timestamped `shots` log.

(All three from `AGENTS.md`, games sections.)

The feel therefore concentrates in four places: the commit acknowledgement, the anticipation beat, the reveal and the aftermath. The core loops make this concrete:

| Game | Core loop |
|---|---|
| Battleship | aim → commit → wait → reveal → consequence |
| Light Cycles | pick a direction → lock → wait for the tick → the tick plays out as motion → near-miss or crash |
| RPS | choose → hidden lock → both locked → chant → simultaneous flip → verdict |

In each loop the reveal is the emotional peak.

One technique transfers from slot-machine presentation: decelerate, and land the deciding element last ([XboxHub](https://www.thexboxhub.com/volatility-and-difficulty-curves-what-game-designers-borrow-from-slot-maths/), low-authority source). Hidden odds manipulation does not transfer. The same writing notes that players accept tension when they understand the rules behind it, and that argues against any hidden pity mechanics in a competitive game.

### Juice is layered response, and its strongest techniques have numbers

"Juice It or Lose It" (Jonasson and Purho, 2012) took a plain Breakout clone and layered on tweening, squash and stretch, particles, screen shake and sound until it felt alive ([GDC Vault](https://gdcvault.com/play/1016487/Juice-It-or-Lose)). Jan Willem Nijman's "The Art of Screenshake" applied about 30 small tweaks to a dull shooter ([YouTube](https://www.youtube.com/watch?v=AJdEqssNZ-U)). They included:

- muzzle flash;
- hit pause;
- camera kick;
- screen shake;
- **permanence**, meaning debris and smoke that stay ([DK Liao breakdown](https://dkliao.itch.io/the-art-of-screenshake-recreation/devlog/451576/quick-breakdown-of-all-the-effects)).

The talk ends with "meaning (game over screen)" and slow motion ([Bayreuth GxD 10](https://medienwissenschaft.uni-bayreuth.de/wp-content/uploads/GxD-10-Game-Feel.pdf)). The counterweight is Lisa Brown's "The Nuance of Juice" (2016), which moved the question from how much juice to when to use it ([Game Developer](https://gamedeveloper.com/design/video-indies-resist-the-urge-to-juice-it-or-lose-it-)).

**Trauma-based shake** comes from Squirrel Eiserloh's GDC 2016 talk, and it works as follows:

- Keep a trauma value in [0,1].
- Derive shake as **trauma² or trauma³**. Cubing turns trauma 0.3/0.6/0.9 into 3%/22%/73% shake.
- Drive each axis from smoothed Perlin noise, which the talk says is "WAY better than random".
- In 3D, shake yaw, pitch and roll plus x/y/z offsets ([Eiserloh slides](http://www.mathforgameprogrammers.com/gdc2016/GDC2016_Eiserloh_Squirrel_JuicingYourCameras.pdf)).

Bevy's official example of the same model uses these constants ([Bevy source](https://raw.githubusercontent.com/bevyengine/bevy/main/examples/camera/2d_screen_shake.rs)):

| Constant | Value | Bevy's comment |
|---|---|---|
| Trauma exponent | 2 | |
| Decay | 0.5/s | full trauma gone in 2 s |
| Max angle | 10° | |
| Max translation | 20 px | "low enough displacement to not be distracting" |
| Noise speed | 20 | |
| Trauma per event | 0.4 | |
| Noise seeds | one per channel | |

**Hit-stop** has concrete fighting-game numbers. Street Fighter V freezes for **8/12/16 frames (≈133/200/267 ms)** on light, medium and heavy hits ([Capcom Fighters Network](https://game.capcom.com/cfn/sfv/column/131545)). Smash's hitlag grows with damage and is capped at 20 frames in Melee and 30 frames from Brawl on ([SmashWiki: Hitlag](https://www.ssbwiki.com/Hitlag)).

**Cinematic treatment is gated on decisiveness** in every case found:

- Smash's Finish Zoom fires only when the game calculates a game-winning KO ([SmashWiki](https://www.ssbwiki.com/Finish_Zoom)).
- Ultimate's roughly one second of slow motion plays only when a last stock is lost ([SmashWiki](https://www.ssbwiki.com/Slow_motion)).
- Tekken 7's slow-motion camera fires when both players are low and trade at once ([Kotaku](https://kotaku.com/a-tekken-7-round-so-close-it-needs-two-slow-mo-cams-1797576157)).

Platform haptics guidance makes the same point about repetition. Apple: an effect can feel right occasionally "but become tiresome when it plays frequently" ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)). Android: very frequent events should get very subtle effects ([Android haptics principles](https://developer.android.com/develop/ui/views/haptics/haptics-principles)).

Together these anchors give a five-tier event ladder. Every row below is a starting value derived from the anchors above, not a published number for these games:

| Tier | Events | Trauma added | Hit-stop | Slow motion | Haptic (Android) | Screen layer |
|---|---|---|---|---|---|---|
| Tick | cell hover, UI tap | 0 | 0 | none | none (10–15 ms only if rare) | none |
| Small | Battleship miss, own lock-in, RPS round won or lost | +0.15–0.25 | 0–60 ms | none | 20 ms | local flash at the cell only |
| Medium | Battleship hit, Light Cycles near-miss | +0.3–0.4 | 80–130 ms (≈ SFV light, 8F) | none | 30–40 ms | bloom pulse |
| Large | ship sunk, rider derezzed | +0.6–0.8 | 200–270 ms (≈ SFV 12–16F) | none unless decisive | `[40,60,40]` | bloom pulse + ShockWave ring |
| Decisive | last ship, last rider, match-winning throw | +0.8, once | 200–270 ms, then slow motion | scale 0.2–0.35 for 0.5–1 s (Smash ≈1 s) | win `[60,80,120]`; loss a single soft 30 ms | one rate-limited flash, stinger |

The 2D shake limits need adjusting for a perspective camera over a grid. A rotational shake swings distant cells much further than near ones, so start with:

- roll ≤ 1–2°;
- yaw and pitch ≤ 0.5–1°;
- a small translation;
- decay of 1.0–1.6/s, so the board is readable again within a second.

Shake the 3D camera only. The HUD, the selected cell and the turn indicator never shake.

Consistency doubles as learnability. Apple's rule is that each haptic needs "a clear, causal relationship" with its cause and must never be reused for the opposite outcome ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)). So "you hit them" and "you were hit" get different signatures, and so do your ship sinking and theirs.

Fire the sound, haptic and flash on the impact frame, which is the start of hit-stop. Keep small and medium sequences under a second. Let a 2–4 s match-end sequence accept a tap to skip. Make defeat dignified: a desaturated side and a gentle cue, never a long losing animation.

### Each game needs its own anticipation, impact and aftermath

| Game | Anticipation | Impact | Aftermath (permanence) |
|---|---|---|---|
| Battleship | Reticle tightens on the cell, then a shell arc with a falling whistle (300–600 ms) | Splash on a miss. On a hit: flash, fire, hit-stop and shake | Miss peg. Scorch decal plus fire and smoke that keep burning. A sunk hull and its surrounding cells stay marked |
| Light Cycles | Lock pips per rider, then the tick plays out as motion with a proximity glow as a head nears a wall | Derez burst plus hit-stop | The dead rider's trail collapses or remains as a dim scar. The survivor's trail flares |
| RPS | A four-beat chant with a fist-pump squash on each beat and a quickening heartbeat bed | Both throws flip on the same frame and collide with squash/stretch and a flash | Score pip and round chip fill and stay, forming the pattern record Koster's point calls for |

Permanence matters most in Battleship because the board is the game's record. A scorch mark that stays is both juice and information. GamePigeon's Sea Battle is the reference: a hit gives haptic feedback, a slight shake and smoke rising from the cell, and a fully hit ship appears with the dots around it filled in ([allthings.how](https://allthings.how/how-to-play-sea-battle-on-imessage/)).

## Arrival, breath and light make a scene feel like a world

### The first three seconds need motion, a reveal and sound together

Shipped games treat the opening view as a composed establishing shot. The level-design "vista" is a wide shot right after the start that shows the main landmarks ([Tuts+: Views and Vistas](https://code.tutsplus.com/level-design-views-and-vistas--cms-25036a); [TV Tropes: Video Game Vista](https://TVTropes.org/pmwiki/pmwiki.php/Main/VideoGameVista)). Industry guidance counts loading as part of the intro: "a long, boring loading will hurt the user's experience as much as a bad tutorial would" ([Game Developer](https://www.gamedeveloper.com/design/how-to-create-immersive-game-intros)).

Psychedelic games grow the world in front of the player:

- Rez levels begin as flat wireframe and grow more complex ([Giant Bomb: Rez](https://giantbomb.com/rez/3030-17578/)).
- Tetris Effect builds anticipation with a metronome before light-particle rays sweep the screen ([New Game Network](https://newgamenetwork.com/article/2181/tetris-effect-review)).
- Journey's palette follows an authored curve meant to "guide the players' emotions" ([CGW](https://www.cgw.com/Publications/CGW/2012/Volume-35-Issue-4-June-July-2012/Mysterious-Journey.aspx)).

The lesson is that **arrival needs three ingredients at once**: the camera travels into the space, light or fog uncovers it, and a sound swells on the same beat. A page load has none of the three. No source gave a frame-by-frame recipe, so the timeline below is an inference built from these patterns:

| Time | Visual | Audio | Implementation note |
|---|---|---|---|
| 0–0.3 s | The DOM overlay fades out from the scene's fog or background colour, never white | The tap that started entry unlocks the AudioContext | The repo's `FirstFrame` already runs `compileAsync` and lifts the loading layer only once shaders are built (`web/app/src/games/arena3d.tsx`). Start the sequence from its `onReady` |
| 0.3–2.5 s | Ease-out fly-in from a high, wide vista to the play camera. Fog density eases from thick to normal | Filter sweep or swell on the ambient bed | `CameraControls.setLookAt(..., true)` with a raised `smoothTime` (recipe below) |
| 1.0–2.5 s | Emissive light lines power on outward from the focal point, Tron-style | The swell peaks as the camera settles | Ramp a shared `uPower` uniform on grid and trim materials, plus light intensities |
| 2.5–4 s | Arena name card, then the HUD slides in and input unlocks | A short sting | HTML or CSS overlay, not 3D text |
| Any time | A tap skips to the end. Repeat entries in a session use a 1 s version. Reduced motion gets a cross-fade with the same light and sound reveal | | |

One caveat for the light ramp. While the composer is mounted, the renderer runs with `NoToneMapping`, and no note verified whether RPP's `ToneMapping` effect honours `renderer.toneMappingExposure`. Ramp uniforms, lights and fog that the app owns, instead of relying on exposure.

### Idle scenes should breathe slowly and answer events

Two shipped games show the pattern:

- Rez's environments "move and fluctuate with the beat" ([Giant Bomb](https://giantbomb.com/rez/3030-17578/)).
- Tetris Effect's team built most of its visuals from particles because particles respond well to music. They alternated excitement and relaxation, with "the music and the visuals ramping up and down". They tuned visuals to stay out of gameplay's way and added an option for players "who want to see less" ([Unreal Engine interview](https://www.unrealengine.com/en-US/developer-interviews/how-tetris-effect-became-a-modern-work-of-art)).

Translated into a working rule, layer idle motion by frequency and size:

- **Slow, large, low-contrast motion reads as breathing.** Examples: a sea swell, sky drift, emissive intensity oscillating ±10–20% over 3–8 s.
- **Medium motion** such as embers, motes and sparks belongs in the periphery.
- **Fast or bright motion** happens only in answer to an event.

**Reactive beats busy.** A ripple runs from a placed ship. A grid pulse spreads from a Light Cycles turn. Arena lights flick toward whoever just locked in. Each of these costs nothing while nothing happens, which suits `frameloop="demand"`.

Permanence also tells the story to latecomers. Burning wrecks, scorch marks and a tally built into the arena let a spectator who joins halfway read the match from the scene alone.

The repo already paces ambient motion with a `Ticker` that invalidates at 30 fps, at 24 fps on touch devices and at 0 under reduced motion (`arena3d.tsx`). That is the right ceiling for the breathing layer. Event animations request every frame while they run.

### Neon grammar: near-black, two team hues, light lines as silhouette

Tron: Legacy reduces to a few rules:

- Light is the one unifying design element. "Light lines" wrap the interiors, streets and buildings (production designer Darren Gilford, [NPR](https://www.npr.org/transcripts/132211816)).
- The light cycle's silhouette is a single line from the rider through both wheels ([Fast Company](https://www.fastcompany.com/1707968/how-tron-legacy-light-cycle-designers-made-sexiest-coolest-vehicle-ever)).
- Two colours dominate: "very desaturated metallic light blue and heavy orange". The orange ranges from saturated yellow to a darker reddish hue ([Pushing Pixels](https://www.pushing-pixels.org/?p=3196)).
- The Tron: Ares Grid was inspired by circuit boards ([ILM](https://www.ilm.com/tron-ares-david-seager-interview-ilm-vfx/)).

Synthwave adds a midnight-navy base, electric magenta, cyan, violet and sunset orange, chrome highlights, and a magenta or cyan perspective grid ([daisyUI Trends](https://trends.daisyui.com/trend/synthwave-outrun/)). One prompt library gives sample values: **#1A0B33** deep violet, **#8E2470** magenta, **#FF7A3C** sunset orange, **#FF4FA3** grid pink, with the horizon about 70% down the frame ([SlideSpeak](https://slidespeak.co/slide-design-prompts/prompts/outrun)). It also has a horizontally striped yellow-to-red sun on the horizon ([Medium](https://medium.com/@cywjoel/outrun-the-aesthetic-deconstructed-dbd3cd8679b7)). These synthwave sources are trend pages, not art-direction postmortems.

The "trippy" lineage shows that simple geometry plus audiovisual sync carries the effect:

- Rez's graphics are spare wireframe ([LABoral](https://laboralcentrodearte.org/?p=15590)), and it quantized every shot and explosion to play in time and in key with the music ([PlayStation Blog](https://blog.eu.playstation.com/2017/10/20/classic-levels-deconstructed-tetsuya-mizuguchi-musician-adam-freeland-dissect-rez-infinites-area-5)).
- Beat Saber's lights are hand-authored events in two semantic colours that resolve to each environment's primary and secondary colour ([BSMG wiki](https://bsmg.wiki/mapping/basic-lighting.html)).
- Thumper's fast environment forced the visuals to prioritise clear cues ([Game Developer](https://gamedeveloper.com/design/how-i-thumper-i-uses-striking-visuals-to-complement-gameplay-at-every-turn)).

The shared grammar this implies for all three arenas has five parts:

1. **A value hierarchy.** Background darkest (5–10% luminance), play surface a step brighter, team light lines brightest, and an HTML HUD brightest of all, outside postprocessing. A grayscale screenshot should still show every critical shape.
2. **One hue per side.** Cyan versus amber is complementary and survives the common red-green deficiencies.
3. **A second channel for identity.** Never encode a team by colour alone: solid versus dashed trails, different hull light patterns, HUD labels.
4. **Rim or Fresnel light instead of fill light,** to separate silhouettes from the dark.
5. **One reserved accent for danger or decisiveness,** in white or hot magenta, not red.

Fog colour should equal the horizon colour so far geometry dissolves into the sky. Emissive lines should never fog out completely.

"Trippy" means hue drift, flowing particles and pulses at the beat (1–2 Hz at 60–120 BPM). It does not mean strobing. Polybius's hands-on coverage still called it "sensory overload" ([Push Square](https://www.pushsquare.com/news/2017/05/hands_on_polybius_is_a_playstation_vr_sensory_overload_befitting_urban_legend)).

Glow must be selective. The RPP docs say a `luminanceThreshold` of 1 means nothing glows by default, so only materials you choose (`emissiveIntensity` above 1 with `toneMapped={false}`) bloom ([RPP bloom docs](https://github.com/pmndrs/react-postprocessing/blob/master/docs/effects/bloom.mdx); [three.js forum](https://discourse.threejs.org/t/what-does-the-threshold-in-unrealbloompass-means-and-how-to-make-a-color-just-pass-that-threshold-a-bit-how-to-calculate-the-threshold-for-a-color/60984)). **The repo is inconsistent here.** `LcArena3D.tsx` uses `luminanceThreshold={1}`. `BsArena3D.tsx` uses `luminanceThreshold={0.72} luminanceSmoothing={0.3}`, so any bright lit surface (pegs, moon specular) blooms whether or not anyone chose it.

### Sound is half of the world

Chrome has applied its autoplay policy to Web Audio since Chrome 71. A context created before a user gesture starts "suspended" and must be resumed in a tap handler ([Chrome: Autoplay policy](https://developer.chrome.com/blog/autoplay); [Chrome: Web Audio and games](https://developer.chrome.com/blog/web-audio-autoplay)). So the "Play" or "Watch" tap that starts the arrival should also create and resume the shared context, and on iOS play a one-sample silent buffer ([Cinevva tutorial](https://app.cinevva.com/tutorials/web-audio-api-games), lower authority).

The repo's `web/app/src/games/chime.ts` is the seed to grow from. It already has:

- one module-level `AudioContext` unlocked on the first pointer or key press;
- a procedural two-note chime (659.25 Hz and 880 Hz, peak gain 0.12, about 0.5 s);
- a persisted mute under `ac-chime-muted`;
- try/catch around every call.

Four ideas from game audio practice shape the SFX layer:

- **Build impacts from layers**: a transient, a body, a tail and an optional sweetener. Small offsets between transient and body change perceived size ([Lior Tega](https://www.liortega.com/post/first-person-shooter-gun-sound-design)).
- **Duck music and ambience on important cues,** by about −6 to −9 dB ([mdskills](https://www.mdskills.ai/skills/game-audio), lower authority).
- **Quantize like Rez.** Schedule non-critical musical flourishes (lock-ins, placements, grid pulses) on the next 8th or 16th note of a 100–120 BPM clock read from `ctx.currentTime`, pitched to a pentatonic scale. The input-acknowledgement click must stay immediate.
- **Synthesize instead of downloading:**

| Sound | Recipe |
|---|---|
| Impact transient | 5–20 ms high-passed noise |
| Thump body | sine whose pitch drops from 180 to 50 Hz over 150 ms |
| Rumble tail | low-passed noise with a falling cutoff over 0.5–2 s |
| Splash | band-passed noise plus a downward "bloop" |
| Cycle engine | two detuned sawtooth oscillators through a low-pass, pitch and cutoff tracking speed |
| Derez | noise burst plus a falling arpeggio |

```ts
// sfx.ts: grows out of chime.ts; one context, four buses, a limiter and ducking
let ctx: AudioContext | null = null;
const bus: Record<"music" | "amb" | "sfx" | "ui", GainNode> = {} as never;
export function unlock() {                       // call inside the Play/Watch pointerdown
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    void ctx.resume();
    const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination); s.start();       // iOS: a real (silent) sound inside the gesture
    if (!bus.sfx) {
      const lim = ctx.createDynamicsCompressor(); lim.connect(ctx.destination);
      const master = ctx.createGain(); master.connect(lim);
      (["music", "amb", "sfx", "ui"] as const).forEach((k) => { bus[k] = ctx!.createGain(); bus[k].connect(master); });
    }
  } catch { /* audio is optional */ }
}
export function duck(holdS = 0.6) {              // ≈ -8 dB, ~30 ms attack, ~500 ms release
  if (!ctx) return; const t = ctx.currentTime;
  for (const g of [bus.music.gain, bus.amb.gain]) {
    g.cancelScheduledValues(t); g.setTargetAtTime(0.4, t, 0.01); g.setTargetAtTime(1, t + holdS, 0.15);
  }
}
document.addEventListener("visibilitychange", () => { try { document.hidden ? ctx?.suspend() : ctx?.resume(); } catch {} });
```

Each arena gets an ambient bed:

- **Battleship:** ocean wash (noise with a slow low-frequency oscillator on its cutoff) and a foghorn or bell every 20–40 s.
- **Light Cycles:** a sub drone, a slow arpeggio pad and electrical hum.
- **RPS:** arena room tone and a heartbeat-like pulse that quickens through the countdown.

For off-screen events (an enemy shell landing, the rival cycle passing), use `PannerNode` with `panningModel = "HRTF"` on desktop and `equalpower` or `StereoPannerNode` on phones ([tproger](https://tproger.ru/translations/web-audio-intro)). Keep the listener tied to the camera and the distance roll-off gentle.

## Four shared primitives carry the R3F implementation

### One game clock clamps delta and owns hit-stop and slow motion

R3F 9's loop computes `let delta = state.clock.getDelta()` and hands it to every `useFrame` subscriber with **no clamp**. In demand mode, rendering continues only while `internal.frames > 0` ([R3F loop.ts](https://github.com/pmndrs/react-three-fiber/blob/master/packages/fiber/src/core/loop.ts)). So the first frame after an idle period carries seconds of delta, and any `p += v * delta` animation jumps. None of the arena `useFrame` callbacks clamp it today (a grep of `BsArena3D.tsx` and `LcArena3D.tsx` finds no `Math.min` on delta).

Three more loop facts shape the design:

- `invalidate()` only requests a frame. Called inside `useFrame` it sets `frames = 2`.
- Only a `useFrame` priority above 0 takes over rendering. RPP's composer uses +1 and drei's `CameraControls` uses −1, and a negative priority only orders callbacks ([R3F loop.ts](https://github.com/pmndrs/react-three-fiber/blob/master/packages/fiber/src/core/loop.ts); [R3F scaling-performance](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/scaling-performance.mdx)).
- `THREE.Clock` is `@deprecated since r183` in favour of `THREE.Timer` ([three r187 Clock.js](https://github.com/mrdoob/three.js/blob/r187/src/core/Clock.js)). Use `performance.now()` in app code.

One shared mutable clock, updated first each frame, solves all of this:

```ts
// gameTime.ts: one clock for the whole arena
import { invalidate, useFrame } from "@react-three/fiber";
export const gt = { scale: 1, target: 1, hitStopUntil: 0, dt: 0, realDt: 0, t: 0, busy: 0 };
export const slowMo = (s = 0.25) => { gt.target = s; invalidate(); };
export const normalSpeed = () => { gt.target = 1; invalidate(); };
export const hitStop = (ms = 100) => { gt.hitStopUntil = performance.now() + ms; invalidate(); };

export function GameClock() {
  useFrame((state, raw) => {
    const real = Math.min(raw, 1 / 20);                               // clamp idle gaps and tab-switch spikes
    gt.scale += (gt.target - gt.scale) * (1 - Math.exp(-8 * real));   // ease into and out of slow motion
    const frozen = performance.now() < gt.hitStopUntil;
    gt.realDt = real;
    gt.dt = frozen ? 0 : real * gt.scale;
    gt.t += gt.dt;
    if (frozen || Math.abs(gt.target - gt.scale) > 1e-3 || gt.busy > 0) state.invalidate();
  }, -10);                                                           // runs first; negative = no render takeover
  return null;
}
```

Different consumers read different clocks:

| Reads `gt.dt` / `gt.t` (slows and freezes) | Reads `gt.realDt` (keeps real speed) |
|---|---|
| Ship sinking, debris, particle `uTime`, derez voxels, tick-replay motion | Camera moves and shake, UI flashes, title cards |
| `shockwave.speed = base * gt.scale` (the composer advances ShockWave, Glitch and Noise on raw delta) | Bloom and chromatic-aberration impact pulses (a flash should not linger in slow motion) |

Write scripted beats as functions of `gt.t − eventStart`, not as accumulated per-frame state. Then pausing, skipping and replaying for spectators are all deterministic, and the "while you were away" replay (covered under async play) reuses the same code. `gt.busy` is a reference count that animators increment while they run, so the clock keeps frames coming above the ambient ticker.

### An effects bus pulses live uniforms and never touches rebuilding props

**Missing tone mapping.** While `<EffectComposer>` is mounted, RPP 3.2.2 sets `gl.toneMapping = NoToneMapping` through a ref-counted guard ([RPP EffectComposer.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/EffectComposer.tsx)). The postprocessing README says tone mapping should instead come from a `ToneMappingEffect` placed at the end of the chain ([postprocessing README](https://github.com/pmndrs/postprocessing#readme)). R3F's `<Canvas>` defaults to ACES Filmic ([R3F canvas.mdx](https://github.com/pmndrs/react-three-fiber/blob/master/docs/API/canvas.mdx)). So both arenas currently lose tone mapping whenever their composer is mounted, and they look different from any no-composer fallback tier. Add `<ToneMapping mode={ToneMappingMode.AGX} />` (or `ACES_FILMIC`) as the last child. The modes are LINEAR 0 to NEUTRAL 8, with AGX at 7 ([ToneMappingMode.js](https://github.com/pmndrs/postprocessing/blob/main/src/enums/ToneMappingMode.js)). Expect to retune emissive intensities afterwards, because HDR highlights will compress.

**Bloom props that rebuild.** In RPP's `<Bloom>`, the props `luminanceThreshold`, `luminanceSmoothing`, `mipmapBlur`, `radius`, `levels` and `resolution*` are constructor arguments inside a `useMemo`. Changing any of them **reconstructs the BloomEffect and its render targets**. Only `intensity`, `blendFunction` and `opacity` are live ([RPP Bloom.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/effects/Bloom.tsx)).

There is also a documentation conflict. RPP's docs table lists `luminanceThreshold` 0.9 and smoothing 0.025, but RPP passes `undefined` through to the constructor, so the effective defaults are the core library's 1 and 0.03 ([BloomEffect.js](https://github.com/pmndrs/postprocessing/blob/main/src/effects/BloomEffect.js)). Always set them explicitly.

Two more traps sit in the same files:

- Mutating an effect through a ref does **not** invalidate. Only prop changes do ([RPP util.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/util.tsx)).
- The composer passes R3F's raw delta to `composer.render(delta)`.

Merge rules decide pass count. `mergeMode="auto"` packs consecutive effects into one `EffectPass`, and starts a new pass only where a convolution effect (ChromaticAberration, SMAA) meets a UV-transforming one (ShockWave, Glitch, Pixelation, LensDistortion) ([RPP EffectComposer.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/EffectComposer.tsx)). `mergeMode="all"` with ChromaticAberration plus ShockWave or Glitch throws "Effects that transform UVs are incompatible with convolution effects" ([EffectPass.js](https://github.com/pmndrs/postprocessing/blob/main/src/passes/EffectPass.js)).

The phone chain `[ShockWave, Glitch, Bloom, Vignette, Noise, ToneMapping]` merges into a single pass. Adding ChromaticAberration forces a second, so keep it on the desktop tier.

```tsx
// fx.ts + Post.tsx: one decaying impact bus, no React state per frame
export const fx = { flash: 0, aberr: 0 };
export function impact(s = 1) { fx.flash = Math.max(fx.flash, s); fx.aberr = Math.max(fx.aberr, s); invalidate(); }

function Post({ phone }: { phone: boolean }) {
  const bloom = useRef<BloomEffect>(null!); const ca = useRef<ChromaticAberrationEffect>(null);
  useFrame((state) => {
    const k = Math.exp(-10 * gt.realDt);                 // k≈10/s → ~95% gone in 300 ms
    fx.flash *= k; fx.aberr *= k;
    bloom.current.intensity = 1.2 + 3 * fx.flash;         // live uniform: no rebuild
    ca.current?.offset.set(0.006 * fx.aberr, 0.003 * fx.aberr);
    if (fx.flash > 0.01 || fx.aberr > 0.01) state.invalidate();
  });
  return (
    <EffectComposer multisampling={phone ? 0 : 4}>
      <Bloom ref={bloom} mipmapBlur levels={phone ? 4 : 7} luminanceThreshold={1} luminanceSmoothing={0.03} intensity={1.2} />
      {!phone && <ChromaticAberration ref={ca} offset={[0, 0]} radialModulation modulationOffset={0.2} />}
      <Vignette darkness={0.6} offset={0.3} />
      <ToneMapping mode={ToneMappingMode.AGX} />
    </EffectComposer>
  );
}
```

Burst effects stay mounted and are triggered through refs:

- **Glitch:** keep `<Glitch ref={g} active={false} />` mounted. On a hit, set `g.current.mode = GlitchMode.CONSTANT_WILD`, then restore `DISABLED` after 200–300 ms. Never mount and unmount it, because that rebuilds passes and recompiles ([RPP Glitch.tsx](https://github.com/pmndrs/react-postprocessing/blob/master/src/effects/Glitch.tsx)).
- **ShockWave:** keep one `<ShockWave ref={sw} speed={1.6} maxRadius={0.9} waveSize={0.15} amplitude={0.04} />` mounted. On impact: `sw.current.position.copy(worldPoint); sw.current.explode(); invalidate()`. Then invalidate each frame while `sw.current.active` is true. One instance holds one epicentre, and the wave only shows while that point is in front of the camera ([ShockWaveEffect.js](https://github.com/pmndrs/postprocessing/blob/main/src/effects/ShockWaveEffect.js)).

The cost ranking below is reasoned from pass and texture-tap counts in the source. No per-device timings were found:

| Cost | Effects | Tier |
|---|---|---|
| Near-free once merged | Vignette, Noise, Scanline, BrightnessContrast/HueSaturation, ToneMapping | All |
| Cheap UV warps | ShockWave, Glitch (needs a perturbation map) | All, as impact pulses |
| Moderate | Bloom with `mipmapBlur` (luminance pass plus down/up chain; `levels` 4–5 on phones) | All, or off on the lowest rung |
| Pass-splitting | ChromaticAberration (3 taps, convolution) | Desktop |
| Heavy | SMAA (3 passes), DepthOfField, GodRays (60 samples by default), SSAO/N8AO, Outline, SelectiveBloom | Desktop only, or never |
| Bandwidth trap | `multisampling` (default 4) on HalfFloat targets | 0 on phones (the repo already sets 0 on lite and 2 otherwise) |

Measured bundle costs ([npm @react-three/postprocessing](https://www.npmjs.com/package/@react-three/postprocessing)): `EffectComposer + Bloom + Vignette` came to ≈28 KB gzip. Adding ChromaticAberration, Noise, ShockWave, Glitch, ToneMapping and SMAA brought it to ≈92 KB gzip, mostly SMAA's embedded lookup textures.

three r187 also ships `WebGLRenderer.setEffects()`, a built-in effect chain that applies tone mapping and colour space automatically ([r187 WebGLRenderer.js](https://github.com/mrdoob/three.js/blob/r187/src/renderers/WebGLRenderer.js)). It is worth watching but was not evaluated against RPP.

### Shake goes through CameraControls, and choreography goes through its promises

Do not use drei's `<CameraShake>` with `<CameraControls>`. Its mechanics explain why:

- `<CameraShake>` overwrites `camera.rotation` with `initialRotation + noise` every frame.
- It refreshes `initialRotation` only on the default controls' `'change'` event ([drei CameraShake.tsx](https://github.com/pmndrs/drei/blob/master/src/core/CameraShake.tsx)).
- camera-controls 3.1.2 dispatches `controlstart`, `control`, `controlend`, `transitionstart`, `update`, `wake`, `rest` and `sleep`, and **never `change`** ([camera-controls README](https://github.com/yomotsu/camera-controls#readme)).

So after the user orbits, the shake snaps the camera back to its mount-time orientation. `<CameraShake>` is also rotation-only and does not invalidate.

The fix is a trauma accumulator applied through `setFocalOffset`. The focal offset moves the camera and its look point together without moving the orbit pivot, and it fires `update`, on which drei's wrapper calls `invalidate()` ([drei CameraControls.tsx](https://github.com/pmndrs/drei/blob/master/src/core/CameraControls.tsx)). camera-controls' own shake example takes a similar route, offsetting the target with gradient noise and a `sineOut` decay. Its presets are 500 ms/frequency 10/strength 0.5 and 1000 ms/10/1 ([camera-controls effect-shake](https://github.com/yomotsu/camera-controls/blob/dev/examples/effect-shake.html)).

```ts
// shake.ts: Eiserloh trauma model on real time
const s = { trauma: 0, t: 0, scale: 1 };                    // scale = user's 0–1 shake setting
export const addTrauma = (a: number) => { s.trauma = Math.min(1, s.trauma + a); invalidate(); };
const n1 = (t: number, k: number) =>                        // cheap smooth 1D noise (summed sines)
  0.5 * Math.sin(t * 1.0 + k * 12.99) + 0.3 * Math.sin(t * 2.17 + k * 78.23) + 0.2 * Math.sin(t * 4.03 + k * 37.72);
export function useShake(ctl: RefObject<CameraControlsImpl>) {
  useFrame(() => {
    if (s.trauma <= 0 || !ctl.current) return;
    s.t += gt.realDt;
    s.trauma = Math.max(0, s.trauma - 1.6 * gt.realDt);     // ~0.6 s from full
    const amp = 0.35 * s.trauma * s.trauma * s.scale;       // world units at the focal plane; tune per scene
    ctl.current.setFocalOffset(amp * n1(s.t * 22, 1), amp * n1(s.t * 22, 2), 0, false);
    if (s.trauma === 0) ctl.current.setFocalOffset(0, 0, 0, false);
  });
}
```

How `setFocalOffset` behaves when called every frame during a user drag was not tested.

For choreography, camera-controls offers `setLookAt`, `lerpLookAt`, `dollyTo`, `rotateTo`, `fitToBox(box, true, {paddingTop…})`, `setFocalOffset`, `saveState`, `reset` and `stop`. Every method with `enableTransition` returns a Promise that resolves on `rest`. Transitions are critically damped with `smoothTime` ("approximate time in seconds to reach the target") rather than fixed-length tweens ([camera-controls src](https://github.com/yomotsu/camera-controls/blob/dev/src/CameraControls.ts); [rest-and-sleep example](https://yomotsu.github.io/camera-controls/examples/rest-and-sleep.html)). In demand mode R3F recommends scheduling a render before starting a move: `invalidate(); requestAnimationFrame(() => controls.dolly(1, true))` ([R3F scaling-performance](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/scaling-performance.mdx)).

```ts
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function intro(ctl: CameraControlsImpl, arena: THREE.Object3D) {
  ctl.enabled = false; const sm = ctl.smoothTime;
  await ctl.setLookAt(0, 90, 160, 0, 0, 0, false);                 // vista: high and far (snap)
  invalidate(); await new Promise((r) => requestAnimationFrame(r)); // avoid one giant first delta
  ctl.smoothTime = 1.1;
  await Promise.race([ctl.setLookAt(30, 22, 48, 0, 0, 0, true), wait(2600)]);
  ctl.smoothTime = 0.6;
  await ctl.fitToBox(arena, true, { paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 });
  ctl.saveState(); ctl.smoothTime = sm; ctl.enabled = true;         // "home" = this framing; reset(true) returns
}
```

Three refinements complete the recipe:

- **Race each await against a timer** so beats stay on schedule.
- **For exact-duration eased moves,** such as a 1.8 s orbit, drive `lerpLookAt(A…, B…, ease(t), false)` from the clock instead of damping.
- **Let a tap skip the sequence:** call `stop()`, then restore the saved state.

drei feeds raw delta into `controls.update`, so the camera keeps real speed through hit-stop and slow motion. That is the desired feel.

### Particles and destruction run on the GPU, one draw call per family

R3F's guidance is that each mesh is a draw call, with "no more than 1000 as the very maximum, and optimally a few hundred or less". Instancing puts thousands of objects in one call ([R3F scaling-performance](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/scaling-performance.mdx)). Its pitfalls page adds:

- mutate in `useFrame`, never `setState`;
- reuse vectors;
- toggle `visible` instead of remounting, because remounting recompiles buffers and materials ([R3F pitfalls](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/pitfalls.mdx)).

Changing the number or type of lights forces every material program to recompile ([three.js manual](https://threejs.org/manual/#en/how-to-update-things)). So keep one `pointLight` mounted at intensity 0 per arena and pulse it.

Pick the primitive by job:

- **`Points` with a custom shader:** sparks, spray and embers, in the thousands.
- **Raw `<instancedMesh>`:** lit debris, hull shards and derez voxels, hundreds to about two thousand. Avoid drei `<Instances>` at these counts, because every instance is a React component.
- **Sprites:** a handful of billboards at most.

The ballistic burst bakes per-particle attributes once and advances a single uniform:

```glsl
// burst.vert: only uT changes per frame; feed uT = gt.t - start so it slows and freezes with the clock
attribute vec3 aDir; attribute float aDelay; attribute float aLife;
uniform float uT; uniform vec3 uOrigin; uniform float uGravity; uniform float uSize;
varying float vFade;
void main() {
  float t = max(uT - aDelay, 0.0);
  float k = clamp(t / aLife, 0.0, 1.0);
  vec3 p = uOrigin + aDir * t + vec3(0.0, -0.5 * uGravity * t * t, 0.0);
  p.y = max(p.y, 0.0);                                   // crude floor
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (1.0 - k) * (300.0 / -mv.z);
  vFade = step(0.0001, t) * (1.0 - k);
}
// burst.frag: round, additive, HDR colour (>1) so threshold-1 bloom catches it
// float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(uColor * vFade * (1.0 - 2.0 * d), 1.0);
// material: transparent, blending={AdditiveBlending}, depthWrite={false}, toneMapped={false}
```

These starting recipes come from the R3F visual-techniques research. Treat them as tunable values, not published numbers:

| Effect | Recipe |
|---|---|
| Explosion | Core flash: an additive icosphere or billboard with colour ≈(6,3,1), scaling 0→1 over ≈120 ms ease-out and fading over ≈250 ms. 150–400 `Points` sparks. 30–120 instanced debris chunks with ballistic motion, spin and a bounce. 6–20 soft smoke billboards. Screen layer: `impact(1)`, ShockWave, `addTrauma(0.6)` |
| Shockwave ring | `RingGeometry` or a plane with `alpha = smoothstep(r-w,r,d)*(1-smoothstep(r,r+w,d))*(1-uProgress)`, additive, scaling with an expo ease-out over 400–700 ms. Lay it flat on water or floor. Use the screen-space ShockWave only on large hits |
| Tron derez | Precompute 400–1,500 voxel centres with `MeshSurfaceSampler` (three r187 `examples/jsm`, [three r187 addons](https://github.com/mrdoob/three.js/tree/r187/examples/jsm)) in a hidden `InstancedMesh`. On death: a 150 ms noise-threshold dissolve with a hot emissive edge (the [Codrops dissolve](https://tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/) approach), then show the voxels at the cycle's matrix and push them outward with noise, upward drift and spin, shrinking to 0 over 0.8–1.5 s in team colour above 1. Stagger by `aDelay` from the impact point for a deresolve sweep. Collapse the trail wall by scaling Y to 0. One draw call plus the ring |
| Ship sinking | Animate the hull group: sink Y with ease-in, pitch 15–35°, a slight roll, over 2–4 s. Hide the underwater part with `material.clippingPlanes` plus `gl.localClippingEnabled`, or with tinted water. Splash: 300–800 upward `Points`, a ring and an expanding foam disc, then a bubble column for 1–2 s |
| Debris without an engine | Semi-implicit Euler: `v += g*dt; p += v*dt`. On contact: `v.y *= -0.35; v.xz *= 0.7`, sleeping below an epsilon. About 20 lines for at most 200 chunks |

Libraries are justified only past what these recipes cover. three.quarks (≈35 KB gzip) adds emitters, flipbooks, behaviours and soft particles ([three.quarks](https://github.com/Alchemist0823/three.quarks)). Soft particles need a depth texture, so enable them on desktop only. `@react-three/rapier` costs **≈843 KB gzip** of WASM ([npm](https://www.npmjs.com/package/@react-three/rapier)). That is unjustified unless debris must collide with real geometry.

### Shaders, animation libraries and text complete the toolkit

A scrolling Tron floor needs one material and no textures:

```glsl
uniform float uTime, uDensity, uSpeed, uPower; uniform vec3 uLine, uBase; varying vec2 vUv;
void main() {
  vec2 g = vUv * uDensity + vec2(0.0, uTime * uSpeed);
  vec2 a = abs(fract(g - 0.5) - 0.5) / fwidth(g);         // anti-aliased lines
  float line = 1.0 - min(min(a.x, a.y), 1.0);
  gl_FragColor = vec4(uBase + uLine * line * 3.0 * uPower, 1.0);  // >1 blooms; uPower drives the power-on
}
```

drei's `<Grid infiniteGrid fadeDistance>` covers static grids ([drei Grid.tsx](https://github.com/pmndrs/drei/blob/master/src/core/Grid.tsx)).

The other shader looks are short recipes:

- **Fresnel rim:** `pow(1.0 - max(dot(N, V), 0.0), 3.0)` added to emissive.
- **Hologram:** the rim plus `0.5 + 0.5*sin(worldY*120.0 - uTime*8.0)` scanlines, with additive blending and `depthWrite={false}`.
- **Phone water:** a 64×64 plane with 3–4 summed sines or Gerstner waves in the vertex shader, normals from `normalize(cross(dFdx(p), dFdy(p)))` and a Fresnel sky tint. Evaluate the same wave function on the CPU so hulls bob in agreement with the water.

Two drei materials re-render the whole scene and must be gated by tier:

- **`MeshReflectorMaterial`** renders from a mirrored camera at `resolution` 256 by default ([drei source](https://github.com/pmndrs/drei/blob/master/src/core/MeshReflectorMaterial.tsx)). The repo already skips it on touch devices.
- **`MeshTransmissionMaterial`** "causes an additional render pass of the scene" ([drei docs](https://github.com/pmndrs/drei/blob/master/docs/shaders/mesh-transmission-material.mdx)).

TSL and NodeMaterials belong to WebGPURenderer, which pmndrs postprocessing 6 does not drive ([three.js manual](https://threejs.org/manual/en/webgpurenderer)), and R3F 10 is still in alpha ([newreleases](https://newreleases.io/project/npm/@react-three/fiber/release/10.0.0-alpha.6)). Stay on GLSL `ShaderMaterial` and `onBeforeCompile` for now.

| Animation tool | Gzip | Demand-mode behaviour | Use for |
|---|---|---|---|
| maath `easing.damp/damp3/dampC/dampE` | 0.9 KB (already installed via drei) | Returns `true` while moving, so `if (damp3(...)) invalidate()` | Anything chasing a target: emissive colour, hover labels, ship pitch ([maath](https://github.com/pmndrs/maath)) |
| `@react-spring/three` | 15.6 KB | Self-invalidates through `Globals.assign({frameLoop:'demand'})` | Interruptible state-to-state transitions ([react-spring three](https://github.com/pmndrs/react-spring/tree/main/targets/three)) |
| GSAP core | 27.7 KB | Manual: `timeline({ onUpdate: invalidate })` | Only long multi-track intro timelines ([npm gsap](https://www.npmjs.com/package/gsap)) |
| framer-motion-3d | n/a | Deprecated, React 18 only | Ruled out on React 19 ([npm](https://npmjs.com/package/framer-motion-3d)) |
| 20-line tween array on `gt.t` | 0 | Invalidates while any tween is active | Fixed beats: 300 ms flashes, 2.5 s sinks, derez. Deterministic for replays |

For text, drei `<Text>` (troika, ≈44 KB gzip) renders SDF glyphs in a worker and calls `invalidate()` after syncing ([drei Text.tsx](https://github.com/pmndrs/drei/blob/master/src/core/Text.tsx)). Without a `font` it resolves fallback fonts from **jsdelivr** ([troika-three-text](https://github.com/protectwise/troika/tree/main/packages/troika-three-text)). So always pass a self-hosted font and a `characters` set, keep a pool of mounted labels, and change their `text` instead of mounting new ones.

Title cards such as "ROUND 1", "FIGHT" and "SUNK" belong in HTML and CSS above the canvas. That keeps them crisp at any DPR and outside postprocessing. Two drei animators interact with demand mode: `Float` has `autoInvalidate`, while `Sparkles` never invalidates and only animates when something else renders ([drei Sparkles](https://github.com/pmndrs/drei/blob/master/src/core/Sparkles.tsx); [drei Float](https://github.com/pmndrs/drei/blob/master/src/core/Float.tsx)).

## Phones set the budget: fill rate, heat and missing APIs

### Budget pixels and passes before triangles

A typical 1080×2400 Android phone reports DPR ≈3 at a CSS viewport of about 360×800. That is **2.59 Mpx per full-screen pass at DPR 3, against 0.65 Mpx at DPR 1.5**, a 4× difference that every postprocessing pass and every overlapping transparent particle layer multiplies. This arithmetic, together with R3F's defaults (`dpr [1,2]`, `antialias`, `powerPreference:"high-performance"`, `frameloop:"always"`; [R3F canvas.mdx](https://github.com/pmndrs/react-three-fiber/blob/master/docs/API/canvas.mdx)), makes the DPR cap the highest-leverage setting.

The other public limits are rough. A community guide puts draw calls under 200 on mobile and 500 on desktop, triangles under 500K and 2M, and the 60 fps budget at under 4 ms of JavaScript and 10 ms of GPU ([3Lens](https://3lens.vercel.app/guide/features/performance)). These are blog-level heuristics, and no device-measured budgets for named mid-range phones turned up.

Two platform throttles set hard ceilings:

- **iOS Safari throttles `requestAnimationFrame` to 30 fps in Low Power Mode,** described by a WebKit engineer as intentional ([WebKit bug 215745](https://bugs.webkit.org/show_bug.cgi?id=215745); [Motion](https://motion.dev/blog/when-browsers-throttle-requestanimationframe)).
- **Sustained clocks after 15–30 minutes of play** are what to design for, not peak clocks ([abratabia](https://abratabia.com/mobile-browser-performance/battery-and-thermal.php), lower authority).

| Budget item | Phone ("lite": `(pointer: coarse)`) | Desktop |
|---|---|---|
| DPR cap | 1.5, stepping to 1.25 then 1.0 under load (repo: `[1, 1.5]`) | 1.75 (repo: `[1, 1.75]`) |
| Draw calls | ≤100–200, instanced | ≤500 |
| Visible triangles | ≤100–300K | ≤2M |
| Composer | `multisampling={0}`, Bloom (`mipmapBlur`, `levels` 4–5) plus one merged pass | Adds ChromaticAberration and optionally SMAA (with `multisampling={0}`) |
| Ambient render | Ticker at 24 fps, 0 under reduced motion (repo) | 30 fps (repo) |
| Event animation | Every frame while `gt.busy > 0` | Same |
| Expensive materials | No reflector or transmission. Use a fake reflection or the scrolling grid | `MeshReflectorMaterial` at 256 |
| Particles | Hard cap on simultaneous count; small additive sprites with `depthWrite={false}` | Higher caps, soft particles |

Two pmndrs facts support the composer row. With `mipmapBlur`, the bloom level count barely affects cost because the working buffers shrink fast ([postprocessing bloom demo](https://pmndrs.github.io/postprocessing/manual/demos/light-shadow/bloom)). Plain `Bloom` outperforms `SelectiveBloom`, and SMAA users should set `multisampling={0}` ([RPP docs](https://react-postprocessing.docs.pmnd.rs/effects/bloom)).

### Adapt from measured frame time, not drei's defaults

drei's `PerformanceMonitor` samples rendered frames every 250 ms over 10 iterations, with `bounds` of `[40,60]` (or `[60,100]` above 100 Hz). It fires `onDecline` when more than 75% of samples fall below the lower bound (drei 10.7.9, `web/node_modules/@react-three/drei/core/PerformanceMonitor.js`). **Under demand mode with a 24 fps ticker, it reads every scene as slow.** It declines every 2.5 s and walks `factor` from 0.5 to 0 in about 12.5 s, whatever the GPU's real headroom. There are two ways out:

- Pass `bounds={() => [ticker*0.8, ticker*0.95]}` and measure only during bursts.
- Better: measure the frame *time* of the frames that do render (an exponential moving average). Step down after N seconds above 70–80% of the frame interval, and cap oscillation with `flipflops={3}` plus an `onFallback` ([R3F scaling-performance](https://github.com/pmndrs/react-three-fiber/blob/master/docs/advanced/scaling-performance.mdx)).

`AdaptiveDpr` and `AdaptiveEvents` do nothing until something calls `regress()`. `AdaptiveEvents` disables raycasting while regressed, which can swallow taps on a tap-to-act board, so skip it on touch.

detect-gpu returns tiers 0–3 (≥15/30/60 fps). Its gfxbench source data "stopped updating in December 2025", and it fetches benchmarks from unpkg unless `benchmarksURL` is self-hosted ([detect-gpu](https://github.com/pmndrs/detect-gpu)). The repo's `(pointer: coarse)` heuristic plus a first-second frame-time probe is enough for picking a starting rung.

The ladder, cheapest change first:

1. DPR 1.5 → 1.25 → 1.0.
2. Bloom off.
3. Ambient ticker 24 → 15 → 0.
4. Particle cap halved.
5. Shadows off.

Treat a sustained rate of 31 fps or below under a free-running loop on iOS as Low Power Mode, step to lite, and stop trying to step back up.

Mobile Safari loses WebGL contexts on quick backgrounding and under memory pressure. Reports cover iOS 17 and an R3F texture case on iPadOS 17.5.1 ([three.js forum](https://discourse.threejs.org/t/context-lost-when-backgrounding-safari-on-ios-17-developer-beta-8/55772); [three.js forum, R3F](https://discourse.threejs.org/t/texture-is-causing-loss-of-context-in-ipados-ios-17-5-1-when-using-react-three-fiber/68643)). Handle it in `onCreated`:

- add `webglcontextlost` and `webglcontextrestored` listeners;
- call `preventDefault()` on loss, pause the ticker and audio, and show "tap to resume";
- remount the `<Canvas>` with a new `key` as the robust fallback;
- never keep game state only in GPU buffers.

### Haptics are an Android-only extra

The W3C Vibration API returns `false` without **sticky activation**, meaning the user must have interacted with the page at least once ([W3C Vibration](https://w3c.github.io/vibration/)). Chrome blocks it in cross-origin iframes from version 55 and requires a gesture from version 60 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)). Firefox made it a no-op ([Mozilla bug 1653318](https://bugzil.la/1653318)), and **Safari on iOS has never implemented it** ([W3C implementation report](https://w3c.github.io/vibration/reports/implementation.html)).

The iOS workaround clicks a hidden `<input type="checkbox" switch>` from script to get the fixed system tick, with no intensity or pattern control ([WebKit commit](https://lists.webkit.org/pipermail/webkit-changes/2023-December/294748.html); [Safari 18 notes](https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes)). The ios-haptics README says it "only works on ios 17.4 to 26.4, as apple patched it in ios 26.5" ([ios-haptics](https://unpkg.com/ios-haptics@3.1.1/README.md)). No Apple note confirms that, but nothing should depend on the trick.

Android's design guidance supplies the only hard numbers:

- "A good keyclick haptic feedback signal should last between 10 to 20 milliseconds."
- The actuator rings for another 20–50 ms after a 20 ms input.
- Legacy one-shot vibrations can feel buzzy.
- "Given the choice of buzzy haptics or no haptics for touch feedback, choose no haptics" ([Android haptics principles](https://developer.android.com/develop/ui/views/haptics/haptics-principles)).

Apple adds four rules: match the haptic's intensity and sharpness to the animation's, sync it with sound, prefer short haptics for discrete events, and make haptics optional ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)).

```ts
// haptics.ts: web only (the Capacitor shell is out of scope)
const P = { tick: 12, tap: 20, thud: 35, sunk: [40, 60, 40], win: [60, 80, 120], loss: 30 } as const;
export function buzz(kind: keyof typeof P) {
  if (!settings.haptics || !("vibrate" in navigator)) return;   // hide the toggle where unsupported
  try { navigator.vibrate(P[kind] as number | number[]); } catch {}
}
```

Fire haptics on the impact frame. A haptic for a remote opponent's move works only if the viewer has already tapped the page, which sticky activation then satisfies for the frame's lifetime ([Chrome user activation](https://developer.chrome.com/blog/user-activation)). In this app's async cadence, a lock-in tap once per 120 s tick is rare enough to deserve 20 ms. Pair every pattern with light and sound, because iPhone users get none.

### Audio, fullscreen and wake lock behave differently on each phone

On iOS, Web Audio follows the ring/silent switch by default, because the session is effectively "ambient". Setting `navigator.audioSession.type = 'playback'` overrides the switch but pauses the user's music ([WebKit bug 237322](https://bugs.webkit.org/show_bug.cgi?id=237322); [MDN AudioSession.type](https://developer.mozilla.org/docs/Web/API/AudioSession/type)). For game blips, respecting the switch is the polite default. A WKWebView AudioContext can stay silent after backgrounding, so call `resume()` again on `visibilitychange` and on the next tap ([WebKit bug 240646](https://bugs.webkit.org/show_bug.cgi?id=240646)). If sample files are ever needed, keep the total under about 100 KB, lazy-loaded after the first gesture, in Opus or AAC.

Fullscreen splits by platform:

| Platform | Behaviour | Approach |
|---|---|---|
| Android Chrome | `requestFullscreen({ navigationUI: 'hide' })` works from a gesture. `screen.orientation.lock()` works only after the fullscreen promise resolves ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/Hjo6zse3tvg)) | Use both, in that order |
| iPhone | No element fullscreen in 2026, only video, so no orientation lock either ([WebKit bug 206854](https://www2.webkit.org/show_bug.cgi?id=206854); [caniuse](https://caniuse.com/fullscreen)) | A fixed overlay sized to `100dvh`/`100svh` with the HUD padded by `env(safe-area-inset-*)` (`viewport-fit=cover` is required) |

Touch handling should change with the mode. In spectating, the repo's `touch-action: pan-y` on the canvas is right. A dedicated play mode should switch to `touch-action: none`, keeping `overscroll-behavior: none` on the body (the repo already sets it in `styles.css`).

Request `navigator.wakeLock.request('screen')` at match start and re-acquire it on `visibilitychange`. iOS has supported it since 16.4, but it only works in Home Screen apps from 18.4 ([Safari 18.4 notes](https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes)). The repo already uses wake lock during uploads.

### Preferences replace effects instead of deleting them

The flash ceilings are firm:

- **WCAG 2.3.1** passes content with no more than three general or red flashes in any one-second period, or with flashing confined to 0.006 steradians. That is about 341×256 px at 1024×768, or **87,296 CSS px** ([WCAG thresholds](https://raw.githubusercontent.com/w3c/wcag/main/guidelines/terms/20/general-flash-and-red-flash-thresholds.html); [Understanding 2.3.1](https://raw.githubusercontent.com/w3c/wcag/main/understanding/20/three-flashes-or-below-threshold.html)).
- A 360×800 phone canvas is 288,000 CSS px, so **any full-canvas flash or bloom pulse counts as large**.
- Saturated red is riskier at lower intensities ([Unity](https://unity.com/blog/video-game-accessibility-basics)).
- Xbox's XAG 118 fails flashes at more than about 3 per second over about 20% of the screen ([XAG 118](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/118)).
- XAG 117 asks for camera shake, bob and motion blur to be avoidable, citing Halo Infinite's 0–100% sliders ([XAG 117](https://devdocs.xbox.com/gaming/accessibility/xbox-accessibility-guidelines/117)).

`prefers-reduced-motion` is readable from JavaScript, and zoom and parallax are named triggers ([web.dev](https://web.dev/articles/prefers-reduced-motion)).

```ts
const flashes: number[] = [];
export function tryFlash(): boolean {                 // route every large-area flash or bloom pulse through here
  const now = performance.now();
  while (flashes.length && now - flashes[0] > 1000) flashes.shift();
  if (!settings.flashes || flashes.length >= 3) return false;
  flashes.push(now); return true;
}
```

| Setting (`ac-*` localStorage keys, try/catch like `ac-chime-muted`) | Default | Under `prefers-reduced-motion: reduce` |
|---|---|---|
| Sound on/off plus volume | On (the iOS silent switch still mutes) | Unchanged |
| Haptics on/off | On where `navigator.vibrate` exists; toggle hidden on iOS | Unchanged |
| Camera shake 0–100% | 100% | 0% |
| Flashes on/off | On (rate-limited) | On, smaller and lower contrast |
| Quality Auto/Low/High | Auto (the ladder above) | Ambient ticker 0 (repo already) |

Reduced motion should substitute effects, not delete feedback:

| Normal | Reduced-motion substitute |
|---|---|
| Camera shake | Colour pulse or outline on the cell |
| Dolly or push-in | Cut or cross-fade |
| Slow-motion zoom | Hit-stop freeze (a freeze is not motion) plus sound |
| Particle burst | Shorter, fewer particles |
| Fly-in entry | Cross-fade with the same light and sound reveal |

Today `BsArena3D.tsx` skips the bomb drop and the shot animation entirely under reduced motion. The research argues for keeping the freeze, the colour change and the sound. There is no web API for battery-saver state: the Battery Status API is Chromium-only and restricted ([OpenReplay](https://blog.openreplay.com/battery-status-api/)). Infer it from the 30 fps Low Power Mode cap.

## Async play feels live when the client replays, signals and stages

### Replay what the viewer missed, then hand over the turn

The strongest async pattern replays what happened while the viewer was away, compressed and in order, before handing over control:

- **Draw Something** replays the partner's drawing stroke by stroke with the thinking pauses cut, and then shows the drawer the guessing ([Wikipedia](https://wikipedia.com/wiki/Draw_Something)).
- **Frozen Synapse Prime** runs five seconds of simultaneous action and then replays the kills ([Softpedia](https://www.softpedia.com/reviews/games/pc/Frozen-Synapse-Prime-Review-472808.shtml)).

Where games skip this, players complain:

- A Lichess correspondence player finds the last move hard to see ([Lichess forum](https://lichess.org/forum/lichess-feedback/are-notifications-possible-in-correspondence-chess)).
- Board Game Arena users request last-move highlights because "it can be hard to figure out what your opponent just did" ([BGA](https://uk.boardgamearena.com/bug?id=14183)).

Into the Breach's telegraphing ("literally show the player what the enemy will do next") is the model for opening on the current threat ([Game Developer](https://gamedeveloper.com/game-platforms/road-to-the-igf-subset-games-i-into-the-breach-i-)).

The repo already has the raw material. `BsArena3D.tsx` replays a shot animation from `last_move` diffs during an open session, but deliberately never on mount. Light Cycles keeps a per-tick `move_log` (direction, source, `pending_at`, resolution time), Battleship keeps an untrimmed timestamped `shots` array, and duel `rounds` become public on resolution (`AGENTS.md`). A purely client-side catch-up needs only one addition: a per-viewer "last seen event" marker, which can live in localStorage keyed by game id.

Scale the replay to what was missed:

- **Battleship:** each missed shot plays in full.
- **Light Cycles:** missed ticks fast-forward (a suggested 3–4×) with slow motion only on crashes and near-misses, following Frozen Synapse's kills-only replay.
- **RPS:** only the last round's reveal plays, followed by the score line.

Cap the whole catch-up at a few seconds with a visible Skip. Leave a resting marker afterwards (the last shot's cell glowing, the rival's last trail segment brighter), then land on a clear "your move". A notification should say what happened ("B7: hit. Your move."), since Lichess users valued pushes that showed the move ([Lichess forum](https://lichess.org/forum/lichess-feedback/are-notifications-possible-in-correspondence-chess)).

### Waiting needs honest presence and a fuse that burns late

Live card games fill waits with honest signals and urgency that arrives late:

- **Hearthstone's rope** appears with about 20 s left of a 75 s turn. A player who idles a whole turn gets a ~7 s fuse next time, and deliberate roping is a known social irritant ([Out of Games](https://outof.games/realms/hearthstone/guides/553-hearthstone-why-do-people-rope-explained/)).
- **Showing which cards an opponent hovers** is cited as something that "add[s] life to the game" ([MOOgiwara issue](https://www.github.com/BAA-Studios/MOOgiwara/issues/49)).
- **Backstabbr** lets all players fast-adjudicate early, puts no-order countries into "civil disorder" and offers a sandbox for testing moves ([Backstabbr FAQ](https://backstabbr.com/faq)).
- **Marvel Snap** removes the wait altogether with simultaneous turns and roughly three-minute games ([GameSpot](https://www.gamespot.com/articles/marvel-snap-is-a-new-fast-paced-collectible-card-game-from-ex-hearthstone-devs/1100-6503602/)).

The server can already back three honest presence cues:

- lock-in pips from `awaiting`/`targets` (riders and throwers who still owe);
- the duel's `thrown` booleans, which show a lock without leaking its content;
- the absence rule that removes a Light Cycles rider after three clock-carried ticks.

Show "waiting since 1 m" as calm elapsed time. Burn a visible fuse only in the last 10–25% of a tick or round clock, which is Hearthstone's ratio. The duel's existing draining bar should switch to that treatment near its end.

Keep the arena breathing while the player waits, and give the waiting player something to do: orbit, inspect the board, replay the last turn, or plan on a sandbox overlay. Both Light Cycles and the Duel already resolve the moment every party has moved, which is Backstabbr's "everyone ready" path. Make that resolution visible as a beat ("all locked"), not a silent jump.

### Simultaneous reveals need four beats: lock, prime, flip, verdict

Shipped and real-world precedents:

- **Marvel Snap** reveals the leading player's cards first, marked by a glowing name tag that "takes some time to appear" ([GINX](https://www.ginx.tv/en/marvel-snap/reveal-first)). It escalates stakes by doubling cubes on the final turn and with the Snap ([Game Developer](https://www.gamedeveloper.com/game-platforms/designers-don-t-sleep-on-marvel-snap-s-simultaneous-turns)).
- **Under WRPSA rules**, players reveal gestures at the same time ([Xataka](https://www.xatakaon.com/magnet/the-rock-paper-scissors-world-cup-actually-exists-its-no-joke)).
- **Alex Kidd's janken bosses** are best of three, and a reviewer called them "essentially random" without the Telepathy Ball, which shows what the rival is thinking ([Wikipedia](https://en.wikipedia.org/wiki/Alex_Kidd_in_Miracle_World); [Nintendo Wire](https://nintendowire.com/reviews/alex-kidd-in-miracle-world-dx/)).

The RPS reveal script follows from these:

1. Each player's commit shows only a sealed token, such as a glowing clenched fist.
2. When both are locked, the four-beat chant runs at 100–120 BPM with a fist-pump squash and a drum on each beat, and the ambient bed ducked.
3. Both throws flip on the same frame.
4. Silence holds for 300–500 ms.
5. The throws clash with squash/stretch, a flash and a burst in the winner's colour.
6. A named verdict appears (the duel UI already says "Scissors cut paper · X takes it"), and a tie gets its own CLASH "again!" beat.

The HUD has to cooperate with the reveal. The 2D scoreboard and round chips should update on the impact frame, not when the server frame arrives, or they spoil the reveal. Input for the next round stays open throughout.

Light Cycles ticks get the same structure as mini Frozen Synapse turns: lock pips, then all new trail segments advance together as one short sprint, then an instant closer-camera slow-motion replay of any crash before the derez.

Spectators seeing throws before the players (dramatic irony) would need the server to stop hiding throws before resolution, and a chat room makes leaking trivial. Keep throws secret.

### Spectators need a director camera, both sides and a readout

Shipped spectator systems converge on a few tools:

- **Dota 2's Directed Camera** "anticipates what is about to happen". Spectators can pick a hero to follow, and the camera returns to directed mode after a delay ([Game Informer](https://gameinformer.com/games/dota_2/b/pc/archive/2011/10/06/a-new-way-to-play-like-the-pros)).
- **Riot patented a camera** that follows "interest values" ([Engadget](https://www.engadget.com/2014-02-06-riot-allegedly-patents-spectator-mode-camera-element.html)).
- **Clash Royale replays** show both sides' cards and elixir at slow, normal or fast speed ([TouchArcade](https://toucharcade.com/2016/01/14/clash-royale-elite-players-head-to-head)).
- **Chess eval bars** show who is winning. Shown to an arena crowd, one drew roars "at every wrong move like at a boxing match" ([Lit & Chess](https://litandchess.substack.com/p/ding-gukesh-2024-world-championship)), while other fans say the bar pulls attention from the board ([Lichess blog](https://lichess.org/@/SayChessClassical/blog/the-great-eval-bar-debate-chesscoms-broadcasting-style/qZ6Fnuw2)).

A rule-based director is enough for these games:

| Game | Interest rule |
|---|---|
| Battleship | Shell in flight, then the hit cell. A sink always wins |
| Light Cycles | The rider pair with the smallest gap to a wall, plus any imminent head-on |
| RPS | A fixed two-shot |

Tapping a player follows them, and the camera returns to the director after a few idle seconds.

The readouts should be honest and toggleable:

| Game | Readout |
|---|---|
| Battleship | Ships remaining per side |
| Light Cycles | Reachable-area "territory" share |
| RPS | Round pips plus streak |

A text ticker ("Ann fires at C4: miss") gives agents, chat and screen readers the same narrative through an `aria-live` region.

### Ceremonies end on the deciding moment and a one-tap rematch

Fighting games set the frame. "Round 1, Fight!" dates to Street Fighter II ([Game Informer](https://gameinformer.com/feature/2022/12/16/returning-to-round-one-the-history-of-street-fighter)), and Street Fighter 6 makes its versus screens interactive ([Destructoid](https://vip-develop.destructoid.com/?p=328372)). Pokémon Red and Blue pick their battle transition from flags such as trainer battle and enemy level advantage ([pokered disassembly](https://v10.next.forgejo.org/foster/pokered/src/branch/master/engine/battle/battle_transitions.asm)), so intro weight can scale with the stakes.

At the end of a match, Call of Duty's final killcam was missed enough that players pushed for its return. Its replacement, an algorithmic "Play of the Game", split opinion ([GameSpot](https://www.gamespot.com/articles/call-of-duty-ww2-beta-replaces-match-ending-killca/1100-6452867/); [ESTNN](https://estnn.com/cod-final-killcam-to-return-to-black-ops-cold-war)). So replay the deterministic deciding moment: the final shot, the final crash, the deciding throw.

Lichess shows a head-to-head crosstable under the board, which players enjoy "building up" ([Lichess forum](https://af.lichess.org/forum/redirect/post/6ye7I3uW)). Its rematch button sits where the board was and disappears once the opponent leaves ([Lichess forum](https://lichess.org/forum/lichess-feedback/bug-rematch-sometimes-not-working)), though some players resent rematch pressure ([Lichess forum](https://lichess.org/forum/general-chess-discussion/why-why-why-is-the-rematch-button-mandatory)). The repo already has one-tap Rematch with the same settings. The head-to-head record is the missing piece.

| Beat | Duration (inferred) | Content |
|---|---|---|
| Present | 1–2 s, at match start, skipped on rematches | VS split with name cards in team colours and the head-to-head record. A heavier "woosh" for rivalries and deciding rounds |
| Count | 2–3 s | Beats on the clock, a light pulse per beat (never full-screen), ambient ducked. In RPS, the chant is the count |
| Release | Instant | GO, music drops in, a burst in both colours, input unlocks on the downbeat |
| Resolve | 200–270 ms hit-stop, then 0.5–1 s slow motion | The decisive moment with a camera push (dropped under reduced motion) |
| Reflect | 2–4 s, skippable | The winner's colour floods the arena lights while the loser's lines dim. Rising major stinger versus falling minor. Result card with the deterministic replay, a stat line (shots and accuracy, ticks survived, moves submitted), the head-to-head and a big Rematch button |

## Per-game playbooks

### Battleship: neon-noir naval warfare where the board is the record

| Aspect | Recommendation |
|---|---|
| Look | Dark navy sea and sky. Hulls as dark silhouettes with emissive deck and waterline light lines, cyan for one side and amber for the other. A violet-to-magenta horizon band with a low striped moon behind fog. The grid as thin emissive lines on the water. Bloom threshold moves from 0.72 to 1 |
| Arrival | Start above a mist layer, descend through fog to the waterline, let the moon break through. Searchlights sweep on, then the grid is painted onto the sea. The vista landmarks are both fleets and the horizon |
| Idle | Sum-of-sines swell with hulls bobbing on the same CPU-side function. A moon glint path. A searchlight sweep every 6–10 s. Fog banks at two speeds. Distant lightning as a soft sky brighten (never a white flash). Embers rising from wrecks |
| Shot | A reticle tightens and the shell arcs with a falling whistle (300–600 ms). Miss: small tier, a band-passed splash plus "bloop", a flat ring and a persistent peg. Hit: medium tier, core flash, sparks, fire and smoke that keep burning, a 30–40 ms buzz |
| Sink | Large tier. The whole hull surfaces, its light lines flicker out one by one, it pitches 15–35° and goes under in 2–4 s through a clipping plane, with spray, a foam disc and bubbles. Neighbouring cells auto-mark (GamePigeon). A "Destroyer sunk" ticker line |
| Decisive | The last ship gets slow motion at about 0.25×, a push-in, ShockWave and a stinger, then Reflect. When both fleets are down to one ship, shift the music layer and lighting instead of escalating every shot |
| Async | Replay each missed shot in full. Your own damaged ships get the Into-the-Breach "current threat" readout on open |
| Spectate | Both grids. Director order: shell, then hit cell, then sink. Readout: ships remaining |

The Hasbro adaptation was criticised for having "not much animation" ([Pure Nintendo](https://purenintendo.com/?p=132307)). The sink is where Battleship's animation budget pays off.

### Light Cycles: a Tron grid where each tick plays as a sprint

| Aspect | Recommendation |
|---|---|
| Look | Canonical Tron: Legacy. A desaturated metallic-blue floor with a circuit-board pattern and the scrolling grid shader. Trails as solid emissive ribbons. Each cycle reads as one glowing line. For 2–4 riders, pair each hue with a trail pattern (solid, dashed, chevron, double) and a HUD label |
| Arrival | From near-black, the grid draws outward from the vanishing point, then the walls, then the cycles fill from wireframe to solid (Rez's growth), under a synth drone whose pitch rises with the sweep |
| Idle | Data-flow shimmer along grid lines, slow pulses in distant circuit silhouettes, trails humming with a slight flicker, idling cycles |
| Tick | Lock pips from `awaiting`. When the tick resolves, all riders sprint their new segments together over roughly 0.5–0.8 s on `gt.t`, with floor streaks and a slight FOV kick instead of a teleport. Extend one trail segment per straight run and add a new one only on turns ([BlenderArtists](https://blenderartists.org/t/blender-tron-light-cycle-game/494631)) |
| Near-miss | A head within one cell of a wall triggers a proximity glow and a small whoosh |
| Crash | Large tier. An instant closer-camera slow-motion replay, then the derez: dissolve, voxel burst, trail collapse, floor ring, CA or Glitch on desktop. A head-on draw gets its own staging. Several deaths on one tick play in sequence |
| Decisive | The last rider standing gets 0.5–1 s of slow motion, and the winner's trail flares |
| Camera | Default to a high three-quarter or top-down overview, the arcade framing ([StrategyWiki](https://strategywiki.org/wiki/TRON)). Offer a per-rider chase cam as a toggle, Armagetron style ([Armagetron docs](https://armagetron.sourceforge.net/doc/commands.html)). Use a low angle only for crash replays |
| Async | Fast-forward missed ticks, slowing for crashes. Open on where each rider will go next |

Tron: Evolution reviewers praised the "neon lights trailing out from behind" for conveying speed ([Push Square](https://www.pushsquare.com/reviews/2010/12/tron_evolution_ps3)) but found its scripted races gave "little sense of speed" ([GameWatcher](https://www.gamewatcher.com/tron-evolution/review)). In this turn-based version, speed has to come from trails, streaks and the sprint beat.

### Rock-Paper-Scissors: a spotlit duel scored like music

| Aspect | Recommendation |
|---|---|
| Look | A dark stage with two pools of light, hands or avatars in player colours, holographic motes in the spotlight cones, a low-contrast silhouetted crowd, and slowly pulsing banners. The round history is built into the floor or banners as physical chips |
| Arrival | Overhead spotlights snap on one by one with a heavy "clunk", ending on the two pools. Present follows immediately |
| Waiting | Breathing bob and fists slowly priming. A sealed glowing token appears the moment `thrown` turns true, and the arena lights flick toward that side |
| Reveal | Lock, chant, same-frame flip, a 300–500 ms hold, clash, verdict. Each throw has its own quantized timbre: a low drum for rock, a filtered swoosh for paper and a bright stab for scissors, with a particle burst in the winner's colour |
| Stakes | At match point the reveal lengthens and staggers, the lights darken and the heartbeat quickens. The final round gets a FINISH treatment. Sudden death gets its own look |
| Async | Replay only the last round's reveal, then the score line |
| Spectate | A fixed two-shot. Readout: pips plus streak. Throws stay secret until the server resolves the round |

RPS is the best fit for the full synesthetic Rez and Tetris Effect treatment, because its rounds are short, discrete and already musical in structure. Beat-locked pulses at 1–2 Hz keep it psychedelic without strobing.

## Conclusion

The main reframing is about where feel lives in this app. Because every game here is asynchronous and often played against agents on minute-scale clocks, input response matters least. The arrival, the catch-up replay and the reveal matter most. The highest-value work is therefore a deterministic presentation layer that can replay any logged event at any speed. One `gt.t` clock, scripted beats written as functions of time since the event, and the move logs the server already keeps would let the same code serve live play, "while you were away" catch-up, spectators and the end-of-match replay.

The platform limits point the same way. iPhones offer no vibration, no fullscreen and 30 fps in Low Power Mode, and every phone is fill-rate bound. That pushes the expressive weight onto emissive light, selective bloom, cheap merged post effects and synthesized sound, which are exactly what the neon "trippy" look is made of. Expensive "pretty" features such as reflections, transmission, depth of field and physics add little to that look.

The open risks are empirical. No device benchmarks exist for these effect stacks, iOS haptics are still changing, and every shake, hit-stop and timing value here is a derived starting point. The skill built from this report should ship with an on-device tuning pass and a frame-time probe, not with the numbers treated as settled.
