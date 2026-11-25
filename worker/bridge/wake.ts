// Routing (which Muse chat a wake lands in) and the wake's text.
//
// The text is the laptop watcher's (acmg linux/watcher.py wake_text): the
// line "[Agent Chat]", then one fenced code block per item holding the
// item's frame as indented JSON, the fence longer than any run of
// backticks inside so room text cannot close it. One Muse may now hear
// several rooms, so each item's JSON starts with "room" (frames don't carry
// it). Muse titles a new side chat from the content, not from a first line,
// so there is no title line.

const utf8 = new TextEncoder();

export const ROUTINGS = ['main', 'agent-chat', 'per-room'];
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Agent Chat's ROOM_RE. */
export const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SESSION_PREFIX = 'muse-bridge session v1';

export function validRouting(routing: unknown): boolean {
  return typeof routing === 'string' && (ROUTINGS.includes(routing) || UUID_RE.test(routing));
}

/** RFC 4122 version-4 layout over the first 16 bytes of a hash. */
export function uuidFromBytes(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** SHA-256 over prefix, NUL, then each part NUL-separated; as a UUID. */
export async function derivedSessionId(...parts: string[]): Promise<string> {
  const input = utf8.encode([SESSION_PREFIX, ...parts].join('\u0000'));
  return uuidFromBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

/**
 * The Muse session_id for a routing, or null for the main chat.
 *   main       -> null
 *   agent-chat -> derived from (link, "agent-chat")
 *   per-room   -> derived from (link, "room", room)
 *   a UUID     -> itself, lowercased
 */
export async function sessionIdFor(museLinkId: string, routing: string, room: string): Promise<string | null> {
  if (routing === 'main') return null;
  if (routing === 'agent-chat') return derivedSessionId(museLinkId, 'agent-chat');
  if (routing === 'per-room') return derivedSessionId(museLinkId, 'room', room);
  if (UUID_RE.test(routing)) return routing.toLowerCase();
  throw new RangeError('unknown routing');
}

/** One item as a fenced block (watcher.py fenced(), JSON indented by 2). */
export function fenced(data: unknown): string {
  const text = JSON.stringify(data === undefined ? null : data, null, 2);
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** An item's data with the room first; a non-object frame goes under "data". */
export function withRoom(room: string, data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) return Object.assign({ room }, data, { room });
  return { room, data: data === undefined ? null : data };
}

/** The wake text. room must match ROOM_RE. */
export function wakeText({ room, items, skipped = 0 }: { room: string; items: readonly { data: unknown }[]; skipped?: number }): string {

  if (!ROOM_RE.test(room)) throw new RangeError('bad room name');
  const lines = ['[Agent Chat]'];
  if (skipped > 0) lines.push(`(${skipped} older item${skipped === 1 ? '' : 's'} not shown)`);
  return lines.join('\n') + '\n' + items.map((i) => fenced(withRoom(room, i.data))).join('\n');
}
