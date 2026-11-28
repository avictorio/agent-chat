// POST /api/oauth/disconnect (worker/routes/oauth.ts disconnectRoute): the
// disconnect-only code the approval gave the page. Same origin only, no CORS
// on any answer, the code read before anything else is asked, any other form
// refused; a sign-in that is no more answers unknown; a disconnect lets go of
// the wakes and says so; nothing in a log line but names and numbers. Run
// with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSigninWorld, people, signIn, disconnect, PUBLIC_APP, signins, signin, toolCall, museSignIn, hookOf, ORIGIN } from "./signin-world.mjs";
import { read } from "./agent-world.mjs";
import { disconnectRoute } from "../../worker/routes/oauth.ts";
import { signinDropNote } from "../../worker/agents/onboarding.ts";

const noCors = (r, what) => assert.equal(r.headers.get("Access-Control-Allow-Origin"), null, what);

test("same origin only, the body capped, the code read first: any other form is 400 Not a disconnect code, nothing asked", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, {}]) {
    const mark = w.asked.length;
    const r = await disconnect(w, { code: s.disconnectCode }, headers);
    assert.deepEqual([r.status, r.json], [403, { error: "This request must come from Agent Chat's own sign-in page.", code: "cross_site" }]);
    noCors(r, "403");
    assert.deepEqual(w.asked.slice(mark), []);
  }
  for (const body of [{}, { code: s.refresh }, { code: s.access }, { code: s.code }, { code: ".ac1." + "A".repeat(22) + "." + "A".repeat(43) }, { code: 42 }]) {
    const mark = w.asked.length;
    const r = await disconnect(w, body);
    assert.deepEqual([r.status, r.json], [400, { error: "Not a disconnect code.", code: "invalid_request" }], JSON.stringify(body).slice(0, 40));
    noCors(r, "400");
    assert.deepEqual(w.asked.slice(mark), [], "nothing asked");
  }
  const notJson = await read(disconnectRoute(w.rc("POST", "/api/oauth/disconnect", { body: "nope", headers: { "Sec-Fetch-Site": "same-origin" } })));
  assert.equal(notJson.status, 400);
  const big = await read(disconnectRoute(w.rc("POST", "/api/oauth/disconnect", { json: { code: s.disconnectCode, pad: "x".repeat(9000) }, headers: { "Sec-Fetch-Site": "same-origin" } })));
  assert.equal(big.status, 413);
  noCors(big, "413");
  assert.equal(signins(w).length, 1, "nothing disconnected");
  assert.equal((await read(disconnectRoute(w.rc("GET", "/api/oauth/disconnect")))).status, 405);
});

test("the code disconnects: the connection works nowhere, every seat stays; again, the sign-in is unknown", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const r = await disconnect(w, { code: s.disconnectCode }, { Origin: ORIGIN });
  assert.deepEqual([r.status, r.json], [200, { disconnected: true, wakes_left: [], note: signinDropNote([]) }]);
  noCors(r, "200");
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal((await signin(w, s.access, toolCall("list_rooms"))).status, 401);
  assert.equal(w.harness("lima").one("SELECT revoked FROM inv WHERE name = 'Scout'").revoked, null, "the seat stays");
  const again = await disconnect(w, { code: s.disconnectCode });
  assert.deepEqual(again.json, { disconnected: false, code: "unknown" });
});

test("its Muse wakes let go of, and the note says so; the lines it logs name no room", async () => {
  const m = await museSignIn(["lima", "oslo"]);
  try {
    const lines = [], real = console.warn;
    console.warn = (s) => lines.push(s);
    let r;
    try { r = await disconnect(m.w, { code: m.s.disconnectCode }); } finally { console.warn = real; }
    assert.deepEqual(r.json, { disconnected: true, wakes_left: [], note: signinDropNote([]) });
    assert.equal(hookOf(m.w, "lima"), null);
    assert.equal(hookOf(m.w, "oslo"), null);
    for (const l of lines) assert.ok(!/lima|oslo|Scout|Pat|\.a[dor]1\.|\.oc1\./.test(l), l);
  } finally {
    m.b.restore();
  }
});
