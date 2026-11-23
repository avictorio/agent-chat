// Cartesia voices: clone, delete, speak.

import { warn } from "../lib/log.js";

const CARTESIA_DELETE_MS = 10000;

// Clone a voice sample with Cartesia and return the new voice id. The API key is the
// CARTESIA_API_KEY Worker secret; callers check for it before calling this.
export async function cartesiaClone(env: Env, data: ArrayBuffer, type: string | null | undefined, memberName: string): Promise<string> {
  const form = new FormData();
  form.append("clip", new Blob([data], { type: type || "audio/mpeg" }), "sample");
  form.append("name", String(memberName).slice(0, 60) + " - Agent Chat");
  form.append("language", "en");
  const r = await fetch("https://api.cartesia.ai/voices/clone", {
    method: "POST",
    headers: { "X-API-Key": env.CARTESIA_API_KEY as string, "Cartesia-Version": "2025-04-16" },
    body: form,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.id) throw new Error("Cartesia cloning failed (" + r.status + ")" + (j && (j.error || j.message) ? ": " + String(j.error || j.message).slice(0, 160) : ""));
  return j.id;
}

// A replaced or cleared clone is deleted at Cartesia too, so re-cloning
// does not pile voices up on the account. True once Cartesia no longer
// has it: it answered 2xx, or 404 (gone already). Anything else - a 429
// or 5xx, no answer within CARTESIA_DELETE_MS, no key - leaves the voice
// there, and the caller keeps its id as a pending delete (room/voices.ts,
// voiceDelPend): forgetting it on an unread answer left clones on the
// owner's account with nothing recording them.
export async function cartesiaDelete(env: Env, voiceId: string | null | undefined, ctx?: { room: string }): Promise<boolean> {
  if (!voiceId) return true;
  if (!env.CARTESIA_API_KEY) { warn("cartesia.delete", "the CARTESIA_API_KEY secret is not set", ctx); return false; }
  try {
    const r = await fetch("https://api.cartesia.ai/voices/" + encodeURIComponent(voiceId), {
      method: "DELETE",
      headers: { "X-API-Key": env.CARTESIA_API_KEY, "Cartesia-Version": "2025-04-16" },
      // a pending delete is kept for a later try, so a hung call need not hold the request
      signal: AbortSignal.timeout(CARTESIA_DELETE_MS),
    });
    if (r.ok || r.status === 404) return true;
    warn("cartesia.delete", "Cartesia answered " + r.status, ctx);
  } catch (e) {
    warn("cartesia.delete", e, ctx);
  }
  return false;
}

// Synthesize text in a cloned voice with Cartesia; returns the MP3 bytes.
// (callers check for the key, as for a clone)
export async function cartesiaSpeak(env: Env, voiceId: string, text: string) {
  const r = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: { "X-API-Key": env.CARTESIA_API_KEY as string, "Cartesia-Version": "2025-04-16", "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: "sonic-3", transcript: text, voice: { mode: "id", id: voiceId }, output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 } }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error("Cartesia speech failed (" + r.status + ")" + (j && (j.error || j.message) ? ": " + String(j.error || j.message).slice(0, 160) : ""));
  }
  return r.arrayBuffer();
}
