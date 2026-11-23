// Room methods: message media in R2 - keys, signed URLs, the md index rows, attaching media to messages.

import { b64urlDecode, b64urlEncode } from "../lib/crypto.js";
import { mediaSig } from "../lib/media.js";
import { isStoreError, storeError } from "../lib/errors.js";
import { parseRange } from "../lib/http.js";
import { STORE_MSG } from "../limits.js";
import type { CfgRow, MdRow, MsgRow, Room } from "./Room.js";
import type { MediaBytes } from "../lib/media.js";
import { warn } from "../lib/log.js";

export type DraftCols = Pick<MsgRow, "sender" | "draft">;
/** Who is asking for a message's media: drafts are their sender's (and
 *  the owner's) alone. */
export type MediaViewer = { name?: string | null, owner?: boolean };

export const MediaMethods = {
  // ---- Message media (images, audio, video): bytes live in R2, the index lives here ----
  // md maps (msg, kind) to an R2 key. An R2 failure fails the request:
  // there is no other store to fall back to (see STORE_MSG).
  mediaKey(room: string | null | undefined, id: number, kind: string) { return (room || this.roomName || "room") + "/" + id + "/" + kind; },

  // The room's media signing key: 32 random bytes in cfg, created on first
  // use. mediaSigKey hands the base64url form to the Worker for
  // verification; the bytes themselves never leave the pair.
  mediaSigKeyBytes() {
    if (this._sigBytes) return this._sigBytes;
    const row = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'media_sig_key'").toArray()[0];
    if (row && row.v) {
      try {
        const b = b64urlDecode(row.v);
        if (b.length === 32) { this._sigBytes = b; return b; }
      } catch {
        // not base64url: replaced below, like a key of the wrong length
      }
      // a new key stops every media link signed with the old one
      warn("media.sigkey", "the stored signing key is unreadable; replacing it", { room: this.roomName });
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
   * @param id a message id, or "match.n" for a Sketch & Guess drawing
   * @param ver the stored file's version (md.at), when there is one
   */
  mediaQuery(id: number | string, kind: string, ver?: number | null) {
    // The expiry sits on an hour grid, one to two hours out, so every
    // mint inside the same hour produces the identical URL. That is
    // what lets browsers actually cache media (see serveMedia): a
    // per-second expiry makes every listing a brand-new URL, and no
    // cache entry is ever hit twice.
    // v= is the file's version, unsigned (the read checks only exp and
    // sig). Without it a file replaced in the same hour kept a
    // byte-identical URL, and browsers showed their cached copy of the
    // old one for up to an hour, reloads included. A row from before
    // md.at existed has no version; any new file stamps one.
    const exp = (Math.floor(Date.now() / 3600000) + 2) * 3600;
    return "?exp=" + exp + "&sig=" + mediaSig(this.mediaSigKeyBytes(), this.roomName, id, kind, exp) + (ver ? "&v=" + ver : "");
  },

  /** md.at of these messages' stored files, by "msg:kind": one query for a whole page */
  mediaVersions(ids: number[]): Map<string, number> {
    const out: Map<string, number> = new Map();
    if (!ids.length) return out;
    for (const r of this.sql.exec<Pick<MdRow, "msg" | "kind" | "at">>("SELECT msg, kind, at FROM md WHERE msg BETWEEN ? AND ? AND at IS NOT NULL AND upload_id IS NULL", Math.min(...ids), Math.max(...ids)).toArray()) {
      if (r.at) out.set(r.msg + ":" + r.kind, r.at);
    }
    return out;
  },

  async putMedia(id: number, kind: string, data: ArrayBuffer, type: string, room: string | null | undefined) {
    const key = this.mediaKey(room, id, kind);
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) throw storeError();
    try { await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } }); } catch { throw storeError(); }
    // A single-shot attach replaces any upload in flight for the same kind.
    const prev = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0];
    if (prev && prev.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(prev.r2key, prev.upload_id).abort(); } catch { /* already completed, aborted or expired */ } }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size, at) VALUES (?, ?, ?, ?, ?, ?)", id, kind, type, key, data.byteLength, Date.now());
    return key;
  },

  // Media exists only with its message: a deleted message has none, even
  // if a row or an object outlived it. (A write that was already under
  // way when the message was deleted - a stream, an upload start, a post
  // still storing its picture - used to finish afterwards, and the file
  // was then served for a message nobody could see or delete. The draft
  // sweep collects such leftovers.) A draft's media is its sender's alone.
  mediaShown(id: number, viewer?: MediaViewer) {
    const m = this.sql.exec<DraftCols>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!m) return false;
    return !(viewer && !viewer.owner && m.draft && String(m.sender).toLowerCase() !== String(viewer.name || "").toLowerCase());
  },

  mediaMeta(id: number, kind: string, viewer?: MediaViewer) {
    if (!this.mediaShown(id, viewer)) return null;
    // An upload still in flight has no object yet.
    const row = this.sql.exec<Pick<MdRow, "type" | "r2key" | "size" | "name">>("SELECT type, r2key, size, name FROM md WHERE msg = ? AND kind = ? AND upload_id IS NULL", id, kind).toArray()[0];
    return row ? { type: row.type, r2key: row.r2key, size: row.size, name: row.name || null } : null;
  },

  /** @param range the request's Range header */
  async getMedia(id: number, kind: string, range: string | null | undefined, viewer?: MediaViewer): Promise<MediaBytes | null> {
    if (!this.mediaShown(id, viewer)) return null;
    const row = this.sql.exec<Pick<MdRow, "type" | "r2key" | "size" | "name">>("SELECT type, r2key, size, name FROM md WHERE msg = ? AND kind = ? AND upload_id IS NULL", id, kind).toArray()[0];
    if (row && row.r2key && this.env && this.env.MEDIA) {
      try {
        const rr = parseRange(range, row.size);
        const obj = await this.env.MEDIA.get(row.r2key, rr ? { range: rr.r2 } : {});
        if (obj) {
          const buf = await obj.arrayBuffer();
          return { data: buf, type: row.type, size: row.size, name: row.name || null, partial: !!rr, start: rr ? rr.start : 0, end: rr ? rr.start + buf.byteLength - 1 : row.size - 1 };
        }
      } catch (e) {
        warn("media.read", e, { room: this.roomName, id, kind });
      }
    }
    // Media lives in R2 or nowhere.
    return null;
  },

  /** @param transcript undefined keeps the current one */
  async attachAudio(id: number, who: string | null | undefined, data: ArrayBuffer, type: string, owner: boolean, transcript: string | null | undefined, room: string) {
    const r = this.sql.exec<Pick<MsgRow, "sender">>("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach audio to your own messages" };
    try { await this.putMedia(id, "audio", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    if (transcript !== undefined) this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", type, data.byteLength, transcript, id);
    else this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, data.byteLength, id);
    this.mediaLanded(id, room);
    return { status: 200, type: type, bytes: data.byteLength };
  },

  async attachImage(id: number, who: string | null | undefined, data: ArrayBuffer, type: string, owner: boolean, room: string) {
    const r = this.sql.exec<Pick<MsgRow, "sender">>("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach an image to your own messages" };
    try { await this.putMedia(id, "image", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, data.byteLength, id);
    this.mediaLanded(id, room);
    return { status: 200, type: type, bytes: data.byteLength };
  },

  async attachVideo(id: number, who: string | null | undefined, data: ArrayBuffer, type: string, owner: boolean, room: string) {
    const r = this.sql.exec<Pick<MsgRow, "sender">>("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach a video to your own messages" };
    try { await this.putMedia(id, "video", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, data.byteLength, id);
    this.mediaLanded(id, room);
    return { status: 200, type: type, bytes: data.byteLength };
  },
} satisfies ThisType<Room>;
