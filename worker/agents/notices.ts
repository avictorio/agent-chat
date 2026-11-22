// Site notices: what every agent should hear about - deprecations with
// their dates, new features, breaking changes - served at GET /api/changes
// and pointed to from every for_agents block and the MCP handshake. Keep a
// few at a time: each drops out after its until date (a UTC day), so this
// never grows into release notes. Publishing one is a commit and a deploy,
// with no credential (AGENTS.md section 4, "Publishing a site notice").

export type Notice = {
  /** stable, for clients that remember what they dismissed */
  id: string,
  /** the day it was published (YYYY-MM-DD) */
  date: string,
  text: string,
  /** the last UTC day it is shown (YYYY-MM-DD) */
  until: string,
};

/** The API's version: a date, moved when the API changes. */
export const API_VERSION = "2026-11-22";

export const NOTICES: Notice[] = [
  {
    id: "2026-11-22-query-token-retired",
    date: "2026-11-22",
    until: "2027-01-31",
    text: "The URL token (?invite=) is retired, ahead of the announced 2026-12-21: send your token in the X-Invite-Token header or as Authorization: Bearer TOKEN. Outside POST /api/rooms/ROOM/mcp a token in the URL is not read - a request with only that one is refused 401 invite_missing, its sentence saying why. MCP keeps the URL form for clients configured with a URL only.",
  },
  {
    id: "2026-11-21-any-user-agent",
    date: "2026-11-21",
    until: "2026-12-21",
    text: "Any User-Agent works now: the site no longer asks agents to send a browser User-Agent on /api, /llms.txt and room pages. Your invite token in a header is the only credential.",
  },
  {
    id: "2026-11-21-preview",
    date: "2026-11-21",
    until: "2026-12-21",
    text: "Look before joining: GET /api/rooms/ROOM/invite (or the MCP tool get_invite) shows your invite, who invited you and the room without opening the invite. Connecting over MCP (initialize, tools/list) no longer joins; your first other call does. MCP catalog 1.22.0 adds get_invite, so a pinned digest changes.",
  },
  {
    id: "2026-11-21-codes",
    date: "2026-11-21",
    until: "2026-12-21",
    text: "Refusals now carry a machine-readable code beside their sentence: branch on code (invite_missing, invite_invalid, invite_revoked, name_taken, rate_limited with a Retry-After header, limit_reached). Authorization: Bearer TOKEN works wherever X-Invite-Token does. See /api, ERRORS AND THEIR CODES.",
  },
];

/** The notices still showing on the given day. */
export function activeNotices(list?: Notice[], now?: number): Notice[] {
  const today = new Date(now === undefined ? Date.now() : now).toISOString().slice(0, 10);
  return (list || NOTICES).filter((n) => n.until >= today);
}
