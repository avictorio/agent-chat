// Gmail API sending through a Workspace service account (domain-wide delegation).

import { b64urlEncode, pemToDer } from "../lib/crypto.js";
import { warn } from "../lib/log.js";

// The service-account JSON arrives via a dashboard paste, and a
// viewer along the way may turn the key's escaped line breaks into
// literal ones - strict JSON rejects raw line breaks inside a
// string. Parse strictly first; on failure, retry with raw line
// breaks inside string values escaped. Anything else malformed
// still fails, just without throwing.
/** @param raw the GMAIL_SA secret */
export function parseServiceAccount(raw: string | null | undefined): { client_email?: string, private_key?: string } | null {
  try { return JSON.parse(raw || "null"); } catch { /* raw line breaks, most likely: the lenient pass below */ }
  try {
    let out = "";
    let inStr = false;
    let esc = false;
    const text = String(raw || "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\" && inStr) { out += ch; esc = true; continue; }
      if (ch === "\"") { inStr = !inStr; out += ch; continue; }
      if (inStr && ch === "\n") { out += "\\n"; continue; }
      if (inStr && ch === "\r") { out += "\\r"; continue; }
      out += ch;
    }
    return JSON.parse(out);
  } catch {
    // never the parse error itself: its message would quote the key
    warn("gmail.config", "the GMAIL_SA secret is not service-account JSON");
    return null;
  }
}

// Gmail sending through a Google Workspace service account with domain-wide
// delegation: the account impersonates env.GMAIL_SENDER (a real mailbox on the
// domain) with only the gmail.send scope, signed with the lib/crypto helpers;
// the service-account JSON is the GMAIL_SA secret. Mail then comes from the
// domain itself, so no DNS changes are needed - Google already signs for it.
export const gmailCache: { email: string | null, sender: string | null, key: CryptoKey | null, token: string | null, exp: number } = { email: null, sender: null, key: null, token: null, exp: 0 };

export async function gmailAccessToken(env: Env) {
  try { return await gmailAccessTokenInner(env); } catch (e) { warn("gmail.token", e); return null; }
}

export async function gmailAccessTokenInner(env: Env) {
  const sa = parseServiceAccount(env.GMAIL_SA);
  const sender = String(env.GMAIL_SENDER || "").trim();
  if (!sa || !sa.client_email || !sa.private_key || !sender) return null;
  const now = Math.floor(Date.now() / 1000);
  if (gmailCache.email === sa.client_email && gmailCache.sender === sender && gmailCache.token && gmailCache.exp > now + 60) return gmailCache.token;
  if (!gmailCache.key || gmailCache.email !== sa.client_email) {
    gmailCache.key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    gmailCache.email = sa.client_email;
  }
  gmailCache.sender = sender;
  const enc = new TextEncoder();
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ iss: sa.client_email, sub: sender, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/gmail.send", iat: now, exp: now + 3600 })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", gmailCache.key, enc.encode(head + "." + claims));
  const jwt = head + "." + claims + "." + b64urlEncode(new Uint8Array(sig));
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + encodeURIComponent(jwt) });
  if (!res.ok) { warn("gmail.token", "HTTP " + res.status); return null; }
  /** the token endpoint's answer */
  const j: { access_token: string, expires_in?: number } = await res.json();
  gmailCache.token = j.access_token; gmailCache.exp = now + (j.expires_in || 3600);
  return gmailCache.token;
}

export function mimePart(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  // apply takes any array-like; its strict typing wants a number[]
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, (bytes.subarray(i, i + 8192) as ArrayLike<number>) as number[]);
  return btoa(bin).replace(/.{76}(?=.)/g, "$&\r\n");
}

export async function sendViaGmail(env: Env, to: string, subject: string, text: string, html: string) {
  // gmailAccessToken never throws: null (logged) when there is no token
  const token = await gmailAccessToken(env);
  if (!token) return false;
  const sender = String(env.GMAIL_SENDER || "").trim();
  const boundary = "acgenesis" + Date.now().toString(36);
  const mime = [
    "From: Agent Chat <" + sender + ">",
    "To: " + to,
    "Subject: " + subject,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=\"" + boundary + "\"",
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimePart(text),
    "--" + boundary,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimePart(html),
    "--" + boundary + "--",
    "",
  ].join("\r\n");
  try {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: b64urlEncode(new TextEncoder().encode(mime)) }),
    });
    if (!res.ok) warn("gmail.send", "HTTP " + res.status);
    return res.ok;
  } catch (e) {
    warn("gmail.send", e);
    return false;
  }
}
