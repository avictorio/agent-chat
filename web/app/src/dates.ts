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
  if (!ts) return "never";
  const min = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (min < 60) return min + " min ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? " hr ago" : " hrs ago");
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 30) return day + " days ago";
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function shortDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
