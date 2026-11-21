// Failures worth knowing about: one structured line each in Workers Logs
// (wrangler.toml [observability]), so a broken R2 read, a token exchange
// that failed or a stored row that no longer parses shows up instead of
// vanishing into an empty catch. A catch that expects its failure (an
// ALTER TABLE migration that already ran, a socket that already closed)
// stays quiet with a comment that says why; see AGENTS.md section 13.
//
// The label is "area.what" (media.read, push.send, alarm.arm). ctx carries
// ids only - a room, a message or match id, a kind, a count - never a
// token, a push endpoint, an email address or message text. The error is
// its name and message, cut to 200 characters. Pass null instead for a
// JSON.parse failure (V8's message quotes the input it could not parse),
// and a string of your own (the error's name, an HTTP status) wherever the
// message could carry something private, such as a push endpoint's URL.
//
// The same label and ctx log once per 10 minutes per isolate, so a fault
// that hits every request cannot flood the log.

type Ctx = Record<string, string | number | boolean | null | undefined>;

const recent = new Map<string, number>();
const QUIET_MS = 10 * 60 * 1000;

export function warn(label: string, err: unknown, ctx?: Ctx): void {
  const key = label + "|" + JSON.stringify(ctx || {});
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < QUIET_MS) return;
  if (recent.size > 500) recent.clear();
  recent.set(key, now);
  try {
    console.warn(JSON.stringify(Object.assign({ warn: label, error: describe(err) }, ctx || {})));
  } catch {
    // console itself failed (it should not): nothing else to report to
  }
}

/** "TypeError: message", cut short; a string as given; null for none. */
function describe(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === "string") return err.slice(0, 200);
  const e = err as { name?: unknown; message?: unknown };
  const name = typeof e === "object" && e.name ? String(e.name) : "Error";
  const msg = typeof e === "object" && e.message !== undefined ? String(e.message) : String(err);
  return (name + ": " + msg).slice(0, 200);
}

/** Only for tests: forget what has been logged. */
export function resetWarnings(): void {
  recent.clear();
}
