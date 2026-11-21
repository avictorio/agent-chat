// Cartesia voices: clone, delete, speak.

// Clone a voice sample with Cartesia and return the new voice id. The API key is the
// CARTESIA_API_KEY Worker secret; callers check for it before calling this.
/**
 * @param {Env} env
 * @param {ArrayBuffer} data
 * @param {string | null | undefined} type
 * @param {string} memberName
 * @returns {Promise<string>}
 */
export async function cartesiaClone(env, data, type, memberName) {
  const form = new FormData();
  form.append("clip", new Blob([data], { type: type || "audio/mpeg" }), "sample");
  form.append("name", String(memberName).slice(0, 60) + " - Agent Chat");
  form.append("language", "en");
  const r = await fetch("https://api.cartesia.ai/voices/clone", {
    method: "POST",
    headers: { "X-API-Key": /** @type {string} */ (env.CARTESIA_API_KEY), "Cartesia-Version": "2025-04-16" },
    body: form,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.id) throw new Error("Cartesia cloning failed (" + r.status + ")" + (j && (j.error || j.message) ? ": " + String(j.error || j.message).slice(0, 160) : ""));
  return j.id;
}

// A replaced or cleared clone is deleted at Cartesia too, so re-cloning
// does not pile voices up on the account. Best effort: a failure here
// never fails the member's request.
/**
 * @param {Env} env
 * @param {string | null | undefined} voiceId
 */
export async function cartesiaDelete(env, voiceId) {
  if (!env.CARTESIA_API_KEY || !voiceId) return;
  try {
    await fetch("https://api.cartesia.ai/voices/" + encodeURIComponent(voiceId), {
      method: "DELETE",
      headers: { "X-API-Key": env.CARTESIA_API_KEY, "Cartesia-Version": "2025-04-16" },
    });
  } catch (e) {}
}

// Synthesize text in a cloned voice with Cartesia; returns the MP3 bytes.
// (callers check for the key, as for a clone)
/**
 * @param {Env} env
 * @param {string} voiceId
 * @param {string} text
 */
export async function cartesiaSpeak(env, voiceId, text) {
  const r = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: { "X-API-Key": /** @type {string} */ (env.CARTESIA_API_KEY), "Cartesia-Version": "2025-04-16", "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: "sonic-3", transcript: text, voice: { mode: "id", id: voiceId }, output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 } }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error("Cartesia speech failed (" + r.status + ")" + (j && (j.error || j.message) ? ": " + String(j.error || j.message).slice(0, 160) : ""));
  }
  return r.arrayBuffer();
}
