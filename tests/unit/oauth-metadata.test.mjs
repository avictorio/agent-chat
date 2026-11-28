// The sign-in's documents (worker/routes/oauth.ts wellKnownRoute, from
// worker/lib/oauth.ts): each exactly as the issuer publishes it, its own
// cache header (never no-store: json() would add that by itself) and open
// to every origin, 405 on other methods, 404 for every other path under
// them, nothing read from the request, and no discovery file. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSigninWorld, document, ORIGIN } from "./signin-world.mjs";

const AS = {
  issuer: ORIGIN,
  authorization_endpoint: ORIGIN + "/oauth/authorize",
  token_endpoint: ORIGIN + "/api/oauth/token",
  revocation_endpoint: ORIGIN + "/api/oauth/revoke",
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  token_endpoint_auth_signing_alg_values_supported: ["ES256", "PS384"],
  revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  revocation_endpoint_auth_signing_alg_values_supported: ["ES256", "PS384"],
  dpop_signing_alg_values_supported: ["ES256", "PS384"],
  scopes_supported: ["rooms"],
  protected_resources: [ORIGIN, ORIGIN + "/api/mcp/signin"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
};

test("each document exactly as published, byte for byte, cached an hour and open to every origin, never no-store", async () => {
  const w = makeSigninWorld([]);
  const want = {
    "/.well-known/oauth-protected-resource": { resource: ORIGIN, authorization_servers: [ORIGIN], scopes_supported: ["rooms"] },
    "/.well-known/oauth-protected-resource/api/mcp/signin": { resource: ORIGIN + "/api/mcp/signin", authorization_servers: [ORIGIN], scopes_supported: ["rooms"], bearer_methods_supported: ["header"], resource_name: "Agent Chat", resource_documentation: ORIGIN + "/api" },
    "/.well-known/oauth-authorization-server": AS,
  };
  for (const [path, doc] of Object.entries(want)) {
    const mark = w.asked.length;
    const r = await document(w, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.text, JSON.stringify(doc), path + ": byte for byte");
    assert.equal(r.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=3600", path);
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*", path);
    assert.deepEqual(w.asked.slice(mark), [], path + ": no object asked, nothing stored");
    const h = await document(w, path, "HEAD");
    assert.deepEqual([h.status, h.text, h.headers.get("Cache-Control")], [200, "", "public, max-age=3600"], path + " HEAD");
    for (const m of ["POST", "PUT", "DELETE"]) {
      const x = await document(w, path, m);
      assert.deepEqual([x.status, x.json], [405, { error: "Method not allowed" }], path + " " + m);
    }
  }
  // nothing of the request reaches a document: a cookie, a credential and a query change nothing
  const plain = await document(w, "/.well-known/oauth-authorization-server");
  const r = await read(w, "/.well-known/oauth-authorization-server?x=1", { Cookie: "a=b", Authorization: "Bearer .ac1.x", "X-Owner-Key": "k" });
  assert.equal(r.text, plain.text);
});

import { wellKnownRoute } from "../../worker/routes/oauth.ts";
import { read as readRes } from "./agent-world.mjs";
const read = (w, path, headers) => readRes(wellKnownRoute(w.rc("GET", path, { headers })));

test("no other path-specific document: /.well-known/oauth-protected-resource/api/mcp and every other path under them answer 404; other /.well-known paths are not the sign-in's", async () => {
  const w = makeSigninWorld([]);
  for (const p of ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource/", "/.well-known/oauth-protected-resource/api/mcp/signin/", "/.well-known/oauth-authorization-server/api/mcp/signin", "/.well-known/oauth-protected-resource/api/rooms/lima/mcp"]) {
    const r = await document(w, p);
    assert.deepEqual([r.status, r.json], [404, { error: "not found" }], p);
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  }
  // the discovery file is not served (it is no document of this server's), nor any other well-known path
  for (const p of ["/.well-known/poppy.json", "/.well-known/openid-configuration", "/.well-known/assetlinks.json"]) assert.equal(document(w, p), undefined, p);
});
