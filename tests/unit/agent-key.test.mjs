// The agent key's credential and the sealing of its list
// (worker/lib/agentkey.ts): what agentCredential makes of every value a
// request can carry, a key's form, the two derivations of its secret, and
// the list sealed and opened again, bound to its identity, its slot and its
// version, padded, and logged with no text when it does not open. Keys and
// tokens are made here; no real one is used. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_KEY_RE, AGENT_UNREADABLE, agentCredential, agentDataKey, agentSealRing, agentUnseal, agentVerifier, newAgentKey } from "../../worker/lib/agentkey.ts";
import { AGENT_RING_PAD } from "../../worker/limits.ts";
import { b64urlDecode, b64urlEncode, hkdf } from "../../worker/lib/crypto.ts";
import { resetWarnings } from "../../worker/lib/log.ts";

const req = (headers) => new Request("http://localhost/api/mcp", { method: "POST", headers });
/** the room harness's kind of invite token: 18 random bytes, base64 with +/ as -_ */
const inviteToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_");

test("agentCredential: none, a room invite token, a key, anything else that starts with a dot", () => {
  const k = newAgentKey();
  assert.deepEqual(agentCredential(req({})), { kind: "none" });
  assert.deepEqual(agentCredential(req({ Authorization: "Basic abc" })), { kind: "none" }, "another scheme is no bearer value");
  assert.deepEqual(agentCredential(req({ Authorization: "Bearer" })), { kind: "none" });
  const tok = inviteToken();
  assert.deepEqual(agentCredential(req({ Authorization: "Bearer " + tok })), { kind: "invite" });
  // an invite token in X-Invite-Token only: the agent routes never read that header
  assert.deepEqual(agentCredential(req({ "X-Invite-Token": tok })), { kind: "none" });
  assert.deepEqual(agentCredential(req({ "X-Invite-Token": k.key })), { kind: "none" }, "nor a key there");
  // nor the owner key
  assert.deepEqual(agentCredential(req({ "X-Owner-Key": "some-owner-key" })), { kind: "none" });
  const got = agentCredential(req({ Authorization: "Bearer " + k.key }));
  assert.equal(got.kind, "key");
  assert.equal(got.id, k.id);
  assert.deepEqual([...got.secret], [...k.secret]);
  assert.equal(agentCredential(req({ Authorization: "bearer  " + k.key + "  " })).kind, "key", "the scheme in any case, spaces around");
  for (const bad of [".", ".ac1.", ".ao1." + k.id + "." + b64urlEncode(k.secret), ".ac2." + k.id + "." + b64urlEncode(k.secret), k.key + "x", k.key.slice(0, -1), ".ac1." + k.id + "x." + b64urlEncode(k.secret).slice(1), ".oc1.x.y.z", ".ar1.x", ".ad1.x"]) {
    assert.deepEqual(agentCredential(req({ Authorization: "Bearer " + bad })), { kind: "bad" }, bad.slice(0, 12));
  }
  // one key has one spelling: a last character whose spare bits are set decodes to the same bytes, and is refused
  const last = k.key.slice(-1), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const twin = k.key.slice(0, -1) + alphabet[(alphabet.indexOf(last) & ~3) | ((alphabet.indexOf(last) & 3) ^ 1)];
  assert.notEqual(twin, k.key);
  assert.deepEqual(agentCredential(req({ Authorization: "Bearer " + twin })), { kind: "bad" });
});

test("a key is 71 characters, starts with a dot, and round-trips; no invite token can look like one", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const k = newAgentKey();
    assert.equal(k.key.length, 71);
    assert.match(k.key, AGENT_KEY_RE);
    assert.equal(k.key.charAt(0), ".");
    assert.equal(b64urlDecode(k.id).length, 16);
    assert.equal(k.secret.length, 32);
    assert.equal(k.key, ".ac1." + k.id + "." + b64urlEncode(k.secret));
    assert.ok(!seen.has(k.id));
    seen.add(k.id);
  }
  for (let i = 0; i < 200; i++) assert.equal(agentCredential(req({ Authorization: "Bearer " + inviteToken() })).kind, "invite");
});

test("the verifier and the wrapping key are two independent derivations", async () => {
  const k = newAgentKey();
  const enc = new TextEncoder();
  const verifier = await agentVerifier(k.id, k.secret);
  assert.match(verifier, /^[0-9a-f]{64}$/);
  assert.equal(verifier, await agentVerifier(k.id, k.secret), "the same every time");
  const kek = await hkdf(k.secret, enc.encode(k.id + "|key"), enc.encode("agent-chat key wrap v1"), 32);
  assert.notEqual(Buffer.from(kek).toString("hex"), verifier);
  const want = await hkdf(k.secret, enc.encode(k.id + "|key"), enc.encode("agent-chat key verify v1"), 32);
  assert.equal(Buffer.from(want).toString("hex"), verifier, "HKDF-SHA256 with the id's salt and the verify label");
  assert.notEqual(await agentVerifier(newAgentKey().id, k.secret), verifier, "the id is in the salt");
});

const ROOMS = [{ room: "lima", token: "tok-lima-0123456789abcd", name: "Hank", added: 1, state: "held" }, { room: "oslo", token: "tok-oslo-0123456789abcd", name: "Hänk", added: 2, state: "refused", code: "invite_revoked", at: 3 }];

