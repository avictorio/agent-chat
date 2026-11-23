// Voices: the speak requests in flight, and the Room methods for members'
// voice samples, clones, their daily clone allowance and speaking.

import { nameFold } from "../lib/text.js";
import { goneError } from "../lib/errors.js";
import { VOICE_CLONES_PER_DAY } from "../limits.js";
import type { CfgRow, MsgRow, MvRow, Room } from "./Room.js";
import { warn } from "../lib/log.js";

/** speak syntheses in flight, by "room:message id" */
export const SPEAK_INFLIGHT: Map<string, Promise<ArrayBuffer>> = new Map();

export const VoiceMethods = {
  // One of the member's VOICE_CLONES_PER_DAY clones (a UTC day), taken in
  // this one call, before anything is read or sent to Cartesia. The count
  // was a KV get then put in the Worker: clones sent together all read the
  // same count and all passed, and a member at the cap still had their
  // stored sample read through the room on every refused reclone.
  cloneTake(name: string) {
    const k = "clone:" + nameFold(name);
    const day = new Date().toISOString().slice(0, 10);
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = ?", k).toArray()[0];
    const [d, c] = String((r && r.v) || "").split(":");
    const used = d === day ? parseInt(c, 10) || 0 : 0;
    if (used >= VOICE_CLONES_PER_DAY) return false;
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES (?, ?)", k, day + ":" + (used + 1));
    return true;
  },

  // Voices: one cloned voice per member. The sample lives in R2; the mv row carries the
  // provider voice id the server saved when it cloned the sample. Streams get a "members"
  // event on change, like avatars.
  voiceRow(name: string): MvRow | null {
    const r = this.sql.exec<MvRow>("SELECT name, provider, voice_id, sample_key, sample_type, sample_ts, ts FROM mv WHERE name = ?", String(name).toLowerCase()).toArray()[0];
    return r || null;
  },

  voiceOf(name: string) {
    const r = this.voiceRow(name);
    if (!r) return null;
    return { provider: r.provider || "cartesia", voice_id: r.voice_id || null, sample: !!r.sample_key, updated: r.ts || null };
  },

  // The slug alone can collide ("José" and "Jos?" both slug to "jos-"),
  // letting one member overwrite another's sample: a hash of the folded
  // name keeps keys distinct. The moment it was stored makes each sample's
  // key its own, as an avatar's is: with the name alone, a sample still
  // being stored when its room was deleted landed on the key of the same
  // name's sample in a room created again, overwriting it. Older rows
  // keep the key they were stored under.
  async voiceSampleKey(room: string | null | undefined, name: string) {
    const fold = nameFold(name);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fold)));
    const hex = Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
    return (room || this.roomName || "room") + "/voice-sample/" + fold.replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) + "-" + hex + "-" + Date.now().toString(36);
  },

  async putVoiceSample(name: string, data: ArrayBuffer, type: string, room: string) {
    const gen = this.gen;
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return null;
    const key = await this.voiceSampleKey(room, name);
    // Storage failure is its own answer: the route turns STORE_FAIL
    // into a 503, distinct from the no-such-member null.
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) return "STORE_FAIL";
    try { await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } }); } catch { return "STORE_FAIL"; }
    // deleted while it was stored: no row, and the object goes (see setAvatar)
    if (!this.alive(gen)) {
      try { await this.env.MEDIA.delete(key); } catch (e) { warn("media.delete", e, { room: this.roomName }); }
      throw goneError();
    }
    const prev = this.voiceRow(name);
    // the row first, the old object after: a delete awaited in between let
    // the room go before the row was written
    this.sql.exec("INSERT OR REPLACE INTO mv (name, provider, voice_id, sample_key, sample_type, sample_ts, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      String(name).toLowerCase(), (prev && prev.provider) || "cartesia", (prev && prev.voice_id) || null, key, type, Date.now(), (prev && prev.ts) || null);
    if (prev && prev.sample_key && prev.sample_key !== key) { try { await this.env.MEDIA.delete(prev.sample_key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
    this.notifyMembers(name);
    // the room this sample went into, for the clone made from it (setVoiceId)
    return { key, gen };
  },

  async getVoiceSample(name: string) {
    const gen = this.gen;
    const r = this.voiceRow(name);
    if (!r || !r.sample_key || !this.env || !this.env.MEDIA) return null;
    try {
      const obj = await this.env.MEDIA.get(r.sample_key);
      if (!obj) return null;
      // read before the read's await: the room this sample is from (setVoiceId)
      return { data: await obj.arrayBuffer(), type: r.sample_type || "audio/mpeg", gen };
    } catch { return null; }
  },

  // The route clones in the Worker, seconds after it stored or read the
  // sample, and the room can be deleted, created again and the name
  // invited in that wait: the old room's clone then became the new
  // member's voice. gen is the room the sample belongs to (putVoiceSample,
  // getVoiceSample); in any other the clone is refused with goneError,
  // and the route deletes it at the provider.
  /** @param gen this.gen as putVoiceSample or getVoiceSample answered it */
  async setVoiceId(name: string, provider: string, voiceId: string, gen: number) {
    this.fence(gen);
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
  async invalidateSpeakCache(name: string) {
    const ids = this.sql.exec<Pick<MsgRow, "id">>("SELECT id FROM m WHERE lower(sender) = lower(?)", name).toArray();
    for (const r of ids) {
      const meta = this.mediaMeta(r.id, "speak");
      if (!meta) continue;
      if (meta.r2key && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(meta.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
      this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = 'speak'", r.id);
    }
  },

  // Called once the clone is gone at Cartesia (the route deletes it there
  // first). voiceId is the clone the route deleted: a different one here
  // means a reclone landed meanwhile, and dropping the row would leave
  // that new clone at Cartesia with nothing recording it. A sample that
  // storage would not delete keeps its row (the clone's id cleared), so a
  // second DELETE finds it and tries again; the row was dropped anyway
  // before, and the object then had no pointer left.
  async clearVoice(name: string, voiceId?: string | null): Promise<"none" | "changed" | "STORE_FAIL" | "cleared"> {
    const r = this.voiceRow(name);
    if (!r) return "none";
    if (voiceId !== undefined && (r.voice_id || null) !== (voiceId || null)) return "changed";
    if (r.sample_key && this.env && this.env.MEDIA) {
      try { await this.env.MEDIA.delete(r.sample_key); }
      catch (e) {
        warn("media.delete", e, { room: this.roomName });
        this.sql.exec("UPDATE mv SET voice_id = NULL, ts = ? WHERE name = ?", Date.now(), String(name).toLowerCase());
        this.notifyMembers(name);
        await this.invalidateSpeakCache(name);
        return "STORE_FAIL";
      }
    }
    this.sql.exec("DELETE FROM mv WHERE name = ?", String(name).toLowerCase());
    this.notifyMembers(name);
    await this.invalidateSpeakCache(name);
    return "cleared";
  },

  // What a speak request needs: the message's sender and text. Drafts never speak.
  speakSource(id: number) {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "text" | "draft">>("SELECT sender, text, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || r.draft) return null;
    return { sender: r.sender, text: r.text };
  },
} satisfies ThisType<Room>;
