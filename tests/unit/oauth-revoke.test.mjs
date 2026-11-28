// POST /api/oauth/revoke (RFC 7009) and how a sign-in ends
// (worker/routes/oauth.ts revokeRoute, signinDisconnect): by each token
// form; the client authenticated by its kind; always 200 {} once it is; a
// token issued to another known app changes nothing; a refresh token ends
// its sign-in and lets go of its wakes; a remainder (wakes a room did not
// confirm) kept on the cut sign-in and finished by any of its credentials
// presented later, at any of the three endpoints; busy, when the list keeps
// moving; an unreadable wake list. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSigninWorld, people, signIn, revoke, token, clientAuth, poppyApp, keyPair, PUBLIC_APP, ADDRESS, signins, signin, toolCall, museSignIn, hookOf, holdersOf, disconnect } from "./signin-world.mjs";
import { AGENT_SWAP_TRIES, OAUTH_QUOTA_ROOM } from "../../worker/limits.ts";
import { signinDropNote } from "../../worker/agents/onboarding.ts";
import { resetWarnings } from "../../worker/lib/log.ts";
import { read } from "./agent-world.mjs";
import { revokeRoute } from "../../worker/routes/oauth.ts";

const refreshOf = (w, rt, auth, headers) => token(w, { grant_type: "refresh_token", refresh_token: rt, resource: ADDRESS, ...auth }, headers);

test("a refresh token, live or spent, issued to the client ends its sign-in: 200 {}, every token refused after, the seats kept", async () => {
  for (const which of ["live", "spent"]) {
    const w = makeSigninWorld();
    const pat = people(w, ["lima"]);
    const s = await signIn(w, PUBLIC_APP, pat);
    const auth = { client_id: PUBLIC_APP.client_id };
    let rt = s.refresh;
    const r1 = await refreshOf(w, s.refresh, auth);
    if (which === "live") rt = r1.json.refresh_token;
    const r = await revoke(w, { token: rt, token_type_hint: "refresh_token", ...auth });
    assert.deepEqual([r.status, r.json], [200, {}], which);
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.equal(r.headers.get("Pragma"), "no-cache");
    assert.deepEqual(signins(w), [], which + ": ended");
    assert.equal((await signin(w, r1.json.access_token, toolCall("list_rooms"))).status, 401, which);
    assert.equal(w.harness("lima").one("SELECT revoked FROM inv WHERE name = 'Scout'").revoked, null, which + ": the seat stays");
  }
});

test("an access token issued to the client ends itself only; anything else, unknown, gone or another app's, changes nothing, and answers 200 {}", async () => {
  const P = await poppyApp();
  const w = makeSigninWorld([PUBLIC_APP, P.app]);
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const auth = { client_id: PUBLIC_APP.client_id };
  const r2 = await refreshOf(w, s.refresh, auth);
  // another known app's revoke of this sign-in's tokens: a deliberate 200 {}, and nothing changes (its caller holds the token already)
  for (const t of [r2.json.refresh_token, r2.json.access_token]) {
    const r = await revoke(w, { token: t, ...(await clientAuth(P.app, P.es)) });
    assert.deepEqual([r.status, r.json], [200, {}]);
  }
  assert.equal((await signin(w, r2.json.access_token, toolCall("list_rooms"))).status, 200, "the other app's revoke changed nothing");
  assert.equal(signins(w).length, 1);
  // its own access token: that one ends, the sign-in and its other tokens stay
  assert.deepEqual((await revoke(w, { token: r2.json.access_token, ...auth })).json, {});
  assert.equal((await signin(w, r2.json.access_token, toolCall("list_rooms"))).status, 401);
  const r3 = await refreshOf(w, r2.json.refresh_token, auth);
  assert.equal(r3.status, 200, "the refresh token still works");
  for (const t of ["", "nonsense", ".ar1.x", ".oc1." + "A".repeat(22) + "." + "A".repeat(11) + "." + "A".repeat(43), ".ac1." + "A".repeat(22) + "." + "A".repeat(43)]) {
    assert.deepEqual((await revoke(w, { token: t, ...auth })).json, {}, JSON.stringify(t));
  }
  assert.equal((await signin(w, r3.json.access_token, toolCall("list_rooms"))).status, 200, "nothing of those ended anything");
});

