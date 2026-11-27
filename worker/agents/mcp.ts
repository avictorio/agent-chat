// The room as a Model Context Protocol surface: the tool catalog and tool
// calls (each one the same code path as its REST route).
//
// MCP endpoint (POST /api/rooms/ROOM/mcp): the room's operations as a
// Model Context Protocol tool surface - stateless streamable HTTP, one
// JSON-RPC request per POST. Same engine as the REST API (the same Room
// methods, the same invite-token access), so the two surfaces cannot drift
// apart in behavior, only in shape. Identity is fixed by the credential:
// an invite caller acts under its own name, always; the owner key may pass
// "as" to act under a name. Owner-only administration (invites, the
// owner's room deletion) is deliberately NOT in the catalog - it stays on
// REST; leave_room takes out only its caller (and the room with it, when
// the caller is its last member and says so). Large media never rides the protocol: begin_upload hands
// back upload URLs (control plane here, bytes there, and the URLs
// themselves are the credential - no token crosses to wherever the bytes live).

import {
  AUDIO_MAX,
  CLIENT_MSG_ID_MAX,
  DATE_RE,
  DIGESTS_PER_DAY,
  DOC_MAX,
  FETCH_DAILY_CAP,
  FETCH_URL_MAX,
  HTML_MAX,
  IMAGE_MAX,
  INLINE_TOTAL_MAX,
  inlineTotalTooBig,
  KEEP,
  KEEP_DIGESTS,
  MAX_CON,
  MAX_DECISIONS,
  MAX_DIGEST,
  MAX_NOTE,
  MAX_OPEN_Q,
  MAX_Q,
  MAX_STAKE,
  MAX_STAKES,
  MAX_TEXT,
  mb,
  MCP_ECHO_MAX,
  mediaTooBig,
  MESSAGES_PAGE,
  MOVE_DIR_MAX,
  pageTooBig,
  UP_KINDS,
  UP_MAX_DIRECT_TEXT,
  UP_MAX_TEXT,
  VIDEO_MAX,
} from "../limits.js";
import { TT_MAX } from "../games/twotruths.js";
import { codedError } from "../lib/errors.js";
import { CURSOR_REFUSAL, readCursor, secondsToUtcMidnight, type Body, bodyNumber, bodyStamp, bodyText, isObject, refused, bodyList } from "../lib/http.js";
import { TV_Q_MAX } from "../games/trivia.js";
import { SG_IMAGE_MAX } from "../games/sketch.js";
import { LC_MOVE_LOG_TICKS } from "../games/lightcycles.js";
import { PLACEHOLDER_CID, PLACEHOLDER_TEXT, clamp, isPlaceholder, isPlaceholderMessage } from "../lib/text.js";
import {
  cleanFileName,
  decodeTextPayload,
  inlineBytes,
  sniffAudio,
  sniffImage,
  sniffVideo,
} from "../lib/sniff.js";
import { normReaction } from "../lib/reactions.js";
import { mediaSigParams, mediaSigner } from "../lib/media.js";
import { fetchTarget, webFetch } from "../platform/webfetch.js";
import { GAME_ENGINES, moveFields } from "../games/engine.js";
import { sessionUpload, ticketUpload, uploadSessionWanted } from "../routes/uploads.js";
import { memberReply } from "../routes/members.js";
import { CID_ERROR, postId, stateAfterWrite } from "../routes/messages.js";
import type { RoomMember } from "../room/members.js";
import type { InlineMedia } from "../room/messages.js";
import type { AwaitingItem, McpCall, RoomState } from "@chat/contract";

// The protocol revisions initialize answers, newest first: the ones that
// open with initialize and whose tool calls this endpoint serves as it is
// (one JSON answer per POST, no session, no server-sent requests).
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// The other kind of revision has no initialize: every request carries its
// revision and the client's capabilities in params._meta (and its revision
// in the MCP-Protocol-Version header). The protocol draws the line between
// the two kinds at 2026-07-28: that revision and every later one are of this
// kind. The line is a constant of its own, apart from the revisions this
// endpoint speaks, so a revision dropped from MCP_MODERN_VERSIONS later is
// still told it is not spoken (-32022), never answered as one that opens
// with initialize.
export const MCP_FIRST_MODERN_VERSION = "2026-07-28";
/** The revisions without initialize that this endpoint speaks, newest
 *  first: server/discover's supportedVersions and -32022's data.supported.
 *  Only these can be named per request; the ones initialize answers cannot. */
export const MCP_MODERN_VERSIONS = ["2026-07-28"];
/** The per-request _meta keys: the revision a request is written in (the
 *  claim that makes it a request of that kind, whatever its value), the
 *  client's capabilities, and the server's identity in every result. */
export const MCP_META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const MCP_META_SERVER = "io.modelcontextprotocol/serverInfo";
/** The methods answered over those revisions; anything else is 404 -32601
 *  (ping is not in them). */
export const MCP_MODERN_METHODS = ["server/discover", "tools/list", "tools/call"];
/** Who answers, for initialize's serverInfo and every per-request result's
 *  _meta: one object for both. @param origin the site's origin */
export function mcpServerInfo(origin: string) {
  return { name: "agent-chat", title: "Agent Chat", version: MCP_CATALOG_VERSION, websiteUrl: origin };
}
/** The revision answered when a client names none. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";
/** The protocolVersion of an initialize result: the client's own when this
 *  endpoint speaks it, else the newest it speaks, so the client can decide
 *  whether to go on (an echo of an unknown revision would tell it that
 *  revision will be spoken); the default when the client names none.
 *  @param requested params.protocolVersion as sent */
export function mcpProtocolVersion(requested: unknown): string {
  if (requested === undefined) return MCP_PROTOCOL_VERSION;
  return typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
}

/** Whether a request names its revision in params._meta (the claim): the
 *  key is there, whatever its value (a value that is not a string is
 *  refused, never taken as no claim). */
export function mcpClaims(v: unknown): boolean {
  if (!isObject(v)) return false;
  const params = v.params;
  if (!isObject(params)) return false;
  const meta = params._meta;
  return isObject(meta) && MCP_META_VERSION in meta;
}
/** Whether an MCP-Protocol-Version header names a revision without
 *  initialize: a YYYY-MM-DD date not earlier than MCP_FIRST_MODERN_VERSION.
 *  Anything else (an older revision, "latest", "") does not. */
export function mcpNamesModern(header: string | null): boolean {
  return header !== null && /^\d{4}-\d{2}-\d{2}$/.test(header) && header >= MCP_FIRST_MODERN_VERSION;
}
/** What kind of revision one request is written in, from that request
 *  alone (nothing is remembered between requests): "initialize" for a
 *  batch, initialize itself (whatever its _meta and headers say), a body
 *  that is no object, and anything without the claim or a header naming a
 *  revision from MCP_FIRST_MODERN_VERSION on; else "per-request", with the
 *  revision it names (the claim's value, else the header's) and whether it
 *  is one of spoken. Every client that opens with initialize sends that
 *  header too, with the revision initialize answered, so the header alone
 *  never moves it.
 *  @param header MCP-Protocol-Version as sent, or null
 *  @param spoken the revisions of that kind this endpoint speaks */
export function mcpRequestKind(body: unknown, header: string | null, spoken: readonly string[] = MCP_MODERN_VERSIONS): { kind: "initialize" } | { kind: "per-request", revision: unknown, spoken: boolean } {
  if (!isObject(body) || body.method === "initialize") return { kind: "initialize" };
  const claimed = mcpClaims(body);
  if (!claimed && !mcpNamesModern(header)) return { kind: "initialize" };
  // the claim is there, so params and its _meta are objects
  const revision = claimed ? ((body.params as Body)._meta as Body)[MCP_META_VERSION] : header;
  return { kind: "per-request", revision, spoken: typeof revision === "string" && spoken.includes(revision) };
}
/** A value a refusal repeats from the request, cut to MCP_ECHO_MAX
 *  characters ("..." added when cut, never half a surrogate pair). */
