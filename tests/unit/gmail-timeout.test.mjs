// Every call to Google's mail endpoints carries a time limit
// (worker/platform/gmail.ts, MAIL_FETCH_MS): with none, a hung call held a
// new room's creation, its invite and its caller for as long as the
// platform let the request live.
import test from "node:test";
import assert from "node:assert/strict";
import { gmailCache, sendViaGmail } from "../../worker/platform/gmail.ts";

test("the token call and the send call both go out with an abort signal, and one that times out fails the send", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = "-----BEGIN PRIVATE KEY-----\n" + Buffer.from(der).toString("base64") + "\n-----END PRIVATE KEY-----\n";
  const env = { GMAIL_SA: JSON.stringify({ client_email: "sa@example.iam", private_key: pem }), GMAIL_SENDER: "rooms@example.org" };
  Object.assign(gmailCache, { email: null, sender: null, key: null, token: null, exp: 0 });
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), signal: init && init.signal });
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    // the send hangs: its time limit runs out (as the signal would throw)
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  try {
    const sent = await sendViaGmail(env, "ada@example.com", "s", "t", "<p>t</p>");
    assert.equal(sent, false, "a send that runs out of time is a failed send");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 2);
  for (const s of seen) assert.ok(s.signal instanceof AbortSignal, s.url + " has no signal");
});

test("the genesis mail's Subject is fixed and its only caller-written text is the room's name", async () => {
  const { sendGenesisEmail } = await import("../../worker/routes/rooms.ts");
  Object.assign(gmailCache, { email: "sa@example.iam", sender: "rooms@example.org", key: null, token: "tok", exp: Math.floor(Date.now() / 1000) + 3600 });
  const env = { GMAIL_SA: JSON.stringify({ client_email: "sa@example.iam", private_key: "x" }), GMAIL_SENDER: "rooms@example.org" };
  let raw = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString(); return new Response("{}", { status: 200 }); };
  try {
    assert.equal(await sendGenesisEmail(env, "ada@example.com", "account-locked-verify-now", "https://chat.example/r/x#invite=t"), true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(raw, /^Subject: Your Agent Chat room is ready\r$/m);
  assert.match(raw, /^To: ada@example\.com\r$/m);
  const bodies = raw.split(/\r\n\r\n/).slice(1).map((b) => Buffer.from(b.split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString()).join("\n");
  assert.match(bodies, /account-locked-verify-now/, "the room's name is in the body");
  assert.doesNotMatch(raw.split("\r\n\r\n")[0], /account-locked/, "and not in a header");
});
