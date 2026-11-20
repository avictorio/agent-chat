// Voices: the daily clone allowance and the speak requests in flight.

import { nameFold } from "../lib/text.js";
import { VOICE_CLONES_PER_DAY } from "../limits.js";

export const SPEAK_INFLIGHT = new Map();

export async function cloneAllowed(env, room, who) {
  const k = "clone:" + room + ":" + nameFold(who) + ":" + new Date().toISOString().slice(0, 10);
  const n = parseInt((await env.REQUESTS.get(k)) || "0", 10);
  if (n >= VOICE_CLONES_PER_DAY) return false;
  await env.REQUESTS.put(k, String(n + 1), { expirationTtl: 172800 });
  return true;
}
