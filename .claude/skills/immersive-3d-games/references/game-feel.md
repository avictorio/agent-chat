# Game feel: theory, juice numbers, staging and accessibility limits

Read this when you tune how an event *feels*: shake, hit-stop, slow motion,
haptic patterns, flashes, or when you decide how big a moment should be.
Every number marked "derived" is a starting value built from the anchors
here, not a published number for these games. Tune on a real phone.

## Contents

1. What these games are made of (MDA, patterns, flow)
2. Where feel lives in a discrete-commit game
3. Juice techniques and their numbers
4. Decisiveness gating and the event ladder
5. Haptic design rules
6. Anticipation, impact, aftermath
7. Overload limits: flashes, motion, legibility
8. Settings model and reduced-motion substitutes

## 1. What these games are made of

- **MDA** splits a game into mechanics ("the particular components of the
  game, at the level of data representation and algorithms"), dynamics ("the
  run-time behavior of the mechanics acting on player inputs and each
  others' outputs over time") and aesthetics (the emotional response).
  Designers work from mechanics outward; players meet aesthetics first.
  Eight aesthetics: Sensation, Fantasy, Narrative, Challenge, Fellowship,
  Discovery, Expression, Submission. Time pressure and opponent play create
  Challenge. ([MDA paper, AAAI](https://aaai.org/papers/ws04-04-001-mda-a-formal-approach-to-game-design-and-game-research/); [Wikipedia](https://en.wikipedia.org/wiki/MDA_framework))
- **Targets for this app:** Challenge from the opponent (human or agent),
  Fellowship from playing inside a chat room with spectators, Sensation
  from juice. Battleship adds Discovery (uncovering a hidden fleet).
- **Pattern learning:** fun is mastering learnable patterns; boredom comes
  when no pattern is visible ([A Theory of Fun, summary](https://www.shortform.com/blog/what-is-the-meaning-of-fun/)).
  RPS without visible history degenerates into coin-flipping, so keep a
  permanent, physical round tally (what each side threw, per round) in the
  arena.
- **Flow / dynamic difficulty** hardly applies to PvP: the matched opponent
  sets the difficulty ([Flow in Games coverage](https://www.engadget.com/2006-09-12-flow-in-games-an-interactive-thesis-on-dynamic-difficulty.html)).
  The flow lever left is **pacing**: clocks short enough that nobody waits
  long enough to lose interest.
- **Feedback loops:** Battleship has a mild positive loop (hits reveal more
  fleet); Light Cycles and best-of RPS have none. Do not rubber-band.
  Stage rising tension instead: "last ship", "match point", "two riders left".
- **Suspense without manipulation:** borrow "decelerate and land the
  deciding element last" from slot presentation ([XboxHub](https://www.thexboxhub.com/volatility-and-difficulty-curves-what-game-designers-borrow-from-slot-maths/), low authority).
  Never borrow hidden odds or pity timers: players accept tension when they
  understand the rules behind it.

## 2. Where feel lives in a discrete-commit game

The classic definition of game feel ("real-time control of virtual objects
in a simulated space, with interactions emphasized by polish") excludes
turn-based play ([Wikipedia: Game feel](https://en.wikipedia.org/wiki/Game_feel); [survey](https://arxiv.org/pdf/2011.09201)).
Every game here is discrete-commit; the round-based games follow commit →
sealed → the round's reveal, and the three below show the range:

| Game | Core loop |
|---|---|
| Battleship | aim → commit → wait → reveal → consequence |
| Light Cycles | pick a direction → lock → wait for the tick → the tick plays out as motion → near-miss or crash |
| RPS Duel | choose → hidden lock → both locked → chant → simultaneous flip → verdict |

What resolves a turn, tick or round and the clocks: SKILL.md, "Where feel
lives in this app", and each game's section of `GET /api`.

So feel concentrates in four places: the **commit acknowledgement**, the
**anticipation** beat, the **reveal**, and the **aftermath**. The reveal is
the emotional peak in every loop; spend the effects budget there, not on the
input. Hit-stop and slow motion are local presentation only: they never
pause authoritative state.

## 3. Juice techniques and their numbers

"Juice It or Lose It" (GDC Europe 2012) layered tweening, squash and
stretch, particles, shake and sound onto a plain block-breaker
([GDC Vault](https://gdcvault.com/play/1016487/Juice-It-or-Lose)). "The Art of
Screenshake" (2013) applied ~30 small tweaks to a dull shooter: muzzle
flash, hit pause, camera kick, shake, **permanence** (debris and smoke that
stay), then "meaning (game over screen)" and slow motion
([YouTube](https://www.youtube.com/watch?v=AJdEqssNZ-U); [Bayreuth GxD 10](https://medienwissenschaft.uni-bayreuth.de/wp-content/uploads/GxD-10-Game-Feel.pdf)).
"The Nuance of Juice" (2016) moved the question from how much to when
([Game Developer](https://gamedeveloper.com/design/video-indies-resist-the-urge-to-juice-it-or-lose-it-)).

### Trauma shake ("Juicing Your Cameras With Math", GDC 2016)

- Keep `trauma` in [0,1]; **add** per event, never set.
- Shake = trauma² or trauma³. Cubed, trauma 0.3/0.6/0.9 gives 3%/22%/73%.
- Drive each axis from smoothed noise ("WAY better than random"); in 3D,
  yaw, pitch, roll plus x/y/z offsets. ([GDC Vault](https://gdcvault.com/play/1023146/Math-for-Game-Programmers-Juicing))
- Bevy's official example ([source](https://raw.githubusercontent.com/bevyengine/bevy/main/examples/camera/2d_screen_shake.rs)):

| Constant | Value | Comment |
|---|---|---|
| Trauma exponent | 2 | linear "doesn't feel punchy" |
| Decay | 0.5/s | full trauma gone in 2 s |
| Max angle | 10° | "somewhat high but still reasonable" |
| Max translation | 20 px | "low enough displacement to not be distracting" |
| Noise speed | 20 | lower = dreamier |
| Trauma per event | 0.4 | |
| Seeds | one per channel | nearby inputs → nearby outputs, so the camera moves, not teleports |

- **Board-game adjustment (derived):** a perspective camera over a grid
  swings far cells more than near ones. Start with roll ≤ 1–2°, yaw/pitch ≤
  0.5–1°, a small translation, decay 1.0–1.6/s so the board reads again
  within a second. Shake the 3D camera only; the HUD, the selected cell and
  the turn indicator never shake. A cell should never visually move more
  than a fraction of its own width.
- Repo: `JuiceRig` (`three/juice.tsx`; contract in `primitives.md`)
  implements trauma², linear decay and value noise through
  `setFocalOffset`. Its constants live in that file; adjust there, not per
  arena.

### Hit-stop (freeze frames)

| Source | Light / medium / heavy |
|---|---|
| Street Fighter V | 8 / 12 / 16 frames ≈ 133 / 200 / 267 ms ([CFN](https://game.capcom.com/cfn/sfv/column/131545)) |
| Street Fighter II | ~14 frames ≈ 233 ms regardless of strength |
| Smash hitlag | grows with damage; capped at 20 frames (Melee) and 30 frames (Brawl on) ([SmashWiki](https://www.ssbwiki.com/Hitlag)) |

Hit-stop reads as weight. It is cheap on the web: freeze the game clock
while still rendering; camera shake and flashes keep running on real time.

## 4. Decisiveness gating and the event ladder

Cinematic treatment is gated on detectable decisiveness everywhere it ships:
Smash's Finish Zoom fires only on a calculated game-winning KO
([SmashWiki](https://www.ssbwiki.com/Finish_Zoom)); Ultimate's ~1 s slow
motion only on a last stock ([SmashWiki](https://www.ssbwiki.com/Slow_motion));
Tekken 7's slow-mo camera only when both players are low and trade at once
([Kotaku](https://kotaku.com/a-tekken-7-round-so-close-it-needs-two-slow-mo-cams-1797576157)).
Repetition fatigue is real: an effect that feels right occasionally
"become[s] tiresome when it plays frequently" ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/playing-haptics));
very frequent events get very subtle effects ([Android](https://developer.android.com/develop/ui/views/haptics/haptics-principles)).

The ladder (derived starting values; trauma feeds `Juice.hit`, hit-stop
and slow motion act on the juice clock, haptics are `BUZZ` names (§5) and
reach Android Chrome only):

| Tier | Events | Trauma | Hit-stop | Slow motion | Haptic | Screen layer |
|---|---|---|---|---|---|---|
| Tick | hover, UI tap, aim | 0 | 0 | none | none (10–15 ms only if rare) | none |
| Small | miss, own lock-in, RPS round won/lost | +0.15–0.25 | 0–60 ms | none | `commit` / `nearMiss` | local flash at the cell |
| Medium | hit, Light Cycles near-miss | +0.3–0.4 | 80–130 ms (≈ SFV light) | none | `scored` (you hit) / `hitYou` (you were hit) | bloom pulse |
| Large | ship sunk, rider derezzed | +0.6–0.8 | 200–270 ms (≈ SFV medium–heavy) | none unless decisive | `sankTheirs` / `lostOne` | bloom pulse + ring + title card |
| Decisive | last ship, last rider, match-winning throw | +0.8, once | 200–270 ms, then slow | 0.2–0.35× for 0.5–1 s | `wonMatch` / `lostMatch` | one rate-limited flash, stinger |

The rules that go with it (sound, haptic and flash on the impact frame;
small and medium sequences under a second, a skippable 2–4 s match end;
one signature per meaning, which Apple's HIG grounds: never reuse a
pattern for the opposite outcome) are stated in SKILL.md. **Losses that
happen to the viewer override this ladder** (the owner's call, replacing
the research's muted "dignified" defeat): SKILL.md, "Losses that happen to
the viewer must be clearly noticeable".

## 5. Haptic design rules

Platform guidance agrees ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/playing-haptics); [Android](https://developer.android.com/develop/ui/views/haptics/haptics-principles)):

- Short, crisp pulses for discrete events. "A good keyclick haptic feedback
  signal should last between 10 to 20 milliseconds." The actuator rings
  another 20–50 ms after a 20 ms input. Legacy one-shot vibrations
  (`navigator.vibrate` is one) can feel buzzy; "given the choice of buzzy
  haptics or no haptics for touch feedback, choose no haptics."
- Strength proportional to importance, inverse to frequency. Match
  intensity and sharpness to the animation; sync with sound. Out-of-sync
  haptics feel broken.
- One meaning per pattern; never share a pattern between good and bad.
- Always optional; the game must work without them. iOS web has none.

The vocabulary is `BUZZ` in `sfx.ts` (values there: derived starting
points, `navigator.vibrate` patterns in ms, arrays alternating
vibrate/pause; tune on a real Android phone). Use the names, never inline
arrays:

| `BUZZ` name | Meaning |
|---|---|
| `commit` | your commit / lock-in: one short tick |
| `nearMiss` | a shot splashed near your fleet |
| `scored` | you hit them / took the round |
| `hitYou` | you were hit / lost the round |
| `sankTheirs` | you sank or derezzed theirs |
| `lostOne` | your ship sunk / your rider derezzed: noticeable, never like a win |
| `wonMatch` | match won: a rising contour |
| `lostMatch` | match lost: the win's contour reversed at equal weight |

A selection tick has no name: the ladder's Tick tier stays silent.

Light Cycles turns are frequent: never buzz per turn; buzz for crashes and
match end. Buzz spectators only for decisive moments, if at all (derived:
haptics need a causal link to the viewer).

## 6. Anticipation, impact, aftermath

Each arena's beats (the anticipation, the impact, what stays) are its
playbook in `game-playbooks.md`. Light Cycles' dead trail stays as a dim
scar (the server keeps it as a wall: never collapse it), and the Duel's
round chips are the pattern record (§1).

Permanence matters most in Battleship: the board is the game's record, so a
scorch mark that stays is both juice and information. Reference: GamePigeon
Sea Battle gives a haptic, a slight shake and smoke from the cell on a hit,
and reveals a fully hit ship with the dots around it filled in (this app's
Battleship does not auto-mark neighbours)
([allthings.how](https://allthings.how/how-to-play-sea-battle-on-imessage/)).

## 7. Overload limits: flashes, motion, legibility

- **WCAG 2.3.1** passes content with no more than three general or red
  flashes in any one-second period, or flashing confined to 0.006 sr
  (≈341×256 px at 1024×768, **87,296 CSS px**). General flash = opposing
  luminance changes of ≥10% where the darker is below 0.80; red flash =
  saturated red (R/(R+G+B) ≥ 0.8). ([thresholds](https://raw.githubusercontent.com/w3c/wcag/main/guidelines/terms/20/general-flash-and-red-flash-thresholds.html); [Understanding 2.3.1](https://raw.githubusercontent.com/w3c/wcag/main/understanding/20/three-flashes-or-below-threshold.html))
- A 360×800 phone canvas is 288,000 CSS px: **any full-canvas flash or bloom
  pulse counts as large.** Route every large flash through one limiter
  (`Juice.flash` refuses a fourth within 1000 ms) and keep it low-contrast.
- Saturated red is riskier at lower intensities ([Unity](https://unity.com/blog/video-game-accessibility-basics)).
  Use a steady red glow or an orange/white flash, never a red strobe.
- XAG 118 fails flashes over ~3/s covering ~20% of the screen
  ([XAG 118](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/118)).
  XAG 117: shake, bob and motion blur must be avoidable (Halo Infinite's
  0–100% sliders) ([XAG 117](https://devdocs.xbox.com/gaming/accessibility/xbox-accessibility-guidelines/117)).
- Legibility: effects add light *around* the game layer, never across it.
  The authoritative state is readable during the effect (the cell is marked
  "hit" while the explosion plays); smoke never hides unresolved cells past
  the impact window; effects never gate input.

## 8. Settings model and reduced-motion substitutes

`prefers-reduced-motion` is readable from JS; zoom and parallax are named
triggers ([web.dev](https://web.dev/articles/prefers-reduced-motion)).
Persist settings under `ac-*` localStorage keys with try/catch (the repo
pattern: `ac-chime-muted`, `ac-sfx-muted`).

| Setting | Default | Under reduced motion |
|---|---|---|
| Sound (+ vibration today, one toggle: `SoundToggle`) | on; iOS silent switch still mutes | unchanged |
| Haptics | on where `navigator.vibrate` exists; hide on iOS | unchanged |
| Camera shake 0–100% | 100% | 0% |
| Flashes | on, rate-limited | on, smaller, lower contrast, soft fades |
| Quality Auto/Low/High | Auto | ambient ticker 0 |

Substitute, never delete:

| Normal | Reduced-motion substitute |
|---|---|
| camera shake | colour pulse or outline on the cell |
| dolly or push-in | cut or cross-fade |
| slow-motion zoom | a brief freeze plus sound (a freeze is not motion) |
| particle burst | shorter, fewer particles |
| fly-in entry | cross-fade with the same light and sound reveal |
| scaling title card | fading title card (`.impact-title.calm`) |

`Juice` under `still` is the repo's substitute set (`primitives.md`,
`three/juice.tsx`): motion drops, titles, sound and buzz stay. If you add a
reduced-motion freeze, keep it short. Never skip an event under reduced
motion: an arena that lands it at once keeps the colour change, the title
and the sound.
