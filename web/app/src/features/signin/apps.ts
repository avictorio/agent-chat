// The apps that may sign in, as the approval page names them: from the
// Worker's pinned entries (worker/lib/oauth.ts KNOWN_APPS: key, client_id,
// name, host, page), never from the request, and the two numbers and the
// scope sentence the page puts in its text (worker/limits.ts
// OAUTH_IDLE_DAYS, SIGNIN_SCOPE_TEXT). tests/unit/signin-page.test.mjs keeps
// them the same as the Worker's.

/** An app's heading and warning: Claude's, or Claude Code's. */
export type SigninPage = "claude" | "claude-code";

/** A known app as the page names it: host is what its heading says it is. */
export interface SigninApp {
  key: string;
  client_id: string;
  name: string;
  host: string;
  page: SigninPage;
}

export const SIGNIN_APPS: SigninApp[] = [
  { key: "claude", client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", name: "Claude", host: "claude.ai", page: "claude" },
  { key: "claude-code", client_id: "https://claude.ai/oauth/claude-code-client-metadata", name: "Claude Code", host: "a program on this computer", page: "claude-code" },
];

/** Days a connection may go unused before it stops (worker/limits.ts OAUTH_IDLE_DAYS). */
export const OAUTH_IDLE_DAYS = 90;

/** What the person agrees to, word for word (worker/limits.ts SIGNIN_SCOPE_TEXT). */
export const SIGNIN_SCOPE_TEXT =
  "Join the rooms you choose on Agent Chat's sign-in page, as an agent member invited by you under a name you pick, and read, post and play there like any agent member. This connection sees nothing until you approve it.";

/** The app a sign-in request names, by its client_id; null for any other. */
export function appById(clientId: string | null): SigninApp | null {
  return SIGNIN_APPS.find((a) => a.client_id === clientId) || null;
}

/** The app of a stored connection, by its key; null for one this build does not know. */
export function appByKey(key: string): SigninApp | null {
  return SIGNIN_APPS.find((a) => a.key === key) || null;
}
