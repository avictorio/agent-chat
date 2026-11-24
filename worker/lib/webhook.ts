// Webhook hooks' outbound calls: checking a URL a member registers, the
// registration's challenge, and signing each call.
//
// Every call is a POST of JSON with
//   X-AgentChat-Event: challenge | wake
//   X-AgentChat-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
// The secret is the hook's own ("whsec_..."), shown to its member once;
// the HMAC key is the secret string's UTF-8 bytes, whole. A receiver
// recomputes v1 over the raw body, compares in constant time and refuses a
// t older than WEBHOOK_TOLERANCE_S, which together stop fakes and replays.
//
// Redirects are not followed (a 3xx is a failed call), the answer is read
// up to WEBHOOK_ANSWER_MAX bytes, and a call gives up after
// WEBHOOK_FETCH_MS. URLs must be https on the default port, by host name:
// no credentials, no fragment, no IP literals and no local or reserved
// names. (A Worker's fetch cannot reach a private network anyway; the
// check keeps the obvious mistakes and probes out of the stored hooks.)

import { b64urlEncode, hexBytes, hmacBytes } from "./crypto.js";
import { WEBHOOK_ANSWER_MAX, WEBHOOK_FETCH_MS, WEBHOOK_URL_MAX } from "../limits.js";

const RESERVED_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "intranet", "test", "invalid", "example", "onion"];

/**
 * A URL a member may register, normalised, or why not.
 * @param raw what the member sent
 * @param selfHosts this site's own host names (a hook must not call the site itself)
 * @param testLocal TEST_HOOKS only: also take http://127.0.0.1:PORT, the API suite's receiver
 */
export function webhookUrl(raw: string, selfHosts: string[], testLocal: boolean): { ok: true, url: string } | { ok: false, error: string } {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, error: "\"url\" is required: the https URL the room should call" };
  if (s.length > WEBHOOK_URL_MAX) return { ok: false, error: "\"url\" is longer than " + WEBHOOK_URL_MAX + " characters" };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: "\"url\" is not a URL" }; }
  if (testLocal && u.protocol === "http:" && u.hostname === "127.0.0.1" && !u.username && !u.password && !u.hash) return { ok: true, url: u.href };
  if (u.protocol !== "https:") return { ok: false, error: "\"url\" must be https" };
  if (u.username || u.password) return { ok: false, error: "\"url\" must not carry credentials: the signature (X-AgentChat-Signature) proves the call is the room's" };
  if (u.hash) return { ok: false, error: "\"url\" must not have a fragment (#...)" };
  if (u.port && u.port !== "443") return { ok: false, error: "\"url\" must use the default https port" };
  const host = u.hostname.toLowerCase(); // lowercase-ok: a host name
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return { ok: false, error: "\"url\" must name a host, not an IP address" };
  if (host.indexOf(".") < 0 || RESERVED_SUFFIXES.some((x) => host === x || host.endsWith("." + x))) return { ok: false, error: "\"url\" must be a public host name" };
  if (selfHosts.some((h) => host === h.toLowerCase())) return { ok: false, error: "\"url\" must not be this site" }; // lowercase-ok: a host name
  return { ok: true, url: u.href };
}

/** A new hook secret: "whsec_" and 32 random bytes, base64url. */
export function webhookSecret(): string {
  return "whsec_" + b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** The signature header's value for a body sent at unix second t. */
export async function webhookSignature(secret: string, t: number, body: string): Promise<string> {
  return "t=" + t + ",v1=" + hexBytes(await hmacBytes(secret, t + "." + body));
}

/** How a call went: the status (0: no answer), the start of the answer,
 *  the seconds a 429 or 503 asked to wait, and a short reason when it
 *  failed (never the answer's text: that is the receiver's). */
export type WebhookAnswer = { status: number, text: string, retryAfter: number, error: string | null };

/** Reads at most max bytes of an answer, then lets the rest go. */
async function readCapped(r: Response, max: number): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
    }
  } finally {
    reader.cancel().catch(() => { /* the rest of the answer is not wanted */ });
  }
  const all = new Uint8Array(Math.min(got, max));
  let at = 0;
  for (const p of parts) { const n = Math.min(p.length, all.length - at); all.set(p.subarray(0, n), at); at += n; if (at >= all.length) break; }
  return new TextDecoder().decode(all);
}

/** One signed POST to a hook's URL. Never throws. */
export async function webhookCall(url: string, secret: string, event: "challenge" | "wake", payload: unknown): Promise<WebhookAnswer> {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_FETCH_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AgentChat-Webhook/1 (+https://chat.victorio.cloud/api)",
        "X-AgentChat-Event": event,
        "X-AgentChat-Signature": await webhookSignature(secret, t, body),
      },
      body: body,
    });
    const text = await readCapped(r, WEBHOOK_ANSWER_MAX);
    const retryAfter = r.status === 429 || r.status === 503 ? parseInt(r.headers.get("Retry-After") || "", 10) || 0 : 0;
    let error: string | null = null;
    if (r.status >= 300 && r.status < 400) error = "HTTP " + r.status + ": redirects are not followed";
    else if (r.status >= 400) error = "HTTP " + r.status;
    return { status: r.status, text, retryAfter, error };
  } catch (e) {
    const name = e && (e as Error).name;
    return { status: 0, text: "", retryAfter: 0, error: name === "TimeoutError" ? "no answer within " + Math.round(WEBHOOK_FETCH_MS / 1000) + " s" : "could not connect" };
  }
}

/**
 * The registration's ownership check: the URL must answer the challenge
 * with 2xx and echo it, as the body or as {"challenge": "..."}.
 * @returns null when it did, else why not
 */
export async function webhookChallenge(url: string, secret: string, room: string, member: string): Promise<string | null> {
  const challenge = "chl_" + b64urlEncode(crypto.getRandomValues(new Uint8Array(18)));
  const a = await webhookCall(url, secret, "challenge", { type: "challenge", challenge: challenge, room: room, member: member });
  if (a.error) return "The URL did not accept the challenge (" + a.error + ")";
  if (a.text.trim() === challenge) return null;
  try {
    const j = JSON.parse(a.text) as { challenge?: unknown };
    if (j && j.challenge === challenge) return null;
  } catch { /* not JSON */ }
  return "The URL answered " + a.status + " but did not echo the challenge: answer with the challenge as the body, or as {\"challenge\": \"...\"}";
}
