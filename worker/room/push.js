// Room methods: Web Push - the site's VAPID keypair (on the __vapid object), members' subscriptions, notifications.

import { b64urlDecode, b64urlEncode, concatBytes } from "../lib/crypto.js";
import { sendWebPush, vapidSubject } from "../platform/webpush.js";
import { PUSH_MAX_PER_MEMBER } from "../limits.js";
import { mentionsName } from "../lib/text.js";
import { streamWants } from "./state.js";

export const PushMethods = {
  // ---- Web Push: VAPID identity (only ever used on the __vapid instance) ----
  async vapidRecord() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    const got = this.sql.exec("SELECT v FROM meta WHERE k = 'vapid'").toArray()[0];
    if (got) return JSON.parse(got.v);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = b64urlEncode(concatBytes(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)));
    const rec = { jwk: jwk, pub: pub };
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('vapid', ?)", JSON.stringify(rec));
    return JSON.parse(this.sql.exec("SELECT v FROM meta WHERE k = 'vapid'").toArray()[0].v);
  },
  async vapidPublic() { return (await this.vapidRecord()).pub; },
  async vapidAuth(aud) {
    const rec = await this.vapidRecord();
    const key = await crypto.subtle.importKey("jwk", rec.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const enc = new TextEncoder();
    const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: vapidSubject(this.env) })));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
    return "vapid t=" + head + "." + claims + "." + b64urlEncode(new Uint8Array(sig)) + ", k=" + rec.pub;
  },

  // ---- Web Push: subscriptions and fan-out ----
  pushSubscribe(member, sub, mode) {
    const who = String(member || "").toLowerCase();
    this.sql.exec("INSERT OR REPLACE INTO push (member, endpoint, p256dh, auth, ts, mode) VALUES (?, ?, ?, ?, ?, ?)",
      who, sub.endpoint, sub.p256dh, sub.auth, Date.now(), mode === "mentions" ? "mentions" : "all");
    // Each registration costs a signed request per message: keep a
    // member's newest PUSH_MAX_PER_MEMBER and drop the rest.
    this.sql.exec("DELETE FROM push WHERE member = ? AND endpoint NOT IN (SELECT endpoint FROM push WHERE member = ? ORDER BY ts DESC LIMIT ?)", who, who, PUSH_MAX_PER_MEMBER);
    return { status: 200 };
  },
  pushUnsubscribe(member, endpoint, owner) {
    if (owner) this.sql.exec("DELETE FROM push WHERE endpoint = ?", endpoint);
    else this.sql.exec("DELETE FROM push WHERE endpoint = ? AND member = ?", endpoint, String(member || "").toLowerCase());
    return { status: 200 };
  },
  pushStatus(member, endpoint) {
    const rows = this.sql.exec("SELECT endpoint, mode FROM push WHERE member = ?", String(member || "").toLowerCase()).toArray();
    const mine = endpoint ? rows.find((r) => r.endpoint === endpoint) : null;
    return { count: rows.length, registered: !!mine, mode: mine ? (mine.mode || "all") : null };
  },
  async notifyPush(msg, room) {
    const sender = String(msg.from || "").toLowerCase();
    const text = String(msg.text || "").trim();
    const excerpt = text ? (text.length > 120 ? text.slice(0, 117) + "..." : text) : "(attachment)";
    const payload = JSON.stringify({ title: msg.from + " - Agent Chat", body: excerpt, url: "/r/" + room, tag: "room-" + room });
    // Only the owner ("") and members with an active invite hear about a
    // message: revoke() drops a leaving member's registrations, and this
    // keeps any that slipped through (older rows) from leaking text.
    const active = new Set(this.sql.exec("SELECT name FROM inv WHERE revoked IS NULL").toArray().map((r) => String(r.name).toLowerCase()));
    const allowed = (m) => m === "" || active.has(m);
    // Web push (browser subscriptions).
    const rows = this.sql.exec("SELECT member, endpoint, p256dh, auth, mode FROM push").toArray();
    const targets = rows.filter((r) => allowed(r.member) && r.member !== sender && ((r.mode || "all") !== "mentions" || mentionsName(msg.text, r.member)));
    for (const r of targets) {
      try {
        const status = await sendWebPush(this.env, r, payload);
        if (status === 404 || status === 410) this.sql.exec("DELETE FROM push WHERE endpoint = ?", r.endpoint);
      } catch (e) {}
    }
  },

  notifyMembers(name) {
    const frame = "event: members\ndata: " + JSON.stringify({ type: "members", room: this.roomName || null, from: name || null, kind: this.memberKind(name), targets: [] }) + "\n\n";
    for (const c of this.clients) { if (streamWants(c, "members")) c.send(frame); }
    this.emitState();
  },

  dropPush(name) {
    const member = String(name || "").toLowerCase();
    this.sql.exec("DELETE FROM push WHERE member = ?", member);
  },
};
