// The resumable upload engine's plan: part sizes, part lengths, kind checks.

import {
  MIB,
  UP_DIRECT_PART_MAX,
  UP_MAX_PARTS,
  UP_PART_MAX,
  UP_PART_MIN,
  UP_TARGET_PARTS,
} from "../limits.js";
import { sniffAudio, sniffImage, sniffVideo } from "../lib/sniff.js";

/** @param {number} size */
export function uploadPlanDirect(size) {
  let ps = Math.ceil(size / UP_TARGET_PARTS / MIB) * MIB;
  ps = Math.max(UP_PART_MIN, Math.min(UP_DIRECT_PART_MAX, ps));
  if (Math.ceil(size / ps) > UP_MAX_PARTS) ps = Math.ceil(size / UP_MAX_PARTS / MIB) * MIB;
  return { part_size: ps, parts: Math.max(1, Math.ceil(size / ps)) };
}
// About 2,000 parts, inside 8-90 MiB: a 1 GB file goes in 8 MiB parts, a
// 50 GB one in 24 MiB parts, anything past ~190 GB in 90 MiB parts.
/** @param {number} size */
export function uploadPlan(size) {
  let ps = Math.ceil(size / UP_TARGET_PARTS / MIB) * MIB;
  ps = Math.max(UP_PART_MIN, Math.min(UP_PART_MAX, ps));
  return { part_size: ps, parts: Math.max(1, Math.ceil(size / ps)) };
}
// The exact length of part n: part_size, except the last (the remainder).
/**
 * @param {number} size
 * @param {number} ps the part size
 * @param {number} n
 */
export function partLength(size, ps, n) {
  const parts = Math.max(1, Math.ceil(size / ps));
  if (n < 1 || n > parts) return 0;
  return n < parts ? ps : size - (parts - 1) * ps;
}
/** @param {string} kind */
export function upNoun(kind) { return kind === "image" ? "an image" : kind === "audio" ? "audio" : kind === "video" ? "a video" : "a file"; }
/** @param {string} kind */
export function upSniff(kind) { return kind === "image" ? sniffImage : kind === "audio" ? sniffAudio : kind === "video" ? sniffVideo : null; }
/** @param {string} kind */
export function upTypeError(kind) { return kind === "image" ? "Image must be JPEG, PNG, GIF, WebP or AVIF" : kind === "audio" ? "Audio must be MP3, WAV, OGG, WebM or M4A" : "Video must be MP4, WebM or MOV"; }
// A declared media type, kept only when it looks like one (type/subtype).
/** @param {unknown} v */
export function cleanMediaType(v) {
  const t = String(v || "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t) ? t : null;
}
