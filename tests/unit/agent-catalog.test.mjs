// The agent key's MCP catalog (worker/agents/mcp.ts mcpAgentCatalog): its
// own four tools, then exactly the room catalog with "room" first and
// required and without the owner key's "as", three sentences replaced; the
// sentences replaced are still in the room descriptions (an edit there
// fails here instead of dropping the replacement unseen); every title its
// own; and both catalogs' (version, digest) pairs pinned, so a digest that
// moves without its version fails. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_DESCRIPTION_SWAPS, AGENT_TOOL_TITLES, MCP_AGENT_CATALOG_VERSION, MCP_CATALOG_VERSION, MCP_TOOL_TITLES, mcpAgentCatalog, mcpAgentCatalogBuilt, mcpCatalog, mcpCatalogBuilt, mcpHasAgentTool } from "../../worker/agents/mcp.ts";
import { AGENT_GLANCE_GAP_S } from "../../worker/limits.ts";

const OWN = ["list_rooms", "whats_waiting", "add_room", "remove_room"];

test("the agent catalog is its four tools, then every room tool with room first and required and no as", () => {
  const agent = mcpAgentCatalog(), room = mcpCatalog();
  assert.deepEqual(agent.map((t) => t.name), [...OWN, ...room.map((t) => t.name)]);
  const swaps = new Map(AGENT_DESCRIPTION_SWAPS.map(([n, was, now]) => [n, [was, now]]));
  for (const [i, r] of room.entries()) {
    const a = agent[OWN.length + i];
    const props = Object.keys(a.inputSchema.properties);
    assert.equal(props[0], "room", a.name);
    assert.deepEqual(a.inputSchema.properties.room, { type: "string", description: "The room's name, as list_rooms gives it." });
    assert.ok(!props.includes("as"), a.name + " offers as");
    assert.deepEqual(props.slice(1), Object.keys(r.inputSchema.properties).filter((k) => k !== "as"), a.name + ": its own arguments, in order");
    for (const k of props.slice(1)) assert.deepEqual(a.inputSchema.properties[k], r.inputSchema.properties[k], a.name + "." + k);
    assert.deepEqual(a.inputSchema.required, ["room", ...r.inputSchema.required], a.name);
    assert.equal(a.inputSchema.additionalProperties, false);
    assert.equal(a.title, r.title);
    assert.deepEqual(a.annotations, r.annotations, a.name);
    const sw = swaps.get(r.name);
    assert.equal(a.description, sw ? r.description.replace(sw[0], sw[1]) : r.description, a.name);
    assert.deepEqual(Object.keys(a), ["name", "title", "description", "inputSchema", "annotations"]);
  }
  assert.equal(room.filter((t) => "as" in t.inputSchema.properties).length, 38, "the room tools that offer as");
  for (const n of OWN) assert.ok(mcpHasAgentTool(n));
  for (const n of ["constructor", "__proto__", "toString", "mcp"]) assert.ok(!mcpHasAgentTool(n), n);
});

test("the three replaced sentences are in the room descriptions, and only there through the key", () => {
  const room = Object.fromEntries(mcpCatalog().map((t) => [t.name, t.description]));
  const agent = Object.fromEntries(mcpAgentCatalog().map((t) => [t.name, t.description]));
  assert.deepEqual(AGENT_DESCRIPTION_SWAPS.map((s) => s[0]), ["get_members", "get_start_page", "leave_room"]);
  for (const [name, was, now] of AGENT_DESCRIPTION_SWAPS) {
    assert.ok(room[name].includes(was), name + ": the room description no longer has the sentence the key replaces: " + was);
    assert.equal(room[name].split(was).length, 2, name + ": once");
    assert.ok(!agent[name].includes(was) || now.startsWith(was), name);
    assert.ok(agent[name].includes(now), name);
  }
  assert.ok(agent.get_members.includes("On this address no row carries an invite link or invite note, yours included: your key never gives out a room's token."));
  assert.ok(!/invite link, so a lost one can be re-sent/.test(agent.get_members));
  assert.ok(agent.get_start_page.endsWith("The same text as a GET of /api/rooms/ROOM with that room's token, with one line first saying it came through your key."));
  assert.ok(agent.leave_room.endsWith("Same as POST /api/rooms/ROOM/leave. Through your key, it also marks the room on your key as left; take it off with remove_room."));
});

test("the four tools of the key's own: titles, arguments, hints and descriptions", () => {
  const by = Object.fromEntries(mcpAgentCatalog().map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(AGENT_TOOL_TITLES), OWN);
  for (const n of OWN) assert.equal(by[n].title, AGENT_TOOL_TITLES[n]);
  assert.deepEqual(by.list_rooms.inputSchema, { type: "object", properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(by.whats_waiting.inputSchema, { type: "object", properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(Object.keys(by.add_room.inputSchema.properties), ["room", "token"]);
  assert.deepEqual(by.add_room.inputSchema.required, ["room", "token"]);
  assert.deepEqual(by.remove_room.inputSchema.required, ["room"]);
  const look = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
  assert.deepEqual(by.list_rooms.annotations, look);
  assert.deepEqual(by.whats_waiting.annotations, look);
  assert.deepEqual(by.add_room.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(by.remove_room.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  assert.ok(by.whats_waiting.description.endsWith("At most once every " + AGENT_GLANCE_GAP_S + " seconds."), "the gap from limits.ts");
  for (const n of OWN) assert.ok(/joins nothing|joins no room|Your seat stays/.test(by[n].description), n + " says what it joins");
  // no description through the key gives out or asks for a token in the URL, or a User-Agent
  const text = JSON.stringify(mcpAgentCatalog());
  assert.ok(!/[?&]invite=/.test(text));
  assert.ok(!/user[- ]?agent/i.test(text));
});

test("every title differs, across both lists, and every tool has one", () => {
  const titles = mcpAgentCatalog().map((t) => t.title);
  assert.ok(titles.every((t) => typeof t === "string" && t.length > 0));
  assert.equal(new Set(titles).size, titles.length);
  for (const n of OWN) assert.ok(!(n in MCP_TOOL_TITLES), n + " is no room tool");
});

// A version that moves with its digest: an edit of either catalog moves
// its digest, and must move its version too (and the room catalog's
// moves the agent's, which derives from it).
test("the (version, digest) pairs of both catalogs are the pinned ones", () => {
  assert.deepEqual([MCP_CATALOG_VERSION, mcpCatalogBuilt().digest], ["1.38.0", "d1e0ba642e2dc5bc"]);
  assert.deepEqual([MCP_AGENT_CATALOG_VERSION, mcpAgentCatalogBuilt().digest], ["1.0.0", "c573bae645e86491"]);
  assert.equal(mcpCatalogBuilt().tools.length, 41);
  assert.equal(mcpAgentCatalogBuilt().tools.length, 45);
});
