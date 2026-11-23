// Messages: posting and reading, drafts and publishing, deletion, reactions, the attachments shelf.

import {
  AUDIO_MAX,
  CLIENT_MSG_ID_MAX,
  DOC_MAX,
  HTML_MAX,
  IMAGE_MAX,
  INLINE_TOTAL_MAX,
  inlineTotalTooBig,
  KEEP,
  MAX_TEXT,
  mediaTooBig,
  MESSAGES_IDS_MAX,
  MESSAGES_PAGE,
  pageTooBig,
  ROOM_RE,
  STORE_MSG,
  VIDEO_MAX,
} from "../limits.js";
import { deny, json, parseBody, readBody, type Body, bodyText, refused } from "../lib/http.js";
import { MAX_NAME, clamp } from "../lib/text.js";
import { normReaction } from "../lib/reactions.js";
import { agentOnboarding, forAgents } from "../agents/onboarding.js";
import {
  cleanFileName,
  decodeTextPayload,
  inlineBytes,
  sniffAudio,
  sniffImage,
  sniffVideo,
} from "../lib/sniff.js";
import { isStoreError } from "../lib/errors.js";
import { warn } from "../lib/log.js";
import type { InlineMedia } from "../room/messages.js";
import type { RouteContext } from "../index.js";
import type { MessagesByIdResponse } from "@chat/contract";

/**
 * room_state for the answer to a write that has already been saved (a
 * post, a publish), or undefined when reading it fails: the answer then
 * leaves room_state out. It is a separate call to the room after the
 * write, and a failure there (the object reset between the two calls)
 * used to turn a saved post into a 500, so the client sent it again and
 * it was posted twice.
 */
export async function stateAfterWrite(stub: DurableObjectStub, who: string, room: string) {
  try { return await stub.roomState(who, room); }
  catch (e) { warn("post.room_state", e, { room }); return undefined; }
}

/** The refusal for a client_msg_id that is not one. */
export const CID_ERROR = "\"client_msg_id\" must be text of 1 to " + CLIENT_MSG_ID_MAX + " characters, the same on every retry of one post";

/**
 * A post's client_msg_id: null when it carries none, undefined when the
 * field is there but not a usable id (the caller answers CID_ERROR).
 */
export function postId(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).trim();
  return s && s.length <= CLIENT_MSG_ID_MAX ? s : undefined;
}

// Publish a draft message (created with {"draft": true}, e.g. while its video
// uploaded): only now does it stream and push.
export async function publishRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const body = await readBody(request);
  const r = await stub.publishMessage(id, acc.name || "", owner, room, body && body.text !== undefined ? bodyText(body.text, "text") : undefined);
  if (refused(r)) return json("uploading" in r ? { error: r.error, uploading: r.uploading } : { error: r.error }, r.status);
  return json(Object.assign({ room: room }, r.msg, { room_state: await stateAfterWrite(stub, acc.name || r.msg.from, room) }));
}

// Delete one of your own messages (the owner can delete any). Its media
// (R2 objects, upload parts) and reactions go with it. ?draft_only=1
// deletes it only while it is still a draft.
export async function messageRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const r = await stub.deleteMessage(id, acc.name || "", owner, url.searchParams.get("draft_only") === "1");
  if (refused(r)) return json({ error: r.error }, r.status);
  return json({ room: room, deleted: r.deleted });
}

export async function reactionsRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const id = parseInt(m[2], 10);
  if (request.method === "GET") {
    const r = await stub.reactionsOf(id, acc.name, owner);
    if (!r) return json({ error: "No message with that id" }, 404);
    return json({ room, id, reactions: r });
  }
  if (request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  /** the request's JSON body */
  let body: Body = {};
  if (request.method !== "DELETE") {
    try { body = (await readBody(request)) || {}; } catch { return json({ error: "Send JSON like {\"from\": \"agent-a\", \"reaction\": \"👍\"}" }, 400); }
  }
  // An invite fixes the name, as with messages.
  const from = acc.name || (bodyText(body.from, "from") || url.searchParams.get("from") || "").trim().slice(0, MAX_NAME);
  if (!from) return json({ error: "\"from\" is required" }, 400);
  const reaction = request.method === "DELETE" ? null : normReaction(body.reaction);
  if (reaction === undefined) return json({ error: "\"reaction\" must be one emoji (or like, love, haha, wow, sad, angry), or null to remove yours" }, 400);
  const r = await stub.react(id, from, reaction, room, owner);
  if (!r) return json({ error: "No message with that id (rooms keep their most recent " + KEEP + " messages)" }, 404);
  return json({ room, id, from, reaction, message_from: r.message_from, reactions: r.reactions });
}

export async function attachmentsRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const r = await stub.attachments({
    kind: url.searchParams.get("kind") || "",
    from: url.searchParams.get("from") || "",
    before: url.searchParams.get("before") || "",
    limit: url.searchParams.get("limit") || "",
  }, room);
  if ("error" in r) return json({ error: r.error }, r.status || 400);
  const extra: { you?: string } = {};
  if (acc.name) extra.you = acc.name;
  return json(Object.assign({ room }, extra, r));
}

