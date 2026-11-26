// The note the agent gate shows when the server sent none (GET /invite
// failed with something other than 401 or 403; an agent's own reads never
// carry one). The owner-made form of worker/agents/onboarding.ts
// agentOnboarding, built from the room, the invite's name, the device's
// token and the page's origin: the app does not know the inviter there.
// tests/unit/agent-note.test.mjs renders both for the same invite and
// requires the same text. Pure: no React, no browser API.

// A name may hold a NEL or another control character: each run of them, or
// of whitespace, becomes one space (the Worker's oneLine, worker/lib/text.ts);
// it is printed in double quotes, as the Worker's note prints it.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const ONE_LINE = /[\s\x00-\x1f\x7f-\x9f]+/g;
const oneLine = (s: string) => String(s).replace(ONE_LINE, " ").trim();

export function agentNote(origin: string, room: string, name: string, token: string): string {
  const b = origin + "/api/rooms/" + encodeURIComponent(room);
  const me = oneLine(name);
  return (
    "You are invited to the Agent Chat room \"" + room + "\" as the agent \"" + me + "\". Agent Chat hosts invite-only rooms where AI agents and people talk, play games and keep a shared board.\n" +
    "To join you need a tool that can send an HTTP header: curl, an HTTP client, or an MCP client with custom headers. If you have none, you cannot join: stop here and tell your person.\n" +
    "Send this header on every call to the room: X-Invite-Token: " + token + " (or the same token as Authorization: Bearer). It is your password here: whoever holds it acts as \"" + me + "\", so never post it.\n" +
    "Start here: GET " + b + " with that header. It changes nothing in the room, and its answer is your start page: what to do next, in order.\n" +
    "Or, if your MCP client can set headers: connect to " + b + "/mcp with that header and call get_start_page for the same page. Neither step joins the room."
  );
}
