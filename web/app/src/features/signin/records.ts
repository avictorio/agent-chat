// What this browser keeps of a connection it approved: one localStorage
// entry per connection, chat-signin:<id> (id: the connection's, the second
// part of its disconnect-only code), holding {app, name, at, rooms, code}:
// the app's key, the agent's name, when it was approved, the rooms it was
// approved for, and the disconnect-only code (.ad1....), which can do one
// thing: disconnect that connection (POST /api/oauth/disconnect). It opens no
// invite and no room. The approval page writes one after a success
// (SignInApproval.tsx), and hands the connection to the app only once the
// record reads back as written: the app never receives a connection this
// browser could not disconnect, and the page disconnects that one itself.
// The Agent keys view lists them, disconnects one and removes one
// (AgentKeys.tsx). Home's room Forget leaves them alone.

/** A connection this browser approved. */
export interface SigninRecord {
  /** the connection's id, from its disconnect-only code */
  id: string;
  app: string;
  name: string;
  at: number;
  rooms: string[];
  code: string;
}

const PREFIX = "chat-signin:";
const CODE_RE = /^\.ad1\.([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{43}$/;

/** The id of a disconnect-only code, or null for anything else. */
export function codeId(code: string): string | null {
  const m = CODE_RE.exec(code);
  return m ? m[1]! : null;
}

/** Stores a connection approved here; true only when the record reads back
 *  as written, false when the code is not one or storage refused or lost it. */
export function saveSignin(app: string, name: string, rooms: string[], code: string): boolean {
  const id = codeId(code);
  if (!id) return false;
  const v = JSON.stringify({ app, name, at: Date.now(), rooms, code });
  try {
    localStorage.setItem(PREFIX + id, v);
    return localStorage.getItem(PREFIX + id) === v;
  } catch {
    return false; /* storage unavailable: nothing here could disconnect the connection */
  }
}

/** Every connection this browser approved, newest first; a record that does not read is left out. */
export function signinRecords(): SigninRecord[] {
  const out: SigninRecord[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      let v: unknown = null;
      try {
        v = JSON.parse(localStorage.getItem(k) || "null");
      } catch {
        continue; /* not a record this page wrote */
      }
      const r = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      const id = k.slice(PREFIX.length);
      if (!r || typeof r.code !== "string" || codeId(r.code) !== id) continue;
      out.push({
        id,
        app: typeof r.app === "string" ? r.app : "",
        name: typeof r.name === "string" ? r.name : "",
        at: typeof r.at === "number" ? r.at : 0,
        rooms: Array.isArray(r.rooms) ? r.rooms.filter((x): x is string => typeof x === "string") : [],
        code: r.code,
      });
    }
  } catch {
    // storage unavailable: none to list
  }
  out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  return out;
}

/** Removes one connection's record from this browser. */
export function dropSignin(id: string): void {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    // storage unavailable: nothing to remove
  }
}
