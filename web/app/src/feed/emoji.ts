// The reaction data layer: the six quick reactions, the
// name/emoji maps behind aria labels and ordering, the recents
// list, and the full compact-emoji dataset the picker loads once
// from the page origin and caches for the session.

import type { Message } from "@chat/shared";
import { same, store } from "../lib";

export const REACTIONS: [string, string][] = [
  ["👍", "Like"],
  ["❤️", "Love"],
  ["😂", "Haha"],
  ["😮", "Wow"],
  ["😢", "Sad"],
  ["😡", "Angry"],
];
export const NAME2EMOJI: Record<string, string> = {};
export const EMOJI2NAME: Record<string, string> = {};
REACTIONS.forEach(([e, n]) => {
  NAME2EMOJI[n] = e;
  EMOJI2NAME[e] = n;
});
export function rxLabel(e: string): string {
  return EMOJI2NAME[e] || e;
}
export function rxOrder(rx: Record<string, string[]>): string[] {
  const keys = Object.keys(rx || {}).filter((k) => (rx[k] || []).length);
  const quick = REACTIONS.map((x) => x[0]).filter((e) => keys.includes(e));
  return quick.concat(keys.filter((k) => !quick.includes(k)).sort());
}
export function myReaction(m: Message, me: string): string | null {
  if (!me) return null;
  const rx = m.reactions || {};
  for (const k of Object.keys(rx)) if ((rx[k] || []).some((w) => same(w, me))) return k;
  return null;
}

const RECENT_KEY = "chat-recent-emoji";
export function recents(): string[] {
  try {
    const a = JSON.parse(store(RECENT_KEY) || "[]") as unknown;
    return Array.isArray(a) ? (a as string[]).slice(0, 24) : [];
  } catch {
    return [];
  }
}
export function addRecent(e: string) {
  const a = recents().filter((x) => x !== e);
  a.unshift(e);
  store(RECENT_KEY, JSON.stringify(a.slice(0, 24)));
}

export type EmojiData = [string, [string, string][]][];
export let emojiCache: EmojiData | null = null;
let emojiLoading: Promise<EmojiData> | null = null;
export function loadEmoji(): Promise<EmojiData> {
  if (emojiCache) return Promise.resolve(emojiCache);
  if (!emojiLoading) {
    emojiLoading = fetch("/emoji.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        emojiCache = Array.isArray(d) ? (d as EmojiData) : [];
        return emojiCache;
      })
      .catch(() => []);
  }
  return emojiLoading;
}
