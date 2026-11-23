// Room methods: messages - posting, reading and listing, reactions, drafts and publishing, deletion, the attachments shelf.

import { streamWants } from "./state.js";
import { isGoneError, isStoreError, storeError } from "../lib/errors.js";
import { CLIENT_MSG_ID_KEEP, CLIENT_MSG_ID_MS, KEEP, MAX_TEXT, UP_SESSION_MS } from "../limits.js";
import { deleteFrame, gapFrame, sseFrame } from "../lib/http.js";
import { mentionsName, nameFold, sameName } from "../lib/text.js";
import { gameEngine } from "../games/engine.js";
import type { AttachmentKind, AttachmentsResponse, Message, MessagesResponse } from "@chat/contract";
import type { CfgRow, InvRow, MdRow, MdelRow, MsgRow, PcidRow, Refusal, Room, RxRow, StreamClient } from "./Room.js";
import { warn } from "../lib/log.js";

/** The columns a message is served from (withKinds turns them into the API's fields). */
const MSG_COLS = 'id, ts, sender AS "from", text, audio_type, audio_size, audio_transcript, image_type, image_size, video_type, video_size, html_type, html_size, html_name, doc_type, doc_size, doc_name, file_type, file_size, file_name, game_id';

/** A message as the API serves it (withKinds): the contract's Message,
 *  plus the members its text @-mentions. */
export type ApiMessage = Message & { targets: string[] };
/** A message as a listing reads it (its sender as from), before withKinds
 *  turns its media columns into media references. */
export type MsgListRow = { id: number, ts: number, from: string, text: string }
  & Partial<Omit<MsgRow, "id" | "ts" | "sender" | "text" | "draft" | "pubauto" | "pub_ts" | "owntrust" | "seq">>;
/** A live message and its delivery number: the number forward reads and
 *  the stream's "id:" lines go by (the message's id unless it went live
 *  late or was sent again; Room.ts, schema step 3). */
export type Delivered = { msg: ApiMessage, dn: number };
/** A listing row while withKinds rewrites it in place into an ApiMessage:
 *  its columns as read (typed), plus the fields it gains on the way. */
export type MsgBag = MsgListRow & Record<string, unknown>;
/** post()'s answer to a repeated client_msg_id: the first post's message
 *  as it is now, and whether it is still a draft (and publishes itself). */
export type PostRepeat = { repeat: true, msg: ApiMessage, draft: boolean, pubauto: boolean };
/** Inline media for post(): the bytes and their sniffed type, plus the
 *  audio transcript or the page / document name those kinds carry. */
export type InlineMedia = { data: ArrayBuffer, type: string, transcript?: string | null, name?: string };