test("the client authenticates by kind first: an unknown client, a request with no assertion or a failed assertion is 401 invalid_client (WWW-Authenticate only for an Authorization header sent) and revokes nothing; only a failed assertion check is counted", async () => {
  const P = await poppyApp();
  const w = makeSigninWorld([P.app]);
  const pat = people(w, ["lima"]);
  const s = await signIn(w, P.app, pat, { pair: P.es });
  for (const [auth, headers, www] of [[{ client_id: "https://nobody.example/c" }, {}, null], [{ client_id: P.app.client_id }, {}, null], [{ client_id: P.app.client_id }, { Authorization: "Basic eA==" }, "Basic"]]) {
    const r = await revoke(w, { token: s.refresh, ...auth }, headers);
    assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }]);
    assert.equal(r.headers.get("WWW-Authenticate"), www);
  }
  assert.equal(signins(w).length, 1, "nothing revoked");
  const get = await read(revokeRoute(w.rc("GET", "/api/oauth/revoke")));
  assert.deepEqual([get.status, get.json.error, get.headers.get("Allow")], [405, "invalid_request", "POST"]);
  w.harness(OAUTH_QUOTA_ROOM).room.setTestAgentLimits({ per_ip: 3 });
  assert.deepEqual((await revoke(w, { token: ".ar1.x", ...(await clientAuth(P.app, P.es)) })).json, {}, "those three took no place: an assertion is still checked");
  // three assertions that fail their signature check (a key of the same kid the app does not hold) fill the app's counter
  const wrong = await keyPair("ES256", P.es.jwk.kid);
  for (let i = 0; i < 3; i++) assert.equal((await revoke(w, { token: s.refresh, ...(await clientAuth(P.app, wrong)) })).status, 401);
  const full = await revoke(w, { token: s.refresh, ...(await clientAuth(P.app, P.es)) });
  assert.deepEqual([full.status, full.json.error], [429, "slow_down"], "the failed checks counted");
  assert.equal(signins(w).length, 1, "nothing revoked");
  w.harness(OAUTH_QUOTA_ROOM).room.setTestAgentLimits(null);
  assert.deepEqual((await revoke(w, { token: s.refresh, ...(await clientAuth(P.app, P.es)) })).json, {});
  assert.deepEqual(signins(w), []);
});

test("a revoke lets go of the sign-in's Muse wakes; a wake another holder also holds stays on", async () => {
  const m = await museSignIn(["lima", "oslo"]);
  try {
    assert.equal(m.reg.json.result.structuredContent.results.every((x) => x.ok), true);
    // another holder (the member's own registration) beside it on oslo's link
    const tok = m.w.harness("oslo").one("SELECT token FROM inv WHERE name = 'Scout'").token;
    assert.ok(m.w.harness("oslo").room.museSetHook(tok, m.g.link, "main", "oslo").ok);
    const r = await revoke(m.w, { token: m.s.refresh, client_id: PUBLIC_APP.client_id });
    assert.deepEqual(r.json, {});
    await Promise.all(m.w.pending);
    assert.equal(hookOf(m.w, "lima"), null, "lima's wake went: its last holder let go");
    assert.deepEqual([hookOf(m.w, "oslo").link, holdersOf(m.w, "oslo")], [m.g.link, ["self"]], "oslo's stays, held by self");
    assert.deepEqual(signins(m.w), []);
  } finally {
    m.b.restore();
  }
});

/** the room made not to answer the sign-in's look and drop (they throw), and back */
const unreachable = (w, room) => { const r = w.harness(room).room; r.museHolderLook = () => { throw new Error("the room did not answer"); }; r.museHolderDrop = () => { throw new Error("the room did not answer"); }; return () => { delete r.museHolderLook; delete r.museHolderDrop; }; };

