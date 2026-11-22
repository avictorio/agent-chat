// The invite token's transport: which header carries it, the one route that
// still reads it from the URL, and what answers a token sent in the URL.

/** The invite token a request carries in a header: X-Invite-Token, else
 *  an Authorization: Bearer token (other schemes are not a token). */
export function headerToken(request: Request): string {
  const x = (request.headers.get("X-Invite-Token") || "").trim();
  if (x) return x;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") || "");
  return m ? m[1] : "";
}

/** POST /api/rooms/ROOM/mcp: the one route that still reads ?invite=, for
 *  MCP clients configured with a URL alone. */
export const MCP_PATH = /^\/api\/rooms\/([^/]+)\/mcp\/?$/;

/** The ?invite= token in a request's URL (read on the MCP route only). */
export function queryToken(url: URL): string {
  return (url.searchParams.get("invite") || "").trim();
}

// The query token is retired: outside MCP the URL token is not read at
// all. It was deprecated on QUERY_DEPRECATED_AT and retired on
// QUERY_RETIRED, ahead of the 2026-12-21 date announced to agents. A
// room-route answer to a request that still carries one keeps the
// Deprecation header (RFC 9745), a Sunset header with the retirement date
// (in the past: RFC 8594 allows that), a Link to the changes feed, and in a
// JSON object body a notice field. Without a header token the answer is the
// 401 invite_missing refusal, its sentence saying why; with one, the header
// token is used and the notice says the URL one was ignored. Keep this at
// least until the changes-feed notice ends (2027-01-31).
export const QUERY_DEPRECATED_AT = Date.UTC(2026, 10, 21);
export const QUERY_RETIRED = "2026-11-22";
const QUERY_REFUSED = "A token in the URL (?invite=) is no longer read: send it in the X-Invite-Token header (or as Authorization: Bearer TOKEN).";
const QUERY_NOTICE = "The URL token (?invite=) was retired on " + QUERY_RETIRED + ": outside POST /api/rooms/ROOM/mcp it is not read. Send your token in the X-Invite-Token header (or as Authorization: Bearer TOKEN). See /api/changes.";
const QUERY_IGNORED = "The ?invite= token in the URL was ignored: the token in your header was used. Drop it from the URL - the URL token was retired on " + QUERY_RETIRED + " (see /api/changes).";

export async function queryTokenNotice(request: Request, res: Response): Promise<Response> {
  const url = new URL(request.url);
  if (!queryToken(url)) return res;
  if (!/^\/api\/rooms\//.test(url.pathname) || MCP_PATH.test(url.pathname)) return res;
  const fromHeader = !!headerToken(request);
  const headers = new Headers(res.headers);
  headers.set("Deprecation", "@" + Math.floor(QUERY_DEPRECATED_AT / 1000));
  headers.set("Sunset", new Date(QUERY_RETIRED + "T00:00:00Z").toUTCString());
  headers.set("Link", "<" + url.origin + "/api/changes>; rel=\"deprecation\"; type=\"application/json\"");
  const init = { status: res.status, statusText: res.statusText, headers: headers };
  if ((headers.get("Content-Type") || "").includes("application/json") && res.body) {
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