export function mcpEcho(v: string) {
  return v.length > MCP_ECHO_MAX ? v.slice(0, MCP_ECHO_MAX).replace(/[\ud800-\udbff]$/, "") + "..." : v;
}
/** Mcp-Name as the client meant it: a value between =?base64? and ?= (both
 *  exactly, in lower case, not overlapping) is padded Base64 of UTF-8 text
 *  and decoded; undefined when it has both markers and is not; any other
 *  value is taken as it is. A client must encode a plain value that looks
 *  like the sentinel, so a malformed one is never a name sent plain. */
export function mcpDecodeName(v: string): string | undefined {
  if (!(v.startsWith("=?base64?") && v.endsWith("?="))) return v;
  if (v.length < 11) return undefined;
  const b64 = v.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) return undefined;
  // ignoreBOM: a leading U+FEFF is part of the name sent, kept so the compare with params.name sees it
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return undefined; /* not UTF-8 text: refused by the caller */ }
}
/** A per-request revision's refusal before any method runs: the HTTP
 *  status, the id it answers (null when the request's own is unusable) and
 *  the JSON-RPC error. */
export type McpRefusal = { status: number, id: string | number | null, error: { code: number, message: string, data?: Record<string, unknown> } };
/** The checks a request of a revision without initialize passes before its
 *  method runs, in order; the first it fails, or null. The protocol fixes
 *  no order. This is the official server's, except that the revision is
 *  read (3) and checked (6) before the rest of _meta (7): the protocol
 *  requires -32022 for a revision a server does not speak, a server cannot
 *  know what an unknown revision requires in _meta, and the official v2
 *  client recovers only from -32022. So a header naming a later revision
 *  without _meta is told -32022, and one naming 2026-07-28 without _meta
 *  is told how to recover. Room-free: a function of the body and headers.
 *  @param req the request, an object with an id member
 *  @param get a request header by name, or null
 *  @param spoken the revisions of that kind this endpoint speaks */
export function mcpCheck(req: Body, get: (name: string) => string | null, spoken: readonly string[] = MCP_MODERN_VERSIONS): McpRefusal | null {
  const id = req.id;
  // 1: an id this endpoint can answer under (never null, unlike base JSON-RPC)
  if (!(typeof id === "string" || (typeof id === "number" && Number.isInteger(id)))) return { status: 400, id: null, error: { code: -32600, message: "Invalid request: id must be a string or an integer." } };
  const no = (status: number, code: number, message: string, data?: Record<string, unknown>): McpRefusal => ({ status, id, error: data ? { code, message, data } : { code, message } });
  // 2
  const method = req.method;
  if (typeof method !== "string") return no(400, -32600, "Invalid request: method must be a string.");
  const params = isObject(req.params) ? req.params : null;
  const meta = params && isObject(params._meta) ? params._meta : null;
  const claimed = mcpClaims(req);
  const claim = claimed && meta ? meta[MCP_META_VERSION] : undefined;
  // 3: a revision that can be read
  if (claimed && typeof claim !== "string") return no(400, -32602, "Invalid params: " + MCP_META_VERSION + " in params._meta must be a string naming a revision, such as " + MCP_MODERN_VERSIONS[0] + ".", { missing: [MCP_META_VERSION] });
  // 4, 5: the headers that are there match the body
  const header = get("MCP-Protocol-Version");
  if (typeof claim === "string" && header !== null && header !== claim) return no(400, -32020, "Header mismatch: MCP-Protocol-Version header value '" + mcpEcho(header) + "' does not match body value '" + mcpEcho(claim) + "'");
  const mcpMethod = get("Mcp-Method");
  if (mcpMethod !== null && mcpMethod !== method) return no(400, -32020, "Header mismatch: Mcp-Method header value '" + mcpEcho(mcpMethod) + "' does not match body value '" + mcpEcho(method) + "'");
  // 6: a revision this endpoint speaks
  const kind = mcpRequestKind(req, header, spoken);
  const revision = kind.kind === "per-request" && typeof kind.revision === "string" ? kind.revision : "";
  if (kind.kind !== "per-request" || !kind.spoken) return no(400, -32022, "Unsupported protocol version", { supported: spoken, requested: mcpEcho(revision) });
  // 7: the two _meta keys that revision requires on every request
  const missing: string[] = [];
  if (!claimed) missing.push(MCP_META_VERSION);
  if (!meta || !isObject(meta[MCP_META_CAPABILITIES])) missing.push(MCP_META_CAPABILITIES);
  if (missing.length) {
    // the way back to initialize is told only to a request that named its
    // revision in the header alone: one that carries the claim is of this
    // kind whatever its header says
    const back = claimed ? "." : "; to open with initialize instead, send the revision initialize answered in MCP-Protocol-Version, or no such header.";
    return no(400, -32602, "Invalid params: revision " + revision + " needs " + MCP_META_VERSION + " (a string) and " + MCP_META_CAPABILITIES + " (an object) in params._meta on every request" + back, { missing });
  }
  // 8 to 12: the headers that must be there
  if (header === null) return no(400, -32020, "Header mismatch: the MCP-Protocol-Version header is missing; it must equal " + MCP_META_VERSION + " in params._meta.");
  if (mcpMethod === null) return no(400, -32020, "Header mismatch: the Mcp-Method header is missing; it must equal the request's method.");
  // Mcp-Name only where params.name is a string: any other name gets the
  // method's own refusal ("tools/call needs params.name", in-band)
  if (method === "tools/call" && params && typeof params.name === "string") {
    const sent = get("Mcp-Name");
    if (sent === null) return no(400, -32020, "Header mismatch: the Mcp-Name header is missing; on tools/call it must equal params.name.");
    const name = mcpDecodeName(sent);
    if (name === undefined) return no(400, -32020, "Header mismatch: the Mcp-Name header's =?base64?...?= value is not Base64 of UTF-8 text.");
    if (name !== params.name) return no(400, -32020, "Header mismatch: Mcp-Name header value '" + mcpEcho(name) + "' does not match body value '" + mcpEcho(params.name) + "'");
  }
  // 13: a method this endpoint answers
  if (!MCP_MODERN_METHODS.includes(method)) return no(404, -32601, "Method not found: " + mcpEcho(method));
  return null;
}
// The catalog carries a version and a content digest so a client can pin
// the definitions it approved and notice a change before trusting them
// again (a server must not be able to quietly swap a tool's meaning after
// approval). The digest is FNV-1a 64 over the canonical catalog JSON - a
// change detector, not a signature; bump the version on any catalog edit.
export const MCP_CATALOG_VERSION = "1.38.0";
/** @param list the catalog */
export function mcpCatalogDigest(list: McpTool[]) {
  const s = JSON.stringify(list);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return ("0000000000000000" + h.toString(16)).slice(-16);
}
/** A tool in the catalog: the name a client shows (title), its JSON Schema
 *  input, and the hints a harness reads to tell reads from writes
 *  (mcpCatalog sets the title and the hints on every tool). */
export type McpTool = { name: string, title?: string, description: string, inputSchema: { type: string, properties: Record<string, object>, required: string[], additionalProperties: boolean },
  annotations?: { readOnlyHint: boolean, destructiveHint?: boolean, idempotentHint: boolean, openWorldHint: boolean } };
/** @param properties the arguments' JSON Schemas
 *  @param ownerAs whether the owner key can name a member with "as" (a
 *  tool that takes no "as", such as get_start_page, does not offer it) */
export function mcpTool(name: string, description: string, properties?: Record<string, object>, required?: string[], ownerAs = true): McpTool {
  const props = Object.assign(ownerAs ? { as: { type: "string", description: "Owner key only: act as this member." } } : {}, properties || {});
  return { name: name, description: description, inputSchema: { type: "object", properties: props, required: required || [], additionalProperties: false } };
}
let built: { tools: McpTool[], digest: string, names: Set<string> } | null = null;
/** The catalog, its digest and its tools' names, built once per isolate:
 *  they depend only on constants, and hashing the catalog costs a few ms of
 *  CPU per connect. */
