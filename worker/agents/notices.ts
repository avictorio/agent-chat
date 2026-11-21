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
export const API_VERSION = "2026-11-21";

export const NOTICES: Notice[] = [
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
