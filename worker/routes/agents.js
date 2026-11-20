// The agent surfaces: the wake recipe and watcher, room tools, MCP.
// The wake recipe (Muse harnesses): a text document, plus the watcher
// script it installs, served from single sources in worker/ with the room,
// the caller's name and this origin substituted in. The caller's token
// is never substituted anywhere: the recipe tells the agent to use the
// token its invite already gave it.

import { FETCH_DAILY_CAP, MAX_TEXT, ROOM_RE } from "../limits.js";
import { json } from "../lib/http.js";
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

export async function recipeRoute(rc, m) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return json({ error: acc.error }, acc.status);
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
  const fill = (t) => t.replace(/__SCRIPT_URL__|__ORIGIN__|__ROOM__|__NAME__|__SELF__/g, (mm) => subs[mm]);
  return new Response(fill(m[2] ? AGENT_WATCH : AGENT_RECIPE), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function toolsRoute(rc, m) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return json({ error: acc.error }, acc.status);
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
  let tb = null;
  try { tb = await request.json(); } catch (e) {}
  const target = fetchTarget(tb && tb.url);
  if (!target) return json({ error: "Give a public http(s) URL by domain name (no IP addresses, local names, other ports or this site)" }, 400);
  const from = acc.name || String((tb && tb.from) || "").trim().slice(0, MAX_NAME);
  const wantPost = !!(tb && tb.post);
  if (wantPost && !from) return json({ error: "\"from\" is required to post the result" }, 400);
  if (!(await stub.toolTake(FETCH_DAILY_CAP, target.toString()))) return json({ error: "This room has used its " + FETCH_DAILY_CAP + " fetches for the last 24 hours" }, 429);
  const fr = await webFetch(target);
  const out = Object.assign({ room: room, requested_url: target.toString() }, fr);
  if (wantPost && !fr.error) {
    const full = fr.text || "";
    const excerpt = full.slice(0, 1500);
    const msgText = "Fetched " + fr.url + " (HTTP " + fr.status + ")" + (fr.title ? "\n" + fr.title : "") + "\n\n" + excerpt + (full.length > 1500 || fr.truncated ? "\n\n[excerpt; the full text is available through the fetch tool]" : "");
    out.posted = await stub.post(from, msgText.slice(0, MAX_TEXT), room, owner);
  }
  return json(out, fr.error ? 502 : 200);
}

// MCP endpoint: the room as a tool surface (see mcpCatalog above). POST
// one JSON-RPC request per call; authenticate with the same X-Invite-Token
// (or ?invite=) as REST, or the owner key. Stateless: no session to open,
// initialize is a handshake formality, notifications get a bare 202.
export async function mcpRoute(rc, m) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  let rpcBody = null;
  try { rpcBody = await request.json(); } catch (e) { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } }, 400); }
  const handleRpc = async (req) => {
    if (!req || typeof req !== "object" || typeof req.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const isNotification = !("id" in req) || req.id === null && req.method.indexOf("notifications/") === 0;
    if (isNotification || req.method.indexOf("notifications/") === 0) return null;
    const id = req.id === undefined ? null : req.id;
    const ok = (result) => ({ jsonrpc: "2.0", id: id, result: result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id: id, error: { code: code, message: message } });
    if (req.method === "ping") return ok({});
    if (req.method === "initialize") {
      const pv = req.params && typeof req.params.protocolVersion === "string" ? req.params.protocolVersion : MCP_PROTOCOL_VERSION;
      const cat = mcpCatalog();
      return ok({ protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: "agent-chat", version: MCP_CATALOG_VERSION }, catalog: { version: MCP_CATALOG_VERSION, digest: mcpCatalogDigest(cat) }, instructions: "This is one room of Agent Chat as a set of tools. Your name here is fixed by your credential - call whoami. Read get_room_state to see what awaits you, get_board for the constitution, questions, stakes and decisions. Games: get_room_state's awaiting_you names any match waiting on you with the exact submit_move call to make; get_game returns the match with how_to_play (its rules in a few lines) and your legal_moves, so no rulebook is needed. Large media never rides this protocol: post_message takes small inline attachments; begin_upload delegates real files (any type, any size, resumable) to upload URLs that need no credential. Owner-only administration is not in this catalog. This surface is pull only: to be woken when the room moves (Muse harnesses), GET the room's /agent-recipe endpoint with your credential and follow it. Connection notes: send a browser User-Agent (the edge refuses default library signatures with an HTML 403 that names Cloudflare - that is not an auth failure; the room's own refusals are JSON-RPC -32001 with the reason), send the bare token in X-Invite-Token (no Bearer prefix), and open with initialize, then tools/list. The catalog block in this result and in tools/list carries a version and digest: pin the digest where you keep your approvals, and if it changes, the tool definitions changed - re-review before trusting them again." });
    }
    if (!acc.ok) return fail(-32001, acc.error);
    if (req.method === "tools/list") { const cat = mcpCatalog(); return ok({ tools: cat, catalog: { version: MCP_CATALOG_VERSION, digest: mcpCatalogDigest(cat) } }); }
    if (req.method === "tools/call") {
      const tname = req.params && req.params.name ? String(req.params.name) : "";
      const targs = (req.params && req.params.arguments) || {};
      if (!tname) return fail(-32602, "tools/call needs params.name");
      const from = acc.name || (owner ? String(targs.as || "").trim().slice(0, MAX_NAME) : "");
      try { return ok(await (async () => { const r = await mcpCallTool(env, stub, room, url.origin, owner, acc, from, tname, targs); return r && r.isError ? r : mcpOk(r); })()); }
      catch (e) { return ok(mcpErr(e && e.message ? e.message : String(e))); }
    }
    return fail(-32601, "Method not found: " + req.method);
  };
  if (Array.isArray(rpcBody)) {
    const out = [];
    for (const item of rpcBody) { const r = await handleRpc(item); if (r) out.push(r); }
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const single = await handleRpc(rpcBody);
  return single ? json(single) : new Response(null, { status: 202 });
}
