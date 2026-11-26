// Voices: a member's voice sample and clone, and speaking a message.

import { CLONE_DELETE_RETRY, inlineBodyCap, mb, ROOM_RE, STORE_MSG, VOICE_CLONES_PER_DAY, VOICE_SAMPLE_MAX } from "../limits.js";
import { CORS, deny, json, rateLimited, readBody, secondsToUtcMidnight } from "../lib/http.js";
import { cartesiaClone, cartesiaDelete, cartesiaSpeak } from "../platform/cartesia.js";
import { SPEAK_INFLIGHT } from "../room/voices.js";
import { inlineBytes, sniffAudio } from "../lib/sniff.js";
import { LINK_REFUSED, mediaLink, serveMedia } from "../lib/media.js";
import { speakableText } from "../lib/text.js";
import type { RouteContext } from "../index.js";
import { warn } from "../lib/log.js";
import { isGoneError } from "../lib/errors.js";

// The clones a room holds as pending deletes (room/voices.ts,
// voiceDelPend), oldest first, up to max: each goes at Cartesia, and a
// 2xx or 404 takes it off the list. Anything else leaves it for the next
// try. Callers check for the key first.
export async function retryCloneDeletes(env: Env, stub: DurableObjectStub, room: string, max: number) {
  try {
    const done: string[] = [];
    for (const id of await stub.voiceDelList(max)) if (await cartesiaDelete(env, id, { room })) done.push(id);
    if (done.length) await stub.voiceDelDone(done);
  } catch (e) {
    warn("cartesia.retry", e, { room });
  }
}

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
  // Clones whose delete Cartesia did not confirm earlier, a few at a
  // time, beside this request (retryCloneDeletes).
  if (env.CARTESIA_API_KEY) rc.ctx.waitUntil(retryCloneDeletes(env, stub, room, CLONE_DELETE_RETRY));
  const oldVoice = await stub.voiceOf(who);
  // A clone this request is done with (its own new one the room would
  // not take) goes at Cartesia; one Cartesia does not confirm deleted is
  // kept in the room as a pending delete. It used to be only logged, and
  // its id was lost.
  const dropClone = async (vid: string) => { if (!(await cartesiaDelete(env, vid, { room }))) await stub.voiceDelPend([vid]); };
  // The room decides, in one call, whether the clone is saved (setVoiceId).
  // Refused, the clone is this request's own and attached to no one, so it
  // goes at Cartesia: the room deleted while the clone was made answers
  // 410 room_deleted; the voice removed or its sample replaced meanwhile,
  // 409 (a DELETE that answered 200 used to find the voice back). Saved,
  // the clone it replaced is the one the room hands back, already a
  // pending delete there: that one goes, and its record comes off on a
  // 2xx or 404. The route used to delete the voice it read at its start,
  // so a clone landing in between was neither deleted nor recorded.
  const saveClone = async (gen: number, key: string, vid: string) => {
    let r;
    try { r = await stub.setVoiceId(who, "cartesia", vid, gen, key); }
    catch (e) {
      if (isGoneError(e)) await dropClone(vid);
      throw e;
    }
    if (!r || r === "changed") {
      await dropClone(vid);
      if (!r) return json({ error: "No member with that name" }, 404);
      return json({ error: "The voice was removed or replaced while it was being cloned, so nothing was saved and this clone was discarded. Send the request again if you still want it." }, 409);
    }
    if (r.replaced && (await cartesiaDelete(env, r.replaced, { room }))) await stub.voiceDelDone([r.replaced]);
    return json({ room, name: who, voice: r.voice, cloned: true });
  };
  const capMsg = "You can clone a voice up to " + VOICE_CLONES_PER_DAY + " times a day. Try again tomorrow.";
  if (request.method === "DELETE" && !action) {
    if (!oldVoice) return json({ error: "No voice to remove" }, 404);
    // The room's part first, and it never waits on Cartesia: a member can
    // always withdraw their recording, and the room stops using the voice
    // at once. The clone's id is recorded as a pending delete in that same
    // call, then Cartesia is asked; only its 2xx or 404 takes the record
    // off, so an unreachable Cartesia or an unset key cannot lose the
    // clone. (A refused delete first answered 200 with the id lost, then
    // 502 with nothing removed: a member could not withdraw their voice
    // until a third party answered.)
    const vid = oldVoice.provider === "cartesia" ? oldVoice.voice_id : null;
    const done = await stub.clearVoice(who, oldVoice.voice_id, vid);
    let pending = false;
    if (vid) {
      if (await cartesiaDelete(env, vid, { room })) await stub.voiceDelDone([vid]);
      else pending = true;
    }
    if (done === "changed") return json({ error: "The voice changed while it was being removed (a new clone landed). Send the DELETE again.", clone_delete_pending: pending }, 409);
    if (done === "STORE_FAIL") return json({ error: "Storage did not delete your voice sample; the room no longer uses the voice. Send the DELETE again.", clone_delete_pending: pending }, 503);
    return json({ room, name: who, voice: null, clone_delete_pending: pending });
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
    return saveClone(smp.gen, smp.key, vid);
  }
  if ((request.method === "PUT" || request.method === "POST") && action === "sample") {
    if (+(request.headers.get("Content-Length") || 0) > inlineBodyCap(VOICE_SAMPLE_MAX)) return json({ error: "Voice samples can be up to " + mb(VOICE_SAMPLE_MAX) }, 413);
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
    const put = await stub.putVoiceSample(who, buf, type, room);
    if (put === "STORE_FAIL") return json({ error: STORE_MSG }, 503);
    if (!put) return json({ error: "No member with that name" }, 404);
    if (!env.CARTESIA_API_KEY) return json({ room, name: who, voice: await stub.voiceOf(who), cloned: false, note: "Sample stored. Server cloning is not configured yet, so no voice id was saved." }, 202);
    if (!owner && !(await stub.cloneTake(who))) return rateLimited(capMsg, secondsToUtcMidnight(), { room, name: who, voice: await stub.voiceOf(who), cloned: false, sample_stored: true });
    let vid;
    try { vid = await cartesiaClone(env, buf, type, who); } catch (e) { return json({ error: String((e && (e as Error).message) || e), sample_stored: true }, 502); }
    return saveClone(put.gen, put.key, vid);
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
  // play straight from the buffer; the next play re-synthesizes fresh. It
  // carries the CORS headers a cached play's answer has (serveMedia).
  return new Response(buf, { headers: Object.assign({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store" }, CORS) });
}
