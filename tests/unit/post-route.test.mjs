// POST /messages (worker/routes/messages.ts messagesRoute) end to end on
// the real Room class (room-harness.mjs): the room object is the route's
// stub, so what the route reads from the body, refuses and answers is
// checked against what the room really stored.
import test from "node:test";
import assert from "node:assert/strict";
import { messagesRoute } from "../../worker/routes/messages.ts";
import { BadRequest } from "../../worker/lib/http.ts";
import { makeRoom } from "./room-harness.mjs";

const R = "unit";

/** POST /api/rooms/unit/messages as Ada, through the route; a BadRequest
 *  is answered as the Worker's fetch answers it (index.ts) */
async function post(h, body, headers = {}) {
  const env = { ROOM: { idFromName: (n) => n, get: () => h.room } };
  const url = new URL("http://localhost/api/rooms/" + R + "/messages");
  const request = new Request(url, { method: "POST", body, headers: { "X-Invite-Token": "tok-Ada", ...headers } });
  let res;
  try { res = await messagesRoute({ request, env, url, path: url.pathname, owner: false, invite: "tok-Ada" }, /^\/api\/rooms\/([^/]+)\/messages$/.exec(url.pathname)); }
  catch (e) { if (e instanceof BadRequest) return { status: 400, json: { error: e.message } }; throw e; }
  return { status: res.status, json: await res.json() };
}

const texts = (h) => h.all("SELECT text, draft FROM m ORDER BY id").map((r) => ({ text: r.text, draft: r.draft }));

test("a JSON body sent without a JSON Content-Type is read as JSON", async () => {
  const h = makeRoom();
  h.member("Ada");
  // fetch's default for a string body, and curl -d's default
  for (const ct of [null, "text/plain;charset=UTF-8", "application/x-www-form-urlencoded"]) {
    const r = await post(h, JSON.stringify({ text: "hello " + ct, draft: true }), ct ? { "Content-Type": ct } : {});
    assert.equal(r.status, 201, ct + ": " + JSON.stringify(r.json));
    assert.equal(r.json.text, "hello " + ct);
    assert.equal(r.json.draft, true, ct + ": the draft field was read");
  }
  assert.deepEqual(texts(h).map((x) => x.text), ["hello null", "hello text/plain;charset=UTF-8", "hello application/x-www-form-urlencoded"]);
});

test("a body that starts with { but is not JSON is refused, not posted", async () => {
  const h = makeRoom();
  h.member("Ada");
  const r = await post(h, "{not json", { "Content-Type": "text/plain" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Send JSON like/);
  assert.equal(texts(h).length, 0);
});

test("plain text and form bodies still post their text", async () => {
  const h = makeRoom();
  h.member("Ada");
  assert.equal((await post(h, "just words", { "Content-Type": "text/plain" })).status, 201);
  assert.equal((await post(h, "text=from+a+form", { "Content-Type": "application/x-www-form-urlencoded" })).status, 201);
  const fd = new FormData();
  fd.set("text", "from a multipart form");
  assert.equal((await post(h, fd)).status, 201);
  assert.deepEqual(texts(h).map((x) => x.text), ["just words", "from a form", "from a multipart form"]);
});
