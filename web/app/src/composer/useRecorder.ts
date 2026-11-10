import { useRef, useState } from "react";
import { toast } from "../lib";
import { getSR, phraseMode, type SRInstance } from "./speech";
import { kb, type PendingClip } from "./useAttachments";

interface MRInstance {
  mimeType: string;
  ondataavailable: ((e: { data: Blob | null }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}
interface MRCtor {
  new (stream: MediaStream, opts?: { mimeType?: string }): MRInstance;
  isTypeSupported?: (t: string) => boolean;
}

export function useRecorder(opts: {
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  grow: () => void;
  clipRef: React.RefObject<PendingClip | null>;
  setClip: (c: PendingClip | null) => void;
  stopDictation: (discard: boolean) => void;
}) {
  const { textRef, grow, clipRef, setClip, stopDictation } = opts;
  const SR = getSR();
  const PHRASE_MODE = phraseMode();

  // A MediaRecorder runs alongside a speech-recognition session that
  // collects the transcript (final results only); where recognition
  // is unavailable or blocked, the clip simply carries none.
  const MRCtorRef = useRef<MRCtor | null | undefined>(undefined);
  if (MRCtorRef.current === undefined) {
    const w = window as unknown as { MediaRecorder?: MRCtor };
    const md = navigator.mediaDevices as { getUserMedia?: unknown } | undefined;
    MRCtorRef.current = md && md.getUserMedia && w.MediaRecorder ? w.MediaRecorder : null;
  }
  const MR = MRCtorRef.current;
  const [recActive, setRecActive] = useState(false);
  const [recLabel, setRecLabel] = useState("");
  const recRef2 = useRef<MRInstance | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recMimeRef = useRef("");
  const recTimerRef = useRef<number | null>(null);
  const recStartedRef = useRef(0);
  const recStartingRef = useRef(false);
  const recRecogRef = useRef<SRInstance | null>(null);
  const recHeardRef = useRef("");
  const recRestartsRef = useRef(0);
  const recSRDeadRef = useRef(true);

  const recElapsed = () => Math.max(0, Math.round((Date.now() - recStartedRef.current) / 1000));
  const recClock = () => {
    const t = recElapsed();
    return Math.floor(t / 60) + ":" + ("0" + (t % 60)).slice(-2);
  };
  const recReset = () => {
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    setRecActive(false);
    recRef2.current = null;
    if (recStreamRef.current) {
      recStreamRef.current.getTracks().forEach((t) => t.stop());
      recStreamRef.current = null;
    }
  };
  const recSRStart = () => {
    if (!SR || recRecogRef.current || recSRDeadRef.current) return;
    try {
      const r = new SR();
      r.lang = navigator.language || "en-US";
      r.continuous = !PHRASE_MODE;
      r.interimResults = false;
      r.onresult = (e) => {
        for (let i = 0; i < e.results.length; i++) {
          if (!e.results[i]!.isFinal) continue;
          const t = (e.results[i]![0]?.transcript || "").replace(/\s+/g, " ").trim();
          if (!t) continue;
          if (recHeardRef.current && recHeardRef.current.slice(-t.length) === t) continue;
          recHeardRef.current = (recHeardRef.current ? recHeardRef.current + " " : "") + t;
        }
      };
      r.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") recSRDeadRef.current = true;
      };
      r.onend = () => {
        if (recRecogRef.current === r) recRecogRef.current = null;
        if (recRef2.current && !recSRDeadRef.current && recRestartsRef.current < 10) {
          recRestartsRef.current++;
          recSRStart();
        }
      };
      r.start();
      recRecogRef.current = r;
    } catch {
      // recognition is best-effort
    }
  };
  const recSRStop = () => {
    recSRDeadRef.current = true;
    if (recRecogRef.current) {
      const r = recRecogRef.current;
      recRecogRef.current = null;
      try {
        r.stop();
      } catch {
        // already stopped
      }
    }
  };
  const recFinish = (discard: boolean) => {
    const recorder = recRef2.current;
    if (!recorder) return;
    recSRStop();
    const keep = !discard;
    recorder.onstop = () => {
      const blob = new Blob(recChunksRef.current, { type: recMimeRef.current || "audio/webm" });
      const secs = recClock();
      recChunksRef.current = [];
      recReset();
      if (!keep) return;
      if (blob.size > 5000000) {
        toast("That recording is over the 5 MB cap", true);
        return;
      }
      const rd = new FileReader();
      rd.onload = () => {
        const ext = blob.type.indexOf("mp4") >= 0 ? "m4a" : blob.type.indexOf("ogg") >= 0 ? "ogg" : "webm";
        const heard = recHeardRef.current.replace(/\s+/g, " ").trim();
        setClip({
          data: String(rd.result),
          name: "voice-message." + ext,
          label: "🎙 Voice message (" + secs + ", " + kb(blob.size) + ") - attaches to your next message",
          transcript: heard || null,
        });
        const textEl = textRef.current;
        if (heard && textEl && !textEl.value.trim()) {
          textEl.value = heard;
          grow();
        }
        setRecLabel("");
      };
      rd.onerror = () => toast("Couldn't read that recording", true);
      rd.readAsDataURL(blob);
    };
    try {
      recorder.stop();
    } catch {
      recReset();
    }
  };
  const recClick = async () => {
    if (recRef2.current) {
      recFinish(false);
      return;
    }
    // The guard above cannot see a start still waiting on the mic
    // prompt: without this flag a second tap runs a second
    // getUserMedia and the first stream leaks.
    if (recStartingRef.current) return;
    if (clipRef.current) {
      toast("A clip is already attached - remove it first, or send it", true);
      return;
    }
    stopDictation(true);
    recStartingRef.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      recStartingRef.current = false;
      toast("Microphone isn't available: " + (err instanceof Error ? err.message : String(err)), true);
      return;
    }
    recStreamRef.current = stream;
    recChunksRef.current = [];
    recMimeRef.current = "";
    const opts: { mimeType?: string } = {};
    if (MR && MR.isTypeSupported && MR.isTypeSupported("audio/webm;codecs=opus")) opts.mimeType = "audio/webm;codecs=opus";
    else if (MR && MR.isTypeSupported && MR.isTypeSupported("audio/mp4")) opts.mimeType = "audio/mp4";
    let recorder: MRInstance;
    try {
      recorder = new MR!(stream, opts);
    } catch {
      try {
        recorder = new MR!(stream);
      } catch (e2) {
        recStartingRef.current = false;
        toast("Recording isn't available in this browser", true);
        recReset();
        return;
      }
    }
    recStartingRef.current = false;
    recMimeRef.current = recorder.mimeType || "";
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recChunksRef.current.push(e.data);
    };
    recorder.start(250);
    recRef2.current = recorder;
    recStartedRef.current = Date.now();
    recHeardRef.current = "";
    recRestartsRef.current = 0;
    recSRDeadRef.current = false;
    recSRStart();
    setRecActive(true);
    setRecLabel("● Recording… 0:00 - tap the record button again to stop");
    recTimerRef.current = window.setInterval(() => {
      setRecLabel("● Recording… " + recClock() + " - tap the record button again to stop");
    }, 500);
  };
  const discardIfRecording = (): boolean => {
    if (recRef2.current) {
      recFinish(true);
      return true;
    }
    return false;
  };
  return { supported: !!MR, recActive, recLabel, recClick, discardIfRecording };
}
