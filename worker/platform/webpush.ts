// Web Push: the VAPID subject, payload encryption (RFC 8291) and delivery.
// (The keypair and the JWT signing are Room methods in room/push.js:
// vapidRecord, vapidAuth, on the __vapid object.)

import { b64urlDecode, concatBytes, hkdf } from "../lib/crypto.js";

// VAPID (RFC 8292): one keypair for the whole site, generated on first use and kept by a
// dedicated Durable Object instance named __vapid; the private half never
// leaves it - it signs inside that object and hands back only the header.
// The JWT's subject is the operator contact push services may use: the
// site's own mailbox (GMAIL_SENDER, a [vars] entry), never a personal
// address in the code. RFC 8292 also accepts an https: URL, the fallback.
// Changing it doesn't touch subscriptions (they're bound to the key).
export function vapidSubject(env: Env | null | undefined) {
  return env && env.GMAIL_SENDER ? "mailto:" + env.GMAIL_SENDER : "https://chat.victorio.cloud";
}

// aes128gcm body for one subscription: header (salt, record size, ephemeral
// public key) followed by the single encrypted record.
/**
 * @param p256dh the subscription's public key (base64url)
 * @param auth its auth secret (base64url)
 */
export async function encryptPushPayload(p256dh: string, auth: string, payloadText: string) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const ikm = await hkdf(shared, authSecret, concatBytes(enc.encode("WebPush: info\u0000"), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\u0000"), 12);
  const plain = concatBytes(enc.encode(payloadText), new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, plain));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concatBytes(header, asPublic, ct);
}

/** @returns the push service's status */
export async function sendWebPush(env: Env, sub: Pick<import("../room/Room.js").PushRow, "endpoint" | "p256dh" | "auth">, payloadText: string): Promise<number> {
  const aud = new URL(sub.endpoint).origin;
  const keys = env.ROOM.get(env.ROOM.idFromName("__vapid"));
  const authorization = await keys.vapidAuth(aud);
  const body = await encryptPushPayload(sub.p256dh, sub.auth, payloadText);
  const resp = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "Authorization": authorization, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "86400" },
    body: body,
  });
  return resp.status;
}
