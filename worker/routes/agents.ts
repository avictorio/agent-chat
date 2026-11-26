// The agent surfaces: the wake recipe and watcher, room tools, MCP.

import { FETCH_DAILY_CAP, FETCH_URL_MAX, MAX_TEXT, MCP_TOOLS_TTL_MS, MIB, ROOM_RE, SMALL_BODY_MAX } from "../limits.js";
import { CORS, bodyText, deny, isObject, json, rateLimited, readBody, settleBody, type Body } from "../lib/http.js";
import { fetchTarget, webFetch } from "../platform/webfetch.js";
import { MAX_NAME, oneLine, quotedBody } from "../lib/text.js";
import {
  MCP_CATALOG_VERSION,
  MCP_FIRST_MODERN_VERSION,
  MCP_META_SERVER,
  MCP_MODERN_VERSIONS,
  mcpCallTool,
  mcpCatalogBuilt,
  mcpCheck,
  mcpClaims,
  mcpEcho,
  mcpErr,
  mcpHasTool,
  mcpOk,
  mcpProtocolVersion,
  mcpRequestKind,
  mcpServerInfo,
  mcpUnknownTool,
} from "../agents/mcp.js";
import type { RouteContext } from "../index.js";
import { API_VERSION, activeNotices } from "../agents/notices.js";
import { LEAVE_OWNER, invitePreviewBody, leaveAfter, leaveAsk, leaveBody, leaveConfirmRefusal, leaveRefusalBody } from "./members.js";
import { MCP_NO_TOKEN, mcpInstructions, type McpVariant } from "../agents/onboarding.js";
import { recipe, watcher, watcherPin } from "../agents/docs.js";
import { OWNER_NO_START_PAGE, START_INVALID, START_LIMITS, START_NO_TOKEN, startPage } from "../agents/start.js";
import { inviteMissing, type InviteLookup, type Refusal } from "../room/Room.js";
import type { LastMemberRefusal, LeaveResult } from "../room/members.js";
import { GONE_MSG, isGoneError } from "../lib/errors.js";

// The wake recipe (Muse harnesses): a text document (its limits filled in
// by docs.ts) with the room, the caller's name, this origin and the
// watcher's version and SHA-256 substituted in; and the watcher script it
// installs, one file for every caller of this origin (docs.ts watcher:
// only the origin is filled in, so an agent and its person can check the
// bytes they approved), sent with its version and SHA-256 in
// X-Watcher-Version and X-Watcher-SHA256. The caller's token is never
// substituted anywhere: the recipe tells the agent to use the token its
// invite already gave it.
export async function recipeRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const pin = await watcherPin(url.origin);
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (m[2]) return new Response(watcher(url.origin), { headers: { ...headers, "X-Watcher-Version": pin.version, "X-Watcher-SHA256": pin.sha256 } });
  // The recipe's text prints the name inside its own double quotes
  // ("__NAME__"), folded onto its line and escaped as the note and the
  // start page print it (oneLine, then quotedBody: a name may hold a NEL,
  // a look-alike quotation mark or a bidi override).
  const subs: Record<string, string> = {
    __SCRIPT_URL__: url.origin + "/api/rooms/" + encodeURIComponent(room) + "/agent-recipe/script",
    __ORIGIN__: url.origin,
    __ROOM__: room,
    __NAME__: quotedBody(oneLine(acc.name || "agent")),
    __WATCHER_VERSION__: pin.version,
    __WATCHER_SHA256__: pin.sha256,
  };
  // One pass with a lookup, never a chain: substituted values are not
  // rescanned, so a member (or room) whose name IS a placeholder string
  // gets it verbatim instead of being rewritten by a later pass.
  const text = recipe().replace(/__SCRIPT_URL__|__ORIGIN__|__ROOM__|__NAME__|__WATCHER_VERSION__|__WATCHER_SHA256__/g, (mm) => subs[mm]);
  return new Response(text, { headers });
}

