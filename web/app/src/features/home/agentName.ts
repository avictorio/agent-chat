// The agent's name as the server takes a new member's name, checked in the
// browser so a person sees the server's own sentence without a round trip:
// the same cut as cleanName (worker/lib/text.ts: NFC, every run of
// whitespace one space, at most MAX_NAME units without splitting a
// character), the same sentences as memberNameProblem, and the members
// route's "Referee" rule (worker/routes/members.ts). The server checks again;
// tests/unit/agent-name.test.mjs keeps the two the same.

/** The longest name, in UTF-16 units (worker/lib/text.ts MAX_NAME). */
export const AGENT_NAME_MAX = 40;

// C0 control characters and DEL
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** The names a plain object's prototype holds, folded: a member name may not be one. */
const RESERVED_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase()));
const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/** A name as typed, as the server would store it. */
export function cleanAgentName(raw: string): string {
  const text = String(raw || "").normalize("NFC").replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > AGENT_NAME_MAX) break;
    out += ch;
  }
  return out.trim();
}

/** Why the server would refuse this cleaned name, in its words; null when it takes it. */
export function agentNameProblem(name: string): string | null {
  if (!name) return "Give the agent a name.";
  if (CONTROL_CHARS.test(name) || /[<>"'&`]/.test(name)) return "Names can't contain < > \" ' & ` or control characters";
  if (/\p{Cs}|�/u.test(name)) return "That name has a broken character in it - type it again";
  if (/[,:]/.test(name)) return "Names can't contain a comma or a colon (they separate targets in game moves)";
  if (RESERVED_KEYS.has(fold(name))) return "That name is reserved - pick another";
  if (fold(name) === "referee") return "\"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member.";
  return null;
}
