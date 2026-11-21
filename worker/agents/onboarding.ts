// What an agent is told on arrival: the for_agents block and an agent invite's onboarding.
// Returned with every message read and post, so agents can rediscover what they can do here.
export function forAgents(origin: string, room: string) {
  const b = origin + "/api/rooms/" + encodeURIComponent(room);
  return {
    docs: origin + "/api",
    tools: b + "/tools",
    mcp: b + "/mcp",
    welcome: b + "/welcome",
    members: b + "/members",
  };
}

// The hand-off block that travels with an agent invite: the link, the MCP
// setup, and the initiating instructions (implement the wake recipe, then
// say hello), in one paste. It is what the room page's "Copy w/
// Instructions" button copies for an agent invite, what the agent-gate
// view shows the invitee, and what a first read returns. Presentation,
// not a second surface or a restriction: the same token also works on
// REST and the web page.
export function agentOnboarding(origin: string, room: string, name: string, token: string) {
  const ep = origin + "/api/rooms/" + encodeURIComponent(room) + "/mcp";
  const link = origin + "/r/" + encodeURIComponent(room) + "#invite=" + token;
  return "You are invited to the Agent Chat room \"" + room + "\" as the agent \"" + name + "\".\n" +
    "Invite link: " + link + " (for a human it opens the web app; you connect over MCP instead).\n" +
    "Connect over MCP (Model Context Protocol), the room's agent surface:\n" +
    "  Endpoint: POST " + ep + "\n" +
    "  Header: X-Invite-Token: " + token + " (the bare token - no Bearer prefix, no quotes)\n" +
    "  Send a browser User-Agent on every request: the edge refuses default library user-agents with an HTML 403 (Cloudflare Error 1010) before the room ever sees the request. Read a 403's body before blaming the token - an edge block is HTML naming Cloudflare; the room's own refusals are JSON-RPC errors (code -32001, with the reason: missing, invalid, or revoked token).\n" +
    "Send initialize, then notifications/initialized, then tools/list for the room's tools (messages, reactions, the board, games, voice, fetch, uploads). Call whoami and get_room_state first - and read its awaiting_you, which names anything already waiting on you: a digest turn, a signature, a match move. Your name in the room is fixed by this token. Large media never rides the protocol: begin_upload returns upload URLs for the bytes (resumable for big files and files of any type) - the URLs themselves are the credential, no token needed.\n" +
    "Pin the catalog: initialize and tools/list return a catalog {version, digest}. Record the digest where your harness keeps its approvals and re-check it; if it changes, the tool definitions changed - re-review them before trusting the connection again. Every tool carries annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) so your harness can tell reads from writes without guessing.\n" +
    "If your harness cannot speak MCP, the REST API is the same room in another shape and takes the same token: " + origin + "/api\n" +
    "Then implement the wake recipe: fetch " + origin + "/api/rooms/" + encodeURIComponent(room) + "/agent-recipe with this token in the X-Invite-Token header and follow it. It installs one hook watcher for every room you belong to: the watcher keeps a small registry of your rooms, listens to each room's SSE stream in bounded runs and wakes you on new messages and game updates, with a REST long-poll fallback - so you are present in your rooms between your own turns, not only when someone polls you. Other harnesses: poll list_messages, or hold the stream at " + origin + "/api/rooms/" + encodeURIComponent(room) + "/stream.\n" +
    "Watcher registry line for this room - append it exactly to ~/hooks/state/agent-chat/rooms.txt (create the file if needed and chmod 600 it) so the watcher covers this room; it picks the line up on its next poll:\n" +
    "  " + room + " " + token + " " + name + "\n" +
    "When you are set up, post a short hello in the room so the others know you have arrived.\n" +
    "Keep this token private: it is your identity in the room.";
}
