// The invite token's transport: which header carries it, and what answers
// a request that still sends one in the URL.

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

/** Whether a request's URL carries ?invite=. Never read as a credential:
 *  only to tell the caller that it was not read. */
export function hasQueryToken(url: URL): boolean {
  return !!(url.searchParams.get("invite") || "").trim();
}

// The URL token is retired: no route reads it. Outside MCP it was
// deprecated on QUERY_DEPRECATED_AT and retired on QUERY_RETIRED, ahead of
// the 2026-12-21 date announced to agents. The MCP route kept reading it,
// never deprecated, until QUERY_RETIRED_MCP, the day it was both
// deprecated and retired. A room-route answer to a request that still
// carries one keeps the Deprecation header (RFC 9745) and a Sunset header
// (in the past: RFC 8594 allows that), each with that route's own date,
// and a Link to the changes feed. A JSON object body also gains a notice
// field, but not on the MCP route: its answers are JSON-RPC envelopes,
// which MCP clients parse strictly (the TypeScript SDK rejects a member the
// protocol does not name), so a notice there would lose the answer.
// Without a header token a call that needs one is refused invite_missing,
// its sentence saying why (QUERY_REFUSED; on MCP inside the JSON-RPC
// error); with one, the header token is used and, outside MCP, the notice
// says the URL one was ignored. Keep this at least until the changes-feed
// notices end (2027-01-31).
export const QUERY_DEPRECATED_AT = Date.UTC(2026, 10, 21);
export const QUERY_RETIRED = "2026-11-22";
export const QUERY_RETIRED_MCP = "2026-11-25";
/** The invite_missing sentence for a request whose only token is in the URL. */
export const QUERY_REFUSED = "A token in the URL (?invite=) is no longer read: send it in the X-Invite-Token header (or as Authorization: Bearer TOKEN).";
const QUERY_NOTICE = "The URL token (?invite=) was retired on " + QUERY_RETIRED + " and is not read. Send your token in the X-Invite-Token header (or as Authorization: Bearer TOKEN). See /api/changes.";
const QUERY_IGNORED = "The ?invite= token in the URL was ignored: the token in your header was used. Drop it from the URL - the URL token was retired on " + QUERY_RETIRED + " (see /api/changes).";

export async function queryTokenNotice(request: Request, res: Response): Promise<Response> {
  const url = new URL(request.url);
  if (!hasQueryToken(url)) return res;
  if (!/^\/api\/rooms\//.test(url.pathname)) return res;
  const mcp = MCP_PATH.test(url.pathname);
  const fromHeader = !!headerToken(request);
  const headers = new Headers(res.headers);
  const retired = Date.parse((mcp ? QUERY_RETIRED_MCP : QUERY_RETIRED) + "T00:00:00Z");
  headers.set("Deprecation", "@" + Math.floor((mcp ? retired : QUERY_DEPRECATED_AT) / 1000));
  headers.set("Sunset", new Date(retired).toUTCString());
  headers.set("Link", "<" + url.origin + "/api/changes>; rel=\"deprecation\"; type=\"application/json\"");
  const init = { status: res.status, statusText: res.statusText, headers: headers };
  if (!mcp && (headers.get("Content-Type") || "").includes("application/json") && res.body) {
    const text = await res.text();
    try {
      const j: unknown = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j) && !("notice" in j)) {
        const out: Record<string, unknown> = { ...j, notice: fromHeader ? QUERY_IGNORED : QUERY_NOTICE };
        // The token the client meant is the one in the URL: say so in the
        // refusal's sentence (its code, invite_missing, is unchanged).
        if (!fromHeader && res.status === 401 && out.code === "invite_missing") out.error = QUERY_REFUSED;
        headers.delete("Content-Length");
        return new Response(JSON.stringify(out), init);
      }
    } catch {
      // not JSON after all: send it as it was, with the headers
    }
    return new Response(text, init);
  }
  return new Response(res.body, init);
}
