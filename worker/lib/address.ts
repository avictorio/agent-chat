// Public room creation's caller keys: the email address it mails, as the
// one form accepted and as the cap counts it, and the client's network.

// RFC 5322 atext: what a dot-atom local part is made of.
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_RE = new RegExp("^" + ATOM + "(?:\\." + ATOM + ")*$");
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** The longest address taken (RFC 5321's path limit, less its brackets). */
export const EMAIL_MAX = 254;

/**
 * Whether s is a plain address: a dot-atom local part, "@", and a host
 * name of at least two labels; at most EMAIL_MAX characters. No display
 * name, no angle brackets, commas, semicolons, colons, spaces, quotes
 * around the local part or control characters: the address goes into
 * the mail's To header as it is, and the old check (no spaces or "@"
 * around one "@") let "Your-Bank<victim@example.com>" through as the To
 * line, and "a<x@y>" and "b<x@y>" count as two addresses.
 */
export function plainAddress(s: string): boolean {
  if (!s || s.length > EMAIL_MAX) return false;
  const at = s.lastIndexOf("@");
  if (at <= 0 || at !== s.indexOf("@")) return false;
  const local = s.slice(0, at), host = s.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return false;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL_RE.test(l)) && /[A-Za-z]/.test(labels[labels.length - 1]);
}

/**
 * The address as the per-address cap counts it: lower case, and a "+tag"
 * taken off the local part, so "Ada+1@x.org" and "ada+2@x.org" are one
 * mailbox's quota. Call it on a plainAddress.
 */
export function addressKey(s: string): string {
  const at = s.lastIndexOf("@");
  const local = s.slice(0, at).toLowerCase(), host = s.slice(at + 1).toLowerCase();
  const plus = local.indexOf("+");
  return (plus > 0 ? local.slice(0, plus) : local) + "@" + host;
}

/**
 * The client as the per-IP cap counts it: an IPv4 address whole, an IPv6
 * address by its /64 (the block one subscriber is handed, so one caller
 * had millions of addresses to count under), "unknown" for nothing.
 */
export function networkKey(ip: string | null | undefined): string {
  const s = String(ip || "").trim().toLowerCase();
  if (!s) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  if (s.indexOf(":") < 0) return s;
  const [head, tail] = s.split("::");
  const groups = (x: string | undefined) => (x ? x.split(":").filter((g) => g !== "") : []);
  const h = groups(head), t = tail === undefined ? [] : groups(tail);
  const full = tail === undefined ? h : h.concat(new Array(Math.max(0, 8 - h.length - t.length)).fill("0"), t);
  if (full.length < 4 || full.slice(0, 4).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}
