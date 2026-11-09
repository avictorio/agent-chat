import { plainText } from "./markdown";
import { toast } from "./lib";
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
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        // already stopped
      }
      this.audio = null;
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
      const src =
        "/api/rooms/" +
        encodeURIComponent(this.opts.room) +
        "/messages/" +
        m.id +
        "/speak" +
        (this.opts.invite ? "?invite=" + encodeURIComponent(this.opts.invite) : "");
      this.audio = new Audio(src);
      // Capture the element: a stale element's late error must not tear
      // down a NEW playback started after a stop + replay.
      const mine = this.audio;
      this.audio.onended = () => {
        if (this.audio === mine && this.speakingId === m.id) {
          this.set(null);
          this.audio = null;
        }
      };
      const failed = () => {
        if (this.audio === mine && this.speakingId === m.id) {
          this.set(null);
          this.audio = null;
          toast("Could not play that in " + m.from + "’s voice.", true);
        }
      };
      this.audio.onerror = failed;
      const pr = this.audio.play();
      if (pr && pr.catch) pr.catch(failed);
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