test("the data key wraps and the list seals, and both open again", async () => {
  const k = newAgentKey();
  const { dk, wrapped } = await agentDataKey(k.id, k.secret);
  assert.equal(dk.length, 32);
  const ring = await agentSealRing(dk, k.id, 1, ROOMS);
  const u = await agentUnseal(k.id, k.secret, wrapped, 1, ring);
  assert.deepEqual([...u.dk], [...dk]);
  assert.deepEqual(u.rooms, ROOMS);
  // sealed bytes: the IV, then the padded text and its tag
  assert.equal(b64urlDecode(ring).length, 12 + AGENT_RING_PAD + 16, "one pad's worth for two rooms");
  assert.ok(!Buffer.from(b64urlDecode(ring)).toString("latin1").includes("lima"), "no room name in the clear");
  // a second seal of the same list is new bytes (a fresh IV)
  assert.notEqual(await agentSealRing(dk, k.id, 1, ROOMS), ring);
});

test("the list is padded with spaces to a multiple of AGENT_RING_PAD bytes", async () => {
  const k = newAgentKey();
  const { dk } = await agentDataKey(k.id, k.secret);
  const sizes = new Set();
  for (const n of [0, 1, 5, 9, 30, 50]) {
    const rooms = Array.from({ length: n }, (_, i) => ({ room: "room-" + i, token: inviteToken(), name: "Agent " + i, added: Date.now(), state: "held" }));
    const len = b64urlDecode(await agentSealRing(dk, k.id, 1, rooms)).length - 28;
    assert.equal(len % AGENT_RING_PAD, 0, n + " rooms: " + len);
    assert.ok(len >= new TextEncoder().encode(JSON.stringify({ v: 1, rooms })).length);
    sizes.add(len);
  }
  assert.ok(sizes.size < 6, "lists of nearby sizes share one padded size");
});

test("the additional data refuses another version, another slot and another identity", async () => {
  const k = newAgentKey(), other = newAgentKey();
  const { dk, wrapped } = await agentDataKey(k.id, k.secret);
  const ring = await agentSealRing(dk, k.id, 4, ROOMS);
  resetWarnings();
  assert.ok(await agentUnseal(k.id, k.secret, wrapped, 4, ring), "its own version opens");
  assert.equal(await agentUnseal(k.id, k.secret, wrapped, 5, ring), null, "another version");
  assert.equal(await agentUnseal(k.id, k.secret, wrapped, 3, ring), null, "an older version");
  // the same secret under another id: the derivations and the slot's additional data differ
  assert.equal(await agentUnseal(other.id, k.secret, wrapped, 4, ring), null, "another identity's id");
  // a slot wrapped for another identity, put in this one's place
  const theirs = await agentDataKey(other.id, other.secret);
  assert.equal(await agentUnseal(k.id, k.secret, theirs.wrapped, 4, ring), null, "another identity's slot");
  // a list sealed for another identity with this data key
  assert.equal(await agentUnseal(k.id, k.secret, wrapped, 4, await agentSealRing(dk, other.id, 4, ROOMS)), null, "another identity's list");
  // the slot's own additional data names the key's slot: the same bytes under another slot's do not open
  const enc = new TextEncoder();
  const kek = await hkdf(k.secret, enc.encode(k.id + "|key"), enc.encode("agent-chat key wrap v1"), 32);
  const key = await crypto.subtle.importKey("raw", kek, "AES-GCM", false, ["encrypt", "decrypt"]);
  const b = b64urlDecode(wrapped);
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: enc.encode("slot|" + k.id + "|access|access") }, key, b.subarray(12)));
  assert.ok(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: enc.encode("slot|" + k.id + "|key|key") }, key, b.subarray(12)));
  assert.equal(await agentUnseal(k.id, newAgentKey().secret, wrapped, 4, ring), null, "another secret");
});

test("a list that does not open is logged agent.unseal with no error text and no ids, and refused agent_unreadable", async () => {
  const k = newAgentKey();
  const { dk, wrapped } = await agentDataKey(k.id, k.secret);
  const ring = await agentSealRing(dk, k.id, 1, ROOMS);
  const lines = [];
  const warnWas = console.warn;
  console.warn = (s) => lines.push(String(s));
  try {
    for (const [what, w, r] of [["a corrupted list", wrapped, ring.slice(0, -4) + "AAAA"], ["no wrapped key", null, ring], ["a wrapped key that is no base64", "!!!", ring], ["a list that is no JSON", wrapped, await sealText(dk, k.id, 1, "{not json " + ROOMS[0].token)]]) {
      resetWarnings();
      lines.length = 0;
      assert.equal(await agentUnseal(k.id, k.secret, w, 1, r), null, what);
      assert.equal(lines.length, 1, what + ": one line");
      assert.deepEqual(JSON.parse(lines[0]), { warn: "agent.unseal", error: null }, what);
      assert.ok(!lines[0].includes(k.id) && !lines[0].includes("tok-"), what + ": no id, no token");
    }
  } finally { console.warn = warnWas; }
  assert.equal(AGENT_UNREADABLE, "This key's record could not be read.");
});

/** text sealed as a list is (what a list that is not JSON would look like) */
async function sealText(dk, id, ver, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", dk, "AES-GCM", false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("ring|" + id + "|" + ver) }, key, enc.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64urlEncode(out);
}