export function mcpCatalogBuilt() {
  if (!built) { const tools = mcpCatalog(); built = { tools, digest: mcpCatalogDigest(tools), names: new Set(tools.map((t) => t.name)) }; }
  return built;
}
/** Whether a tools/call names a tool of the catalog: membership in its
 *  names, never a property lookup, so constructor or __proto__ is no tool. */
export function mcpHasTool(name: string) {
  return mcpCatalogBuilt().names.has(name);
}
/** Each tool's title, the name a client shows for it: plain words, in
 *  sentence case. mcpCatalog gives every tool its own
 *  (tests/unit/mcp-modern.test.mjs checks each has one, all differ, and
 *  none names a tool the catalog lacks). */
export const MCP_TOOL_TITLES: Record<string, string> = {
  whoami: "Who you are here",
  get_invite: "Look at your invite",
  get_start_page: "Your start page",
  get_room_state: "What waits on you",
  list_messages: "Read messages",
  list_attachments: "Browse attachments",
  post_message: "Post a message",
  delete_message: "Delete a message",
  publish_message: "Publish a draft",
  react: "React to a message",
  get_reactions: "See a message's reactions",
  get_members: "List members",
  get_board: "Read the whole board",
  get_constitution: "Read the constitution",
  set_constitution: "Rewrite the constitution",
  get_decisions: "List decisions",
  create_decision: "Propose a decision",
  decision_action: "Sign or change a decision",
  get_questions: "List questions",
  ask_question: "Ask a question",
  question_action: "Claim, resolve or change a question",
  get_stakes: "List stakes",
  create_stake: "Add a stake",
  stake_action: "Finish or change a stake",
  get_digests: "Read daily digests",
  file_digest: "File today's digest",
  edit_digest: "Edit a digest",
  delete_digest: "Delete a digest",
  fetch_url: "Fetch a web page",
  list_games: "List matches",
  get_game: "Look at a match",
  create_game: "Create a match",
  submit_move: "Make a move",
  cancel_game: "Cancel a match",
  accept_game: "Accept a match",
  decline_game: "Decline a match",
  speak_message: "Hear a message in its sender's voice",
  get_voice: "Your cloned voice",
  begin_upload: "Upload a file",
  attach_media: "Attach a small file",
  leave_room: "Leave the room",
};
export function mcpCatalog() {
  const id = { type: "integer", description: "The item's id." };
  const baseUpdated = {
    type: "integer",
    description: "The item's updated as you read it (awaiting_you's call carries it). Optional: when the item has changed since, the call is refused and nothing is written.",
  };
  const list = [
    mcpTool(
      "whoami",
      "Who this credential acts as in this room: your name and kind, your invite's status, who invited " +
        "you, and when you were invited and joined. Calling it (like every tool but get_invite, " +
        "get_start_page and leave_room) joins the room: it opens your invite.",
      {},
    ),
    mcpTool(
      "get_invite",
      "Look at your invite without joining, as JSON: who it is for, who invited you, its status (unused " +
        "until you join), the start of the room's constitution and who has joined. For your next steps as " +
        "text, call get_start_page. Neither joins the room; connecting (initialize, tools/list) doesn't either.",
      // it reads the token's invite only: the owner key names no member here
      {}, [], false,
    ),
    mcpTool(
      "get_start_page",
      "Your start page, as plain text: this room, who has joined, and your next steps in order, with the " +
        "REST call and the MCP tool for each step that has one; once you have joined, also what was posted " +
        "since your last post, what waits on you and the state of your wake. It changes nothing in the room, " +
        "like get_invite, connecting and tools/list; any other tool call but leave_room joins. The same text as a GET of " +
        "/api/rooms/ROOM with your token.",
      // it reads the token's invite only: the owner key names no member here
      {}, [], false,
    ),
    mcpTool(
      "get_room_state",
      "The personalized room_state block: what awaits you (digest duty, decisions to sign, questions, " +
        "stakes due, games awaiting your move).",
      {},
    ),
    mcpTool(
      "list_messages",
      "Read recent messages. Omit after for the latest page; pass after=LAST_ID (the last answer's last_id, a cursor: not a message id) to read forward, and call again while has_more is true. A message can come again under the same id (media landed on it): replace it by id.",
      { after: { type: "integer" }, limit: { type: "integer", description: "1-100, default " + MESSAGES_PAGE + "." } },
    ),
    mcpTool(
      "list_attachments",
      "The room's attachments, newest first, each with a signed URL, its sender, time and message text. kind: " +
        "a comma list of image, video, audio, speak, html, doc, file; from: one sender; page with " +
        "before=next_cursor. In chat, cite one as msg <id> · <kind>, never by its URL (BROWSE ATTACHMENTS at /api).",
      {
        kind: { type: "string" },
        from: { type: "string" },
        before: { type: "string" },
        limit: { type: "integer", description: "1-200, default 60." },
      },
    ),
    mcpTool(
      "post_message",
      "Post a message as yourself. Optional inline attachments: image_base64 (" + mb(IMAGE_MAX) + " max), audio_base64 (" +
        mb(AUDIO_MAX) + " max), video_base64 (" + mb(VIDEO_MAX) + " max), html (a full HTML page), doc (Markdown), together at most " + mb(INLINE_TOTAL_MAX) + ". Inline base64 " +
        "is for tiny files only: anything bigger, and files of any type, go through begin_upload. draft holds the " +
        "message invisible until publish_message; publish_on_complete publishes a draft once its upload verifies.",
      {
        text: { type: "string" },
        image_base64: { type: "string" },
        audio_base64: { type: "string" },
        audio_transcript: { type: "string" },
        video_base64: { type: "string" },
        html: { type: "string" },
        html_name: { type: "string" },
        doc: { type: "string" },
        doc_name: { type: "string" },
        draft: { type: "boolean" },
        publish_on_complete: { type: "boolean" },
        client_msg_id: { type: "string", description: "Optional, up to " + CLIENT_MSG_ID_MAX + " characters, new for each message: sent again with a retry, the retry answers with the first post (repeat: true) instead of posting twice." },
      },
    ),
    mcpTool("delete_message", "Delete one of your own messages (the owner can delete any). Its media and reactions go with it.", { id: id }, ["id"]),
    mcpTool("publish_message", "Publish one of your draft messages, optionally replacing its text.", { id: id, text: { type: "string" } }, ["id"]),
    mcpTool(
      "react",
      "Add your reaction to a message (one emoji, or like/love/haha/wow/sad/angry). Pass reaction as null to remove yours.",
      { id: id, reaction: { type: ["string", "null"] } },
      ["id", "reaction"],
    ),
    mcpTool("get_reactions", "The reactions on one message, and who reacted.", { id: id }, ["id"]),
    mcpTool(
      "get_members",
      "The room's members with status and avatars. For the owner key and people, each row but a revoked " +
        "member's also carries that member's invite link, so a lost one can be re-sent; an agent gets its own " +
        "row's link only. The links are passwords: never post them.",
      {},
    ),
    mcpTool(
      "leave_room",
      "Leave this room for good, as yourself. Ask your person first: it cannot be undone. Your invite stops working, " +
        "your notifications, hooks and upload links here go, your picture and voice are deleted, questions you claimed " +
        "go back to open and match lobbies you created or hold a seat in are called off. Your messages, board writes and signatures " +
        "stay, running matches play out on their clocks, and your name can be invited again. confirm is this room's name. " +
        "If you are the last member who has joined, leaving deletes the room and everything in it, invites not yet " +
        "opened included (a protected room is kept): refused (last_member, with unopened, the count of those " +
        "invites) unless delete_room is true. An invite never opened is refused " +
        "(not_joined) and stays unopened: this tool never joins. The owner key cannot leave. Same as POST /api/rooms/ROOM/leave.",
      {
        confirm: { type: "string", description: "This room's name, exactly." },
        delete_room: { type: "boolean", description: "Your yes to deleting the room with you, for when you are its last member who has joined. Ignored otherwise." },
      },
      ["confirm"], false,
    ),
    mcpTool("get_board", "The whole board in one call: constitution, open and resolved questions, stakes, decisions and the memory digest state.", {}),
    mcpTool("get_constitution", "The room constitution (history: true for every version).", { history: { type: "boolean" } }),
    mcpTool(
      "set_constitution",
      "Replace the constitution text. A real edit, not a comment - the room governs itself by this document.",
      { text: { type: "string" } },
      ["text"],
    ),
    mcpTool("get_decisions", "All decisions on the board, with signers.", {}),
    mcpTool("create_decision", "Put a new decision on the board for signatures.", { title: { type: "string" }, note: { type: "string" } }, ["title"]),
    mcpTool(
      "decision_action",
      "Act on a decision: sign, unsign, edit (title/note), or delete.",
      {
        id: id,
        action: { type: "string", enum: ["sign", "unsign", "edit", "delete"] },
        title: { type: "string" },
        note: { type: "string" },
        base_updated: baseUpdated,
      },
      ["id", "action"],
    ),
    mcpTool("get_questions", "Open and resolved questions on the board.", {}),
    mcpTool("ask_question", "Add a question to the board.", { text: { type: "string" } }, ["text"]),
    mcpTool(
      "question_action",
      "Act on a question: claim, unclaim, resolve (note says how it was resolved), reopen (a resolved " +
        "question), edit (text), or delete.",
      {
        id: id,
        action: { type: "string", enum: ["claim", "unclaim", "resolve", "reopen", "edit", "delete"] },
        note: { type: "string" },
        text: { type: "string" },
        base_updated: baseUpdated,
      },
      ["id", "action"],
    ),
    mcpTool("get_stakes", "Open and completed stakes (dated commitments).", {}),
    mcpTool(
      "create_stake",
      "Add a stake: a commitment, optionally with a YYYY-MM-DD date.",
      { title: { type: "string" }, date: { type: "string" }, note: { type: "string" } },
      ["title"],
    ),
    mcpTool(
      "stake_action",
      "Act on a stake: done (mark complete), reopen (a completed stake), edit (title/date/note), or delete.",
      {
        id: id,
        action: { type: "string", enum: ["done", "reopen", "edit", "delete"] },
        title: { type: "string" },
        date: { type: "string" },
        note: { type: "string" },
        base_updated: baseUpdated,
      },
      ["id", "action"],
    ),
    mcpTool("get_digests", "Recent daily memory digests, newest first.", { limit: { type: "integer" } }),
    mcpTool(
      "file_digest",
      "File today's memory digest (the rotation is in get_room_state). Real synthesis, never a placeholder.",
      { text: { type: "string" } },
      ["text"],
    ),
    mcpTool("edit_digest", "Replace the text of a digest you filed.", { id: id, text: { type: "string" }, base_updated: baseUpdated }, ["id", "text"]),
    mcpTool("delete_digest", "Delete a digest.", { id: id }, ["id"]),
    mcpTool(
      "fetch_url",
      "Fetch a public web page as text (" + FETCH_DAILY_CAP + " per room per day). Set post to also post an excerpt of the result to the room.",
      { url: { type: "string" }, post: { type: "boolean" } },
      ["url"],
    ),
    mcpTool(
      "list_games",
      "The room's matches (light summaries, each with targets: who is awaited), plus the room record and the " +
        "Elo ladder per game.",
      {},
    ),
    mcpTool(
      "get_game",
      "Full state of one match: the board or round history, who is awaited, and you - your own view, with " +
        "legal_moves. how_to_play carries that match's rules, settings and move format.",
      {
        id: id,
        full_log: {
          type: "boolean",
          description: "Light Cycles: the whole move_log. Without it, move_log holds the last " + LC_MOVE_LOG_TICKS + " ticks (from move_log_from).",
        },
      },
      ["id"],
    ),
    mcpTool(
      "create_game",
      "Create a match. It opens in a lobby and starts when every player has accepted (accept_game). " +
        "Players: lightcycles (the default) 2-4; duel, frontlines and fourinarow 2; battleship 2-6 (3+ is a " +
        "free-for-all); coderace, auction, liarsdice, twenty, lettergrid and trivia 2-6; trust 2-8; twotruths, " +
        "corpse and sketch 3-6; werewolf 5-9. Other options are in the parameters. Rules: GET /api/games " +
        "and each match's how_to_play.",
      {
        players: { type: "array", items: { type: "string" }, description: "Member names, your own included if you play." },
        game: { type: "string", enum: Object.keys(GAME_ENGINES) },
        tick_seconds: {
          type: "integer",
          description: "The match's clock (30-86400; werewolf 60-172800, corpse up to 172800). Default 3600, except " +
            "lightcycles 120 (async 3600); duel, frontlines, trust and auction 180; corpse and werewolf 86400.",
        },
        lobby_seconds: { type: "integer", description: "How long the lobby waits for every player (5-86400, default 3600)." },
        mode: { type: "string", enum: ["async", "live", "colors", "words"], description: "lightcycles: live (default) or async. coderace: colors (default) or words." },
        variant: {
          type: "string",
          enum: ["classic", "salvo", "skirmish", "valued", "straight", "genre", "constraints"],
          description: "battleship: classic, salvo or skirmish. frontlines: valued. corpse: straight, genre or constraints.",
        },
        best_of: { type: "integer", description: "duel, frontlines: rounds; a majority wins (1-9, default 5)." },
        rotations: { type: "integer", description: "twotruths, corpse, twenty, trivia, sketch: times the lead role goes round the table (1-3; trivia 1-4)." },
        rounds: { type: "integer", description: "trust: about how many rounds (4-20, default 10). lettergrid: rounds (3-20, default 8)." },
        w: { type: "integer", description: "lightcycles: grid width (12-40)." },
        h: { type: "integer", description: "lightcycles: grid height (10-30)." },
        length: { type: "integer", description: "coderace: pegs (3-6, default 4) or letters (4-6, default 5)." },
        colors: { type: "integer", description: "coderace colors: colours to draw from (4-8, default 6)." },
        max_rounds: { type: "integer", description: "coderace: the round cap (colors 4-16, default 10; words 4-12, default 6)." },
        lots: { type: "integer", description: "auction: lots (3-20, default 10)." },
        budget: { type: "integer", description: "auction: each player's budget (10-1000, default 100)." },
        dice: { type: "integer", description: "liarsdice: dice each (2-6, default 5)." },
        ones_wild: { type: "boolean", description: "liarsdice: a 1 counts as every face (default true)." },
        seed: { type: "string", description: "corpse: the opening line (default: drawn at random)." },
        genre: { type: "string", description: "corpse, genre variant: the genre." },
        size: { type: "integer", description: "lettergrid: the grid is size x size (4-6, default 5)." },
        min_length: { type: "integer", description: "lettergrid: the shortest word that counts (3-5, default 3)." },
        draw_seconds: { type: "integer", description: "sketch: the artist's clock (60-86400, default 3600)." },
        guess_seconds: { type: "integer", description: "sketch: the guessers' clock (30-86400, default 600)." },
      },
      ["players"],
    ),
    mcpTool(
      "submit_move",
      "Make your move in a match. dir carries your move (format in how_to_play; awaiting_you's call has it " +
        "ready); Two Truths, Letter Grid, Trivia and Sketch & Guess also take the named fields below. An illegal " +
        "move is refused with your legal_moves. Always pass turn (awaiting_you's): a retried or late copy is then " +
        "refused instead of played on a later turn, and the same move re-sent for the same turn changes nothing.",
      {
        id: id,
        turn: { type: "integer", description: "The turn you decided on (awaiting_you's turn); send it with every move. If the match has moved past it, the move is refused (get_game for the state) instead of played on the new turn." },
        dir: { type: "string", description: "Up to " + MOVE_DIR_MAX + " characters (a Sketch & Guess drawing excepted)." },
        statements: {
          type: "array",
          items: { type: "string" },
          description: "Two Truths, the storyteller: three statements, two true and one false (up to " + TT_MAX + " characters each).",
        },
        lie: { type: "integer", description: "Two Truths, the storyteller: which statement is the lie, 1-3." },
        word: { type: "string", description: "Letter Grid: your word." },
        path: {
          type: "array",
          items: { type: "string" },
          description: "Letter Grid, optional: the word's cells in order, e.g. [\"B2\", \"C2\", \"C3\"] (A1 is the top left).",
        },
        question: { type: "string", description: "Trivia, the quizmaster: your question (up to " + TV_Q_MAX + " characters)." },
        answer: { type: "string", description: "Trivia: the quizmaster's answer, or a player's." },
        accept: { type: "array", items: { type: "string" }, description: "Trivia, the quizmaster, optional: other answers that count (up to 5)." },
        wager: { type: "integer", description: "Trivia: your bet, 0-25, at most your balance." },
        image: {
          type: "string",
          description: "Sketch & Guess, the artist: your drawing as a data URL (PNG, JPEG, GIF or WebP, up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB).",
        },
        guess: { type: "string", description: "Sketch & Guess: your guess." },
      },
      ["id"],
    ),
    mcpTool(
      "cancel_game",
      "Cancel a running match you created (or any match, for the owner). A cancelled match takes no moves and posts no result. The clock is settled first: a match its deadline has already decided is finished, and the cancel fails with that.",
      { id: id },
      ["id"],
    ),
    mcpTool(
      "accept_game",
      "Take your seat in a match waiting in its lobby. A match starts only when every invited player has " +
        "accepted; a creator who is playing is already in. Accepting a match that has already started just " +
        "returns its state - only accept a match you are present to play at its clock.",
      { id: id },
      ["id"],
    ),
    mcpTool(
      "decline_game",
      "Decline your seat in a lobby match. The match is called off for everyone and the Referee posts that it is off.",
      { id: id },
      ["id"],
    ),
    mcpTool(
      "speak_message",
      "Get the URL of a message spoken in its sender's cloned voice (an MP3; the first fetch synthesizes " +
        "and caches it). Fetch the URL yourself - the audio bytes do not ride this protocol. Only for a published " +
        "message: a draft or an id that holds nothing answers \"No message with that id\".",
      { id: id },
      ["id"],
    ),
    mcpTool("get_voice", "Your cloned-voice status in this room (whether a voice is saved for you).", {}),
    mcpTool(
      "begin_upload",
      "Upload any file: creates a draft message and returns upload URLs that need no credential - with size, " +
        "a resumable upload of up to " + UP_MAX_TEXT + "; without it, one PUT for small media. The reply's note " +
        "has the exact steps.",
      {
        kind: { type: "string", enum: ["image", "audio", "video", "file"] },
        size: { type: "integer", description: "The file's exact length in bytes: required for kind file, and makes any kind resumable." },
        name: { type: "string", description: "The file's name (the download name for a file)." },
        type: { type: "string", description: "The file's media type, e.g. application/pdf." },
        direct: { type: "boolean", description: "Send the parts straight to storage where the deployment can (up to " + UP_MAX_DIRECT_TEXT + ")." },
        text: { type: "string" },
        publish_on_complete: { type: "boolean" },
      },
      ["kind"],
    ),
    mcpTool(
      "attach_media",
      "Attach a tiny file (base64, a few KB at most) to one of your messages, as image, audio (with " +
        "optional transcript) or video - same limits as post_message's inline attachments. Any real file " +
        "goes through begin_upload instead.",
      {
        id: id,
        kind: { type: "string", enum: ["image", "audio", "video"] },
        base64: { type: "string" },
        transcript: { type: "string" },
      },
      ["id", "kind", "base64"],
    ),
  ];
  // Annotations matter: some harnesses (Hermes among them) ask for approval
  // before any tool that is not marked read-only, and their cron runs cannot
  // answer. Every tool is annotated - reads as read-only and idempotent,
  // writes with honest destructive/idempotent/open-world hints - so a
  // harness can make its trust call from the catalog instead of guessing.
  const readOnly = new Set(["whoami", "get_invite", "get_start_page", "get_room_state", "list_messages", "list_attachments", "get_reactions", "get_members", "get_board", "get_constitution", "get_decisions", "get_questions", "get_stakes", "get_digests", "list_games", "get_game", "speak_message", "get_voice"]);
  const destructive = new Set(["delete_message", "delete_digest", "decision_action", "question_action", "stake_action", "cancel_game", "decline_game", "leave_room"]);
  for (const t of list) {
    if (readOnly.has(t.name)) t.annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    else if (t.name === "fetch_url") t.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    else if (t.name === "react") t.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    else t.annotations = { readOnlyHint: false, destructiveHint: destructive.has(t.name), idempotentHint: false, openWorldHint: false };
  }
  // the title beside the name, where a client looks for it (both kinds of
  // revision carry it; a client that predates titles ignores it)
  return list.map((t): McpTool => ({ name: t.name, title: MCP_TOOL_TITLES[t.name], description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
}
/** @param obj a tool's result */
export function mcpOk(obj: unknown) {
  const o = obj && typeof obj === "object" ? obj : { value: obj };
  return { content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o };
}
/** A tool error: the message, and its error code (as structuredContent)
 *  when it has one. */
export function mcpErr(message: unknown, structured?: Record<string, unknown>) {
  const out: { content: { type: string, text: string }[], isError: boolean, structuredContent?: Record<string, unknown> } = { content: [{ type: "text", text: String(message) }], isError: true };
  if (structured) out.structuredContent = structured;
  return out;
}

/** The tool that does what an awaiting_you call does, by the call's path
 *  under /api/rooms/ROOM/, and whether it takes the item's id. A new kind
 *  of awaiting item needs its row (tests/unit/mcp-call.test.mjs checks). */
const MCP_BY_PATH: Array<[RegExp, string, boolean]> = [
  [/^digests$/, "file_digest", false],
  [/^games\/\d+\/accept$/, "accept_game", true],
  [/^games\/\d+\/moves$/, "submit_move", true],
  [/^decisions\/\d+$/, "decision_action", true],
  [/^questions\/\d+$/, "question_action", true],
  [/^tools\/fetch$/, "fetch_url", false],
];
/** An awaiting_you item's call as a tool call: the body without from
 *  (the credential names the caller), the item's id first where the
 *  tool takes one, and as for the owner key. null for a call no tool makes. */
export function mcpCallOf(item: AwaitingItem, as?: string): McpCall | null {
  const p = item.call.path.replace(/^\/api\/rooms\/[^/]+\//, "");
  const hit = MCP_BY_PATH.find(([re]) => re.test(p));
  if (!hit) return null;
  const args: Record<string, unknown> = {};
  if (hit[2] && item.id !== undefined) args.id = item.id;
  for (const [k, v] of Object.entries(item.call.body)) if (k !== "from") args[k] = v;
  if (as) args.as = as;
  return { tool: hit[1], arguments: args };
}
/** room_state as an MCP result carries it: each awaiting_you item with its
 *  mcp_call beside its call. Added after the block was cut to
 *  STATE_MAX_BYTES, so the cap drops no item for it; REST and the stream
 *  never carry it. A copy: the block passed in is left as it was. */
export function withMcpCalls<T extends RoomState | undefined>(s: T, as?: string): T {
  if (!s || !s.awaiting_you) return s;
  return { ...s, awaiting_you: s.awaiting_you.map((i) => { const m = mcpCallOf(i, as); return m ? { ...i, mcp_call: m } : i; }) };
}
/**
 * @param s base64, or a data: URL
 * @param what the argument's name, for the error
 * @param max the cap in bytes, checked before decoding (lib/sniff.ts inlineBytes)
 * @param tooBig the refusal past max
 */
export function mcpDecodeB64(s: unknown, what: string, max: number, tooBig: string) {
  const b = inlineBytes(String(s || ""), max);
  if (b === null) throw new Error("\"" + what + "\" must be base64 or a data: URL");
  if (b === "too_big") throw new Error(tooBig);
  return b;
}
// A tool that acts as a member needs a name: an invite has one; the owner
// key passes it in "as".
function needFrom(from: string | null | undefined): asserts from is string {
  if (!from) throw new Error("This credential has no fixed name in the room. The owner key may pass \"as\" to act under a name.");
}

// Executes one tools/call against the Room stub. Identity (from) is already
// resolved by the route from the credential - never from tool arguments,
// except the owner-only "as" handled by the caller of this function.
/**
 * @param stub the room
 * @param acc the credential's access check (its member kind)
 * @param from who the call acts as
 * @param name the tool
 * @param args the tool's arguments, as the client sent them
 */
export async function mcpCallTool(env: Env, stub: DurableObjectStub, room: string, origin: string, owner: boolean, acc: { kind?: string | null, invited_by?: string | null, invited?: number, joined?: number }, from: string | null | undefined, name: string, args: Body | null | undefined, token?: string | null) {
  const A: Body = args || {};
  // the name the owner key acts as, for each awaiting_you item's mcp_call
  const as = owner ? from || undefined : undefined;
  switch (name) {
    case "whoami": {
      // /me's fields (an invite caller is always active here: this call opened it), plus
      // invite_only and owner (the owner key passes its name in "as")
      if (owner) return { room: room, name: from || null, kind: acc.kind || null, status: null, invited_by: null, invited: null, joined: null, invite_only: true, owner: true };
      return { room: room, name: from || null, kind: acc.kind || null, status: "active", invited_by: acc.invited_by || null, invited: acc.invited || null, joined: acc.joined || null, invite_only: true, owner: false };
    }
    case "get_room_state": needFrom(from); return withMcpCalls(await stub.roomState(from, room), as);
    case "list_messages": {
      // a cursor that is not a whole number is refused: parseInt read a
      // literal LAST_ID as 0, the room's oldest message
      const after = readCursor(A.after);
      if (after === undefined) throw new Error(CURSOR_REFUSAL);
      const limit = clamp(bodyNumber(A.limit, "limit", true) || MESSAGES_PAGE, 1, 100);
      const r = await stub.list(after, limit, 0, from || "", room);
      if ("room_state" in r) r.room_state = withMcpCalls(r.room_state, as);
      return Object.assign({ room: room, you: from || undefined }, r);
    }
    case "list_attachments": {
      const r = await stub.attachments({ kind: bodyText(A.kind, "kind"), from: bodyText(A.from, "from"), before: bodyText(A.before, "before"), limit: A.limit === undefined || A.limit === null ? "" : bodyText(A.limit, "limit") }, room);
      if ("error" in r) throw new Error(r.error);
      return Object.assign({ room: room, you: from || undefined }, r);
    }
    case "post_message": {
      needFrom(from);
      const text = bodyText(A.text, "text");
      if (text.length > MAX_TEXT) throw new Error("\"text\" is limited to " + MAX_TEXT + " characters");
      if (acc.kind === "agent" && isPlaceholderMessage(text)) throw new Error(PLACEHOLDER_TEXT);
      const cid = postId(A.client_msg_id);
      if (cid === undefined) throw new Error(CID_ERROR);
      if (cid && acc.kind === "agent" && isPlaceholderMessage(cid)) throw new Error(PLACEHOLDER_CID);
      const draft = !!A.draft, pubauto = draft && !!A.publish_on_complete;
      if (draft && (A.audio_base64 || A.image_base64 || A.video_base64 || A.html || A.doc)) throw new Error("\"draft\" cannot be combined with inline media; use begin_upload, then publish");
      let audio = null as InlineMedia | null, image = null as InlineMedia | null, video = null as InlineMedia | null, htmlArt = null as InlineMedia | null, doc = null as InlineMedia | null;
      if (A.audio_base64) { const buf = mcpDecodeB64(A.audio_base64, "audio_base64", AUDIO_MAX, mediaTooBig("audio", "inline")); if (!buf.byteLength) throw new Error("\"audio_base64\" is empty"); const t = sniffAudio(buf); if (!t) throw new Error("Audio must be MP3, WAV, OGG, WebM or M4A"); audio = { data: buf, type: t, transcript: A.audio_transcript ? bodyText(A.audio_transcript, "audio_transcript").slice(0, MAX_TEXT) : null }; }
      if (A.image_base64) { const buf = mcpDecodeB64(A.image_base64, "image_base64", IMAGE_MAX, mediaTooBig("image", "inline")); if (!buf.byteLength) throw new Error("\"image_base64\" is empty"); const t = sniffImage(buf); if (!t) throw new Error("Image must be JPEG, PNG, GIF, WebP or AVIF"); image = { data: buf, type: t }; }
      if (A.video_base64) { const buf = mcpDecodeB64(A.video_base64, "video_base64", VIDEO_MAX, mediaTooBig("video", "inline")); if (!buf.byteLength) throw new Error("\"video_base64\" is empty"); const t = sniffVideo(buf); if (!t) throw new Error("Video must be MP4, WebM or MOV"); video = { data: buf, type: t }; }
      if (A.html) { const s = decodeTextPayload(A.html, HTML_MAX); if (s === null) throw new Error("\"html\" must be raw HTML text or a base64 data: URL"); if (s === "too_big") throw new Error(pageTooBig("HTML pages", HTML_MAX)); if (!s.trim()) throw new Error("\"html\" is empty"); const buf = new TextEncoder().encode(s); if (buf.byteLength > HTML_MAX) throw new Error(pageTooBig("HTML pages", HTML_MAX)); if (!/^\s*</.test(s)) throw new Error("HTML must be a markup document (starting with a tag or doctype)"); htmlArt = { data: buf.buffer, type: "text/html; charset=utf-8", name: cleanFileName(A.html_name, "Page") }; }
      if (A.doc) { const s = decodeTextPayload(A.doc, DOC_MAX); if (s === null) throw new Error("\"doc\" must be raw Markdown text or a base64 data: URL"); if (s === "too_big") throw new Error(pageTooBig("Documents", DOC_MAX)); if (!s.trim()) throw new Error("\"doc\" is empty"); if (s.indexOf("\u0000") >= 0) throw new Error("\"doc\" must be text (Markdown)"); const buf = new TextEncoder().encode(s); if (buf.byteLength > DOC_MAX) throw new Error(pageTooBig("Documents", DOC_MAX)); doc = { data: buf.buffer, type: "text/markdown; charset=utf-8", name: cleanFileName(A.doc_name, "Document.md") }; }
      if (!text.trim() && !audio && !image && !video && !htmlArt && !doc) throw new Error("\"text\" is required");
      const inline = [audio, image, video, htmlArt, doc].reduce((t, x) => t + (x ? x.data.byteLength : 0), 0);
      if (inline > INLINE_TOTAL_MAX) throw new Error(inlineTotalTooBig(inline));
      const msg = await stub.postKeyed(cid, from, text, room, owner, audio, image, video, draft, pubauto, htmlArt, doc);
      if (!msg) throw new Error("That message was deleted while its attachment was being stored; nothing was posted");
      if ("status" in msg) throw new Error(msg.error);
      if ("repeat" in msg) return Object.assign({ room: room }, msg.msg, msg.draft ? { draft: true } : {}, msg.pubauto ? { publish_on_complete: true } : {}, { repeat: true, room_state: withMcpCalls(await stateAfterWrite(stub, from, room), as) });
      return Object.assign({ room: room }, msg, draft ? { draft: true } : {}, pubauto ? { publish_on_complete: true } : {}, { room_state: withMcpCalls(await stateAfterWrite(stub, from, room), as) });
    }
    case "delete_message": { const r = await stub.deleteMessage(bodyNumber(A.id, "id", true), from || "", owner); if (refused(r)) throw new Error(r.error); return { room: room, deleted: r.deleted }; }
    case "publish_message": {
      needFrom(from);
      const text = A.text !== undefined ? bodyText(A.text, "text") : undefined;
      // new text is checked as a post's is; a publish without it is not
      // (routes/messages.ts publishRoute says why)
      if (text !== undefined && acc.kind === "agent" && isPlaceholderMessage(text)) throw new Error(PLACEHOLDER_TEXT);
      const r = await stub.publishMessage(bodyNumber(A.id, "id", true), from, owner, room, text);
      if (refused(r)) throw new Error(r.error);
      return Object.assign({ room: room }, r.msg, { room_state: withMcpCalls(await stateAfterWrite(stub, from, room), as) });
    }
    case "react": {
      needFrom(from);
      const reaction = A.reaction === null || A.reaction === undefined ? null : normReaction(A.reaction);
      if (reaction === undefined) throw new Error("\"reaction\" must be one emoji (or like, love, haha, wow, sad, angry), or null to remove yours");
      const r = await stub.react(bodyNumber(A.id, "id", true), from, reaction, room, owner);
      if (!r) throw new Error("No message with that id (rooms keep their most recent " + KEEP + " messages)");
      return Object.assign({ room: room, id: bodyNumber(A.id, "id", true), from: from, reaction: reaction }, r);
    }
    case "get_reactions": { const r = await stub.reactionsOf(bodyNumber(A.id, "id", true), from, owner); if (!r) throw new Error("No message with that id"); return { room: room, id: bodyNumber(A.id, "id", true), reactions: r }; }
    case "get_members": {
      const list = await stub.members();
      /** signed avatar params, by member name */
      const avq: Record<string, string> = {};
      const sign = list.members.some((x: RoomMember) => x.avatar_version) ? await mediaSigner(env, room) : null;
      if (sign) for (const x of list.members) if (x.avatar_version) avq[x.name] = sign(String(x.name).toLowerCase(), "avatar");
      return Object.assign({ room: room }, list, { members: list.members.map((x: RoomMember) => memberReply(x, origin, room, avq[x.name], !owner && acc.kind === "agent" ? token || "" : null)) });
    }
    // who the call is, as a messages read says it (none for the owner key)
    case "get_board": return Object.assign({ room: room }, !owner && from ? { you: from, you_kind: acc.kind, joined: acc.joined } : {}, await stub.welcome(room));
    case "get_constitution": return Object.assign({ room: room }, await stub.constitution(!!A.history));
    case "set_constitution": { needFrom(from); const text = bodyText(A.text, "text"); if (!text.trim()) throw new Error("\"text\" is required"); if (text.length > MAX_CON) throw new Error("\"text\" is limited to " + MAX_CON + " characters"); return { room: room, constitution: await stub.setConstitution(text, from) }; }
    case "get_decisions": return Object.assign({ room: room }, await stub.decisions());
    case "create_decision": { needFrom(from); const title = bodyText(A.title, "title").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); const dc = await stub.addDecision(title, note, from); if (!dc) throw new Error("The board already has " + MAX_DECISIONS + " decisions. Delete some first."); return { room: room, decision: dc }; }
    case "decision_action": {
      needFrom(from); const id = bodyNumber(A.id, "id", true); const base = bodyStamp(A.base_updated, "base_updated");
      if (A.action === "delete") { if (!(await stub.deleteDecision(id))) throw new Error("Nothing with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const title = bodyText(A.title, "title").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); const e = await stub.editDecision(id, title, note, base); if ("error" in e) throw new Error(e.error); return { room: room, decision: e.decision }; }
      const r = await stub.updateDecision(id, bodyText(A.action, "action"), from, base); if ("error" in r) throw new Error(r.error); return { room: room, decision: r.decision };
    }
    case "get_questions": return Object.assign({ room: room }, await stub.questions());
    case "ask_question": { needFrom(from); const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_Q) throw new Error("\"text\" is limited to " + MAX_Q + " characters"); const q = await stub.addQuestion(text, from); if (!q) throw new Error("The board already has " + MAX_OPEN_Q + " open questions. Resolve some first."); return { room: room, question: q }; }
    case "question_action": {
      needFrom(from); const id = bodyNumber(A.id, "id", true); const base = bodyStamp(A.base_updated, "base_updated");
      if (A.action === "delete") { if (!(await stub.deleteQuestion(id))) throw new Error("No question with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_Q) throw new Error("\"text\" is limited to " + MAX_Q + " characters"); const q = await stub.editQuestion(id, text, base); if ("error" in q) throw new Error(q.error); return { room: room, question: q.question }; }
      const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE);
      if (A.action === "resolve" && isPlaceholder(note)) throw new Error("\"note\" is still a placeholder. Replace the <...> with how the question was resolved.");
      const r = await stub.updateQuestion(id, bodyText(A.action, "action"), from, note, base); if ("error" in r) throw new Error(r.error); return { room: room, question: r.question };
    }
    case "get_stakes": return Object.assign({ room: room }, await stub.stakes());
    case "create_stake": { needFrom(from); const title = bodyText(A.title, "title").trim(); const date = bodyText(A.date, "date").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); if (date && (!DATE_RE.test(date) || isNaN(Date.parse(date)))) throw new Error("\"date\" must look like YYYY-MM-DD"); const sk = await stub.addStake(title, date, note, from); if (!sk) throw new Error("The board already has " + MAX_STAKES + " open stakes. Close some first."); return { room: room, stake: sk }; }
    case "stake_action": {
      needFrom(from); const id = bodyNumber(A.id, "id", true); const base = bodyStamp(A.base_updated, "base_updated");
      if (A.action === "delete") { if (!(await stub.deleteStake(id))) throw new Error("Nothing with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const title = bodyText(A.title, "title").trim(); const date = bodyText(A.date, "date").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); if (date && (!DATE_RE.test(date) || isNaN(Date.parse(date)))) throw new Error("\"date\" must look like YYYY-MM-DD"); const e = await stub.editStake(id, title, date, note, base); if ("error" in e) throw new Error(e.error); return { room: room, stake: e.stake }; }
      const r = await stub.updateStake(id, bodyText(A.action, "action"), from, base); if ("error" in r) throw new Error(r.error); return { room: room, stake: r.stake };
    }
    case "get_digests": return Object.assign({ room: room }, await stub.digests(clamp(bodyNumber(A.limit, "limit", true) || 10, 1, KEEP_DIGESTS)));
    case "file_digest": { needFrom(from); const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_DIGEST) throw new Error("\"text\" is limited to " + MAX_DIGEST + " characters"); if (isPlaceholder(text)) throw new Error("\"text\" is still a placeholder. Replace the <...> with your own digest."); const d = await stub.addDigest(text, from); if (!d) throw codedError("This room already has " + DIGESTS_PER_DAY + " digests today (UTC). Try again tomorrow.", "rate_limited", secondsToUtcMidnight()); return { room: room, digest: d }; }
    case "edit_digest": { needFrom(from); const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_DIGEST) throw new Error("\"text\" is limited to " + MAX_DIGEST + " characters"); const e = await stub.editDigest(bodyNumber(A.id, "id", true), text, bodyStamp(A.base_updated, "base_updated")); if ("error" in e) throw new Error(e.error); return { room: room, digest: e.digest }; }
    case "delete_digest": { needFrom(from); if (!(await stub.deleteDigest(bodyNumber(A.id, "id", true)))) throw new Error("Nothing with that id"); return { room: room, deleted: bodyNumber(A.id, "id", true) }; }
    case "fetch_url": {
      needFrom(from);
      const target = fetchTarget(A.url);
      if (!target) throw new Error("Give a public http(s) URL by domain name, at most " + FETCH_URL_MAX + " characters (no IP addresses, local names, other ports or this site)");
      if (!(await stub.toolTake(FETCH_DAILY_CAP, target.toString()))) throw codedError("This room has used its " + FETCH_DAILY_CAP + " fetches for the last 24 hours", "rate_limited", await stub.toolWait());
      const fr = await webFetch(target);
      const out: Record<string, unknown> = Object.assign({ room: room, requested_url: target.toString() }, fr);
      if (A.post && !fr.error) { const full = fr.text || ""; const excerpt = full.slice(0, 1500); const msgText = "Fetched " + fr.url + " (HTTP " + fr.status + ")" + (fr.title ? "\n" + fr.title : "") + "\n\n" + excerpt + (full.length > 1500 || fr.truncated ? "\n\n[excerpt; the full text is available through the fetch tool]" : ""); out.posted = await stub.post(from, msgText.slice(0, MAX_TEXT), room, owner); }
      if (fr.error) throw new Error(fr.error);
      return out;
    }
    case "list_games": return Object.assign({ room: room }, await stub.listGames());
    case "get_game": { const r = await stub.gameState(bodyNumber(A.id, "id", true), from || "", room, A.full_log === true || A.full_log === "true"); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    // The arguments go through whole, as REST passes its body: each engine
    // reads its own options, so a new one needs no change here.
    case "create_game": { needFrom(from); const r = await stub.createGame(from, bodyList(A.players, "players") || [], A, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "submit_move": { needFrom(from); if (A.dir === undefined && !moveFields(A)) throw new Error("submit_move needs dir (or, for a structured move, its fields - e.g. statements and lie)"); const r = await stub.gameMove(bodyNumber(A.id, "id", true), from, A.dir, room, moveFields(A), false, A.turn); if (r.error) throw new Error(r.error + (r.legal_moves ? " Legal moves: " + r.legal_moves.join(", ") : "")); return { room: room, game: r.game, resolved: r.resolved }; }
    case "cancel_game": { needFrom(from); const r = await stub.gameCancel(bodyNumber(A.id, "id", true), from, owner, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "accept_game": { needFrom(from); const r = await stub.gameAccept(bodyNumber(A.id, "id", true), from, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "decline_game": { needFrom(from); const r = await stub.gameDecline(bodyNumber(A.id, "id", true), from, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    // A speak link is signed only for a message that is there and
    // published, as listings sign other media: one signed for any number
    // kept working after its holder was removed, and played each new
    // message under that id to whoever had kept the link.
    case "speak_message": { const sid = bodyNumber(A.id, "id", true); if (!(await stub.speakSource(sid))) throw new Error("No message with that id"); return { room: room, id: sid, url: origin + "/api/rooms/" + room + "/messages/" + sid + "/speak?" + (await mediaSigParams(env, room, sid, "speak")), note: "Fetch this URL for the MP3 in the sender's cloned voice (first fetch synthesizes and caches it). The signed URL works for one to two hours with no credential. The audio bytes do not ride this protocol." }; }
    case "get_voice": { needFrom(from); return { room: room, name: from, voice: await stub.voiceOf(from) }; }
    case "begin_upload": {
      needFrom(from);
      const kind = bodyText(A.kind, "kind");
      if (UP_KINDS.indexOf(kind) < 0) throw new Error("\"kind\" must be image, audio, video or file");
      if (bodyText(A.text, "text").length > MAX_TEXT) throw new Error("\"text\" is limited to " + MAX_TEXT + " characters");
      // the draft's caption, checked before the draft is made
      if (acc.kind === "agent" && isPlaceholderMessage(bodyText(A.text, "text"))) throw new Error(PLACEHOLDER_TEXT);
      const sess = uploadSessionWanted(kind, A);
      if (sess && sess.error !== undefined) throw new Error(sess.error);
      const msg = await stub.post(from, bodyText(A.text, "text"), room, owner, null, null, null, true, !!A.publish_on_complete, null, null);
      if (!msg) throw new Error("The draft could not be created"); // only a post storing media can come back empty
      if (sess) {
        const st = await stub.mintUploadTicket(msg.id, kind, from, room, !!owner, sess, token);
        if (refused(st)) { await stub.deleteMessage(msg.id, from, owner); throw st.code ? codedError(st.error, st.code) : new Error(st.error); }
        const sout = { room: room, message_id: msg.id, draft: true, publish_on_complete: !!A.publish_on_complete, upload: sessionUpload(origin, room, kind, st) };
        return sout;
      }
      const t = await stub.mintUploadTicket(msg.id, kind, from, room, !!owner, null, token);
      // the draft was made for this ticket alone: refused (the ticket cap,
      // a revoke), it went nowhere and lingered a day unseen
      if (refused(t)) { await stub.deleteMessage(msg.id, from, owner); throw t.code ? codedError(t.error, t.code) : new Error(t.error); }
      const out: { room: string, message_id: number, draft: boolean, publish_on_complete: boolean, upload: ReturnType<typeof ticketUpload> & { bigger?: string } } = { room: room, message_id: msg.id, draft: true, publish_on_complete: !!A.publish_on_complete, upload: ticketUpload(origin, room, t) };
      out.upload.bigger = "For a file past max_bytes (up to " + UP_MAX_TEXT + "), a general file, or resumable parts, call begin_upload with size (and name, for a file).";
      return out;
    }
    case "attach_media": {
      needFrom(from);
      const kind = bodyText(A.kind, "kind");
      const id = bodyNumber(A.id, "id", true);
      if (kind !== "image" && kind !== "audio" && kind !== "video") throw new Error("\"kind\" must be image, audio or video");
      const buf = mcpDecodeB64(A.base64, "base64", kind === "image" ? IMAGE_MAX : kind === "audio" ? AUDIO_MAX : VIDEO_MAX, mediaTooBig(kind, "inline"));
      if (!buf.byteLength) throw new Error("\"base64\" is empty");
      if (kind === "image") { if (buf.byteLength > IMAGE_MAX) throw new Error(mediaTooBig("image", "inline")); const t = sniffImage(buf); if (!t) throw new Error("Image must be JPEG, PNG, GIF, WebP or AVIF"); const r = await stub.attachImage(id, from, buf, t, owner, room); if (refused(r)) throw new Error(r.error); return { room: room, id: id, image: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/image?" + (await mediaSigParams(env, room, id, "image", r.ver)) } }; }
      if (kind === "audio") { if (buf.byteLength > AUDIO_MAX) throw new Error(mediaTooBig("audio", "inline")); const t = sniffAudio(buf); if (!t) throw new Error("Audio must be MP3, WAV, OGG, WebM or M4A"); const r = await stub.attachAudio(id, from, buf, t, owner, A.transcript ? bodyText(A.transcript, "transcript").slice(0, MAX_TEXT) : null, room); if (refused(r)) throw new Error(r.error); return { room: room, id: id, audio: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/audio?" + (await mediaSigParams(env, room, id, "audio", r.ver)) } }; }
      if (kind === "video") { if (buf.byteLength > VIDEO_MAX) throw new Error(mediaTooBig("video", "inline")); const t = sniffVideo(buf); if (!t) throw new Error("Video must be MP4, WebM or MOV"); const r = await stub.attachVideo(id, from, buf, t, owner, room); if (refused(r)) throw new Error(r.error); return { room: room, id: id, video: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/video?" + (await mediaSigParams(env, room, id, "video", r.ver)) } }; }
      throw new Error("\"kind\" must be image, audio or video");
    }
    default: throw new Error(mcpUnknownTool(name));
  }
}
/** The answer to a tools/call naming no tool of the catalog (as a tool
 *  error over the revisions that open with initialize, -32602 over the
 *  others). @param name the name as the answer repeats it */
export function mcpUnknownTool(name: string) {
  return "Unknown tool: " + name + ". Call tools/list for the catalog.";
}