test("a remainder: the rooms that did not confirm stay on the cut sign-in's wake list (logged with a count), and any of its credentials presented later finishes it: the refresh token at the token endpoint, the code, the disconnect code, a revoke", async () => {
  for (const by of ["refresh token", "code", "disconnect code", "revoke"]) {
    const m = await museSignIn(["lima", "oslo"]);
    try {
      const back = unreachable(m.w, "oslo");
      resetWarnings();
      const lines = [], real = console.warn;
      console.warn = (s) => { try { lines.push(JSON.parse(s)); } catch { lines.push(s); } };
      let first;
      try { first = await disconnect(m.w, { code: m.s.disconnectCode }); } finally { console.warn = real; }
      assert.deepEqual(first.json, { disconnected: true, wakes_left: ["oslo"], note: signinDropNote(["oslo"]) }, by);
      assert.ok(lines.some((l) => l.warn === "agent.drop" && l.left === 1), "logged with a count, no room");
      assert.ok(!JSON.stringify(lines).includes("oslo"));
      assert.equal(hookOf(m.w, "lima"), null);
      assert.equal(hookOf(m.w, "oslo").link, m.g.link, "oslo's wake on: not confirmed");
      assert.equal(signins(m.w).length, 1, "the cut sign-in kept for its remainder");
      assert.equal((await signin(m.w, m.s.access, toolCall("list_rooms"))).status, 401, "cut: it works nowhere");
      back();
      let r;
      if (by === "refresh token") r = await refreshOf(m.w, m.s.refresh, { client_id: PUBLIC_APP.client_id });
      else if (by === "code") r = await token(m.w, { grant_type: "authorization_code", code: m.s.code, code_verifier: m.s.verifier, redirect_uri: new URLSearchParams(m.s.query).get("redirect_uri"), resource: ADDRESS, client_id: PUBLIC_APP.client_id });
      else if (by === "disconnect code") r = await disconnect(m.w, { code: m.s.disconnectCode });
      else r = await revoke(m.w, { token: m.s.refresh, client_id: PUBLIC_APP.client_id });
      await Promise.all(m.w.pending);
      if (by === "disconnect code") assert.deepEqual(r.json, { disconnected: true, wakes_left: [], note: signinDropNote([]) });
      else if (by === "revoke") assert.deepEqual(r.json, {});
      else assert.deepEqual(r.json, { error: "invalid_grant" }, by);
      assert.equal(hookOf(m.w, "oslo"), null, by + ": the remainder finished");
      assert.deepEqual(signins(m.w), [], by + ": the sign-in gone");
    } finally {
      m.b.restore();
    }
  }
});

/** a sign-in's slots as its object stores them: each kind, and whether it holds a wrapped key */
const slotsOf = (w) => { const [id] = signins(w); return w.harness(id).all("SELECT kind, wrapped FROM aks ORDER BY kind").map((r) => [r.kind, r.wrapped !== null]); };

test("a cut sign-in keeps no data key: after a disconnect that leaves wakes behind, or one that ends busy, only the disconnect slot holds a wrapped key (its wake key), and the disconnect is still finished by the refresh token, an access token at revoke, or the disconnect code", async () => {
  for (const end of ["remainder", "busy"]) {
    for (const by of ["refresh token", "access token at revoke", "disconnect code"]) {
      const m = await museSignIn(["lima"]);
      try {
        assert.deepEqual(slotsOf(m.w), [["access", true], ["code", false], ["disconnect", true], ["refresh", true]], "before: the access and refresh slots wrap the data key");
        const back = unreachable(m.w, "lima");
        assert.deepEqual((await disconnect(m.w, { code: m.s.disconnectCode })).json.wakes_left, ["lima"]);
        back();
        if (end === "busy") {
          // a second disconnect whose every write meets a moved list ends busy
          const [id] = signins(m.w);
          const obj = m.w.harness(id).room, realDrop = obj.signinDrop.bind(obj);
          const stale = async () => ({ ok: false, code: "stale" });
          obj.signinDrop = (...a) => (a.length > 2 && a[2] !== undefined ? stale() : realDrop(...a));
          obj.signinRemain = stale;
          assert.deepEqual((await disconnect(m.w, { code: m.s.disconnectCode })).json.note, signinDropNote(["lima"], true));
          delete obj.signinDrop;
          delete obj.signinRemain;
        }
        assert.deepEqual(slotsOf(m.w), [["access", false], ["code", false], ["disconnect", true], ["refresh", false]], end + ": no slot opens the room list");
        let r;
        if (by === "refresh token") r = await refreshOf(m.w, m.s.refresh, { client_id: PUBLIC_APP.client_id });
        else if (by === "access token at revoke") r = await revoke(m.w, { token: m.s.access, client_id: PUBLIC_APP.client_id });
        else r = await disconnect(m.w, { code: m.s.disconnectCode });
        await Promise.all(m.w.pending);
        assert.ok(r.status === 200 || r.status === 400, by + ": " + r.text);
        assert.equal(hookOf(m.w, "lima"), null, end + ", " + by + ": the remainder finished");
        assert.deepEqual(signins(m.w), [], end + ", " + by + ": the sign-in gone");
      } finally {
        m.b.restore();
      }
    }
  }
});

