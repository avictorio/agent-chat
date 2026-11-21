// File-type sniffing (never trust a Content-Type) and upload payload decoding.

/** @param {ArrayBuffer} buf */
export function sniffAudio(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return "audio/wav";
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "audio/mp4";
  return null;
}

// Identify an image by its first bytes (never trust the Content-Type). SVG is not accepted.
/** @param {ArrayBuffer} buf */
export function sniffImage(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && ((b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66) || (b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x73))) return "image/avif";
  return null;
}

/** @param {ArrayBuffer} buf */
export function sniffVideo(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  return null;
}

// Text attachments (HTML pages and Markdown documents) arrive as JSON strings:
// either the raw text itself, or a data: URL carrying it base64-encoded. Raw
// HTML is unambiguous (it starts with "<", outside the base64 alphabet); raw
// Markdown is taken as-is. Returns the decoded string, or null if a data: URL
// does not decode.
/** @param {unknown} v */
export function decodeTextPayload(v) {
  const s = String(v == null ? "" : v);
  if (/^data:[^,]*;base64,/i.test(s)) {
    const b64 = s.replace(/^data:[^,]*,/i, "").replace(/\s+/g, "");
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) { return null; }
  }
  if (/^data:/i.test(s)) return s.replace(/^data:[^,]*,/i, "");
  return s;
}

/**
 * @template F
 * @param {unknown} v
 * @param {F} fallback what an empty name becomes
 * @returns {string | F}
 */
export function cleanFileName(v, fallback) {
  const n = String(v || "").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return n || fallback;
}
