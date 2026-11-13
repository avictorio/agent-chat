# Mobile web: budgets, adaptive quality, haptics, audio, immersion

Read this when a change must hold up on phones: render cost, frame rate,
heat, vibration, sound, fullscreen, touch, wake lock, or detecting
low-power states. Target the **website only**: mobile web means Android
Chrome and iOS Safari. The Android Capacitor app is deprecated; ignore the
research's native-plugin route (`@capacitor/haptics`, SystemBars, a native
PowerSave plugin) and anything that needs an APK.

## Contents

1. Budget pixels and passes before triangles
2. The repo's quality profile
3. Adapting quality at runtime
4. Haptics on the web
5. Web Audio on phones
6. Fullscreen, orientation, touch, wake lock, safe areas
7. Preferences and power saving

## 1. Budget pixels and passes before triangles

Phones are bound by **fill rate and heat**, not triangles.

- A typical 1080×2400 Android phone reports DPR ≈ 3 at a ~360×800 CSS
  viewport: **2.59 Mpx per full-screen pass at DPR 3 vs 0.65 Mpx at DPR 1.5**
  (0.88 at 1.75). Every postprocessing pass and every overlapping transparent
  particle layer multiplies that. The DPR cap is the highest-leverage
  setting.
- **iOS Safari throttles `requestAnimationFrame` to 30 fps in Low Power
  Mode**, intentionally ([WebKit 215745](https://bugs.webkit.org/show_bug.cgi?id=215745);
  [Motion](https://motion.dev/blog/when-browsers-throttle-requestanimationframe)).
  It also throttles rAF to 30 fps in cross-origin iframes until interaction.
  Use delta time everywhere; nothing above 30 fps is possible in LPM.
- Design for the **sustained** clock after 15–30 minutes of play, not the
  peak ([abratabia](https://abratabia.com/mobile-browser-performance/battery-and-thermal.php),
  lower authority). A long spectator session heats more than a 2–3 minute
  duel, so spectators default to the lowest ambient rate.
- Desktop device emulation reproduces none of this; test on real phones.

Community heuristics (blog-level, no device-measured budgets exist): draw
calls < 200 mobile / < 500 desktop; triangles < 500K / < 2M; 60 fps budget <
4 ms JS and < 10 ms GPU ([3Lens](https://3lens.vercel.app/guide/features/performance)).
`renderer.info.render.calls` / `.triangles` give live counts.

| Budget item | Phone ("lite": `(pointer: coarse)`) | Desktop |
|---|---|---|
| DPR cap | 1.5, stepping to 1.25 then 1.0 under load (repo `[1, 1.5]`) | 1.75 (repo `[1, 1.75]`) |
| Draw calls | ≤ 100–200, instanced | ≤ 500 |
| Visible triangles | ≤ 100–300K | ≤ 2M |
| Composer | `multisampling={0}`, Bloom (`mipmapBlur`, levels 4–5) + one merged pass; no grain | may add SMAA (with `multisampling={0}`), grain |
| Ambient render | Ticker 24 fps; 0 under reduced motion | 30 fps |
| Event animation | every frame while it runs | same |
| Expensive materials | no reflector, no transmission | `MeshReflectorMaterial` at 256 |
| Particles | hard cap on simultaneous count; small additive sprites, `depthWrite={false}` | higher caps, soft particles |
| Textures (unverified) | tens of MB total, KTX2, ≤ 1024–2048 px | |

## 2. The repo's quality profile

`useQuality(still)` in `web/app/src/games/arena3d.tsx` returns
`{ lite, dpr, ambientFps, msaa }`: lite = `(pointer: coarse)`; dpr `[1, 1.5]`
lite / `[1, 1.75]` otherwise; ambient 24 / 30 fps, 0 when `still` (reduced
motion); MSAA 0 lite / 2 otherwise. Lite also skips the reflective floor, and
`ArenaPost` skips film grain on lite. Keep new expensive features behind
`q.lite` the same way rather than inventing a second profile.

## 3. Adapting quality at runtime

- **drei `PerformanceMonitor` misbehaves under demand rendering.** It samples
  rendered frames every 250 ms over 10 iterations with `bounds` `[40, 60]`
  (`[60, 100]` above 100 Hz) and fires `onDecline` when > 75% of samples are
  below the lower bound (drei 10.7.9,
  `web/node_modules/@react-three/drei/core/PerformanceMonitor.js`). With a
  24 fps ticker it reads every scene as slow: it declines every ~2.5 s and
  walks `factor` from 0.5 to 0 in ~12.5 s regardless of the GPU. Either pass
  `bounds={() => [ticker * 0.8, ticker * 0.95]}` and measure only during
  bursts, or (better) measure the frame **time** of frames that do render
  with an EMA and step down after N seconds above 70–80% of the frame
  interval. Cap oscillation with `flipflops={3}` + `onFallback`.
- `AdaptiveDpr` / `AdaptiveEvents` do nothing until something calls
  `regress()`. `AdaptiveEvents` disables raycasting while regressed, which
  swallows taps on a tap-to-act board: skip it on touch.
- detect-gpu returns tiers 0–3 (< 15, ≥ 15, ≥ 30, ≥ 60 fps), fetches
  benchmarks from unpkg unless `benchmarksURL` is self-hosted, and its source
  data "stopped updating in December 2025"
  ([detect-gpu](https://github.com/pmndrs/detect-gpu)). The repo's
  `(pointer: coarse)` heuristic plus a first-second frame-time probe is
  enough to pick a starting rung.
- **Ladder, cheapest change first:** DPR 1.5 → 1.25 → 1.0; Bloom off;
  ambient ticker 24 → 15 → 0; particle cap halved; shadows off.
- **Treat a sustained ≤ 31 fps under a free-running loop on iOS as Low Power
  Mode:** step to lite and stop trying to step back up. There is no web API
  for battery-saver state.

## 4. Haptics on the web

- **Android Chrome:** `navigator.vibrate` works but returns `false` without
  **sticky activation** (the user interacted with the page at least once);
  blocked in cross-origin iframes from Chrome 55, gesture required from
  Chrome 60 ([W3C](https://w3c.github.io/vibration/);
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)).
  Sticky activation lasts the frame's lifetime, so a buzz for a remote
  opponent's move works only if the viewer has tapped the page before
  ([Chrome user activation](https://developer.chrome.com/blog/user-activation)).
  Firefox made it a no-op ([bug 1653318](https://bugzil.la/1653318)).
- **iOS Safari has never implemented the Vibration API**
  ([implementation report](https://w3c.github.io/vibration/reports/implementation.html)).
  The `<input type="checkbox" switch>` script-click trick gave a fixed system
  tick on some versions, and a library README says it "only works on ios
  17.4 to 26.4, as apple patched it in ios 26.5"
  ([ios-haptics](https://unpkg.com/ios-haptics@3.1.1/README.md)). Do not
  depend on it.
- Consequence: **haptics are an Android-only extra; every cue must also exist
  in light and sound** (and, because the iOS ringer switch mutes Web Audio,
  in light alone).
- Repo: `buzz(pattern)` in `sfx.ts` checks the sound toggle,
  `typeof navigator.vibrate`, and `navigator.userActivation.hasBeenActive`
  before vibrating, all in try/catch. `Juice.hit({ buzz })` routes through
  it. Pattern vocabulary and design rules: `game-feel.md` §5.
- Keep pulses short (10–40 ms singles; patterns ≲ 300 ms total) and rare;
  long or frequent buzzing feels cheap and drains battery.

## 5. Web Audio on phones

- One shared `AudioContext`, created or resumed inside the first tap or
  keydown (Chrome since 71, Safari, WebView all require it)
  ([Chrome](https://developer.chrome.com/blog/autoplay)). On iOS also play a
  one-sample silent buffer inside the gesture. Repo: `chime.ts` unlocks on
  the first pointer/key press; `sfx.ts` gets the context via
  `audioContext()` and silently does nothing before unlock.
- **iOS follows the ring/silent switch** for Web Audio by default (the
  session is effectively "ambient"). `navigator.audioSession.type =
  'playback'` overrides it but pauses the user's music
  ([WebKit 237322](https://bugs.webkit.org/show_bug.cgi?id=237322);
  [MDN](https://developer.mozilla.org/docs/Web/API/AudioSession/type)). For
  game blips, respect the switch: leave the default (or set `'ambient'`
  explicitly where `'audioSession' in navigator`). Never `'playback'`.
- A WKWebView/iOS `AudioContext` can stay silent after backgrounding: call
  `resume()` again on `visibilitychange` → visible and on the next tap
  ([WebKit 240646](https://bugs.webkit.org/show_bug.cgi?id=240646)). Suspend
  when hidden to save battery.
- Spectators who never tap hear nothing until they do: give an obvious sound
  control (`SoundToggle` sits beside Reset view) and never assume autoplay.
- Synthesized SFX cost zero bytes; if files are ever needed keep the total
  < ~100 KB, lazy-loaded after the first gesture, WebM/Ogg or AAC, decoded once.
- `latencyHint: 'interactive'` (default) is fine; tens of ms of output
  latency is invisible next to a network round-trip in a turn-based game.

## 6. Fullscreen, orientation, touch, wake lock, safe areas

| Platform | Behaviour | Approach |
|---|---|---|
| Android Chrome | `requestFullscreen({ navigationUI: 'hide' })` works from a gesture; `screen.orientation.lock()` works only after the fullscreen promise resolves ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/Hjo6zse3tvg)) | both, in that order, `.catch(() => {})` |
| iPhone Safari | no element fullscreen in 2026 (video only), so no orientation lock ([WebKit 206854](https://www2.webkit.org/show_bug.cgi?id=206854); [caniuse](https://caniuse.com/fullscreen)) | a fixed overlay sized `100dvh`/`100svh`, HUD padded by `env(safe-area-inset-*)` (needs `viewport-fit=cover`) |

- **Touch:** spectating inside the scrolling room keeps the canvas
  `touch-action: pan-y` (repo default, `styles.css`) so one finger scrolls the
  page; `TouchControls` leaves orbit to two fingers. A dedicated play mode
  should switch to `touch-action: none`, keeping `overscroll-behavior: none`
  on the body (already set) so pull-to-refresh never fires mid-game.
- **Wake lock:** `navigator.wakeLock.request('screen')` at match start,
  re-acquired on `visibilitychange`, released at match end, all in
  try/catch. iOS has it since 16.4, but in Home Screen web apps only from
  18.4 ([Safari 18.4](https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes)).
  The repo already uses it during uploads (`composer/uploads.ts`).
- **Safe areas:** AGENTS.md section 10 applies: fixed or full-height UI pads
  with `env(safe-area-inset-*)`, top and bottom. The app shell is
  `position: fixed; inset: 0`; never go back to `height: 100dvh` for the
  shell itself.

## 7. Preferences and power saving

- `prefers-reduced-motion: reduce` is the default for shake, flashes and
  ambient animation; the repo reads it live (`useReducedMotion`) and drops
  the ambient ticker to 0. Sound and haptics are separate preferences, not
  motion.
- The Battery Status API is Chromium-only and restricted; Safari and Firefox
  lack it ([OpenReplay](https://blog.openreplay.com/battery-status-api/)).
  Do not call `navigator.getBattery()`. Infer power saving from the 30 fps
  Low Power Mode cap (§3).
- Settings keys follow `ac-*` in localStorage with try/catch around every
  access (AGENTS.md section 5). The arena's sound toggle is `ac-sfx-muted`
  and also governs vibration; the your-move chime is `ac-chime-muted`.
