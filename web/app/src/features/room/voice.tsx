import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { VoiceState } from "@chat/contract";
import { toast } from "../../lib/index";
import { useSession } from "./ctx";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

// The "Your voice" dialog: record the script (or upload a sample
// file), the server clones it, and the status line reports the
// outcome. Remove deletes sample and clone.

export interface VoiceDialogHandle {
  open(): void;
}

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

function voiceText(v: VoiceState | null | undefined): string {
  if (!v) return "No voice yet. Record the script below and upload it - the server clones it for you.";
  if (v.voice_id)
    return "Your voice is set (id " + String(v.voice_id).slice(0, 8) + "…). Record a fresh take any time to replace it.";
  // Nothing clones a stored sample later on its own: a clone the cap or
  // the provider refused waits for Retry clone (or a new take).
  if (v.sample) return "Your sample is stored but not cloned yet. Retry the clone, or record a fresh take.";
  return "No voice yet. Record the script below and upload it - the server clones it for you.";
}

// "...: <the server's sentence>." without a doubled full stop
function notCloned(why: string): string {
  return "Your sample is stored, but it was not cloned: " + why.replace(/\.$/, "") + ".";
}

const SCRIPT =
  "“Hey, this is my voice — the real one, not the announcer one. Last Tuesday I drove to the coast with the windows down, singing along badly and thinking about coffee. Do you know how the first cup decides the whole morning? This year I planted twelve tomatoes, which is eleven more than anybody needs. So call me when you land, bring the blue charger, and don’t worry — I saved you the good seat by the window.”";

