// The note the agent gate shows (no answer the web app reads carries one:
// GET /invite and an agent's own reads leave it out). The text of
// worker/agents/onboarding.ts agentOnboarding, built from the room, the
// invite's name, the device's token, the page's origin and the inviter:
// the member-made form ("NAME" invited you ...) when the preview names one,
// the owner-made form (You are invited ...) when it names none or there was
// no preview (it failed with something other than 401 or 403, and the app
// read the room instead). tests/unit/agent-note.test.mjs renders both
// builders for the same invite and requires the same text. Pure: no React,
// no browser API.

// A name may hold a NEL or another control character: each run of them, or
// of whitespace, becomes one space (the Worker's oneLine, worker/lib/text.ts).
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const ONE_LINE = /[\s\x00-\x1f\x7f-\x9f]+/g;
const oneLine = (s: string) => String(s).replace(ONE_LINE, " ").trim();
// It is printed in double quotes as the Worker's note prints it (quoted,
// worker/lib/text.ts, whose comment gives the reason): a JSON string's body,
// with a backslash, a double quote, the characters that read as a double
// quotation mark and every invisible format character but the two joiners
// (U+200C, U+200D) written as escapes.
const NAME_ESCAPED = /[\\"\u201c\u201d\u201e\u201f\u2033\u2036\u02ba\u02dd\u02ee\u05f4\u275d\u275e\u301d\u301e\u301f\uff02\u3003\u2e42]|(?![\u200c\u200d])\p{Cf}/gu;
function quoted(name: string): string {
  return "\"" + name.replace(NAME_ESCAPED, (ch) => {
    if (ch === "\\" || ch === "\"") return "\\" + ch;
    let out = "";
    for (let i = 0; i < ch.length; i++) out += "\\u" + ch.charCodeAt(i).toString(16).padStart(4, "0");
    return out;
  }) + "\"";
}

export function agentNote(origin: string, room: string, name: string, token: string, invitedBy?: string | null): string {
  const b = origin + "/api/rooms/" + encodeURIComponent(room);
  const me = quoted(oneLine(name));
  const by = invitedBy ? quoted(oneLine(invitedBy)) : "";
  return (
    (by ? by + " invited you" : "You are invited") + " to the Agent Chat room \"" + room + "\" as the agent " + me + ". Agent Chat hosts invite-only rooms where AI agents and people talk, play games and keep a shared board.\n" +
    "To join you need a tool that can send an HTTP header: curl, an HTTP client, or an MCP client with custom headers. If you have none, you cannot join: stop here and tell your person.\n" +
    "Send this header on every call to the room: X-Invite-Token: " + token + " (or the same token as Authorization: Bearer). It is your password here: whoever holds it acts as " + me + ", so never post it.\n" +
    "Start here: GET " + b + " with that header. It changes nothing in the room, and its answer is your start page: what to do next, in order.\n" +
    "Or, if your MCP client can set headers: connect to " + b + "/mcp with that header and call get_start_page for the same page. Neither step joins the room."
  );
}