export const MessageMethods = {
  // Reactions: one per person per message. Streams get an "event: reaction"; long-polls waiting on the room wake up.
  reactionsFor(id: number) {
    /** who, by emoji */
    const out: Record<string, string[]> = {};
    for (const r of this.sql.exec<Pick<RxRow, "emoji" | "who">>("SELECT emoji, who FROM rx WHERE msg = ? ORDER BY ts", id).toArray()) (out[r.emoji] = out[r.emoji] || []).push(r.who);
    return out;
  },

  reactionsOf(id: number, who: string | null | undefined, owner: boolean) {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "draft" | "ts">>("SELECT sender, draft, ts FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    // Drafts are invisible to everyone but their sender and the owner, here
    // as everywhere else: a draft answers exactly like a missing message.
    if (this.draftHidden(r, who, owner)) return null;
    return this.reactionsFor(id);
  },

  /** @param emoji null takes the reaction back */
  react(id: number, who: string, emoji: string | null, room: string, owner: boolean) {
    const msg = this.sql.exec<Pick<MsgRow, "sender" | "draft" | "ts">>("SELECT sender, draft, ts FROM m WHERE id = ?", id).toArray()[0];
    if (!msg) return null;
    if (this.draftHidden(msg, who, owner)) return null;
    const ts = Date.now();
    for (const x of this.sql.exec<Pick<RxRow, "who">>("SELECT DISTINCT who FROM rx WHERE msg = ?", id).toArray()) if (sameName(x.who, who)) this.sql.exec("DELETE FROM rx WHERE msg = ? AND who = ?", id, x.who);
    if (emoji) this.sql.exec("INSERT INTO rx (msg, emoji, who, ts) VALUES (?, ?, ?, ?)", id, emoji, who, ts);
    const reactions = this.reactionsFor(id);
    const frame = "event: reaction\ndata: " + JSON.stringify({ type: "reaction", room: room, id: id, message_from: msg.sender, from: who, kind: this.memberKind(who), targets: [msg.sender], reaction: emoji, reactions: reactions, ts: ts }) + "\n\n";
    // A draft is private to its sender (and the owner): its reactions are
    // not announced to the rest of the room.
    const sees = (c: StreamClient) => !msg.draft || !this.draftHidden(msg, c.name, c.owner);
    for (const c of this.clients) { if (streamWants(c, "reaction") && sees(c)) c.send(frame); }
    if (msg.draft) return { reactions: reactions, message_from: msg.sender };
    this.emitState(room);
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    return { reactions: reactions, message_from: msg.sender };
  },

  /**
   * A post with no client_msg_id (the room's own callers, the fetch
   * tool's post, MCP begin_upload's draft): postKeyed without one.
   * @param trusted the post carried the owner key (kept as provenance)
   * @param pubauto publish the draft once its upload verifies
   */
  async post(sender: string, text: string, room: string, trusted: boolean, audio: InlineMedia | null = null, image: InlineMedia | null = null, video: InlineMedia | null = null, draft = false, pubauto = false, html: InlineMedia | null = null, doc: InlineMedia | null = null): Promise<ApiMessage | null> {
    const r = await this.postKeyed(null, sender, text, room, trusted, audio, image, video, draft, pubauto, html, doc);
    if (r && ("repeat" in r || "status" in r)) throw new Error("a post without a client_msg_id cannot repeat");
    return r;
  },

  /**
   * @param trusted the post carried the owner key (kept as provenance)
   * @param pubauto publish the draft once its upload verifies
   * @param cid the client_msg_id the post carried: a repeat of one this
   *   sender used gets the first post back (repeatPost), not a second post
   * @returns the message; null when it was deleted while its media was
   *   stored; a repeat, or a refusal of one
   */
  async postKeyed(cid: string | null, sender: string, text: string, room: string, trusted: boolean, audio: InlineMedia | null = null, image: InlineMedia | null = null, video: InlineMedia | null = null, draft = false, pubauto = false, html: InlineMedia | null = null, doc: InlineMedia | null = null): Promise<ApiMessage | PostRepeat | { status: 409, error: string, id: number, code: "post_gone" | "still_storing" } | null> {
    // the room the post was sent to: deleted during the sweep, it takes no message (Room.fence)
    const gen = this.gen;
    this.fence(gen);
    await this.sweepDrafts(room);
    this.fence(gen);
    this.roomName = room;
    // Looked up and recorded with no await between, with the insert
    // below: a repeat sent while the first is still storing its media
    // finds it.
    if (cid) {
      const seen = this.sql.exec<Pick<PcidRow, "msg" | "draft" | "ts">>("SELECT msg, draft, ts FROM pcid WHERE sender = ? AND cid = ?", this.postIdKey(sender, trusted), cid).toArray()[0];
      // One recorded before the sender's invite was made is a previous
      // holder's of the name (draftSince): answered as a repeat, it
      // handed the new holder the old holder's draft, caption included.
      // This post goes ahead, and its record takes that one's place.
      if (seen && (trusted || Number(seen.ts) >= this.draftSince(sender))) return this.repeatPost(seen.msg, !!seen.draft);
    }
    const ts = Date.now();
    // A post with media inside it is stored as a draft until every file
    // is in storage, then goes live in one step. Stored live from the
    // start it could be read before it was announced - without its media,
    // and even when the post then failed and "nothing was saved" - and a
    // reader who took a later message's id as their cursor meanwhile
    // never got it.
    const held = !draft && !!(audio || image || video || html || doc);
    const id = this.sql.exec<Pick<MsgRow, "id">>("INSERT INTO m (id, ts, sender, text, draft, pubauto, pub_ts, owntrust) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, sender, text, draft || held ? 1 : null, draft && pubauto ? 1 : null, ts, trusted ? 1 : null).one().id;
    if (cid) this.rememberPostId(this.postIdKey(sender, trusted), cid, id, draft, ts);
    // Inline media is all or nothing: every put lands in R2 before the
    // message is announced at the end of this method, so on a storage
    // failure the catch below removes the row, its index rows and any object
    // already written - no message, no frame, no push survives a failed post.
    // Nothing publishes or sweeps it until every file is in (Room.storing).
    if (audio || image || video || html || doc) this.storing.add(id);
    try {
      if (audio) {
        await this.putMedia(id, "audio", audio.data, audio.type, room);
        this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", audio.type, audio.data.byteLength, audio.transcript || null, id);
      }
      if (image) {
        await this.putMedia(id, "image", image.data, image.type, room);
        this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", image.type, image.data.byteLength, id);
      }
      if (video) {
        await this.putMedia(id, "video", video.data, video.type, room);
        this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", video.type, video.data.byteLength, id);
      }
      if (html) {
        await this.putMedia(id, "html", html.data, html.type, room);
        this.sql.exec("UPDATE m SET html_type = ?, html_size = ?, html_name = ? WHERE id = ?", html.type, html.data.byteLength, html.name || null, id);
      }
      if (doc) {
        await this.putMedia(id, "doc", doc.data, doc.type, room);
        this.sql.exec("UPDATE m SET doc_type = ?, doc_size = ?, doc_name = ? WHERE id = ?", doc.type, doc.data.byteLength, doc.name || null, id);
      }
    } catch (e) {
      // a deleted room took these rows with it (and a new one is not this room's)
      if (isGoneError(e)) throw e;
      // Any failure, not only storage's: nothing was posted, so the rows
      // go and the same client_msg_id sent again posts it. Only a store
      // error used to clean up; anything else left the held message and
      // its pcid row, and every retry with that id was told "still storing
      // its files" until the draft sweep, then "no longer in the room".
      const keys = this.sql.exec<Pick<MdRow, "r2key">>("SELECT r2key FROM md WHERE msg = ?", id).toArray().map((r) => r.r2key).filter(Boolean);
      this.sql.exec("DELETE FROM md WHERE msg = ?", id);
      this.sql.exec("DELETE FROM m WHERE id = ?", id);
      this.sql.exec("DELETE FROM pcid WHERE msg = ?", id);
      if (keys.length && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(keys); } catch (de) { warn("media.delete", de, { room: this.roomName }); } }
      if (isStoreError(e)) throw storeError();
      throw e;
    } finally {
      this.storing.delete(id);
    }
    // The message was deleted while its media was being stored (its
    // sender, or the owner, got there first): nothing is announced, and
    // what this call stored goes with it.
    if (!this.sql.exec("SELECT id FROM m WHERE id = ?", id).toArray().length) {
      const keys = this.sql.exec<Pick<MdRow, "r2key">>("SELECT r2key FROM md WHERE msg = ?", id).toArray().map((r) => r.r2key).filter(Boolean);
      this.sql.exec("DELETE FROM md WHERE msg = ?", id);
      if (keys.length && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(keys); } catch (de) { warn("media.delete", de, { room: this.roomName }); } }
      return null;
    }
    // held back until here: now it is live, and it went live now (a
    // reader whose cursor passed its id meanwhile is still owed it)
    const dn = held ? this.goLive(id) : id;
    this.trimHistory();
    // A member has posted once something of theirs went live: a draft is
    // invisible, and stamping it put the drafter into the digest rotation
    // that room_state shows every member (awaiting_digest_from), even
    // after the draft was deleted. publishMessage stamps a draft's sender.
    if (!draft) { const [who, ...names] = this.invMatch(sender); this.sql.exec("UPDATE inv SET posted = ? WHERE " + who + " AND posted IS NULL", ts, ...names); }
    const row: MsgListRow = { id, ts, from: sender, text };
    if (audio) { row.audio_type = audio.type; row.audio_size = audio.data.byteLength; row.audio_transcript = audio.transcript || null; }
    if (image) { row.image_type = image.type; row.image_size = image.data.byteLength; }
    if (video) { row.video_type = video.type; row.video_size = video.data.byteLength; }
    if (html) { row.html_type = html.type; row.html_size = html.data.byteLength; row.html_name = html.name || null; }
    if (doc) { row.doc_type = doc.type; row.doc_size = doc.data.byteLength; row.doc_name = doc.name || null; }
    const msg = this.withKinds([row])[0];
    // A draft is stored but not announced: no stream frame, no push. It goes
    // live only when publishMessage runs - that is what lets a long media upload
    // finish before the message officially posts.
    if (!draft) this.announce(msg, room, dn);
    return msg;
  },

  /** Whose client_msg_ids a post is filed under (pcid.sender): the
   *  sender's fold, or for a post made with the owner key, that fold
   *  behind a control character, which no member name can hold. The owner
   *  posts under any name, and filed with the member's own posts, an
   *  owner post as "Ada" and Ada's own with the same id answered each
   *  other as repeats. */
  postIdKey(sender: string, trusted: boolean) {
    return (trusted ? "\u0001" : "") + nameFold(sender);
  },

  /** Records a post's client_msg_id under key (postIdKey), and lets go of
   *  that key's ids past the newest CLIENT_MSG_ID_KEEP or older than
   *  CLIENT_MSG_ID_MS. */
  rememberPostId(key: string, cid: string, id: number, draft: boolean, ts: number) {
    this.sql.exec("INSERT OR REPLACE INTO pcid (sender, cid, msg, ts, draft) VALUES (?, ?, ?, ?, ?)", key, cid, id, ts, draft ? 1 : null);
    this.sql.exec("DELETE FROM pcid WHERE sender = ? AND (ts < ? OR rowid NOT IN (SELECT rowid FROM pcid WHERE sender = ? ORDER BY ts DESC, rowid DESC LIMIT ?))", key, ts - CLIENT_MSG_ID_MS, key, CLIENT_MSG_ID_KEEP);
  },

  /**
   * The answer to a post that repeats a client_msg_id: the message the
   * first one made, as it is now (a draft since published is live). A
   * first post still storing its media, or one whose message is gone,
   * is a 409: answered as posted, the first could still fail, and
   * posting again would bring back a message its sender deleted.
   * @param asDraft the first post asked to be a draft
   */
  // The two refusals carry a code, since a client must act differently on
  // each: wait and ask again with the same id (still_storing), or send a
  // new id if it wants the message posted again (post_gone). They used to
  // differ only in their wording, and the web app, guessing from what it
  // had sent, could post a slow upload a second time.
  repeatPost(id: number, asDraft: boolean): PostRepeat | { status: 409, error: string, id: number, code: "post_gone" | "still_storing" } {
    const r = this.sql.exec<MsgListRow & Pick<MsgRow, "draft" | "pubauto">>("SELECT " + MSG_COLS + ", draft, pubauto FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 409, error: "This client_msg_id already posted message " + id + ", which is no longer in the room; nothing was posted. Send a new client_msg_id to post it again.", id, code: "post_gone" };
    if (r.draft && !asDraft) return { status: 409, error: "This client_msg_id's first post (message " + id + ") is still storing its files; nothing was posted. Ask again in a moment.", id, code: "still_storing" };
    const { draft, pubauto, ...row } = r;
    return { repeat: true, msg: this.withKinds([row])[0], draft: !!draft, pubauto: !!(draft && pubauto) };
  },

  // The room keeps its newest KEEP live messages - newest by when they
  // went live, not by id. A draft keeps the id it was created with, so one
  // published after KEEP newer messages was "older than the window" by
  // id, and the next post deleted it, media and all, moments after it
  // appeared. Drafts are never trimmed: their upload may still be running.
  // Every writer of m calls this, the Referee's posts and match cards
  // included (only post() used to, so a room that only played games kept
  // every message ever posted).
  trimHistory() {
    const cut = this.sql.exec<{ t: number, id: number }>("SELECT COALESCE(pub_ts, ts) AS t, id FROM m WHERE draft IS NULL OR draft = 0 ORDER BY t DESC, id DESC LIMIT 1 OFFSET ?", KEEP).toArray()[0];
    if (!cut) return;
    const old = "SELECT id FROM m WHERE (draft IS NULL OR draft = 0) AND (COALESCE(pub_ts, ts) < ? OR (COALESCE(pub_ts, ts) = ? AND id <= ?))";
    const keys = this.sql.exec<Pick<MdRow, "r2key">>("SELECT r2key FROM md WHERE r2key IS NOT NULL AND msg IN (" + old + ")", cut.t, cut.t, cut.id).toArray().map((r) => r.r2key);
    // a stream resuming from below these numbers can no longer be given them
    this.forget(this.sql.exec<{ n: number | null }>("SELECT MAX(COALESCE(seq, id)) AS n FROM m WHERE id IN (" + old + ")", cut.t, cut.t, cut.id).one().n || 0);
    for (const table of ["rx", "md", "upp"]) this.sql.exec("DELETE FROM " + table + " WHERE msg IN (" + old + ")", cut.t, cut.t, cut.id);
    this.sql.exec("DELETE FROM m WHERE (draft IS NULL OR draft = 0) AND (COALESCE(pub_ts, ts) < ? OR (COALESCE(pub_ts, ts) = ? AND id <= ?))", cut.t, cut.t, cut.id);
    if (!keys.length || !this.env || !this.env.MEDIA) return;
    // storage takes at most 1000 keys a call
    for (let i = 0; i < keys.length; i += 1000) {
      this.ctx.waitUntil(this.env.MEDIA.delete(keys.slice(i, i + 1000)).catch((e) => warn("media.delete", e, { room: this.roomName })));
    }
  },

  /** @param dn the message's delivery number, its frame's "id:" line */
  announce(msg: ApiMessage, room: string | null, dn: number = msg.id) {
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    if (this.clients.size) {
      // Message frames are lean and identical for every client; the
      // current room state travels as its own event (see emitState).
      const frame = sseFrame(room, msg, dn);
      for (const c of this.clients) {
        if (!streamWants(c, "message")) continue;
        c.send(frame);
      }
      this.emitState(room);
    }
    this.ctx.waitUntil(this.notifyPush(msg, room).catch((e) => this.activityLog(room, "push error: " + String((e && e.message) || e))));
  },

  // Media landed on a message that is already live: an attach after the
  // post (PUT /messages/ID/image, attach_media) or an upload finished on a
  // published message. Only the rows used to change, so open tabs kept the
  // text-only message until a reload, long polls slept through it, and a
  // reader whose cursor had passed the id never saw the file. The message
  // goes out again, whole, under a fresh delivery number: the web app swaps
  // in a copy that carries media its own lacks, a long poll wakes, and a
  // forward read from any earlier cursor, the message's own included,
  // returns it once. pub_ts stays when it went live, so the trim order does
  // not change (moving pub_ts used to do both jobs, and a reader whose
  // cursor was this very message got nothing). No second push: members
  // were told when it went live. A draft is left alone; its publish
  // announces it with everything it has.
  mediaLanded(id: number, room: string | null | undefined) {
    const r = this.sql.exec<Pick<MsgRow, "draft">>("SELECT draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || r.draft) return;
    const dn = this.nextMsgId();
    this.sql.exec("UPDATE m SET seq = ? WHERE id = ?", dn, id);
    const msg = this.withKinds(this.sql.exec<MsgListRow>('SELECT id, ts, sender AS "from", text, audio_type, audio_size, audio_transcript, image_type, image_size, video_type, video_size, html_type, html_size, html_name, doc_type, doc_size, doc_name, file_type, file_size, file_name, game_id FROM m WHERE id = ?', id).toArray())[0];
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    if (!this.clients.size || !msg) return;
    const frame = sseFrame(room || null, msg, dn);
    for (const c of this.clients) { if (streamWants(c, "message")) c.send(frame); }
    this.emitState(room);
  },

  // Message ids never come back. SQLite hands out max(id)+1, so deleting
  // the newest message would free its id for the next post: cursor
  // readers past it would miss the repost, and a signed media URL for the
  // deleted message would serve the new one's media. A high-water mark in
  // cfg keeps every id fresh. Delivery numbers (m.seq) come from the same
  // counter, so ids and delivery numbers share one number line.
  nextMsgId() {
    const id = this.msgHwm() + 1;
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('msg_hwm', ?)", String(id));
    return id;
  },

  /** The newest number the id counter has handed out. */
  msgHwm(): number {
    const max = this.sql.exec<{ n: number | null }>("SELECT MAX(MAX(id), COALESCE(MAX(seq), 0)) AS n FROM m").one().n || 0;
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'msg_hwm'").toArray()[0];
    return Math.max(max, r ? parseInt(r.v, 10) || 0 : 0);
  },

  // A draft or a held post goes live now. While its id is still the newest
  // number handed out nothing can be past it, so it is delivered under its
  // id and no number is spent; otherwise it takes a fresh delivery number,
  // so a reader whose cursor passed its id meanwhile gets it, once.
  /** @returns its delivery number */
  goLive(id: number): number {
    const seq = id < this.msgHwm() ? this.nextMsgId() : null;
    this.sql.exec("UPDATE m SET draft = NULL, pub_ts = ?, seq = ? WHERE id = ?", Date.now(), seq, id);
    return seq === null ? id : seq;
  },

  // A room message from the referee itself (match results). Not a member: it
  // never claims a member's name, and members cannot post as it.
  postSystem(text: string, room: string) {
    const ts = Date.now();
    const id = this.sql.exec<Pick<MsgRow, "id">>("INSERT INTO m (id, ts, sender, text, pub_ts) VALUES (?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, "Referee", text, ts).one().id;
    this.trimHistory();
    const msg = this.withKinds([{ id: id, ts: ts, from: "Referee", text: text }])[0];
    this.announce(msg, room);
    return msg;
  },

  /** The kinds of the message's uploads still in flight: begun less than
   *  UP_SESSION_MS ago (sweepDrafts counts them the same way). */
  upsLive(id: number): string[] {
    return this.sql.exec<Pick<MdRow, "kind">>("SELECT md.kind AS kind FROM md JOIN m ON m.id = md.msg WHERE md.msg = ? AND md.upload_id IS NOT NULL AND COALESCE(md.began, m.ts) > ? ORDER BY md.kind", id, Date.now() - UP_SESSION_MS).toArray().map((x) => x.kind);
  },

  /** @param text a caption to publish with (undefined or null keeps the draft's) */
  async publishMessage(id: number, who: string | null | undefined, owner: boolean, room: string, text: unknown) {
    const r = this.sql.exec<MsgRow>("SELECT * FROM m WHERE id = ?", id).toArray()[0];
    if (!r || this.draftHidden(r, who, owner)) return { status: 404, error: "No message with that id" };
    if (!owner && !sameName(r.sender, who)) return { status: 403, error: "You can only publish your own messages" };
    if (!r.draft) return { status: 409, error: "That message is already live" };
    // Its post is still storing its files (Room.storing): published now it
    // went out with half of them, and a later file's failure then deleted
    // the live message without telling anyone.
    if (this.storing.has(id)) return { status: 409, error: "Message " + id + " is still storing its files; nothing was published. Publish it once its post has answered." };
    // Not while one of its files is still on its way: published then, the
    // message went live with that file missing and its upload dangling,
    // or with a file from another send the author had dropped since (a
    // resend that adopted the draft, another device). Whatever ends the
    // last upload publishes a publish_on_complete draft (maybeAutoPublish).
    // An upload past UP_SESSION_MS from its start is no longer on its way
    // (storage has dropped it) and holds nothing back.
    const flying = this.upsLive(id);
    if (flying.length) return { status: 409, error: "An upload for this message is still in flight (" + flying.join(", ") + "): finish it, or abort it (POST /messages/" + id + "/KIND/abort), then publish", uploading: flying };
    // An over-long caption is refused, as a post with it is: cutting it to
    // MAX_TEXT here published a shortened message and told no one, when
    // the author could have split it.
    if (text !== undefined && text !== null && String(text).length > MAX_TEXT) return { status: 413, error: "\"text\" is limited to " + MAX_TEXT + " characters" };
    // An empty shell never goes live: MCP begin_upload can mint a draft with
    // no text (a media container captioned later), which REST's post path
    // forbids creating - this is the uniform backstop for both surfaces.
    const finalText = (text !== undefined && text !== null) ? String(text) : (r.text || "");
    if (!finalText.trim() && !r.audio_type && !r.image_type && !r.video_type && !r.html_type && !r.doc_type && !r.file_type) return { status: 400, error: "Nothing to publish yet: add text or attach the media first" };
    if (text !== undefined && text !== null) this.sql.exec("UPDATE m SET text = ? WHERE id = ?", String(text), id);
    const dn = this.goLive(id);
    const [poster, ...names] = this.invMatch(r.sender);
    this.sql.exec("UPDATE inv SET posted = ? WHERE " + poster + " AND posted IS NULL", Date.now(), ...names);
    const f = this.sql.exec<MsgRow>("SELECT * FROM m WHERE id = ?", id).toArray()[0];
    const row = { id: f.id, ts: f.ts, from: f.sender, text: f.text, audio_type: f.audio_type, audio_size: f.audio_size, audio_transcript: f.audio_transcript, image_type: f.image_type, image_size: f.image_size, video_type: f.video_type, video_size: f.video_size, html_type: f.html_type, html_size: f.html_size, html_name: f.html_name, doc_type: f.doc_type, doc_size: f.doc_size, doc_name: f.doc_name, file_type: f.file_type, file_size: f.file_size, file_name: f.file_name };
    const msg = this.withKinds([row])[0];
    this.roomName = room;
    this.announce(msg, room, dn);
    return { status: 200, msg: msg };
  },

  // Publish-on-completion: a draft created with publish_on_complete is
  // the sender's standing instruction to post the moment its media upload
  // verifies - for an uploader that may finish with no client left to
  // call /publish. Runs through publishMessage so the announce path (stream,
  // push) is identical to a manual publish. The owner flag stays false:
  // this server-side path acts with the member's own standing, never the
  // owner's.
  // It runs wherever an upload of the draft ends - a finish, an abort, a
  // finish or stream whose file did not land, a revoke's cancel - and in
  // the draft sweep, which is where an upload that expired unfinished is
  // noticed. It ran on a finish only, so a draft whose last upload was
  // aborted after another file had finished stayed a draft, and the sweep
  // deleted it with that file a day later. It goes live once one file is
  // in place and no upload is still live; a draft with nothing finished
  // stays a draft.
  async maybeAutoPublish(id: number, room: string) {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "draft" | "pubauto">>("SELECT sender, draft, pubauto FROM m WHERE id = ?", id).toArray()[0];
    if (!r || !r.draft || !r.pubauto || this.storing.has(id)) return null;
    if (!this.sql.exec("SELECT 1 FROM md WHERE msg = ? AND upload_id IS NULL LIMIT 1", id).toArray().length) return null;
    if (this.upsLive(id).length) return null;
    const res = await this.publishMessage(id, r.sender, false, room, undefined);
    return res && res.status === 200 ? res.msg : null;
  },

  /** Ends the uploads and deletes the objects that media rows pointed at (the rows are the caller's to delete, first). */
  async dropStored(media: Array<Pick<MdRow, "r2key" | "upload_id">>) {
    if (!this.env || !this.env.MEDIA) return;
    for (const md of media) {
      if (md.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(md.r2key, md.upload_id).abort(); } catch { /* already completed, aborted or expired */ } }
      if (md.r2key) { try { await this.env.MEDIA.delete(md.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
    }
  },

  // Delete one of your own messages (the owner can delete any). Removes the
  // row, its reactions, and any media: in-flight multipart uploads are
  // aborted and R2 objects deleted.
  /** @param draftOnly delete it only while it is still a draft (409 once it is live) */
  async deleteMessage(id: number, who: string | null | undefined, owner: boolean, draftOnly = false) {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "draft" | "ts">>("SELECT sender, draft, ts FROM m WHERE id = ?", id).toArray()[0];
    if (!r || this.draftHidden(r, who, owner)) return { status: 404, error: "No message with that id" };
    if (!owner && !sameName(r.sender, who)) return { status: 403, error: "You can only delete your own messages" };
    // A client throwing away an upload it thinks never finished asks for
    // this: the draft may have been published meanwhile (another tab or
    // device picked it up, or this one's publish answer was lost), and a
    // plain delete then took the live message from everyone.
    if (draftOnly && !r.draft) return { status: 409, error: "That message is already live, so it was not deleted" };
    // The rows go first, in this one step, and storage after: with the
    // storage calls first, whatever happened to the message while they ran
    // (a publish, a new attachment) was deleted unseen along with it.
    const media = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ?", id).toArray();
    this.sql.exec("DELETE FROM upp WHERE msg = ?", id);
    this.sql.exec("DELETE FROM md WHERE msg = ?", id);
    this.sql.exec("DELETE FROM rx WHERE msg = ?", id);
    this.sql.exec("DELETE FROM m WHERE id = ?", id);
    // A live message's delete is announced, and kept for a replay; a
    // draft was never shown to anyone else.
    if (!r.draft) this.announceDelete(id, owner ? null : (who || null));
    await this.dropStored(media);
    return { status: 200, deleted: id };
  },

  // A delete goes out as a "delete" frame under a delivery number of its
  // own (from the id counter, like a message), and is kept in mdel so a
  // stream resuming from below that number gets it in order with the
  // messages. Without it every open page kept the deleted message, and
  // links to its media that no longer worked, until a reload.
  announceDelete(id: number, who: string | null) {
    const d: MdelRow = { dn: this.nextMsgId(), id, ts: Date.now(), who };
    this.sql.exec("INSERT INTO mdel (dn, id, ts, who) VALUES (?, ?, ?, ?)", d.dn, d.id, d.ts, d.who);
    this.trimDeletes();
    if (!this.clients.size) return;
    const frame = this.deleteFrameOf(d);
    for (const c of this.clients) { if (streamWants(c, "delete")) c.send(frame); }
  },

  deleteFrameOf(d: MdelRow) {
    return deleteFrame(d.dn, { type: "delete", room: this.roomName || null, from: d.who, kind: this.memberKind(d.who), targets: [], id: d.id });
  },

  // The newest KEEP deletes are kept, as the newest KEEP messages are; a
  // stream resuming from below the ones dropped gets a gap frame instead.
  trimDeletes() {
    const cut = this.sql.exec<Pick<MdelRow, "dn">>("SELECT dn FROM mdel ORDER BY dn DESC LIMIT 1 OFFSET ?", KEEP).toArray()[0];
    if (!cut) return;
    this.forget(cut.dn);
    this.sql.exec("DELETE FROM mdel WHERE dn <= ?", cut.dn);
  },

  /** Records that deliveries up to dn may no longer be held (cfg msg_forgot only rises). */
  forget(dn: number) {
    if (dn > this.forgotten()) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('msg_forgot', ?)", String(dn));
  },

  /** The highest delivery number the room no longer holds everything up to (0: it holds all). */
  forgotten(): number {
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'msg_forgot'").toArray()[0];
    return r ? parseInt(r.v, 10) || 0 : 0;
  },

  // What a stream opened with after=N is owed before it goes live: a gap
  // frame when deliveries past N are no longer held (the room keeps KEEP
  // messages and KEEP deletes), then every message and delete numbered past
  // N, in delivery order. A reconnect after more messages than the room
  // keeps used to be shown its old rows joined straight onto the new ones,
  // with nothing to say some were missing in between; and the replay
  // stopped at KEEP messages, which a room holds more of for a while when
  // drafts publish (only a post trims).
  replay(c: StreamClient, room: string, after: number) {
    const through = this.forgotten();
    if (streamWants(c, "gap") && through > after) c.send(gapFrame({ type: "gap", room, from: null, kind: null, targets: [], after, through }));
    const out: Array<{ dn: number, frame: string }> = [];
    if (streamWants(c, "message")) {
      // one page at a time, all of it: no await runs in between, so nothing changes under it
      for (let from = after; ;) {
        const page = this.delivered(from, KEEP);
        for (const d of page) out.push({ dn: d.dn, frame: sseFrame(room, d.msg, d.dn) });
        if (page.length < KEEP) break;
        from = page[page.length - 1]!.dn;
      }
    }
    if (streamWants(c, "delete")) {
      for (const d of this.sql.exec<MdelRow>("SELECT dn, id, ts, who FROM mdel WHERE dn > ? ORDER BY dn", after).toArray()) out.push({ dn: d.dn, frame: this.deleteFrameOf(d) });
    }
    out.sort((a, b) => a.dn - b.dn);
    for (const o of out) c.send(o.frame);
  },

  // The members @-mentioned in a text: canonical names, in the order they
  // are first mentioned, the sender excluded. The same word-boundary rule
  // as push targeting (mentionsName).
  /** @param names the members (read here when not given) */
  mentionTargets(text: string | null | undefined, selfName: string | null | undefined, names?: string[]): string[] {
    const t = String(text || "");
    if (!t || t.indexOf("@") < 0) return [];
    const list = names || this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    const low = t.toLowerCase(); // lowercase-ok: where the mention sits in the text, as mentionsName finds it
    const hits = [];
    for (const name of list) {
      if (sameName(name, selfName)) continue;
      if (!mentionsName(t, name)) continue;
      const needle = "@" + name.toLowerCase(); // lowercase-ok: as above
      let at = -1;
      let i = low.indexOf(needle);
      while (i >= 0) {
        const before = i === 0 ? "" : low.charAt(i - 1);
        const after = low.charAt(i + needle.length);
        if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) { at = i; break; }
        i = low.indexOf(needle, i + 1);
      }
      hits.push({ name: name, at: at });
    }
    hits.sort((a, b) => a.at - b.at);
    return hits.map((h) => h.name);
  },

  // Adds kind ("human" | "agent") to each message from the sender's invite.
  // A sender with no invite is a system actor - the Referee, above all -
  // and reads "non_interactive": not a member anyone can address. Targets
  // (the members @-mentioned in the text) ride along on every message.
  /**
   * @param rows rewritten in place
   * @returns the same rows
   */
  withKinds(rows: MsgListRow[]): ApiMessage[] {
    if (!rows.length) return rows as ApiMessage[];
    // kind by folded name (nameFold), the newest invite's (as memberKind).
    // Both sides were lowercased apart - JS on the sender, SQL lower() on
    // the invite, which folds ASCII only - so every sender with a capital
    // outside ASCII ("Émile", "Иван") matched no invite and read as a
    // system actor, the Referee's kind.
    const map: Map<string, string> = new Map(this.sql.exec<Pick<InvRow, "name" | "kind">>("SELECT name, kind FROM inv ORDER BY revoked IS NOT NULL DESC, created").toArray().map((r) => [nameFold(r.name), r.kind === "human" ? "human" : "agent"]));
    const names = this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    for (const r of rows as MsgBag[]) {
      r.kind = !r.from ? null : (map.get(nameFold(r.from)) || "non_interactive");
      r.targets = this.mentionTargets(r.text, r.from, names);
    }
    // Reactions: { "👍": ["Henry", ...], ... } in the order they were first used.
    const ids = rows.map((r) => r.id).filter((x) => typeof x === "number");
    if (ids.length) {
      /** who reacted, by emoji, by message */
      const by: Map<number, Record<string, string[]>> = new Map();
      for (const x of this.sql.exec<Pick<RxRow, "msg" | "emoji" | "who">>("SELECT msg, emoji, who FROM rx WHERE msg BETWEEN ? AND ? ORDER BY ts", Math.min(...ids), Math.max(...ids)).toArray()) {
        if (!by.has(x.msg)) by.set(x.msg, {});
        const o = by.get(x.msg) as Record<string, string[]>; // set just above
        (o[x.emoji] = o[x.emoji] || []).push(x.who);
      }
      for (const r of rows as MsgBag[]) r.reactions = by.get(r.id) || {};
    }
    // Audio and images: listings carry type, size and URL; the bytes live behind the URL.
    const withMedia = (rows as MsgBag[]).filter((r) => r.audio_type || r.image_type || r.video_type || r.html_type || r.doc_type || r.file_type).map((r) => r.id);
    const vers = this.mediaVersions(withMedia);
    const q = (id: number, kind: string) => this.mediaQuery(id, kind, vers.get(id + ":" + kind));
    for (const r of rows as MsgBag[]) {
      if ("audio_type" in r) {
        r.audio = r.audio_type ? { type: r.audio_type, bytes: r.audio_size || 0, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/audio" + q(r.id, "audio") : null, transcript: r.audio_transcript || null } : null;
        delete r.audio_type;
        delete r.audio_size;
        delete r.audio_transcript;
      }
      if ("image_type" in r) {
        r.image = r.image_type ? { type: r.image_type, bytes: r.image_size || 0, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/image" + q(r.id, "image") : null } : null;
        delete r.image_type;
        delete r.image_size;
      }
      if ("video_type" in r) {
        r.video = r.video_type ? { type: r.video_type, bytes: r.video_size || 0, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/video" + q(r.id, "video") : null } : null;
        delete r.video_type;
        delete r.video_size;
      }
      if ("html_type" in r) {
        r.html = r.html_type ? { type: r.html_type, bytes: r.html_size || 0, name: r.html_name || null, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/html" + q(r.id, "html") : null } : null;
        delete r.html_type;
        delete r.html_size;
        delete r.html_name;
      }
      if ("doc_type" in r) {
        r.doc = r.doc_type ? { type: r.doc_type, bytes: r.doc_size || 0, name: r.doc_name || null, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/doc" + q(r.id, "doc") : null } : null;
        delete r.doc_type;
        delete r.doc_size;
        delete r.doc_name;
      }
      if ("file_type" in r) {
        r.file = r.file_type ? { type: r.file_type, bytes: r.file_size || 0, name: r.file_name || "file", url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/file" + q(r.id, "file") : null } : null;
        delete r.file_type;
        delete r.file_size;
        delete r.file_name;
      }
      if ("game_id" in r) {
        const g = r.game_id ? this.gameRow(r.game_id) : null;
        // the light reference a match card message carries (engine.card)
        r.game = g && g.st ? gameEngine(g.st).card(g) : null;
        delete r.game_id;
      }
    }
    return rows as ApiMessage[];
  },

  /** @param after the cursor, or null for the latest */
  read(after: number | null, limit: number): ApiMessage[] {
    return this.delivered(after, limit).map((d) => d.msg);
  },

  // The latest page is the newest messages by id. A forward read is every
  // live message whose delivery number is past the cursor, in delivery
  // order: a message that went live late, or came again with new media,
  // carries a number past every cursor taken before, so it is delivered
  // once to each of them and a cursor at its number never sees it again.
  /** @param after the cursor, or null for the latest */
  delivered(after: number | null, limit: number): Delivered[] {
    const cols = MSG_COLS + ", COALESCE(seq, id) AS dn";
    const rows = after === null
      ? this.sql.exec<MsgListRow & { dn: number }>("SELECT " + cols + " FROM (SELECT * FROM m WHERE (draft IS NULL OR draft = 0) ORDER BY id DESC LIMIT ?) ORDER BY id", limit).toArray()
      : this.sql.exec<MsgListRow & { dn: number }>("SELECT " + cols + " FROM m WHERE (draft IS NULL OR draft = 0) AND COALESCE(seq, id) > ? ORDER BY dn LIMIT ?", after, limit).toArray();
    const dns = rows.map((r) => r.dn);
    // the delivery number is a cursor, not a field of the message
    for (const r of rows as MsgBag[]) delete r.dn;
    return this.withKinds(rows).map((msg, i) => ({ msg, dn: dns[i]! }));
  },

  // These live messages, by id, in id order (GET /messages?ids=): how a
  // client renews the media links of rows it already holds in one read.
  // A row deep in a big room used to need a walk of pages from its id to
  // the newest. A draft is never in it, as in every listing, its sender's
  // own included, and an id that holds nothing is left out, so what is
  // missing is gone.
  /** @param ids at most MESSAGES_IDS_MAX (the route checks) */
  byIds(ids: number[], room: string): ApiMessage[] {
    this.roomName = room;
    if (!ids.length) return [];
    const rows = this.sql.exec<MsgListRow>("SELECT " + MSG_COLS + " FROM m WHERE (draft IS NULL OR draft = 0) AND id IN (" + ids.map(() => "?").join(",") + ") ORDER BY id", ...ids).toArray();
    return this.withKinds(rows);
  },

  lastId(): number {
    // The highest delivery number a reader can actually see: drafts do not
    // count. It can be past the newest message's id (a late publish, media
    // landed on an older message).
    return this.sql.exec<{ n: number | null }>("SELECT MAX(COALESCE(seq, id)) AS n FROM m WHERE draft IS NULL OR draft = 0").one().n || 0;
  },

  // The room's attachments, newest first: one entry per media row on a
  // published message, joined with the message for sender, time and
  // caption text. Drafts never appear (their media is the sender's
  // alone until publish) and neither do uploads still in flight.
  // kind is a comma list of media kinds; from narrows to one sender.
  // The cursor is "msg:kind" of the last entry served - the pair is
  // unique (md's primary key), so paging never skips or repeats an
  // attachment when a message carries several. counts are faceted:
  // they respect the sender filter but not the kind filter, so a UI
  // can label every filter chip from one response.
  /** @param opts the query: kind, from, before, limit */
  attachments(opts: { kind: string, from: string, before: string, limit: string }, room: string): Omit<AttachmentsResponse, "room" | "you"> | { error: string, status: number } {
    this.roomName = room;
    const KINDS = ["image", "video", "audio", "speak", "html", "doc", "file"];
    let kinds = KINDS;
    if (opts.kind) {
      kinds = String(opts.kind).split(",").map((k) => k.trim().toLowerCase()).filter((k) => KINDS.indexOf(k) >= 0); // lowercase-ok: media kinds
      if (!kinds.length) return { error: "kind must name one or more of: " + KINDS.join(", "), status: 400 };
    }
    const limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 60));
    const from = String(opts.from || "").trim();
    let curMsg = null as number | null, curKind = null as string | null;
    if (opts.before) {
      const m = String(opts.before).match(/^(\d+):([a-z]+)$/);
      if (!m) return { error: "before must be a cursor returned as next_cursor", status: 400 };
      curMsg = parseInt(m[1], 10);
      curKind = m[2];
    }
    const inList = kinds.map(() => "?").join(",");
    const base = "FROM md JOIN m ON m.id = md.msg WHERE (m.draft IS NULL OR m.draft = 0) AND md.upload_id IS NULL";
    // the senders whose name is this one (sameName), as each is stored
    const senders = from ? this.sql.exec<{ s: string }>("SELECT DISTINCT m.sender AS s " + base).toArray().map((r) => r.s).filter((n) => sameName(n, from)) : [];
    const fromSql = from ? " AND m.sender IN (" + senders.map(() => "?").join(", ") + ")" : "";
    const counts = { all: 0, image: 0, video: 0, audio: 0, speak: 0, html: 0, doc: 0, file: 0 };
    const cArgs = senders;
    for (const r of this.sql.exec<{ kind: string, n: number }>("SELECT md.kind AS kind, COUNT(*) AS n " + base + fromSql + " GROUP BY md.kind", ...cArgs).toArray()) {
      if (r.kind in counts) { (counts as Record<string, number>)[r.kind] = r.n; counts.all += r.n; }
    }
    let sql = "SELECT md.msg AS id, m.ts AS ts, m.sender AS \"from\", m.text AS text, m.audio_transcript AS transcript, m.html_name AS html_name, m.doc_name AS doc_name, m.file_name AS file_name, md.kind AS kind, md.type AS type, md.size AS bytes, md.at AS at " + base + fromSql + " AND md.kind IN (" + inList + ")";
    const args: Array<string | number> = [...senders, ...kinds];
    // curKind is set together with curMsg
    if (curMsg !== null) { sql += " AND (md.msg < ? OR (md.msg = ? AND md.kind > ?))"; args.push(curMsg, curMsg, curKind as string); }
    sql += " ORDER BY md.msg DESC, md.kind ASC LIMIT ?";
    args.push(limit + 1);
    const rows = this.sql.exec<{ id: number, ts: number, from: string, text: string, transcript: string | null, html_name: string | null, doc_name: string | null, file_name: string | null, kind: AttachmentKind, type: string, bytes: number, at: number | null }>(sql, ...args).toArray();
    const more = rows.length > limit;
    if (more) rows.pop();
    const out = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      from: r.from,
      kind: r.kind,
      type: r.type,
      bytes: r.bytes || 0,
      name: r.kind === "html" ? (r.html_name || null) : r.kind === "doc" ? (r.doc_name || null) : r.kind === "file" ? (r.file_name || "file") : null,
      text: String(r.text || "").slice(0, 300),
      transcript: r.kind === "audio" ? (r.transcript || null) : null,
      url: "/api/rooms/" + this.roomName + "/messages/" + r.id + "/" + r.kind + this.mediaQuery(r.id, r.kind, r.at),
    }));
    const last = out[out.length - 1];
    return { attachments: out, counts: counts, next_cursor: more && last ? last.id + ":" + last.kind : null };
  },

  /**
   * @param after the cursor, or null for the latest
   * @param wait seconds to hold an empty forward read open
   * @param token the caller's invite, when that is how they came in: looked at again after a wait
   */
  async list(after: number | null, limit: number, wait: number, who: string | null | undefined, room: string, token?: string | null): Promise<Pick<MessagesResponse, "messages" | "last_id" | "has_more" | "room_state"> | Refusal> {
    this.roomName = room;
    // last_id is the cursor to read on from. Usually that is the room's
    // newest message. A forward read that fills its page has more behind
    // it, so there it is the page's last message, and has_more says so:
    // it used to be the room's newest id even then, and a reader who
    // followed the documented loop (read after=LAST_ID, keep last_id)
    // silently skipped every message past the page.
    // last_id is a delivery number, like the cursor it replaces.
    const answer = (page: Delivered[]) => {
      const more = after !== null && page.length >= limit;
      return { messages: page.map((d) => d.msg), last_id: more ? Math.max(after as number, page[page.length - 1]!.dn) : this.lastId(), has_more: more, room_state: this.roomState(who, room) };
    };
    let rows = this.delivered(after, limit);
    if (rows.length || !wait || after === null) return answer(rows);
    await (new Promise((resolve) => {
      let t: number | undefined;
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      t = setTimeout(done, wait * 1000);
      this.waiters.add(done);
    }) as Promise<void>);
    if (!this.ready) return { messages: [], last_id: 0, has_more: false, room_state: { v: 1 } };
    // the wait can outlast the invite: someone removed meanwhile does not get what was posted since
    if (token) { const l = this.lookupInvite(token); if (!l.ok) return l; }
    rows = this.delivered(after, limit);
    return answer(rows);
  },
} satisfies ThisType<Room>;
