// The agent surfaces: the wake recipe and watcher, room tools, MCP.

import { FETCH_DAILY_CAP, MAX_TEXT, ROOM_RE } from "../limits.js";
import { bodyText, deny, isObject, json, rateLimited, readBody, type Body } from "../lib/http.js";
import AGENT_WATCH from "../agents/agent-watch.sh";
import AGENT_RECIPE from "../agents/agent-recipe.md";
import { fetchTarget, webFetch } from "../platform/webfetch.js";
import { MAX_NAME } from "../lib/text.js";
import {
  MCP_CATALOG_VERSION,
  MCP_PROTOCOL_VERSION,
  mcpCallTool,
  mcpCatalog,
  mcpCatalogDigest,
  mcpErr,
  mcpOk,
} from "../agents/mcp.js";
import type { RouteContext } from "../index.js";
import { API_VERSION, activeNotices } from "../agents/notices.js";
import { invitePreviewBody } from "./members.js";
import { mcpInstructions } from "../agents/onboarding.js";
import type { InviteLookup, Refusal } from "../room/Room.js";

// The wake recipe (Muse harnesses): a text document, plus the watcher
// script it installs, served from single sources in worker/ with the room,
// the caller's name and this origin substituted in. The caller's token
// is never substituted anywhere: the recipe tells the agent to use the
// token its invite already gave it.
/** @param m the path's match */
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
  const fill = (t: string) => t.replace(/__SCRIPT_URL__|__ORIGIN__|__ROOM__|__NAME__|__SELF__/g, (mm) => (subs as Record<string, string>)[mm]);
  return new Response(fill(m[2] ? AGENT_WATCH : AGENT_RECIPE), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** @param m the path's match */
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
      { name: "fetch", method: "POST", url: tbase + "/tools/fetch", body: "{\"from\": name, \"url\": \"https://...\", \"post\": true}", about: "Fetch a public web page as text. " + FETCH_DAILY_CAP + " per room per 24 hours." },
      { name: "board", method: "GET", url: tbase + "/welcome", about: "Read the room's constitution, questions, stakes, decisions and memory in one call." },
      { name: "mcp", method: "POST", url: tbase + "/mcp", body: "{\"jsonrpc\": \"2.0\", \"id\": 1, \"method\": \"tools/list\"}", about: "The whole room as a Model Context Protocol tool surface: messages, reactions, board, games, voice, delegated uploads. Authenticate with your invite token; tools/list is the catalog." },
    ] });
  }
  if (m[2] !== "fetch") return json({ error: "Unknown tool. GET " + tbase + "/tools lists them" }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const target = fetchTarget(tb && tb.url);
  if (!target) return json({ error: "Give a public http(s) URL by domain name (no IP addresses, local names, other ports or this site)" }, 400);
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
// change has to reach agents in every room.
export function changesBody(origin: string) {
  return { api_version: API_VERSION, catalog_version: MCP_CATALOG_VERSION, url: origin + "/api/changes", notices: activeNotices() };
}
export function changesRoute(rc: RouteContext) {
  const { request, url } = rc;
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  return json(changesBody(url.origin));
}

// MCP endpoint: the room as a tool surface (see mcpCatalog in agents/mcp.ts). POST
// one JSON-RPC request per call; authenticate with the same X-Invite-Token
// (or ?invite=) as REST, or the owner key. Stateless: no session to open,
// initialize is a handshake formality, notifications get a bare 202.
/** @param m the path's match */
export async function mcpRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  // Connecting is not joining (Phase A): ping, initialize and notifications
  // touch no invite; tools/list, an unknown method and get_invite check the
  // token without opening it; any other tools/call runs access(), which
  // opens it. Each runs at most once per HTTP request, batches included.
  let accP: ReturnType<typeof stub.access> | null = null;
  const getAcc = () => accP || (accP = stub.access(invite, owner));
  let checkP: Promise<{ ok: true } | Refusal> | null = null;
  const checkToken = () => checkP || (checkP = owner ? Promise.resolve({ ok: true as const }) : stub.lookupInvite(invite).then((l: InviteLookup) => (l.ok ? { ok: true as const } : l)));
  /** the request's JSON body: one JSON-RPC request, or a batch */
  let rpcBody: unknown = null;
  try { rpcBody = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } }, 400); }
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
      const cat = mcpCatalog();
      return ok({ protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: "agent-chat", version: MCP_CATALOG_VERSION }, catalog: { version: MCP_CATALOG_VERSION, digest: mcpCatalogDigest(cat) }, changes: changesBody(url.origin), instructions: mcpInstructions(url.origin) });
    }
    if (method !== "tools/call") {
      const c = await checkToken();
      if (!c.ok) return fail(-32001, c.error, { code: c.code });
    }
    if (method === "tools/list") { const cat = mcpCatalog(); return ok({ tools: cat, catalog: { version: MCP_CATALOG_VERSION, digest: mcpCatalogDigest(cat) } }); }
    if (method === "tools/call") {
      const tname = params && typeof params.name === "string" ? params.name : "";
      // arguments that are not an object are taken as none (each tool says what it misses)
      const targs: Body = params && isObject(params.arguments) ? params.arguments : {};
      if (!tname) return fail(-32602, "tools/call needs params.name");
      if (tname === "get_invite") {
        const pv = await stub.previewInvite(invite);
        if (!pv.ok) return fail(-32001, pv.error, { code: pv.code });
        return ok(mcpOk(invitePreviewBody(url.origin, room, invite, pv)));
      }
      const acc = await getAcc();
      if (!acc.ok) return fail(-32001, acc.error, { code: acc.code });
      try { return ok(await (async () => { const from = acc.name || (owner ? bodyText(targs.as, "as").trim().slice(0, MAX_NAME) : ""); const r = await mcpCallTool(env, stub, room, url.origin, owner, acc, from, tname, targs); return r && r.isError ? r : mcpOk(r); })()); }
      catch (e) { const ce = (e || {}) as { message?: string, code?: string, retry_after?: number }; return ok(mcpErr(ce.message ? ce.message : String(e), ce.code ? (ce.retry_after ? { code: ce.code, retry_after: ce.retry_after } : { code: ce.code }) : undefined)); }
    }
    return fail(-32601, "Method not found: " + method);
  };
  if (Array.isArray(rpcBody)) {
    const out: unknown[] = [];
    for (const item of rpcBody) { const r = await handleRpc(item); if (r) out.push(r); }
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const single = await handleRpc(rpcBody);
  return single ? json(single) : new Response(null, { status: 202 });
}
