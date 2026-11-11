// The your-move chime: a soft two-note cue (Web Audio, no assets)
// for backgrounded play. Browsers unlock audio only after a user
// gesture, so the context is created/resumed on the first pointer or
// key press. Muted state persists in localStorage ("ac-chime-muted").
let ctx: AudioContext | null = null;
let unlocked = false;

export function chimeMuted(): boolean {
  try {
    return localStorage.getItem("ac-chime-muted") === "1";
  } catch {
    return false;
  }
}

export function setChimeMuted(m: boolean): void {
  try {
    localStorage.setItem("ac-chime-muted", m ? "1" : "0");
  } catch {
    // storage unavailable: the toggle just won't persist
  }
}

export function unlockChime(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    // no audio available: the title badge still carries the signal
  }
}

export function playYourMoveChime(): void {
  if (!unlocked || chimeMuted()) return;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    gain.connect(ctx.destination);
    [659.25, 880].forEach((f, i) => {
      const o = ctx!.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(gain);
      o.start(t0 + i * 0.13);
      o.stop(t0 + i * 0.13 + 0.3);
    });
  } catch {
    // a failed chime must never break the room
  }
}
