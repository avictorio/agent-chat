// Voices: a member's voice sample and clone, and speaking a message.

import { mb, ROOM_RE, STORE_MSG, VOICE_CLONES_PER_DAY, VOICE_SAMPLE_MAX } from "../limits.js";
import { deny, json, rateLimited, readBody, secondsToUtcMidnight } from "../lib/http.js";
import { cartesiaClone, cartesiaDelete, cartesiaSpeak } from "../platform/cartesia.js";
import { SPEAK_INFLIGHT } from "../room/voices.js";
import { inlineBytes, sniffAudio } from "../lib/sniff.js";
import { LINK_REFUSED, mediaLink, serveMedia } from "../lib/media.js";
import { speakableText } from "../lib/text.js";
import type { RouteContext } from "../index.js";
import { warn } from "../lib/log.js";

// Voices. A member uploads a voice sample (invite token); the server stores it in R2,
// clones it with Cartesia and saves the voice id on the member record. The owner can
// upload for, reclone or clear anyone. Playback reads the saved id from GET /members.
export async function voiceRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const action = m[2] || m[4] || "";
  let who;
  if (m[3] !== undefined) {
    if (!owner) return json({ error: "Changing someone else's voice needs the owner key" }, 403);
    who = decodeURIComponent(m[3]);
  } else {
    who = await stub.inviter(invite);
    if (!who) return json({ error: "Voices are for members: send your X-Invite-Token." }, 403);
  }
  if (request.method === "GET" && !action) return json({ room, name: who, voice: await stub.voiceOf(who) });
  const oldVoice = await stub.voiceOf(who);
  // A replaced clone: its id is already overwritten, so a delete
  // Cartesia refuses is only logged (cartesiaDelete).
  const dropOld = async (keep: string | null) => { if (oldVoice && oldVoice.provider === "cartesia" && oldVoice.voice_id && oldVoice.voice_id !== keep) await cartesiaDelete(env, oldVoice.voice_id, { room }); };
  const capMsg = "You can clone a voice up to " + VOICE_CLONES_PER_DAY + " times a day. Try again tomorrow.";
  if (request.method === "DELETE" && !action) {
    if (!oldVoice) return json({ error: "No voice to remove" }, 404);
    // Cartesia first, and the room forgets the clone only once Cartesia
    // has: the row went first before, so a refused delete answered 200
    // and left the clone on the account with its id recorded nowhere.
    const vid = oldVoice.provider === "cartesia" ? oldVoice.voice_id : null;
    if (vid && !(await cartesiaDelete(env, vid, { room }))) return json({ error: env.CARTESIA_API_KEY ? "Cartesia did not delete the voice; nothing was removed. Try again in a minute." : "Removing a cloned voice is not configured right now (the CARTESIA_API_KEY secret is not set); nothing was removed." }, env.CARTESIA_API_KEY ? 502 : 503);
    const done = await stub.clearVoice(who, oldVoice.voice_id);
    if (done === "none") return json({ room, name: who, voice: null });
    if (done === "changed") return json({ error: "The voice changed while it was being removed (a new clone landed). Send the DELETE again." }, 409);
    if (done === "STORE_FAIL") return json({ error: "Storage did not delete your voice sample (the cloned voice is gone). Send the DELETE again." }, 503);
    return json({ room, name: who, voice: null });
  }
  if (request.method === "POST" && action === "reclone") {
    if (!env.CARTESIA_API_KEY) return json({ error: "Server cloning is not configured yet (the CARTESIA_API_KEY secret is not set)" }, 503);
    if (!oldVoice || !oldVoice.sample) return json({ error: "No stored sample to clone from" }, 404);
    // the allowance before the sample is read: a refused reclone costs no read
    if (!owner && !(await stub.cloneTake(who))) return rateLimited(capMsg, secondsToUtcMidnight());
    const smp = await stub.getVoiceSample(who);
    if (!smp) return json({ error: "No stored sample to clone from" }, 404);
    let vid;
    try { vid = await cartesiaClone(env, smp.data, smp.type, who); } catch (e) { return json({ error: String((e && (e as Error).message) || e) }, 502); }
    const v = await stub.setVoiceId(who, "cartesia", vid);
    if (!v) { await cartesiaDelete(env, vid, { room }); return json({ error: "No member with that name" }, 404); }
    await dropOld(vid);
    return json({ room, name: who, voice: v, cloned: true });
  }
  if ((request.method === "PUT" || request.method === "POST") && action === "sample") {
    if (+(request.headers.get("Content-Length") || 0) > VOICE_SAMPLE_MAX * 1.4 + 1000) return json({ error: "Voice samples can be up to " + mb(VOICE_SAMPLE_MAX) }, 413);
    let buf;
    if ((request.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
      const body = await readBody(request);
      const s64 = String((body && (body.audio || body.audio_base64)) || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      const b = inlineBytes(s64, VOICE_SAMPLE_MAX);
      if (b === null) return json({ error: "\"audio\" must be base64 or a data: URL" }, 400);
      if (b === "too_big") return json({ error: "Voice samples can be up to " + mb(VOICE_SAMPLE_MAX) }, 413);
      buf = b;
    } else {
      buf = await request.arrayBuffer();
    }
    if (!buf.byteLength) return json({ error: "Send the sample as the request body (or JSON {\"audio\": base64})" }, 400);
    if (buf.byteLength > VOICE_SAMPLE_MAX) return json({ error: "Voice samples can be up to " + mb(VOICE_SAMPLE_MAX) }, 413);
    const type = sniffAudio(buf);
    if (!type) return json({ error: "Samples must be MP3, WAV, M4A, OGG or WebM audio" }, 415);
    const key = await stub.putVoiceSample(who, buf, type, room);
    if (key === "STORE_FAIL") return json({ error: STORE_MSG }, 503);
    if (!key) return json({ error: "No member with that name" }, 404);
    if (!env.CARTESIA_API_KEY) return json({ room, name: who, voice: await stub.voiceOf(who), cloned: false, note: "Sample stored. Server cloning is not configured yet, so no voice id was saved." }, 202);
    if (!owner && !(await stub.cloneTake(who))) return rateLimited(capMsg, secondsToUtcMidnight(), { room, name: who, voice: await stub.voiceOf(who), cloned: false, sample_stored: true });
    let vid;
    try { vid = await cartesiaClone(env, buf, type, who); } catch (e) { return json({ error: String((e && (e as Error).message) || e), sample_stored: true }, 502); }
    const v = await stub.setVoiceId(who, "cartesia", vid);
    await dropOld(vid);
    return json({ room, name: who, voice: v, cloned: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

// Speak a message in its sender's cloned voice. The first play synthesizes with
// Cartesia and caches the MP3 as the message's "speak" media; later plays stream
// the cache. Same access as the room: the header or a signed URL.
export async function speakRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const read = request.method === "GET" || request.method === "HEAD";
  const acc = await stub.access(invite, owner, read ? mediaLink(url, room, id, "speak") : undefined);
  if (!acc.ok) return acc.code === LINK_REFUSED ? json({ error: acc.error }, 403) : deny(acc);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  const meta = await stub.mediaMeta(id, "speak", { name: acc.name, owner: owner });
  if (meta) return serveMedia(request, env, stub, id, "speak", room, { name: acc.name, owner: owner });
  const src = await stub.speakSource(id);
  if (!src) return json({ error: "No message with that id" }, 404);
  const v = await stub.voiceOf(src.sender);
  const voiceId = v && v.voice_id;
  if (!voiceId) return json({ error: src.sender + " has no voice yet" }, 404);
  if (!env.CARTESIA_API_KEY) return json({ error: "Playback is not configured yet (the CARTESIA_API_KEY secret is not set)" }, 503);
  const text = speakableText(src.text);
  if (!text) return json({ error: "Nothing speakable in that message" }, 422);
  // Concurrent first plays of the same message share one synthesis.
  const skey = room + ":" + id;
  if (SPEAK_INFLIGHT.has(skey)) {
    try { await SPEAK_INFLIGHT.get(skey); } catch { /* the first play failed (and says so); this one tries again */ }
    const meta2 = await stub.mediaMeta(id, "speak", { name: acc.name, owner: owner });
    if (meta2) return serveMedia(request, env, stub, id, "speak", room, { name: acc.name, owner: owner });
  }
  let buf;
  const synth = (async () => {
    const b = await cartesiaSpeak(env, voiceId, text);
    // Cache only if the sender's voice is still the one synthesized. A
    // reclone landing mid-synthesis runs its invalidation against an
    // empty cache; caching this buffer anyway would resurrect the old
    // voice for this message indefinitely.
    const v2 = await stub.voiceOf(src.sender);
    // The speak cache is best-effort: a storage failure (putMedia throws)
    // must not fail playback. This play is served from the buffer below
    // and the next play simply re-synthesizes.
    if (v2 && v2.voice_id === v.voice_id) { try { await stub.putMedia(id, "speak", b, "audio/mpeg", room); } catch (e) { warn("speak.cache", e, { room, id }); } }
    return b;
  })();
  SPEAK_INFLIGHT.set(skey, synth);
  try { buf = await synth; } catch (e) { return json({ error: String((e && (e as Error).message) || e) }, 502); }
  finally { SPEAK_INFLIGHT.delete(skey); }
  const meta3 = await stub.mediaMeta(id, "speak", { name: acc.name, owner: owner });
  if (meta3) return serveMedia(request, env, stub, id, "speak", room, { name: acc.name, owner: owner });
  // Uncached on purpose (the voice changed mid-synthesis): serve this
  // play straight from the buffer; the next play re-synthesizes fresh.
  return new Response(buf, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