export const VoiceDialog = forwardRef<VoiceDialogHandle>(
  function VoiceDialog(_props, ref) {
    const session = useSession();
    const p = { client: session.client, hasToken: !!session.token };
    const dlgRef = useRef<HTMLDialogElement | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const [status, setStatus] = useState("Checking…");
    // a stored sample with no voice id: offer Retry clone
    const [unclonedSample, setUnclonedSample] = useState(false);
    const showVoice = (v: VoiceState | null | undefined) => {
      setStatus(voiceText(v));
      setUnclonedSample(!!(v && v.sample && !v.voice_id));
    };
    const [canRecord] = useState<boolean>(() => {
      const w = window as unknown as { MediaRecorder?: MRCtor };
      const md = navigator.mediaDevices as { getUserMedia?: unknown } | undefined;
      return !!(md && md.getUserMedia && w.MediaRecorder);
    });
    const [recording, setRecording] = useState(false);
    const [recBtnLabel, setRecBtnLabel] = useState("● Record");
    const [recMeta, setRecMeta] = useState(
      canRecord ? "The whole script is about 30 seconds." : "Recording is not available in this browser - upload a file instead."
    );
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    // An upload or a clone is out: both buttons wait for it. A second tap
    // on Retry clone used to send a second clone, spending two of the
    // day's clones on one sample. The ref stops a tap that lands before
    // the disabled state has rendered.
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const whileBusy = async (fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    };

    const vRecRef = useRef<MRInstance | null>(null);
    const vStreamRef = useRef<MediaStream | null>(null);
    const vChunksRef = useRef<Blob[]>([]);
    const vMimeRef = useRef("");
    const vTimerRef = useRef<number | null>(null);
    const vStartedRef = useRef(0);
    const vBlobRef = useRef<Blob | null>(null);
    const vSecsRef = useRef(0);
    const vDiscardRef = useRef(false);
    const vStartingRef = useRef(false);

    const vClock = () => {
      const t = Math.max(0, Math.round((Date.now() - vStartedRef.current) / 1000));
      return Math.floor(t / 60) + ":" + ("0" + (t % 60)).slice(-2);
    };
    const vStopTracks = () => {
      if (vStreamRef.current) {
        vStreamRef.current.getTracks().forEach((t) => t.stop());
        vStreamRef.current = null;
      }
    };
    const vResetRec = () => {
      if (vTimerRef.current) {
        clearInterval(vTimerRef.current);
        vTimerRef.current = null;
      }
      vStopTracks();
      vRecRef.current = null;
      setRecording(false);
      setRecBtnLabel(vBlobRef.current ? "● Record again" : "● Record");
    };
    const refresh = () => {
      if (!p.hasToken) {
        setStatus("Voices need a member invite.");
        return;
      }
      p.client
        .getVoice()
        .then((j) => showVoice(j && j.voice))
        .catch(() => setStatus("Could not load your voice status."));
    };
    useImperativeHandle(ref, () => ({
      open() {
        refresh();
        if (dlgRef.current && !dlgRef.current.open) dlgRef.current.showModal();
      },
    }));

    const recClick = async () => {
      if (vRecRef.current) {
        try {
          vRecRef.current.stop();
        } catch {
          vResetRec();
        }
        return;
      }
      if (vStartingRef.current) return;
      vStartingRef.current = true;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        vStartingRef.current = false;
        toast("Microphone is not available: " + (err instanceof Error ? err.message : String(err)), true);
        return;
      }
      vStreamRef.current = stream;
      // A new take supersedes the previous one: drop the old blob
      // now, so an Upload tapped mid-recording can never submit the
      // take before it.
      vBlobRef.current = null;
      vSecsRef.current = 0;
      setPreviewSrc(null);
      vChunksRef.current = [];
      vMimeRef.current = "";
      const MR = (window as unknown as { MediaRecorder?: MRCtor }).MediaRecorder;
      const opts: { mimeType?: string } = {};
      if (MR && MR.isTypeSupported && MR.isTypeSupported("audio/webm;codecs=opus")) opts.mimeType = "audio/webm;codecs=opus";
      else if (MR && MR.isTypeSupported && MR.isTypeSupported("audio/mp4")) opts.mimeType = "audio/mp4";
      let rec: MRInstance;
      try {
        rec = new MR!(stream, opts);
      } catch {
        try {
          rec = new MR!(stream);
        } catch {
          vStartingRef.current = false;
          toast("Recording is not available in this browser", true);
          vStopTracks();
          return;
        }
      }
      vStartingRef.current = false;
      vMimeRef.current = rec.mimeType || "";
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) vChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        if (vDiscardRef.current) {
          vDiscardRef.current = false;
          vBlobRef.current = null;
          vChunksRef.current = [];
          vResetRec();
          setPreviewSrc(null);
          setRecMeta("The whole script is about 30 seconds.");
          return;
        }
        vSecsRef.current = Math.max(0, Math.round((Date.now() - vStartedRef.current) / 1000));
        vBlobRef.current = new Blob(vChunksRef.current, { type: vMimeRef.current || "audio/webm" });
        vChunksRef.current = [];
        vResetRec();
        try {
          setPreviewSrc((prev) => {
            if (prev && prev.indexOf("blob:") === 0) URL.revokeObjectURL(prev);
            return URL.createObjectURL(vBlobRef.current!);
          });
        } catch {
          // preview is best-effort
        }
        setRecMeta("Recorded " + vSecsRef.current + "s - listen back, then Upload sample. Not happy? Record again.");
        if (fileRef.current) fileRef.current.value = "";
      };
      rec.start(250);
      vRecRef.current = rec;
      vDiscardRef.current = false;
      vStartedRef.current = Date.now();
      setRecording(true);
      setRecBtnLabel("■ Stop");
      setRecMeta("● 0:00 - read the script, then tap Stop");
      vTimerRef.current = window.setInterval(() => {
        setRecMeta("● " + vClock() + " - read the script, then tap Stop");
      }, 500);
    };

    const upload = async () => {
      if (vRecRef.current) {
        toast("Stop the recording first, then upload.", true);
        return;
      }
      const f = fileRef.current && fileRef.current.files && fileRef.current.files[0];
      const blob = vBlobRef.current || f;
      if (!blob) {
        toast("Record the script first, or choose a file.", true);
        return;
      }
      if (blob.size > 10000000) {
        toast("Samples can be up to 10 MB.", true);
        return;
      }
      if (vBlobRef.current && vSecsRef.current < 8) {
        toast("That take is under 8 seconds - the clone needs the whole script.", true);
        return;
      }
      setStatus("Uploading…");
      try {
        const j = await p.client.putVoiceSample(blob);
        if (j.cloned) {
          showVoice(j.voice);
          toast("Voice cloned and saved.");
        } else if (j.sample_stored) {
          // the daily clone cap or the provider said no; the take is kept
          setStatus(notCloned(j.error || "the clone failed"));
          setUnclonedSample(!(j.voice && j.voice.voice_id));
          toast(j.error || "Cloning failed.", true);
        } else if (j.voice) {
          showVoice(j.voice);
          toast("Sample stored.");
        } else toast(j.error || "Upload failed.", true);
      } catch (err) {
        // the server's sentence says why (too large, not audio, no access)
        const why = err instanceof Error ? err.message : "";
        setStatus(why ? "Upload failed: " + why.replace(/\.$/, "") + "." : "Upload failed.");
        toast(why || "Upload failed.", true);
      }
    };
    const reclone = async () => {
      setStatus("Cloning…");
      try {
        const j = await p.client.recloneVoice();
        showVoice(j.voice);
        toast("Voice cloned and saved.");
      } catch (err) {
        const why = err instanceof Error ? err.message : "the clone failed";
        setStatus(notCloned(why));
        toast(why, true);
      }
    };
    const remove = async () => {
      try {
        const j = await p.client.deleteVoice();
        if (j && j.error) toast(j.error, true);
        else {
          showVoice(null);
          vBlobRef.current = null;
          setPreviewSrc(null);
          toast("Voice removed.");
        }
      } catch {
        toast("Could not remove your voice.", true);
      }
    };

    return (
      <Dialog
        className="voice-dlg"
        id="voiceDlg"
        aria-labelledby="voiceTitle"
        ref={dlgRef}
        onClose={() => {
          if (vRecRef.current) {
            vDiscardRef.current = true;
            try {
              vRecRef.current.stop();
            } catch {
              // already stopped
            }
          }
          vResetRec();
        }}
      >
        <div className="vd-head">
          <span className="av-name" id="voiceTitle">
            Your voice
          </span>
          <Button
            type="button"
            variant="quiet" size="sm"
            id="voiceClose"
            aria-label="Close"
            onClick={() => dlgRef.current?.close()}
          >
            ✕
          </Button>
        </div>
        <p className="vd-status" id="voiceStatus">
          {status}
        </p>
        <p>Record in one take — quiet room, mic close, speak naturally. A clone copies your mood and pace, not just your voice.</p>
        <p className="vd-label">Read this aloud</p>
        <p className="voice-script">{SCRIPT}</p>
        <div className="vd-row">
          <Button
            type="button"
            size="sm"
            variant="primary"
            className={recording ? "recording" : undefined}
            id="voiceRec"
            hidden={!canRecord}
            onClick={() => void recClick()}
          >
            {recBtnLabel}
          </Button>
          <span className="vd-meta" id="voiceRecMeta">
            {recMeta}
          </span>
        </div>
        <audio id="voicePreview" controls hidden={!previewSrc} src={previewSrc || undefined}></audio>
        <div className="vd-row">
          <input
            type="file"
            id="voiceFile"
            accept="audio/*"
            aria-label="Voice sample file"
            ref={fileRef}
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (f) {
                vBlobRef.current = null;
                setPreviewSrc(null);
                setRecMeta(f.name + " - ready to upload.");
              }
            }}
          />
        </div>
        <p className="vd-hint">Or upload a file instead — MP3, WAV, M4A, OGG or WebM, up to 10 MB.</p>
        <div className="vd-actions">
          <Button type="button" size="sm" id="voiceRemove" onClick={() => void remove()}>
            Remove voice
          </Button>
          <span className="vd-sp"></span>
          <Button type="button" size="sm" id="voiceReclone" hidden={!unclonedSample} disabled={busy} onClick={() => void whileBusy(reclone)}>
            Retry clone
          </Button>
          <Button type="button" variant="primary" size="sm" id="voiceUpload" disabled={busy} onClick={() => void whileBusy(upload)}>
            Upload sample
          </Button>
        </div>
      </Dialog>
    );
  }
);
