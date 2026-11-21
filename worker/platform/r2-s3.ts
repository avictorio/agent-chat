// R2 through its S3 API: SigV4-presigned part uploads and ListParts, for uploads that go straight to R2.

import { hexBytes, hmacBytes } from "../lib/crypto.js";

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

// o: { method, host, path (already encoded), query, accessKey, secretKey,
// region, expires (seconds), date }. Answers the presigned URL.
export async function sigv4Presign(o: { method: string, host: string, path: string, query?: Record<string, string> | null, accessKey: string, secretKey: string, region: string, expires: number, date: Date }) {
  const amz = o.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amz.slice(0, 8);
  const scope = day + "/" + o.region + "/s3/aws4_request";
  const q = Object.assign({}, o.query || {}, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": o.accessKey + "/" + scope,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(o.expires),
    "X-Amz-SignedHeaders": "host",
  });
  const qs = Object.keys(q).map((k) => [awsEncode(k), awsEncode(String(q[k]))]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((p) => p[0] + "=" + p[1]).join("&");
  const canonical = o.method + "\n" + o.path + "\n" + qs + "\nhost:" + o.host + "\n\nhost\nUNSIGNED-PAYLOAD";
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

// The address part n of an upload goes to, good for ttl seconds.
/** @param ttl seconds */
export async function r2PresignPart(env: R2DirectEnv, key: string, uploadId: string, n: number, ttl: number) {
  const a = r2Address(env, key);
  return sigv4Presign({ method: "PUT", host: a.host, path: a.path, query: { partNumber: String(n), uploadId: uploadId }, accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY, region: "auto", expires: ttl, date: new Date() });
}

// Every part storage holds for an upload (S3 ListParts, 1,000 a page):
// part number -> { etag, size }. Storage's own record is what a direct
// upload's status and finish go by.
export async function r2ListParts(env: Env, key: string, uploadId: string) {
  if (!r2DirectConfigured(env)) throw new Error("Direct uploads are not configured");
  const a = r2Address(env, key);
  const parts: Map<number, { etag: string, size: number }> = new Map();
  let marker = 0;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { uploadId: uploadId, "max-parts": "1000" };
    if (marker) query["part-number-marker"] = String(marker);
    const url = await sigv4Presign({ method: "GET", host: a.host, path: a.path, query: query, accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY, region: "auto", expires: 300, date: new Date() });
    const res = await fetch(url);
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
