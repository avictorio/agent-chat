// Room methods: message media in R2 - keys, signed URLs, the md index rows, attaching media to messages.

import { b64urlDecode, b64urlEncode } from "../lib/crypto.js";
import { mediaSig } from "../lib/media.js";
import { isStoreError, storeError } from "../lib/errors.js";
import { parseRange } from "../lib/http.js";
import { STORE_MSG } from "../limits.js";

/** @typedef {import("./Room.js").MdRow} MdRow */
/** @typedef {Pick<import("./Room.js").MsgRow, "sender" | "draft">} DraftCols */
/** Who is asking for a message's media: drafts are their sender's (and
 *  the owner's) alone.
 *  @typedef {{ name?: string | null, owner?: boolean }} MediaViewer */

/** @satisfies {ThisType<import("./Room.js").Room>} */
export const MediaMethods = {
  // ---- Message media (images, audio, video): bytes live in R2, the index lives here ----
  // md maps (msg, kind) to an R2 key. The legacy in-DB store (au/im) was
  // drained and dropped in phase B; since phase A an R2 failure fails the
  // request instead of falling back (see STORE_MSG).
  /**
   * @param {string | null | undefined} room
   * @param {number} id
   * @param {string} kind
   */
  mediaKey(room, id, kind) { return (room || this.roomName || "room") + "/" + id + "/" + kind; },

  // The room's media signing key (phase E): 32 random bytes in cfg,
  // created on first use. mediaSigKey hands the base64url form to the
  // Worker for verification; the bytes themselves never leave the pair.
  mediaSigKeyBytes() {
    if (this._sigBytes) return this._sigBytes;
    const row = /** @type {Pick<import("./Room.js").CfgRow, "v">[]} */ (this.sql.exec("SELECT v FROM cfg WHERE k = 'media_sig_key'").toArray())[0];
    if (row && row.v) {
      try { const b = b64urlDecode(row.v); if (b.length === 32) { this._sigBytes = b; return b; } } catch (e) {}
    }
    const b = crypto.getRandomValues(new Uint8Array(32));
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('media_sig_key', ?)", b64urlEncode(b));
    this._sigBytes = b;
    return b;
  },

  mediaSigKey() {
    if (!this.ready) return null;
    return b64urlEncode(this.mediaSigKeyBytes());
  },

  /**
   * @param {number | string} id a message id, or "match.n" for a Sketch & Guess drawing
   * @param {string} kind
   */
  mediaQuery(id, kind) {
    // The expiry sits on an hour grid, one to two hours out, so every
    // mint inside the same hour produces the identical URL. That is
    // what lets browsers actually cache media (see serveMedia): a
    // per-second expiry makes every listing a brand-new URL, and no
    // cache entry is ever hit twice.
    const exp = (Math.floor(Date.now() / 3600000) + 2) * 3600;
    return "?exp=" + exp + "&sig=" + mediaSig(this.mediaSigKeyBytes(), this.roomName, id, kind, exp);
  },

  /**
   * @param {number} id
   * @param {string} kind
   * @param {ArrayBuffer} data
   * @param {string} type
   * @param {string | null | undefined} room
   */
  async putMedia(id, kind, data, type, room) {
    const key = this.mediaKey(room, id, kind);
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) throw storeError();
    try { await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } }); } catch (e) { throw storeError(); }
    // A single-shot attach replaces any upload in flight for the same kind.
    const prev = /** @type {Pick<MdRow, "r2key" | "upload_id">[]} */ (this.sql.exec("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = ?", id, kind).toArray())[0];
    if (prev && prev.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(prev.r2key, prev.upload_id).abort(); } catch (e) {} }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size) VALUES (?, ?, ?, ?, ?)", id, kind, type, key, data.byteLength);
    return key;
  },

  /**
   * @param {number} id
   * @param {string} kind
   * @param {MediaViewer} [viewer]
   */
  mediaMeta(id, kind, viewer) {
    if (viewer && !viewer.owner) {
      const m = /** @type {DraftCols[]} */ (this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", id).toArray())[0];
      if (m && m.draft && String(m.sender).toLowerCase() !== String(viewer.name || "").toLowerCase()) return null;
    }
    // An upload still in flight has no object yet.
    const row = /** @type {Pick<MdRow, "type" | "r2key" | "size" | "name">[]} */ (this.sql.exec("SELECT type, r2key, size, name FROM md WHERE msg = ? AND kind = ? AND upload_id IS NULL", id, kind).toArray())[0];
    return row ? { type: row.type, r2key: row.r2key, size: row.size, name: row.name || null } : null;
  },

  /**
   * @param {number} id
   * @param {string} kind
   * @param {string | null | undefined} range the request's Range header
   * @param {MediaViewer} [viewer]
   * @returns {Promise<import("../lib/media.js").MediaBytes | null>}
   */
  async getMedia(id, kind, range, viewer) {
    if (viewer && !viewer.owner) {
      const m = /** @type {DraftCols[]} */ (this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", id).toArray())[0];
      if (m && m.draft && String(m.sender).toLowerCase() !== String(viewer.name || "").toLowerCase()) return null;
    }
    const row = /** @type {Pick<MdRow, "type" | "r2key" | "size" | "name">[]} */ (this.sql.exec("SELECT type, r2key, size, name FROM md WHERE msg = ? AND kind = ? AND upload_id IS NULL", id, kind).toArray())[0];
    if (row && row.r2key && this.env && this.env.MEDIA) {
      try {
        const rr = parseRange(range, row.size);
        const obj = await this.env.MEDIA.get(row.r2key, rr ? { range: rr.r2 } : {});
        if (obj) {
          const buf = await obj.arrayBuffer();
          return { data: buf, type: row.type, size: row.size, name: row.name || null, partial: !!rr, start: rr ? rr.start : 0, end: rr ? rr.start + buf.byteLength - 1 : row.size - 1 };
        }
      } catch (e) {}
    }
    // No legacy fallback any more (phase B): media lives in R2 or nowhere.
    return null;
  },

  /**
   * @param {number} id
   * @param {string | null | undefined} who
   * @param {ArrayBuffer} data
   * @param {string} type
   * @param {boolean} owner
   * @param {string | null | undefined} transcript undefined keeps the current one
   * @param {string} room
   */
  async attachAudio(id, who, data, type, owner, transcript, room) {
    const r = /** @type {Pick<import("./Room.js").MsgRow, "sender">[]} */ (this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray())[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach audio to your own messages" };
    try { await this.putMedia(id, "audio", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    if (transcript !== undefined) this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", type, data.byteLength, transcript, id);
    else this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, data.byteLength, id);
    return { status: 200, type: type, bytes: data.byteLength };
  },

  /**
   * @param {number} id
   * @param {string | null | undefined} who
   * @param {ArrayBuffer} data
   * @param {string} type
   * @param {boolean} owner
   * @param {string} room
   */
  async attachImage(id, who, data, type, owner, room) {
    const r = /** @type {Pick<import("./Room.js").MsgRow, "sender">[]} */ (this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray())[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach an image to your own messages" };
    try { await this.putMedia(id, "image", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, data.byteLength, id);
    return { status: 200, type: type, bytes: data.byteLength };
  },

  /**
   * @param {number} id
   * @param {string | null | undefined} who
   * @param {ArrayBuffer} data
   * @param {string} type
   * @param {boolean} owner
   * @param {string} room
   */
  async attachVideo(id, who, data, type, owner, room) {
    const r = /** @type {Pick<import("./Room.js").MsgRow, "sender">[]} */ (this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray())[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach a video to your own messages" };
    try { await this.putMedia(id, "video", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, data.byteLength, id);
    return { status: 200, type: type, bytes: data.byteLength };
  },
};