export async function messagesRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);

  if (request.method === "GET") {
    const a = url.searchParams.get("after");
    const idsQ = url.searchParams.get("ids");
    if (idsQ !== null) {
      // a read of these messages, not of the stream of them: no cursor
      if (a !== null || url.searchParams.get("wait") !== null) return json({ error: "\"ids\" reads those messages only: leave out after and wait" }, 400);
      const parts = idsQ.split(",").map((s) => s.trim()).filter(Boolean);
      if (!parts.length || parts.some((s) => !/^\d{1,15}$/.test(s))) return json({ error: "\"ids\" must be message ids separated by commas, like ids=12,15,40" }, 400);
      const ids = [...new Set(parts.map(Number))];
      if (ids.length > MESSAGES_IDS_MAX) return json({ error: "\"ids\" takes at most " + MESSAGES_IDS_MAX + " message ids" }, 400);
      const out: MessagesByIdResponse = { room, messages: await stub.byIds(ids, room) };
      if (acc.name) { out.you = acc.name; if (acc.kind) out.you_kind = acc.kind; }
      return json(Object.assign({ invite_only: true }, out, { for_agents: forAgents(url.origin, room) }));
    }
    const after = a === null || a === "" ? null : Math.max(0, parseInt(a, 10) || 0);
    // a missing limit or wait parses as NaN, so the default applies
    const limit = clamp(parseInt(url.searchParams.get("limit") as string, 10) || MESSAGES_PAGE, 1, 500);
    const wait = clamp(parseInt(url.searchParams.get("wait") as string, 10) || 0, 0, 25);
    const r = await stub.list(after, limit, wait, acc.name || "", room, owner ? null : invite);
    if ("ok" in r) return deny(r);
    const extra: { invite_only: boolean, welcome?: string, you?: string, you_kind?: string, agent_onboarding?: string } = { invite_only: true };
    if (after === null) extra.welcome = url.origin + "/api/rooms/" + encodeURIComponent(room) + "/welcome";
    if (acc.name) { extra.you = acc.name; if (acc.kind) extra.you_kind = acc.kind; }
    // The hand-off block rides a first read only until the agent has posted:
    // by then it is connected, and the block is ~3 KB with its token in it.
    if (after === null && acc.name && extra.you_kind === "agent" && !acc.posted) extra.agent_onboarding = agentOnboarding(url.origin, room, acc.name, invite, { invitedBy: "invited_by" in acc ? acc.invited_by : null });
    return json(Object.assign({ room }, extra, r, { for_agents: forAgents(url.origin, room) }));
  }

  if (request.method === "POST") {
    let body: Body | null;
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    try {
      if (ct.includes("multipart/form-data")) {
        const f = await request.formData();
        body = { from: f.get("from"), text: f.get("text") };
      } else {
        // A body that starts with { is JSON whatever its Content-Type:
        // fetch sends a string body as text/plain and curl -d as a form
        // when no type is set, and both used to be taken as plain text,
        // so the JSON itself was posted as the message (or, as a form,
        // refused with "text is required") and draft, media and every
        // other field were dropped. Plain text and form fields stay
        // accepted: text is the body, or the form's text field.
        const raw = await request.text();
        if (ct.includes("application/json") || raw.trimStart().startsWith("{")) body = parseBody(raw);
        else if (ct.includes("application/x-www-form-urlencoded")) {
          const f = new URLSearchParams(raw);
          body = { from: f.get("from"), text: f.get("text") };
        } else body = { from: url.searchParams.get("from"), text: raw };
      }
    } catch {
      return json({ error: "Couldn't read the body. Send JSON like {\"from\":\"agent-a\",\"text\":\"hi\"}" }, 400);
    }
    // An invite fixes the sender's name to the one it was made for.
    const from = acc.name || bodyText(body?.from, "from").trim().slice(0, MAX_NAME);
    const text = bodyText(body?.text, "text");
    if (!from) return json({ error: "\"from\" is required" }, 400);
    if (!text.trim() && !(body && (body.audio || body.image || body.video || body.html || body.doc))) return json({ error: "\"text\" is required" }, 400);
    if (text.length > MAX_TEXT) return json({ error: "\"text\" is limited to " + MAX_TEXT + " characters" }, 413);
    const cid = postId(body?.client_msg_id);
    if (cid === undefined) return json({ error: CID_ERROR }, 400);
    const draftWanted = !!(body && body.draft);
  const pubautoWanted = draftWanted && !!(body && body.publish_on_complete);
  if (draftWanted && body && (body.audio || body.image || body.video || body.html || body.doc)) return json({ error: "\"draft\" cannot be combined with inline media; upload in chunks, then publish" }, 400);
  let audio: InlineMedia | null = null;
    if (body && body.audio) {
      const buf = inlineBytes(bodyText(body.audio, "audio"), AUDIO_MAX);
      if (buf === null) return json({ error: "\"audio\" must be base64 or a data: URL" }, 400);
      if (buf === "too_big") return json({ error: mediaTooBig("audio", "inline") }, 413);
      if (!buf.byteLength) return json({ error: "\"audio\" is empty" }, 400);
      const atype = sniffAudio(buf);
      if (!atype) return json({ error: "Audio must be MP3, WAV, OGG, WebM or M4A" }, 415);
      const tr = body && body.transcript ? bodyText(body.transcript, "transcript").slice(0, MAX_TEXT) : null;
      audio = { data: buf, type: atype, transcript: tr };
    }
    let image: InlineMedia | null = null;
    if (body && body.image) {
      const buf = inlineBytes(bodyText(body.image, "image"), IMAGE_MAX);
      if (buf === null) return json({ error: "\"image\" must be base64 or a data: URL" }, 400);
      if (buf === "too_big") return json({ error: mediaTooBig("image", "inline") }, 413);
      if (!buf.byteLength) return json({ error: "\"image\" is empty" }, 400);
      const itype = sniffImage(buf);
      if (!itype) return json({ error: "Image must be JPEG, PNG, GIF, WebP or AVIF" }, 415);
      image = { data: buf, type: itype };
    }
    let video: InlineMedia | null = null;
    if (body && body.video) {
      const buf = inlineBytes(bodyText(body.video, "video"), VIDEO_MAX);
      if (buf === null) return json({ error: "\"video\" must be base64 or a data: URL" }, 400);
      if (buf === "too_big") return json({ error: mediaTooBig("video", "inline") }, 413);
      if (!buf.byteLength) return json({ error: "\"video\" is empty" }, 400);
      const vtype = sniffVideo(buf);
      if (!vtype) return json({ error: "Video must be MP4, WebM or MOV" }, 415);
      video = { data: buf, type: vtype };
    }
    let htmlArt: InlineMedia | null = null;
    if (body && body.html) {
      const s = decodeTextPayload(body.html, HTML_MAX);
      if (s === null) return json({ error: "\"html\" must be raw HTML text or a base64 data: URL" }, 400);
      if (s === "too_big") return json({ error: pageTooBig("HTML pages", HTML_MAX) }, 413);
      if (!s.trim()) return json({ error: "\"html\" is empty" }, 400);
      const buf = new TextEncoder().encode(s);
      if (buf.byteLength > HTML_MAX) return json({ error: pageTooBig("HTML pages", HTML_MAX) }, 413);
      if (!/^\s*</.test(s)) return json({ error: "HTML must be a markup document (starting with a tag or doctype)" }, 415);
      htmlArt = { data: buf.buffer, type: "text/html; charset=utf-8", name: cleanFileName(body.html_name, "Page") };
    }
    let doc: InlineMedia | null = null;
    if (body && body.doc) {
      const s = decodeTextPayload(body.doc, DOC_MAX);
      if (s === null) return json({ error: "\"doc\" must be raw Markdown text or a base64 data: URL" }, 400);
      if (s === "too_big") return json({ error: pageTooBig("Documents", DOC_MAX) }, 413);
      if (!s.trim()) return json({ error: "\"doc\" is empty" }, 400);
      if (s.indexOf("\u0000") >= 0) return json({ error: "\"doc\" must be text (Markdown)" }, 415);
      const buf = new TextEncoder().encode(s);
      if (buf.byteLength > DOC_MAX) return json({ error: pageTooBig("Documents", DOC_MAX) }, 413);
      doc = { data: buf.buffer, type: "text/markdown; charset=utf-8", name: cleanFileName(body.doc_name, "Document.md") };
    }
    const inline = [audio, image, video, htmlArt, doc].reduce((t, x) => t + (x ? x.data.byteLength : 0), 0);
    if (inline > INLINE_TOTAL_MAX) return json({ error: inlineTotalTooBig(inline) }, 413);
    const trusted = owner;
    let msg;
    try { msg = await stub.postKeyed(cid, from, text, room, trusted, audio, image, video, draftWanted, pubautoWanted, htmlArt, doc); }
    catch (e) { if (isStoreError(e)) return json({ error: STORE_MSG }, 503); throw e; }
    if (!msg) return json({ error: "That message was deleted while its attachment was being stored; nothing was posted" }, 409);
    if ("status" in msg) return json({ error: msg.error, id: msg.id, code: msg.code }, msg.status);
    // a repeat: 200, not 201, since nothing new was posted
    if ("repeat" in msg) return json(Object.assign({ room }, msg.msg, msg.draft ? { draft: true } : {}, msg.pubauto ? { publish_on_complete: true } : {}, { repeat: true, room_state: await stateAfterWrite(stub, from, room), for_agents: forAgents(url.origin, room) }));
    return json(Object.assign({ room }, msg, draftWanted ? { draft: true } : {}, pubautoWanted ? { publish_on_complete: true } : {}, { room_state: await stateAfterWrite(stub, from, room), for_agents: forAgents(url.origin, room) }), 201);
  }

  return json({ error: "Method not allowed" }, 405);
}
