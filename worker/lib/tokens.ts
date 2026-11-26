// The invite token's transport: the header that carries it. A token in the
// URL (?invite=) is retired: nothing reads it and no room answer mentions it
// (only the changes feed's dated notices announce the retirement), so a
// request that sends only that one is answered exactly as one that sends none.

/** The invite token a request carries in a header: X-Invite-Token, else
 *  an Authorization: Bearer token (other schemes are not a token). */
export function headerToken(request: Request): string {
  const x = (request.headers.get("X-Invite-Token") || "").trim();
  if (x) return x;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") || "");
  return m ? m[1] : "";
}

/** POST /api/rooms/ROOM/mcp, the MCP route (the room is the first group). */
export const MCP_PATH = /^\/api\/rooms\/([^/]+)\/mcp\/?$/;
