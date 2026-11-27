// A Room namespace for the agent key's tests: every name is a Room object
// on the room harness (room-harness.mjs), a room where the test made one
// and a bare object anywhere else (an agent key's identity, the quota
// object, a name no room was created under), each reached through a stub
// that answers as Durable Object RPC does (a promise, a copy of the
// arguments and of the answer) and records each method asked. And the
// route context the Worker builds for a request, whose waitUntil records
// where it was registered among the methods asked. A helper, not a test.
import { makeRoom } from "./room-harness.mjs";

// Node wants duplex: "half" on a Request built with a stream body, which
// settleBody (lib/http.ts) makes; the Workers runtime does not.
const NodeRequest = globalThis.Request;
if (!NodeRequest.agentWorld) {
  globalThis.Request = class extends NodeRequest {
    static agentWorld = true;
    constructor(input, init) { super(input, init && init.body && typeof init.body.getReader === "function" ? { duplex: "half", ...init } : init); }
  };
}

export const ORIGIN = "http://localhost";

/**
 * @param {{ env?: object }} [opts] env adds bindings and variables (TEST_HOOKS, say)
 */
export function makeWorld(opts = {}) {
  const objects = new Map();
  /** every method asked, in order: { name (the object's), method, args } */
  const asked = [];
  const harness = (name) => {
    if (!objects.has(name)) objects.set(name, makeRoom({ bare: true, env: opts.env }));
    return objects.get(name);
  };
  const stub = (name) => new Proxy({}, {
    get: (_, method) => async (...args) => {
      asked.push({ name, method: String(method), args: structuredClone(args) });
      const h = harness(name);
      if (typeof h.room[method] !== "function") throw new Error("RPC receiver does not implement the method \"" + String(method) + "\"");
      const r = await h.room[method](...structuredClone(args));
      return r === undefined ? r : structuredClone(r);
    },
  });
  const pending = [];
  /** where each waitUntil was registered: the length of asked at that moment */
  const waits = [];
  const env = { ...(opts.env || {}), ROOM: { idFromName: (n) => n, get: (n) => stub(n) } };
  return {
    env, objects, asked, pending, waits,
    /** a room, created (as the owner's POST /api/rooms/ROOM does) */
    room(name) { const h = makeRoom({ env: opts.env }); objects.set(name, h); return h; },
    /** the harness behind a name (a bare one if nothing is there yet) */
    harness,
    /** the identity objects that exist (names starting __agent-) */
    identities() { return [...objects.keys()].filter((n) => n.startsWith("__agent-") && n !== "__agent-quota"); },
    /** the methods asked of one object since mark (an index into asked) */
    methods(name, mark = 0) { return asked.slice(mark).filter((a) => a.name === name).map((a) => a.method); },
    /** a route context for a request, as index.ts builds it */
    rc(method, path, o = {}) {
      const url = new URL(ORIGIN + path);
      const init = { method, headers: { ...(o.headers || {}) } };
      if (o.json !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = typeof o.json === "string" ? o.json : JSON.stringify(o.json); }
      else if (o.body !== undefined) init.body = o.body;
      const request = new Request(url, init);
      const auth = request.headers.get("Authorization") || "";
      const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
      return { request, env, url, path: url.pathname, owner: !!o.owner, invite: (request.headers.get("X-Invite-Token") || "").trim() || (m ? m[1] : ""), ctx: { waitUntil: (p) => { waits.push(asked.length); pending.push(Promise.resolve(p).catch(() => {})); } } };
    },
  };
}

/** an answer's status, headers, text and JSON */
export async function read(res) {
  const r = await res;
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: an empty 202 or HEAD */ }
  return { status: r.status, headers: r.headers, text, json };
}

/** an agent invite in a harness room, as the owner makes it: its token */
export function agentInvite(h, name, kind = "agent") {
  const inv = h.room.invite(name, kind, null);
  return inv.token;
}

/** The methods that write: an object asked one of these has changed something. */
export const WRITES = new Set(["agentCut", "agentRemain", "agentDrop", "agentReserve", "agentRelease", "agentMake", "agentSwap", "invite", "revoke", "museSetHookLook", "museDropLook", "museHolderDrop", "leave"]);

/** Whether the work a call started was registered with waitUntil before its first write (since mark). */
export function waitedBeforeWrite(w, mark) {
  const first = w.asked.findIndex((a, i) => i >= mark && WRITES.has(a.method));
  if (first < 0) return { first: -1, ok: w.waits.some((x) => x >= mark) };
  return { first, ok: w.waits.some((x) => x >= mark && x <= first) };
}
