// Voices: the daily clone allowance, the speak requests in flight, and the
// Room methods for members' voice samples, clones and speaking.

import { nameFold } from "../lib/text.js";
import { VOICE_CLONES_PER_DAY } from "../limits.js";

export const SPEAK_INFLIGHT = new Map();

export async function cloneAllowed(env, room, who) {
  const k = "clone:" + room + ":" + nameFold(who) + ":" + new Date().toISOString().slice(0, 10);
  const n = parseInt((await env.REQUESTS.get(k)) || "0", 10);
  if (n >= VOICE_CLONES_PER_DAY) return false;
  await env.REQUESTS.put(k, String(n + 1), { expirationTtl: 172800 });
  return true;
}

export const VoiceMethods = {
  // Voices: one cloned voice per member. The sample lives in R2; the mv row carries the
  // provider voice id the server saved when it cloned the sample. Streams get a "members"
  // event on change, like avatars.
  voiceRow(name) {
    const r = this.sql.exec("SELECT name, provider, voice_id, sample_key, sample_type, sample_ts, ts FROM mv WHERE name = ?", String(name).toLowerCase()).toArray()[0];
    return r || null;
  },

  voiceOf(name) {
    const r = this.voiceRow(name);
    if (!r) return null;
    return { provider: r.provider || "cartesia", voice_id: r.voice_id || null, sample: !!r.sample_key, updated: r.ts || null };
  },

  // The slug alone collided ("José" and "Jos?" both slug to "jos-"), so
  // one member could overwrite another's sample: a hash of the folded name
  // keeps keys distinct. Older rows keep the key they were stored under.
  async voiceSampleKey(room, name) {
    const fold = nameFold(name);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fold)));
    const hex = Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
    return (room || this.roomName || "room") + "/voice-sample/" + fold.replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) + "-" + hex;
  },

  async putVoiceSample(name, data, type, room) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return null;
    const key = await this.voiceSampleKey(room, name);
    // Storage failure is its own answer (phase A): the route turns STORE_FAIL
    // into a 503, distinct from the no-such-member null.
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) return "STORE_FAIL";
    try { await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } }); } catch (e) { return "STORE_FAIL"; }
    const prev = this.voiceRow(name);
    if (prev && prev.sample_key && prev.sample_key !== key) { try { await this.env.MEDIA.delete(prev.sample_key); } catch (e) {} }
    this.sql.exec("INSERT OR REPLACE INTO mv (name, provider, voice_id, sample_key, sample_type, sample_ts, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      String(name).toLowerCase(), (prev && prev.provider) || "cartesia", (prev && prev.voice_id) || null, key, type, Date.now(), (prev && prev.ts) || null);
    this.notifyMembers(name);
    return key;
  },

  async getVoiceSample(name) {
    const r = this.voiceRow(name);
    if (!r || !r.sample_key || !this.env || !this.env.MEDIA) return null;
    try {
      const obj = await this.env.MEDIA.get(r.sample_key);
      if (!obj) return null;
      return { data: await obj.arrayBuffer(), type: r.sample_type || "audio/mpeg" };
    } catch (e) { return null; }
  },

  async setVoiceId(name, provider, voiceId) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return null;
    const prev = this.voiceRow(name);
    this.sql.exec("INSERT OR REPLACE INTO mv (name, provider, voice_id, sample_key, sample_type, sample_ts, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      String(name).toLowerCase(), provider, voiceId, (prev && prev.sample_key) || null, (prev && prev.sample_type) || null, (prev && prev.sample_ts) || null, Date.now());
    this.notifyMembers(name);
    await this.invalidateSpeakCache(name);
    return this.voiceOf(name);
  },

  // A voice change makes every cached speak rendering of that member's messages
  // stale: drop them so the next play re-synthesizes in the new voice.
  async invalidateSpeakCache(name) {
    const ids = this.sql.exec("SELECT id FROM m WHERE lower(sender) = lower(?)", name).toArray();
    for (const r of ids) {
      const meta = this.mediaMeta(r.id, "speak");
      if (!meta) continue;
      if (meta.r2key && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(meta.r2key); } catch (e) {} }
      this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = 'speak'", r.id);
    }
  },

  async clearVoice(name) {
    const r = this.voiceRow(name);
    if (!r) return false;
    if (r.sample_key && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(r.sample_key); } catch (e) {} }
    this.sql.exec("DELETE FROM mv WHERE name = ?", String(name).toLowerCase());
    this.notifyMembers(name);
    await this.invalidateSpeakCache(name);
    return true;
  },

  // What a speak request needs: the message's sender and text. Drafts never speak.
  speakSource(id) {
    const r = this.sql.exec("SELECT sender, text, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || r.draft) return null;
    return { sender: r.sender, text: r.text };
  },
};