/** The start page's refusal from the lookup: a token that is none of the
 *  room's invites gets the page's own sentence (START_INVALID), the code kept. */
function startRefusal(v: Refusal): Refusal {
  return v.code === "invite_invalid" ? { ...v, error: START_INVALID } : v;
}

// GET or HEAD /api/rooms/ROOM with an invite token: the start page, as
// text (agents/start.ts). A look: Room.startView runs no access(), so it
// opens nothing and marks nothing seen, and it shows the token's holder
// nothing its own reads do not. The owner key alone is no member (400);
// beside a header token the page is that token's, as GET /invite's is,
// opening with a line that calls carrying the key act as the owner. A token
// only in the URL is not read (lib/tokens.ts): answered as none. The room
// exists (roomRoute answered 404 before the token, as on every room route).
// Step 3c prints the watcher's version and SHA-256 for this origin
// (watcherPin: an async digest, made once per origin).
export async function startPageRoute(rc: RouteContext, stub: DurableObjectStub, room: string): Promise<Response> {
  const { request, url, owner, invite } = rc;
  if (!invite) return owner ? json({ error: OWNER_NO_START_PAGE }, 400) : json({ error: START_NO_TOKEN, code: "invite_missing" }, 401);
  const v = await stub.startView(invite, room);
  if (!v.ok) return deny(startRefusal(v));
  const headers = Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, CORS);
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(startPage(v, url.origin, room, await watcherPin(url.origin), START_LIMITS, owner), { headers });
}

export async function toolsRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const tbase = url.origin + "/api/rooms/" + room;
  if (!m[2]) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return json({ room, available: true, tools: [
      { name: "fetch", method: "POST", url: tbase + "/tools/fetch", body: "{\"url\": \"https://...\", \"post\": true}", about: "Fetch a public web page as text. " + FETCH_DAILY_CAP + " per room per 24 hours." },
      { name: "board", method: "GET", url: tbase + "/welcome", about: "Read the room's constitution, questions, stakes, decisions and memory in one call." },
      { name: "mcp", method: "POST", url: tbase + "/mcp", body: "{\"jsonrpc\": \"2.0\", \"id\": 1, \"method\": \"tools/list\"}", about: "The whole room as a Model Context Protocol tool surface: messages, reactions, board, games, voice, delegated uploads. Authenticate with your invite token; tools/list is the catalog." },
    ] });
  }
  if (m[2] !== "fetch") return json({ error: "Unknown tool. GET " + tbase + "/tools lists them" }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const target = fetchTarget(tb && tb.url);
  if (!target) return json({ error: "Give a public http(s) URL by domain name, at most " + FETCH_URL_MAX + " characters (no IP addresses, local names, other ports or this site)" }, 400);
  const from = acc.name || bodyText(tb?.from, "from").trim().slice(0, MAX_NAME);
  const wantPost = !!(tb && tb.post);
  if (wantPost && !from) return json({ error: "\"from\" is required to post the result" }, 400);
  if (!(await stub.toolTake(FETCH_DAILY_CAP, target.toString()))) return rateLimited("This room has used its " + FETCH_DAILY_CAP + " fetches for the last 24 hours", await stub.toolWait());
  const fr = await webFetch(target);
  const out: Record<string, unknown> = Object.assign({ room: room, requested_url: target.toString() }, fr);
  if (wantPost && !fr.error) {
    const full = fr.text || "";
    const excerpt = full.slice(0, 1500);
    const msgText = "Fetched " + fr.url + " (HTTP " + fr.status + ")" + (fr.title ? "\n" + fr.title : "") + "\n\n" + excerpt + (full.length > 1500 || fr.truncated ? "\n\n[excerpt; the full text is available through the fetch tool]" : "");
    out.posted = await stub.post(from, msgText.slice(0, MAX_TEXT), room, owner);
  }
  return json(out, fr.error ? 502 : 200);
}

