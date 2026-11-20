// Reactions: emoji names and shortcuts, per-message reaction lists, the picker's emoji list.
// room_state.reactions_to_you: the latest reactions others left on your messages in the last 24 hours (up to 5).

import { EMOJI_KV_KEY, EMOJI_SOURCE, REACTION_ALIASES, STATE_MAX_BYTES } from "../limits.js";

export function withReactions(s, d, who) {
  if (!d || !d.rx || !who) return s;
  const w = String(who).toLowerCase();
  const mine = d.rx.filter((r) => String(r.to).toLowerCase() === w && String(r.who).toLowerCase() !== w).slice(0, 5);
  if (!mine.length) return s;
  const entries = mine.map((r) => ({ message_id: r.msg, reaction: r.emoji, from: r.who, at: new Date(r.ts).toISOString().replace(".000Z", "Z"), excerpt: r.excerpt }));
  // The reactions ride on top of a block the caller already shrank to fit
  // STATE_MAX_BYTES: trim them back off until the FINAL block fits the same
  // budget, so the cap the steps loop enforces is the cap that ships.
  const enc = new TextEncoder();
  while (entries.length) {
    s.reactions_to_you = entries;
    if (enc.encode(JSON.stringify(s)).length <= STATE_MAX_BYTES) return s;
    entries.pop();
  }
  delete s.reactions_to_you;
  return s;
}

// A reaction is one emoji (a single grapheme with an emoji in it) or one of the alias names. undefined = invalid.
export function normReaction(x) {
  if (x === null || x === undefined || x === "") return null;
  const s = String(x).trim();
  if (REACTION_ALIASES[s.toLowerCase()]) return REACTION_ALIASES[s.toLowerCase()];
  if (!s || s.length > 32) return undefined;
  if (typeof Intl !== "undefined" && Intl.Segmenter && Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)).length !== 1) return undefined;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(s)) return undefined;
  return s === "❤" ? "❤️" : s;
}

// Builds the picker's emoji list from the pinned dataset: [[category, [[emoji, "keywords"], ...]], ...].
export async function emojiList(env) {
  const cached = await env.REQUESTS.get(EMOJI_KV_KEY);
  if (cached) return cached;
  const res = await fetch(EMOJI_SOURCE, { headers: { "user-agent": "chat.victorio.cloud" } });
  if (!res.ok) return null;
  const data = await res.json();
  const order = ["Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Activities", "Travel & Places", "Objects", "Symbols", "Flags"];
  const cats = {};
  for (const c of order) cats[c] = [];
  data.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  for (const e of data) {
    if (!cats[e.category]) continue;
    const ch = String(e.unified || "").split("-").map((h) => String.fromCodePoint(parseInt(h, 16))).join("");
    const words = new Set((e.short_names || []).concat([String(e.name || "").toLowerCase()]).filter(Boolean).map((w) => w.replace(/_/g, " ")));
    cats[e.category].push([ch, Array.from(words).sort().join(" ")]);
  }
  const out = JSON.stringify(order.map((c) => [c, cats[c]]));
  await env.REQUESTS.put(EMOJI_KV_KEY, out);
  return out;
}
