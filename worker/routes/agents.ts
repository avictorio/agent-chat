// The agent surfaces: the wake recipe and watcher, room tools, MCP.

import { FETCH_DAILY_CAP, FETCH_URL_MAX, MAX_TEXT, MIB, ROOM_RE, SMALL_BODY_MAX } from "../limits.js";
import { CORS, bodyText, deny, isObject, json, rateLimited, readBody, settleBody, type Body } from "../lib/http.js";
import AGENT_WATCH from "../agents/agent-watch.sh";
import { fetchTarget, webFetch } from "../platform/webfetch.js";
import { MAX_NAME, oneLine, shellQuote } from "../lib/text.js";
import {
  MCP_CATALOG_VERSION,
  MCP_PROTOCOL_VERSION,
  mcpCallTool,
  mcpCatalogBuilt,
  mcpErr,
  mcpOk,
} from "../agents/mcp.js";
import type { RouteContext } from "../index.js";
import { API_VERSION, activeNotices } from "../agents/notices.js";
import { invitePreviewBody } from "./members.js";
import { MCP_NO_TOKEN, mcpInstructions, type McpVariant } from "../agents/onboarding.js";
import { recipe } from "../agents/docs.js";
import { OWNER_NO_START_PAGE, START_INVALID, START_LIMITS, START_NO_TOKEN, startPage } from "../agents/start.js";
import { inviteMissing, type InviteLookup, type Refusal } from "../room/Room.js";

// The wake recipe (Muse harnesses): a text document (its limits filled in
// by docs.ts), plus the watcher script it installs, with the room, the
// caller's name and this origin substituted in. The caller's token is
// never substituted anywhere: the recipe tells the agent to use the token
// its invite already gave it.
export async function recipeRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const who = acc.name || "agent";
  const subs = {
    __SCRIPT_URL__: url.origin + "/api/rooms/" + encodeURIComponent(room) + "/agent-recipe/script",
    __ORIGIN__: url.origin,
    __ROOM__: room,
    __NAME__: who,
    __SELF__: who,
  };
  // One pass with a lookup, never a chain: substituted values are not
  // rescanned, so a member (or room) whose name IS a placeholder string
  // gets it verbatim instead of being rewritten by a later pass.
  const fill = (t: string, v: Record<string, string>) => t.replace(/__SCRIPT_URL__|__ORIGIN__|__ROOM__|__NAME__|__SELF__/g, (mm) => v[mm]);
  // The script is shell code that runs on the agent's machine, and a
  // member's name is chosen by whoever invited them: every value goes in
  // as a single-quoted literal, so none of it can be expanded or run. The
  // recipe's text prints the name inside its sentences, folded onto its
  // line as the note and the start page fold it (oneLine: a name may hold
  // a NEL); the script gets the name as it is.
  const text = m[2] ? fill(AGENT_WATCH, Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, shellQuote(v)]))) : fill(recipe(), { ...subs, __NAME__: oneLine(who), __SELF__: oneLine(who) });
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
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
export async function startPageRoute(rc: RouteContext, stub: DurableObjectStub, room: string): Promise<Response> {
  const { request, url, owner, invite } = rc;
  if (!invite) return owner ? json({ error: OWNER_NO_START_PAGE }, 400) : json({ error: START_NO_TOKEN, code: "invite_missing" }, 401);
  const v = await stub.startView(invite, room);
  if (!v.ok) return deny(startRefusal(v));
  const headers = Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, CORS);
  return new Response(request.method === "HEAD" ? null : startPage(v, url.origin, room, START_LIMITS, owner), { headers });
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
// (or Authorization: Bearer) as REST, or the owner key. Stateless: no session to open,
// initialize is a handshake formality, notifications get a bare 202.
export async function mcpRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  // Connecting is not joining: ping, initialize and notifications
  // open no invite. A token that was sent is looked up, without opening
  // it, once per HTTP request before the body is read (it decides how big a body and
  // whether a batch is taken), and tools/list, an unknown method,
  // get_invite and get_start_page (the two looks: previewInvite,
  // startView) are refused when it fails; any other
  // tools/call runs access(), which opens it - before every call, a
  // batch's included. A batch can take a while (a call may fetch a page or
  // wait on storage), and one checked only at its start went on reading
  // and acting for a member who had been removed meanwhile.
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
  // only ping, initialize or be told the token is wrong: one small request.
  // The body used to be parsed whatever its size, and a batch had no end,
  // so 1 MB of tokenless initialize calls came back as a 75 MB answer.
  const tokenOk = await checkToken();
  // initialize's instructions follow what the token turned out to be
  const variant: McpVariant = owner ? "owner" : tokenOk.ok ? "ok" : tokenOk.code === "invite_missing" ? "none" : tokenOk.code === "invite_revoked" ? "revoked" : "invalid";
  let body: Request | null = request;
  if (!tokenOk.ok) body = await settleBody(request, SMALL_BODY_MAX);
  if (!body) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large: without a valid invite token a request can be up to " + Math.floor(SMALL_BODY_MAX / MIB) + " MiB" } }, 413);
  try { rpcBody = await body.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } }, 400); }
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
      const pv = params && typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION;
      return ok({
        protocolVersion: pv, capabilities: { tools: {} },
        serverInfo: { name: "agent-chat", title: "Agent Chat", version: MCP_CATALOG_VERSION, websiteUrl: url.origin },
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
      if (tname === "get_invite") {
        const pv = invite ? await stub.previewInvite(invite) : missing();
        if (!pv.ok) return fail(-32001, pv.error, { code: pv.code });
        return ok(mcpOk(invitePreviewBody(url.origin, room, invite, pv, false)));
      }
      // the start page's text, once (no structuredContent copy); the owner
      // key alone has none, and with a token it is that token's page, with
      // the line that says calls carrying the key act as the owner
      if (tname === "get_start_page") {
        if (!invite) { if (owner) return ok(mcpErr(OWNER_NO_START_PAGE)); const none = missing(); return fail(-32001, none.error, { code: none.code }); }
        const v = await stub.startView(invite, room);
        if (!v.ok) { const no = startRefusal(v); return fail(-32001, no.error, { code: no.code }); }
        return ok({ content: [{ type: "text", text: startPage(v, url.origin, room, START_LIMITS, owner) }] });
      }
      const acc = owner || invite ? await getAcc() : missing();
      if (!acc.ok) return fail(-32001, acc.error, { code: acc.code });
      try { return ok(await (async () => { const from = acc.name || (owner ? bodyText(targs.as, "as").trim().slice(0, MAX_NAME) : ""); const r = await mcpCallTool(env, stub, room, url.origin, owner, acc, from, tname, targs, invite); return r && r.isError ? r : mcpOk(r); })()); }
      catch (e) { const ce = (e || {}) as { message?: string, code?: string, retry_after?: number }; return ok(mcpErr(ce.message ? ce.message : String(e), ce.code ? (ce.retry_after ? { code: ce.code, retry_after: ce.retry_after } : { code: ce.code }) : undefined)); }
    }
    return fail(-32601, "Method not found: " + method);
  };
  if (Array.isArray(rpcBody) && !tokenOk.ok) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: a batch (a JSON array of requests) is answered only for a valid invite token. " + tokenOk.error + " Without one, send ping or initialize as a single request.", data: { code: tokenOk.code } } }, 400);
  }
  if (Array.isArray(rpcBody)) {
    const out: unknown[] = [];
    for (const item of rpcBody) { const r = await handleRpc(item); if (r) out.push(r); }
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const single = await handleRpc(rpcBody);
  return single ? json(single) : new Response(null, { status: 202 });
}
