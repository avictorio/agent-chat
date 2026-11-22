// R2 through its S3 API: SigV4-presigned part uploads and ListParts, for uploads that go straight to R2.

import { b64urlEncode, hexBytes, hmacBytes } from "../lib/crypto.js";

// The binding can neither presign nor list an upload's parts, so these
// speak S3 to <account>.r2.cloudflarestorage.com with SigV4 query
// authentication (region "auto", payload unsigned), using the R2 API
// credential. sigv4Presign is checked against AWS's published example
// (the sigv4 test hook and the API suite).
/** The Worker's env with the R2 API credential and bucket all set. */
export type R2DirectEnv = Env & Required<Pick<Env, "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_ACCOUNT_ID" | "R2_BUCKET">>;
export function r2DirectConfigured(env: Env | null | undefined): env is R2DirectEnv {
  return !!(env && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_BUCKET);
}

// RFC 3986, as SigV4 wants it (encodeURIComponent leaves !'()* alone).
export function awsEncode(v: string) { return encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }

/** An S3 credential: the API credential itself, or a temporary one with its session token. */
export type R2Credential = { accessKey: string, secretKey: string, token?: string };

// o: { method, host, path (already encoded), query, headers, accessKey,
// secretKey, token, region, expires (seconds), date }. Answers the
// presigned URL. headers (lower-case names) are signed beside host: the
// request must then carry each with exactly that value.
export async function sigv4Presign(o: R2Credential & { method: string, host: string, path: string, query?: Record<string, string> | null, headers?: Record<string, string> | null, region: string, expires: number, date: Date }) {
  const amz = o.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amz.slice(0, 8);
  const scope = day + "/" + o.region + "/s3/aws4_request";
  const signed: Record<string, string> = Object.assign({}, o.headers || {}, { host: o.host });
  const names = Object.keys(signed).sort();
  const q: Record<string, string> = Object.assign({}, o.query || {}, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": o.accessKey + "/" + scope,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(o.expires),
    "X-Amz-SignedHeaders": names.join(";"),
  });
  if (o.token) q["X-Amz-Security-Token"] = o.token;
  const qs = Object.keys(q).map((k) => [awsEncode(k), awsEncode(String(q[k]))]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((p) => p[0] + "=" + p[1]).join("&");
  const canonical = o.method + "\n" + o.path + "\n" + qs + "\n" + names.map((n) => n + ":" + signed[n] + "\n").join("") + "\n" + names.join(";") + "\nUNSIGNED-PAYLOAD";
  const toSign = "AWS4-HMAC-SHA256\n" + amz + "\n" + scope + "\n" + hexBytes(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  let k = await hmacBytes("AWS4" + o.secretKey, day);
  k = await hmacBytes(k, o.region);
  k = await hmacBytes(k, "s3");
  k = await hmacBytes(k, "aws4_request");
  return "https://" + o.host + o.path + "?" + qs + "&X-Amz-Signature=" + hexBytes(await hmacBytes(k, toSign));
}

export function r2Address(env: R2DirectEnv, key: string) {
  return { host: env.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com", path: "/" + awsEncode(env.R2_BUCKET) + "/" + String(key).split("/").map(awsEncode).join("/") };
}

// What an upload's part addresses are signed with. An address goes to
// whoever is uploading, and one signed with the API credential would carry
// that credential's reach: the whole bucket. S3 turns an UploadPart into
// UploadPartCopy when the request adds an x-amz-copy-source header, so
// such an address could copy any object - another room's media - into
// the caller's own upload. So each upload gets an R2 temporary credential
// that can do one thing, UploadPart, on one object, its own: a JWT that
// names that scope, signed with the API credential's secret, which R2
// checks on every request
// (developers.cloudflare.com/r2/api/s3/temporary-credentials, "Locally").
//
// An address made with it IS that credential: the JWT rides in the
// address (X-Amz-Security-Token) and the temporary secret is the JWT's
// SHA-256, so whoever holds an address can sign requests of their own
// within the scope - any part number, any length, on that one object,
// until it expires. The scope is the whole fence, and it is R2 that
// enforces it: r2-direct-check.ts proves on the live bucket that it does.
/** @param ttl seconds */
export async function r2PartCredential(env: R2DirectEnv, key: string, ttl: number, now: Date): Promise<Required<R2Credential>> {
  const part = (v: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  const iat = Math.floor(now.getTime() / 1000);
  const body = part({ alg: "HS256", typ: "JWT" }) + "." + part({
    bucket: env.R2_BUCKET, actions: ["UploadPart"], paths: { prefixPaths: [], objectPaths: [key] },
    sub: env.R2_ACCOUNT_ID, iss: env.R2_ACCESS_KEY_ID, aud: r2Address(env, key).host, iat: iat, exp: iat + ttl,
  });
  const jwt = body + "." + b64urlEncode(await hmacBytes(env.R2_SECRET_ACCESS_KEY, body));
  return { accessKey: env.R2_ACCESS_KEY_ID, secretKey: hexBytes(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt))), token: btoa("jwt/" + jwt) };
}

// The addresses an upload's parts go to, by part number: each good for ttl
// seconds, all signed with one credential made for this upload. The one
// way a part address is made, for the sign route and the direct check
// alike. Each also signs its part's length, so a client that sends the
// wrong slice is told at once instead of at finish. That is a courtesy,
// not a limit (see above): what bounds an upload is the scope, the
// expiry, and finish counting only parts of the planned length.
/** @param ttl seconds */
export async function r2PartAddresses(env: R2DirectEnv, key: string, uploadId: string, parts: { n: number, bytes: number }[], ttl: number, now: Date) {
  const cred = await r2PartCredential(env, key, ttl, now);
  const a = r2Address(env, key);
  const urls: Record<number, string> = {};
  for (const p of parts) {
    urls[p.n] = await sigv4Presign(Object.assign({ method: "PUT", host: a.host, path: a.path, query: { partNumber: String(p.n), uploadId: uploadId }, headers: { "content-length": String(p.bytes) }, region: "auto", expires: ttl, date: now }, cred));
  }
  return urls;
}

// Every part storage holds for an upload (S3 ListParts, 1,000 a page):
// part number -> { etag, size }. Storage's own record is what a direct
// upload's status and finish go by.
/** @param signal ends the reads early (a caller with a deadline) */
export async function r2ListParts(env: Env, key: string, uploadId: string, signal?: AbortSignal) {
  if (!r2DirectConfigured(env)) throw new Error("Direct uploads are not configured");
  const a = r2Address(env, key);
  const parts: Map<number, { etag: string, size: number }> = new Map();
  let marker = 0;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { uploadId: uploadId, "max-parts": "1000" };
    if (marker) query["part-number-marker"] = String(marker);
    // signed with the API credential itself: this address never leaves the Worker
    const url = await sigv4Presign({ method: "GET", host: a.host, path: a.path, query: query, accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY, region: "auto", expires: 300, date: new Date() });
    const res = await fetch(url, { signal: signal });
    const text = await res.text();
    if (!res.ok) throw new Error("ListParts " + res.status + " " + ((/<Code>([^<]*)<\/Code>/.exec(text) || [])[1] || ""));
    for (const m of text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const n = Number((/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1]) || [])[1] || 0);
      const etag = ((/<ETag>([^<]*)<\/ETag>/.exec(m[1]) || [])[1] || "").replace(/&quot;/g, "\"").replace(/^"|"$/g, "");
      const size = Number((/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1] || -1);
      if (n) parts.set(n, { etag: etag, size: size });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break;
    const next = Number((/<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/.exec(text) || [])[1] || 0);
    if (!next || next <= marker) break;
    marker = next;
  }
  return parts;
}
