// The invite token's transport (worker/lib/tokens.ts): only a header
// carries it. A token in the URL (?invite=) is retired: nothing reads it and
// no room answer mentions it, so a request that sends only that one is
// answered exactly as one that sends none. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as T from "../../worker/lib/tokens.ts";
import { CORS } from "../../worker/lib/http.ts";

const at = (headers, search) => new Request("https://chat.example/api/rooms/unit/messages" + (search || ""), { headers: headers || {} });

test("headerToken reads X-Invite-Token, else a Bearer token, and nothing else", () => {
  assert.equal(T.headerToken(at({ "X-Invite-Token": "  tok-A_1  " })), "tok-A_1");
  assert.equal(T.headerToken(at({ Authorization: "Bearer tok-B" })), "tok-B");
  assert.equal(T.headerToken(at({ "X-Invite-Token": "tok-A", Authorization: "Bearer tok-B" })), "tok-A", "X-Invite-Token wins");
  assert.equal(T.headerToken(at({ Authorization: "Basic " + Buffer.from("a:b").toString("base64") })), "", "Basic is no token");
  assert.equal(T.headerToken(at({}, "?invite=tok-in-the-url")), "", "a token in the URL is no token");
  assert.equal(T.headerToken(at({ "X-Invite-Token": "tok-A" }, "?invite=tok-in-the-url")), "tok-A", "beside a header token, the URL's is not read");
});

test("the URL token's special answers are gone from tokens.ts", () => {
  for (const name of ["queryTokenNotice", "hasQueryToken", "QUERY_REFUSED", "QUERY_NOTICE", "QUERY_IGNORED", "QUERY_DEPRECATED_AT", "QUERY_RETIRED", "QUERY_RETIRED_MCP"]) assert.ok(!(name in T), name + " is still exported");
  assert.deepEqual(Object.keys(T).sort(), ["MCP_PATH", "headerToken"]);
});

/** every file under worker/, as text */
function workerFiles() {
  const root = new URL("../../worker/", import.meta.url);
  const out = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = new URL(f, dir);
      if (statSync(p).isDirectory()) walk(new URL(f + "/", dir));
      else out.push({ path: p.pathname.slice(root.pathname.length), text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

// The changes feed keeps its dated notices about the retirement (the MCP one
// says the route "no longer reads" a token in the URL, and today's names the
// three headers), so the scan looks for the removed code, not for words.
test("nothing in the Worker builds a URL-token answer any more", () => {
  const files = workerFiles();
  assert.ok(files.length > 50, "found the Worker's files");
  for (const { path, text } of files) {
    assert.ok(!/QUERY_REFUSED|QUERY_NOTICE|QUERY_IGNORED|QUERY_DEPRECATED_AT|QUERY_RETIRED|queryTokenNotice|hasQueryToken/.test(text), path + " still names the URL token's answers");
    assert.ok(!text.includes("no longer read:"), path + " still carries the URL-only refusal's sentence");
    assert.ok(!/\.set\(\s*["'](Deprecation|Sunset|Link)["']/.test(text), path + " sets a Deprecation, Sunset or Link header");
    assert.ok(!/["'](Deprecation|Sunset|Link)["']\s*:/.test(text), path + " has a Deprecation, Sunset or Link header in a headers object");
  }
});

test("browsers are shown Retry-After only", () => {
  assert.equal(CORS["Access-Control-Expose-Headers"], "Retry-After");
});