// The public changes feed: the API version, the MCP catalog version and
// the site notices still showing (agents/notices.ts). No token: a site
// change has to reach agents in every room. MCP initialize carries only the
// link (changesLink): the whole feed was most of its answer, which some
// harnesses keep in every turn.
export function changesLink(origin: string) {
  return { api_version: API_VERSION, catalog_version: MCP_CATALOG_VERSION, url: origin + "/api/changes" };
}
export function changesBody(origin: string) {
  return { ...changesLink(origin), notices: activeNotices() };
}
export function changesRoute(rc: RouteContext) {
  const { request, url } = rc;
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  return json(changesBody(url.origin));
}

// MCP endpoint: the room as a tool surface (see mcpCatalog in agents/mcp.ts). POST
// one JSON-RPC request per call; authenticate with the same X-Invite-Token
// (or Authorization: Bearer) as REST, or the owner key. Stateless: no session
// to open, and nothing is remembered between requests. One address serves
// two kinds of protocol revision, told apart for each request from that
// request alone (mcpRequestKind): the revisions that open with initialize (a
// handshake formality here; notifications get a bare 202), which handleRpc
// answers, and those that carry their revision and the client's
// capabilities on every request (from MCP_FIRST_MODERN_VERSION on), which
// pass mcpCheck and then ask server/discover, tools/list or tools/call
// (perRequest).
export async function mcpRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  // Connecting is not joining: ping, initialize, server/discover and
  // notifications open no invite. A token that was sent is looked up,
  // without opening it, once per HTTP request before the body is read (it
  // decides how big a body and whether a batch is taken). tools/list and an
  // unknown method are refused when that look fails, as is every tools/call
  // over the revisions without initialize; get_invite and get_start_page
  // look again (previewInvite, startView), and leave_room is refused on it
  // and the room looks the token up itself, never opening an invite. A
  // tools/call that names no tool of the catalog joins nothing either: it is
  // answered after the token's verdict and before any dispatch (over the
  // revisions that open with initialize, from a fresh lookupInvite). Any
  // other tools/call runs access(), which opens the invite - before every
  // call, a batch's included. A batch can take a while (a call may fetch a
  // page or wait on storage), and one checked only at its start went on
  // reading and acting for a member who had been removed meanwhile.
  const getAcc = () => stub.access(invite, owner);
  let checkP: Promise<{ ok: true } | Refusal> | null = null;
  // No token, no question for the room: the refusal is built here, for
  // every method that needs one (the room could only answer
  // invite_missing). Asking made every tokenless ping, initialize and
  // notification (which never touched the Room object before) a Durable
  // Object call. Its sentence is MCP's own (MCP_NO_TOKEN): the REST one says
  // to open the invite link, which an MCP client cannot do. A token in the
  // URL (?invite=) is not read (lib/tokens.ts): a request that sent only
  // that one is answered exactly as one that sent none.
  const missing = (): Refusal => ({ ...inviteMissing(), error: MCP_NO_TOKEN });
  const checkToken = () => checkP || (checkP = owner ? Promise.resolve({ ok: true as const }) : !invite ? Promise.resolve(missing()) : stub.lookupInvite(invite).then((l: InviteLookup) => (l.ok ? { ok: true as const } : l)));
  /** the request's JSON body: one JSON-RPC request, or a batch */
  let rpcBody: unknown = null;
  // A caller whose token checks out has had its body read already
  // (index.ts settleRoomBody, up to SETTLED_BODY_MAX; an owner request's too). Anyone else may
  // only ping, initialize, ask server/discover or be told the token is wrong:
  // one small request. The body used to be parsed whatever its size, and a
  // batch had no end, so 1 MB of tokenless initialize calls came back as a
  // 75 MB answer.
  const tokenOk = await checkToken();
  // initialize's and server/discover's instructions follow what the token turned out to be
  const variant: McpVariant = owner ? "owner" : tokenOk.ok ? "ok" : tokenOk.code === "invite_missing" ? "none" : tokenOk.code === "invite_revoked" ? "revoked" : "invalid";
  let body: Request | null = request;
  if (!tokenOk.ok) body = await settleBody(request, SMALL_BODY_MAX);
  if (!body) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large: without a valid invite token a request can be up to " + Math.floor(SMALL_BODY_MAX / MIB) + " MiB" } }, 413);
  try { rpcBody = await body.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } }, 400); }
  // A tools/call of a tool in the catalog, once its name (and, over the
  // revisions without initialize, the token) has been taken: get_invite,
  // get_start_page and leave_room look, or leave, without access(); every
  // other tool runs access(), which opens the invite, then mcpCallTool.
  // say words a token refusal for the kind of revision asked (its sentence;
  // the code is the contract).
  const toolAnswer = async (tname: string, targs: Body, say: (r: Worded) => Worded): Promise<ToolAnswer> => {
    const no = (r: Worded): ToolAnswer => { const w = say(r); return { error: { code: -32001, message: w.error, data: { code: w.code } } }; };
    if (tname === "get_invite") {
      const pv = invite ? await stub.previewInvite(invite) : missing();
      if (!pv.ok) return no(pv);
      return { result: mcpOk(invitePreviewBody(url.origin, room, pv)) };
    }
    // the start page's text, once (no structuredContent copy); the owner
    // key alone has none, and with a token it is that token's page, with
    // the line that says calls carrying the key act as the owner
    if (tname === "get_start_page") {
      if (!invite) return owner ? { result: mcpErr(OWNER_NO_START_PAGE) } : no(missing());
      const v = await stub.startView(invite, room);
      if (!v.ok) return no(startRefusal(v));
      return { result: { content: [{ type: "text", text: startPage(v, url.origin, room, await watcherPin(url.origin), START_LIMITS, owner) }] } };
    }
    // a leave, as POST .../leave takes it: the room looks the token up
    // (room/members.ts leave) and refuses an invite never opened without
    // opening it, so this runs no access(); the owner key is no member
    if (tname === "leave_room") {
      if (owner) return { result: mcpErr(LEAVE_OWNER, { code: "owner_not_member" }) };
      // the token's refusal first, as every other tool answers it: the
      // look this request already made (checkToken), which opens nothing
      const tk = await checkToken();
      if (!tk.ok) return no(tk);
      const ask = leaveAsk(targs, room);
      if (!ask.confirmed) return { result: mcpErr(leaveConfirmRefusal(room), { code: "confirm_mismatch" }) };
      let r: LeaveResult | Refusal | LastMemberRefusal;
      // a room deleted meanwhile (goneError), as any other tool's call answers it
      try { r = await stub.leave(invite, room, ask.deleteRoom); } catch (e) { return { result: mcpErr(isGoneError(e) ? GONE_MSG : String((e && (e as Error).message) || e), isGoneError(e) ? { code: "room_deleted" } : undefined) }; }
      if (!r.ok) { const b = leaveRefusalBody(r); return r.code.indexOf("invite_") === 0 ? no(b) : { result: mcpErr(b.error, b.unopened === undefined ? { code: b.code } : { code: b.code, unopened: b.unopened }) }; }
      leaveAfter(rc, stub, room, r);
      return { result: mcpOk(leaveBody(room, r)) };
    }
    const acc = owner || invite ? await getAcc() : missing();
    if (!acc.ok) return no(acc);
    try { return { result: await (async () => { const from = acc.name || (owner ? bodyText(targs.as, "as").trim().slice(0, MAX_NAME) : ""); const r = await mcpCallTool(env, stub, room, url.origin, owner, acc, from, tname, targs, invite); return r && r.isError ? r : mcpOk(r); })() }; }
    catch (e) { const ce = (e || {}) as { message?: string, code?: string, retry_after?: number }; return { result: mcpErr(ce.message ? ce.message : String(e), ce.code ? (ce.retry_after ? { code: ce.code, retry_after: ce.retry_after } : { code: ce.code }) : undefined) }; }
  };
  // A request of a revision that opens with initialize, alone or in a batch.
  const handleRpc = async (/** one JSON-RPC request, as sent */ raw: unknown) => {
    const req = isObject(raw) ? raw : null;
    if (!req || typeof req.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const method = req.method;
    const params = isObject(req.params) ? req.params : null;
    const isNotification = !("id" in req) || req.id === null && method.indexOf("notifications/") === 0;
    if (isNotification || method.indexOf("notifications/") === 0) return null;
    const id = req.id === undefined ? null : req.id;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: id, result: result });
    const fail = (code: number, message: string, data?: Record<string, unknown>) => ({ jsonrpc: "2.0", id: id, error: data ? { code: code, message: message, data: data } : { code: code, message: message } });
    if (method === "ping") return ok({});
    if (method === "initialize") {
      return ok({
        protocolVersion: mcpProtocolVersion(params ? params.protocolVersion : undefined), capabilities: { tools: {} },
        serverInfo: mcpServerInfo(url.origin),
        catalog: { version: MCP_CATALOG_VERSION, digest: mcpCatalogBuilt().digest },
        changes: changesLink(url.origin), instructions: mcpInstructions(url.origin, variant),
      });
    }
    if (method !== "tools/call") {
      const c = await checkToken();
      if (!c.ok) return fail(-32001, c.error, { code: c.code });
    }
    if (method === "tools/list") { const cat = mcpCatalogBuilt(); return ok({ tools: cat.tools, catalog: { version: MCP_CATALOG_VERSION, digest: cat.digest } }); }
    if (method === "tools/call") {
      const tname = params && typeof params.name === "string" ? params.name : "";
      // arguments that are not an object are taken as none (each tool says what it misses)
      const targs: Body = params && isObject(params.arguments) ? params.arguments : {};
      if (!tname) return fail(-32602, "tools/call needs params.name");
      // a name that is no tool of the catalog opens nothing: the token's
      // verdict, from a fresh look (lookupInvite only reads, and a batch can
      // run a while) or, without a token, the tokenless refusal; the owner
      // key passes. Then a tool error (isError), which these clients hand
      // to their model.
      if (!mcpHasTool(tname)) {
        const l = owner ? null : invite ? await stub.lookupInvite(invite) : missing();
        if (l && !l.ok) return fail(-32001, l.error, { code: l.code });
        return ok(mcpErr(mcpUnknownTool(tname)));
      }
      const a = await toolAnswer(tname, targs, (r) => r);
      return "result" in a ? ok(a.result) : { jsonrpc: "2.0", id: id, error: a.error };
    }
    return fail(-32601, "Method not found: " + method);
  };
  // A request of a revision without initialize (one per POST, never in a
  // batch): mcpCheck's refusals first (400, or 404 for a method this
  // endpoint lacks, with the protocol's own codes), then the method's own
  // checks, then the token's verdict where the method needs one, then the
  // work. Those answers are in-band, HTTP 200, a refused token included
  // (-32001 with data.code, as over the other kind): the official v2 client
  // hands a 200's code and data to its caller, a 401's or 403's only as an
  // HTTP error, and a 401 sends a client with an auth flow into OAuth,
  // which this endpoint does not offer. Every result carries resultType and
  // the server's identity in _meta. A notification (no id) gets the bare
  // 202, validated for nothing and running nothing.
  const perRequest = async (req: Body): Promise<Response> => {
    if (!("id" in req)) return accepted();
    const bad = mcpCheck(req, (name) => request.headers.get(name));
    if (bad) return json({ jsonrpc: "2.0", id: bad.id, error: bad.error }, bad.status);
    const id = req.id;
    const method = req.method;
    // past mcpCheck, params is an object (its _meta holds the revision)
    const params: Body = isObject(req.params) ? req.params : {};
    const done = (result: object) => json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result, _meta: { [MCP_META_SERVER]: mcpServerInfo(url.origin) } } });
    const fail = (code: number, message: string, data?: Record<string, unknown>) => json({ jsonrpc: "2.0", id, error: data ? { code, message, data } : { code, message } });
    // a token that is none of the room's gets the start page's sentence
    // (written for a client that sent a header: send the token alone, for
    // its own room); every other refusal keeps the room's
    const say = (r: Worded): Worded => (r.code === "invite_invalid" ? { error: START_INVALID, code: r.code } : r);
    const refuse = (r: Worded) => { const w = say(r); return fail(-32001, w.error, { code: w.code }); };
    // answers anyone, as initialize does, with the instructions for what
    // the token turned out to be; ttlMs 0 since those follow the token and
    // can go stale the moment an invite is revoked
    if (method === "server/discover") {
      return done({
        supportedVersions: MCP_MODERN_VERSIONS, capabilities: { tools: {} },
        instructions: mcpInstructions(url.origin, variant),
        catalog: { version: MCP_CATALOG_VERSION, digest: mcpCatalogBuilt().digest },
        changes: changesLink(url.origin), ttlMs: 0, cacheScope: "private",
      });
    }
    // one page, so any cursor is one this endpoint never gave. The list is
    // the same for everyone, but it is answered only for a token: private,
    // so no shared cache hands it to a caller without one.
    if (method === "tools/list") {
      if (params.cursor !== undefined && params.cursor !== null) return fail(-32602, "Invalid cursor: tools/list answers in one page; send it without a cursor.");
      const tk = await checkToken();
      if (!tk.ok) return refuse(tk);
      const cat = mcpCatalogBuilt();
      return done({ tools: cat.tools, catalog: { version: MCP_CATALOG_VERSION, digest: cat.digest }, ttlMs: MCP_TOOLS_TTL_MS, cacheScope: "private" });
    }
    // tools/call, the one method left (mcpCheck refused the rest)
    const tname = params.name;
    if (typeof tname !== "string" || !tname) return fail(-32602, "tools/call needs params.name");
    if (params.arguments !== undefined && !isObject(params.arguments)) return fail(-32602, "Invalid params for tools/call: 'arguments' must be an object");
    const tk = await checkToken();
    if (!tk.ok) return refuse(tk);
    // after the token, so a caller without one learns nothing of the catalog
    if (!mcpHasTool(tname)) return fail(-32602, mcpUnknownTool(mcpEcho(tname)));
    const a = await toolAnswer(tname, isObject(params.arguments) ? params.arguments : {}, say);
    return "result" in a ? done(a.result) : json({ jsonrpc: "2.0", id, error: a.error });
  };
  if (Array.isArray(rpcBody) && !tokenOk.ok) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: a batch (a JSON array of requests) is answered only for a valid invite token. " + tokenOk.error + " Without one, send ping or initialize as a single request.", data: { code: tokenOk.code } } }, 400);
  }
  if (Array.isArray(rpcBody)) {
    // batches belong to the revisions that open with initialize: one that
    // holds a request of the other kind (the claim in its _meta) is
    // refused whole, before any of it runs
    if (rpcBody.some((item) => mcpClaims(item))) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: revision " + MCP_FIRST_MODERN_VERSION + " has no batches; send each request as its own POST." } }, 400);
    const out: unknown[] = [];
    for (const item of rpcBody) { const r = await handleRpc(item); if (r) out.push(r); }
    return out.length ? json(out) : accepted();
  }
  if (isObject(rpcBody) && mcpRequestKind(rpcBody, request.headers.get("MCP-Protocol-Version")).kind === "per-request") return perRequest(rpcBody);
  const single = await handleRpc(rpcBody);
  return single ? json(single) : accepted();
}

/** A refusal's sentence and code, as a tools/call words it. */
type Worded = { error: string, code: string };
/** A tools/call's answer: its result, or the JSON-RPC error. */
type ToolAnswer = { result: object } | { error: { code: number, message: string, data?: Record<string, unknown> } };

/** The answer to notifications alone: 202, no body, and the CORS headers
 *  json() gives every other answer. Without them a browser refused it, and
 *  an MCP client in a browser failed at its notifications/initialized. */
function accepted(): Response {
  return new Response(null, { status: 202, headers: CORS });
}
