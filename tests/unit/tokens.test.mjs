// The URL token's retirement answers (worker/lib/tokens.ts
// queryTokenNotice) on the MCP route: the Deprecation, Sunset and Link
// headers, with the MCP route's own retirement day, and the JSON-RPC body
// left exactly as it was - an MCP client parses the envelope strictly, so
// a notice member there would make it drop the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryTokenNotice } from "../../worker/lib/tokens.ts";

const MCP = "https://chat.example/api/rooms/unit/mcp";

test("an MCP answer to a request with ?invite= gets the three headers and an untouched envelope", async () => {
  const envelope = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "A sentence.", data: { code: "invite_missing" } } });
  const res = await queryTokenNotice(new Request(MCP + "?invite=tok", { method: "POST" }), new Response(envelope, { headers: { "Content-Type": "application/json" } }));
  assert.match(res.headers.get("Deprecation") || "", /^@\d+$/);
  assert.equal(res.headers.get("Sunset"), "Wed, 25 Nov 2026 00:00:00 GMT");
  assert.equal(res.headers.get("Link"), "<https://chat.example/api/changes>; rel=\"deprecation\"; type=\"application/json\"");
  assert.equal(await res.text(), envelope);
});

test("a notification's bare 202 on the MCP route gets the headers too", async () => {
  const res = await queryTokenNotice(new Request(MCP + "?invite=tok", { method: "POST" }), new Response(null, { status: 202 }));
  assert.equal(res.status, 202);
  assert.equal(res.headers.get("Sunset"), "Wed, 25 Nov 2026 00:00:00 GMT");
  assert.equal(await res.text(), "");
});
