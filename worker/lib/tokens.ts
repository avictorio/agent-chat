// The invite token's transport: which header carries it, and what answers
// a token sent in the URL while the query form is retired.

/** The invite token a request carries in a header: X-Invite-Token, else
 *  an Authorization: Bearer token (other schemes are not a token). */
export function headerToken(request: Request): string {
  const x = (request.headers.get("X-Invite-Token") || "").trim();
  if (x) return x;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") || "");
  return m ? m[1] : "";
}

// The query-token retirement, phase 1 (from 2026-11-21): a request that
// carries ?invite= on a room route other than MCP still works, but every
// answer to it says so - a Deprecation header (RFC 9745), the Sunset date,
// a Link to the changes feed, and in a JSON object body a notice field. A
// token in a header always wins; then the notice says the query one was
// ignored. MCP keeps the query form (clients configured with a URL only).
export const QUERY_DEPRECATED_AT = Date.UTC(2026, 10, 21);
export const QUERY_SUNSET = "2026-12-21";
const QUERY_NOTICE = "A token in the URL (?invite=) is deprecated: send it in the X-Invite-Token header (or as Authorization: Bearer TOKEN). Outside POST /api/rooms/ROOM/mcp it stops working after " + QUERY_SUNSET + " at the earliest; media reads already need a header. See /api/changes.";
const QUERY_IGNORED = "The ?invite= token in the URL was ignored: the token in your header was used. Drop it from the URL - the query form is deprecated (see /api/changes).";

export async function queryTokenNotice(request: Request, res: Response): Promise<Response> {
  const url = new URL(request.url);
  if (!(url.searchParams.get("invite") || "").trim()) return res;
  if (!/^\/api\/rooms\//.test(url.pathname) || /^\/api\/rooms\/[^/]+\/mcp\/?$/.test(url.pathname)) return res;
  const notice = headerToken(request) ? QUERY_IGNORED : QUERY_NOTICE;
  const headers = new Headers(res.headers);
  headers.set("Deprecation", "@" + Math.floor(QUERY_DEPRECATED_AT / 1000));
  headers.set("Sunset", new Date(QUERY_SUNSET + "T00:00:00Z").toUTCString());
  headers.set("Link", "<" + url.origin + "/api/changes>; rel=\"deprecation\"; type=\"application/json\"");
  const init = { status: res.status, statusText: res.statusText, headers: headers };
  if ((headers.get("Content-Type") || "").includes("application/json") && res.body) {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j) && !("notice" in j)) {
        j.notice = notice;
        headers.delete("Content-Length");
        return new Response(JSON.stringify(j, null, 2), init);
      }
    } catch {
      // not JSON after all: send it as it was, with the headers
    }
    return new Response(text, init);
  }
  return new Response(res.body, init);
}
