// Room methods: Web Push - the site's VAPID keypair (on the __vapid object), members' subscriptions, notifications.

import { b64urlDecode, b64urlEncode, concatBytes } from "../lib/crypto.js";
import { sendWebPush, vapidSubject } from "../platform/webpush.js";
import { PUSH_FAIL_MAX, PUSH_FAIL_MS, PUSH_MAX_PER_MEMBER, PUSH_PARALLEL } from "../limits.js";
import { mentionsName } from "../lib/text.js";
import { streamWants } from "./state.js";
import type { ApiMessage } from "./messages.js";
import type { InvRow, PushRow, Room } from "./Room.js";
import { warn } from "../lib/log.js";

/** The site's VAPID keypair (the meta row "vapid" on the __vapid object):
 *  the private key as a JWK and the public key in base64url. */
export type VapidRecord = { jwk: JsonWebKey, pub: string };

export const PushMethods = {
  // ---- Web Push: VAPID identity (only ever used on the __vapid instance) ----
  async vapidRecord(): Promise<VapidRecord> {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    const got = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'vapid'").toArray()[0];
    if (got) return JSON.parse(got.v);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = b64urlEncode(concatBytes(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)));
    const rec = { jwk: jwk, pub: pub };
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('vapid', ?)", JSON.stringify(rec));
    return JSON.parse(this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'vapid'").toArray()[0].v);
  },
  async vapidPublic() { return (await this.vapidRecord()).pub; },
  /** @param aud the push service's origin */
  async vapidAuth(aud: string) {
    const rec = await this.vapidRecord();
    const key = await crypto.subtle.importKey("jwk", rec.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const enc = new TextEncoder();
    const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: vapidSubject(this.env) })));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
    return "vapid t=" + head + "." + claims + "." + b64urlEncode(new Uint8Array(sig)) + ", k=" + rec.pub;
  },

  // ---- Web Push: subscriptions and fan-out ----
  // The member comes from the invite, looked up in this call: a
  // registration is a standing credential for the room's text, so it is
  // written only for an invite that is active as it is written (see
  // inviteStill, room/members.ts). The owner key registers under "".
  /** @param mode "mentions" or "all" */
  pushSubscribe(token: string | null | undefined, owner: boolean, sub: Pick<PushRow, "endpoint" | "p256dh" | "auth">, mode: string) {
    let who = "";
    if (!owner) {
      const l = this.lookupInvite(token);
      if (!l.ok) return l;
      who = String(l.row.name || "").toLowerCase();
    }
    this.sql.exec("INSERT OR REPLACE INTO push (member, endpoint, p256dh, auth, ts, mode) VALUES (?, ?, ?, ?, ?, ?)",
      who, sub.endpoint, sub.p256dh, sub.auth, Date.now(), mode === "mentions" ? "mentions" : "all");
    // Each registration costs a signed request per message: keep a
    // member's newest PUSH_MAX_PER_MEMBER and drop the rest.
    this.sql.exec("DELETE FROM push WHERE member = ? AND endpoint NOT IN (SELECT endpoint FROM push WHERE member = ? ORDER BY ts DESC LIMIT ?)", who, who, PUSH_MAX_PER_MEMBER);
    return { status: 200 };
  },
  pushUnsubscribe(member: string, endpoint: string, owner: boolean) {
    if (owner) this.sql.exec("DELETE FROM push WHERE endpoint = ?", endpoint);
    else this.sql.exec("DELETE FROM push WHERE endpoint = ? AND member = ?", endpoint, String(member || "").toLowerCase());
    return { status: 200 };
  },
  pushStatus(member: string, endpoint: string) {
    const rows = this.sql.exec<Pick<PushRow, "endpoint" | "mode">>("SELECT endpoint, mode FROM push WHERE member = ?", String(member || "").toLowerCase()).toArray();
    const mine = endpoint ? rows.find((r) => r.endpoint === endpoint) : null;
    return { count: rows.length, registered: !!mine, mode: mine ? (mine.mode || "all") : null };
  },
  async notifyPush(msg: ApiMessage, room: string | null) {
    const sender = String(msg.from || "").toLowerCase();
    const text = String(msg.text || "").trim();
    const excerpt = text ? (text.length > 120 ? text.slice(0, 117) + "..." : text) : "(attachment)";
    const payload = JSON.stringify({ title: msg.from + " - Agent Chat", body: excerpt, url: "/r/" + room, tag: "room-" + room });
    // Only the owner ("") and members with an active invite hear about a
    // message: revoke() drops a leaving member's registrations, and this
    // keeps any that slipped through (older rows) from leaking text.
    const active = new Set(this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE revoked IS NULL").toArray().map((r) => String(r.name).toLowerCase()));
    const allowed = (m: string) => m === "" || active.has(m);
    // Web push (browser subscriptions).
    const rows = this.sql.exec<Pick<PushRow, "member" | "endpoint" | "p256dh" | "auth" | "mode" | "fails">>("SELECT member, endpoint, p256dh, auth, mode, fails FROM push WHERE member != ?", sender).toArray();
    const targets = rows.filter((r) => allowed(r.member) && ((r.mode || "all") !== "mentions" || mentionsName(msg.text, r.member)));
    // The targets are fixed here, but the sends take a while: each is
    // checked again just before it leaves. A member removed meanwhile has
    // no push rows left (revoke, revokeAll and a re-issued name drop
    // them), and a deleted message has no row in m. Without this the
    // fan-out went on sending the text to members revoked while it ran,
    // and a message deleted at once still reached every phone after DELETE
    // had answered.
    const wanted = (r: Pick<PushRow, "member" | "endpoint" | "p256dh" | "auth">) => () =>
      this.sql.exec("SELECT 1 FROM m WHERE id = ?", msg.id).toArray().length > 0 &&
      this.sql.exec("SELECT 1 FROM push WHERE endpoint = ? AND member = ? AND p256dh = ? AND auth = ?", r.endpoint, r.member, r.p256dh, r.auth).toArray().length > 0;
    // PUSH_PARALLEL sends at a time, each taking the next target when it
    // is done (sendWebPush times every send out).
    let next = 0;
    const lane = async () => {
      while (next < targets.length) {
        const r = targets[next++]!;
        try {
          const status = await sendWebPush(this.env, r, payload, wanted(r));
          if (status === null) continue;
          if (status === 404 || status === 410) { this.sql.exec("DELETE FROM push WHERE endpoint = ?", r.endpoint); continue; }
          if (status < 300) {
            if (r.fails) this.sql.exec("UPDATE push SET fails = NULL, fail_ts = NULL WHERE endpoint = ? AND member = ?", r.endpoint, r.member);
            continue;
          }
          warn("push.send", "HTTP " + status, { room });
        } catch (e) {
          // the error's name only: a fetch error's message can quote the endpoint
          warn("push.send", e instanceof Error ? e.name : "Error", { room });
        }
        this.pushFailed(r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_PARALLEL, targets.length) }, lane));
  },

  // A send that failed (an error, a timeout, any answer but 2xx, 404 or
  // 410). The streak is counted on the row, and a row that has failed
  // every send for PUSH_FAIL_MS and at least PUSH_FAIL_MAX times is
  // dropped: a junk or long-dead registration, not an outage.
  pushFailed(r: Pick<PushRow, "member" | "endpoint">) {
    const now = Date.now();
    this.sql.exec("UPDATE push SET fails = COALESCE(fails, 0) + 1, fail_ts = COALESCE(fail_ts, ?) WHERE endpoint = ? AND member = ?", now, r.endpoint, r.member);
    this.sql.exec("DELETE FROM push WHERE endpoint = ? AND fails >= ? AND fail_ts <= ?", r.endpoint, PUSH_FAIL_MAX, now - PUSH_FAIL_MS);
  },

  notifyMembers(name: string | null | undefined) {
    const frame = "event: members\ndata: " + JSON.stringify({ type: "members", room: this.roomName || null, from: name || null, kind: this.memberKind(name), targets: [] }) + "\n\n";
    for (const c of this.clients) { if (streamWants(c, "members")) c.send(frame); }
    this.emitState();
  },

  dropPush(name: string) {
    const member = String(name || "").toLowerCase();
    this.sql.exec("DELETE FROM push WHERE member = ?", member);
  },
} satisfies ThisType<Room>;
