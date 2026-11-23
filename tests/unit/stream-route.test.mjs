// The stream route (worker/routes/stream.ts) and the room object's stream
// (Room.fetch, on room-harness.mjs): the invite reaches the room object in
// a header, never in the URL of that fetch, which Workers Logs records.
import test from "node:test";
import assert from "node:assert/strict";
import { streamRoute } from "../../worker/routes/stream.ts";
import { makeRoom } from "./room-harness.mjs";

test("the stream route hands the invite to the room object in a header, not in its URL", async () => {
  const seen = [];
  const stub = {
    access: async () => ({ ok: true, name: "Ada" }),
    fetch: async (input, init) => { seen.push(new Request(input, init)); return new Response("ok"); },
  };
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/unit/stream?events=message&after=3");
  const request = new Request(url, { headers: { "X-Invite-Token": "tok-Ada_with-dash" } });
  const r = await streamRoute({ request, env, url, path: url.pathname, owner: false, invite: "tok-Ada_with-dash" }, /^\/api\/rooms\/([^/]+)\/stream$/.exec(url.pathname));
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].url.includes("tok-Ada"), "no token in the room object's URL: " + seen[0].url);
  assert.ok(!new URL(seen[0].url).searchParams.has("token"));
  assert.equal(seen[0].headers.get("X-Invite-Token"), "tok-Ada_with-dash");
  // the logs redact a header by its name (cookie, set-cookie, or one containing auth, key, secret, token or jwt)
  const carrying = [...seen[0].headers].filter(([, v]) => v === "tok-Ada_with-dash").map(([k]) => k);
  assert.ok(carrying.length && carrying.every((k) => /^(set-)?cookie$|auth|key|secret|token|jwt/i.test(k)), "a name the logs redact: " + carrying);
  assert.equal(new URL(seen[0].url).searchParams.get("events"), "message");
});

test("the room object's stream reads the invite from the header", async () => {
  const h = makeRoom();
  h.member("Ada");
  let r = await h.room.fetch(new Request("https://room/stream?room=unit&after=latest", { headers: { "X-Invite-Token": "tok-Ada" } }));
  assert.equal(r.status, 200);
  assert.equal([...h.room.clients].filter((c) => c.name === "Ada").length, 1, "Ada's stream is open");
  for (const c of [...h.room.clients]) c.close();
  // a token in the query is no credential here any more
  r = await h.room.fetch(new Request("https://room/stream?room=unit&after=latest&token=tok-Ada"));
  assert.notEqual(r.status, 200);
  clearInterval(h.room.pinger);
});

// The route once sent a refused stream again with the token in the URL,
// for room objects still on the code from before the header; that window
// has passed, and a second try only put the token back in the logged URL.
test("a refusal from the room object is the answer: no second try with the token in the URL", async () => {
  const seen = [];
  const stub = {
    access: async () => ({ ok: true, name: "Ada" }),
    fetch: async (input, init) => { seen.push(new Request(input, init)); return Response.json({ error: "invite-only", code: "invite_missing" }, { status: 401 }); },
  };
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/unit/stream");
  const r = await streamRoute({ request: new Request(url), env, url, path: url.pathname, owner: false, invite: "tok-Ada" }, /^\/api\/rooms\/([^/]+)\/stream$/.exec(url.pathname));
  assert.equal(r.status, 401);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].url.includes("tok-Ada"));
});

test("the stream's ping interval is STREAM_PING_MS, and /api quotes it", async () => {
  const { STREAM_PING_MS } = await import("../../worker/limits.ts");
  const { docsValues } = await import("../../worker/agents/docs.ts");
  assert.equal(docsValues("https://x").STREAM_PING_S, STREAM_PING_MS / 1000);
  const h = makeRoom();
  h.member("Ada");
  const real = globalThis.setInterval;
  const asked = [];
  globalThis.setInterval = (fn, ms) => { asked.push(ms); return real(fn, 1e9); };
  try {
    const r = await h.room.fetch(new Request("https://room/stream?room=unit&after=latest", { headers: { "X-Invite-Token": "tok-Ada" } }));
    assert.equal(r.status, 200);
  } finally {
    globalThis.setInterval = real;
    for (const c of [...h.room.clients]) c.close();
    clearInterval(h.room.pinger);
    h.room.pinger = null;
  }
  assert.deepEqual(asked, [STREAM_PING_MS]);
});