test("busy: two disconnects of one sign-in keep moving its list; the last cut tells a complete disconnect (record gone) from busy, and each start answers busy its own way", async () => {
  for (const by of ["disconnect code", "revoke", "token"]) {
    for (const end of ["busy", "complete"]) {
      const m = await museSignIn(["lima"]);
      try {
        const back = unreachable(m.w, "lima");
        assert.deepEqual((await disconnect(m.w, { code: m.s.disconnectCode })).json.wakes_left, ["lima"]);
        back();
        // every write this disconnect makes meets a list another disconnect moved; for complete, the last one deleted it
        const [id] = signins(m.w);
        const obj = m.w.harness(id).room, realDrop = obj.signinDrop.bind(obj);
        let writes = 0;
        const stale = async (...a) => {
          writes++;
          if (end === "complete" && writes === AGENT_SWAP_TRIES) await realDrop(a[0], a[1]);
          return { ok: false, code: "stale" };
        };
        obj.signinDrop = (...a) => (a.length > 2 && a[2] !== undefined ? stale(...a) : realDrop(...a));
        obj.signinRemain = stale;
        let r;
        if (by === "disconnect code") r = await disconnect(m.w, { code: m.s.disconnectCode });
        else if (by === "revoke") r = await revoke(m.w, { token: m.s.refresh, client_id: PUBLIC_APP.client_id });
        else r = await refreshOf(m.w, m.s.refresh, { client_id: PUBLIC_APP.client_id });
        delete obj.signinDrop;
        delete obj.signinRemain;
        assert.equal(writes, AGENT_SWAP_TRIES, by + " " + end + ": every try wrote");
        if (by === "disconnect code") assert.deepEqual(r.json, end === "busy" ? { disconnected: true, wakes_left: ["lima"], note: signinDropNote(["lima"], true) } : { disconnected: true, wakes_left: [], note: signinDropNote([]) }, end);
        else if (by === "revoke") assert.deepEqual([r.status, r.json], [200, {}], end);
        else assert.deepEqual([r.status, r.json], [400, { error: "invalid_grant" }], end);
      } finally {
        m.b.restore();
      }
    }
  }
});

test("an unreadable wake list: the cut sign-in deleted with signinDrop and no version, and the answer says its wakes could not be let go of", async () => {
  const m = await museSignIn(["lima"]);
  try {
    const [id] = signins(m.w);
    m.w.harness(id).db.prepare("UPDATE ak SET wakes = 'not-sealed'").run();
    const mark = m.w.asked.length;
    const r = await disconnect(m.w, { code: m.s.disconnectCode });
    assert.deepEqual(r.json, { disconnected: true, wakes_left: null, note: signinDropNote(null) });
    const drop = m.w.asked.slice(mark).find((a) => a.method === "signinDrop");
    assert.equal(drop.args.length, 2, "no version");
    assert.deepEqual(signins(m.w), []);
    assert.equal(hookOf(m.w, "lima").link, m.g.link, "its wake stays on: the gadget's Disconnect stops it");
  } finally {
    m.b.restore();
  }
});

import { slotUnwrap, agentOpenRing, agentUnsealWakes } from "../../worker/lib/agentkey.ts";
import { parseSigninToken } from "../../worker/lib/oauth.ts";
test("the disconnect-only code opens the wake list only: it cannot unwrap the data key any slot holds, and its wake key opens no room list", async () => {
  const m = await museSignIn(["lima"]);
  try {
    const t = parseSigninToken(m.s.disconnectCode);
    const h = m.w.harness("__agent-" + t.id);
    const slots = h.all("SELECT slot, kind, wrapped, bind FROM aks");
    const mine = slots.find((x) => x.kind === "disconnect");
    const wk = await slotUnwrap(t.id, t.slot, "disconnect", t.secret, mine.wrapped);
    assert.equal(wk.length, 32, "its own slot wraps the wake key");
    const a = h.one("SELECT ver, ring, wakes FROM ak");
    assert.ok(Array.isArray(await agentUnsealWakes(wk, t.id, a.ver, a.wakes)), "which opens the wake list");
    assert.equal(await agentOpenRing(wk, t.id, a.ver, a.ring), null, "and no room list");
    for (const s of slots.filter((x) => x.kind !== "disconnect")) {
      for (const kind of ["disconnect", s.kind]) assert.equal(await slotUnwrap(t.id, s.slot, kind, t.secret, s.wrapped), null, s.kind + ": its data key does not open with the disconnect code");
    }
    assert.ok(!JSON.stringify(slots.find((x) => x.kind === "disconnect")).includes(m.s.disconnectCode.split(".")[4]), "the code's secret is not stored");
  } finally {
    m.b.restore();
  }
});
