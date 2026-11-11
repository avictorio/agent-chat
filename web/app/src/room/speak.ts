import { plainText } from "../feed/markdown";
import { toast } from "../lib";
import type { Message } from "@chat/shared";

// Read-aloud, ported from the current app: a message plays in the
// sender's cloned voice when they have one (the server synthesizes and
// caches it), otherwise the browser voice reads the markdown-stripped
// text in sentence-sized chunks (browsers cut long utterances short).
// Toggling the button stops playback on both paths.

export const canSpeak =
  "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

function chunks(s: string): string[] {
  const parts = s.match(/[^.!?\n]+[.!?]*[\s]*|[.!?\n]+/g) || [s];
  const out: string[] = [];
  let cur = "";
  parts.forEach((p) => {
    if ((cur + p).length > 220 && cur) {
      out.push(cur);
      cur = "";
    }
    cur += p;
  });
  if (cur.trim()) out.push(cur);
  return out;
}

export class Speaker {
  speakingId: number | null = null;
  onChange: (id: number | null) => void = () => {};
  private audio: HTMLAudioElement | null = null;
  private objUrl: string | null = null;
  private gen = 0;

  constructor(
    private opts: {
      room: string;
      invite: string;
      voiceOf: (name: string) => string | null;
    }
  ) {}

  private set(id: number | null) {
    this.speakingId = id;
    this.onChange(id);
  }

  private stopServer() {
    // Bumping the generation invalidates any speak fetch still in
    // flight: its continuation checks before it starts playing.
    this.gen++;
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        // already stopped
      }
      this.audio = null;
    }
    if (this.objUrl) {
      URL.revokeObjectURL(this.objUrl);
      this.objUrl = null;
    }
  }

  speak(m: Message): void {
    if (this.opts.voiceOf(m.from)) this.speakServer(m);
    else this.speakSynth(m);
  }

  private speakServer(m: Message) {
    const again = this.speakingId === m.id;
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // no synth to cancel
      }
    }
    this.stopServer();
    this.set(null);
    if (!again) {
      this.set(m.id);
      const gen = this.gen;
      const src =
        "/api/rooms/" +
        encodeURIComponent(this.opts.room) +
        "/messages/" +
        m.id +
        "/speak";
      const failed = () => {
        if (gen === this.gen && this.speakingId === m.id) {
          this.set(null);
          toast("Could not play that in " + m.from + "’s voice.", true);
        }
      };
      // An <audio> element cannot send headers, so the clip is fetched
      // with the invite in the X-Invite-Token header and played from a
      // blob URL — the token no longer rides in the speak URL.
      void (async () => {
        try {
          const res = await fetch(src, {
            headers: this.opts.invite ? { "X-Invite-Token": this.opts.invite } : {},
          });
          if (!res.ok) throw new Error("speak " + res.status);
          const blob = await res.blob();
          if (gen !== this.gen || this.speakingId !== m.id) return;
          const url = URL.createObjectURL(blob);
          this.objUrl = url;
          this.audio = new Audio(url);
          // Capture the element: a stale element's late error must not tear
          // down a NEW playback started after a stop + replay.
          const mine = this.audio;
          this.audio.onended = () => {
            if (this.audio === mine && this.speakingId === m.id) {
              this.set(null);
              this.audio = null;
              if (this.objUrl === url) {
                URL.revokeObjectURL(url);
                this.objUrl = null;
              }
            }
          };
          const failMine = () => {
            if (this.audio === mine && this.speakingId === m.id) {
              this.set(null);
              this.audio = null;
              toast("Could not play that in " + m.from + "’s voice.", true);
            }
          };
          this.audio.onerror = failMine;
          const pr = this.audio.play();
          if (pr && pr.catch) pr.catch(failMine);
        } catch {
          failed();
        }
      })();
    }
  }

  private speakSynth(m: Message) {
    const synth = window.speechSynthesis;
    const again = this.speakingId === m.id;
    this.stopServer();
    synth.cancel();
    this.set(null);
    if (!again) {
      const text = "From " + m.from + ". " + plainText(m.text || "");
      const pieces = chunks(text);
      this.set(m.id);
      pieces.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(p);
        u.lang = navigator.language || "en-US";
        if (i === pieces.length - 1)
          u.onend = () => {
            if (this.speakingId === m.id) this.set(null);
          };
        u.onerror = (e) => {
          if (
            this.speakingId === m.id &&
            e.error !== "interrupted" &&
            e.error !== "canceled"
          )
            this.set(null);
        };
        synth.speak(u);
      });
    }
  }

  stopAll(): void {
    this.stopServer();
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // nothing playing
      }
    }
    this.set(null);
  }
}
