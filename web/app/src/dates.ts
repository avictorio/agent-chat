// Date helpers ported from the current app: board dates are YYYY-MM-DD
// strings read as local days, never UTC.

export function parseDay(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!);
}

export function daysAway(s: string | null | undefined): number | null {
  const d = parseDay(s);
  if (!d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

export function rel(ts: number | null | undefined): string {
  if (!ts) return "";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.round(sec / 60) + " min ago";
  if (sec < 86400) return Math.round(sec / 3600) + " hr ago";
  if (sec < 7 * 86400) {
    const d = Math.round(sec / 86400);
    return d + (d === 1 ? " day ago" : " days ago");
  }
  return shortDate(ts);
}

export function shortDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
