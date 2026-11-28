// The skills' runtime (worker/agents/skills.ts): what server/discover
// declares, and the result bodies of skills/list, skills/get,
// resources/list, resources/templates/list and resources/read, each as
// SERVED_SKILLS holds them, with an hour's private ttlMs, and nothing for a
// URI no skill serves. Run with `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import { SKILLS_EXTENSION, mcpDiscoverCapabilities, resourceRead, resourceTemplatesList, resourcesList, skillGet, skillsList } from "../../worker/agents/skills.ts";
import { SERVED_SKILLS } from "../../worker/agents/skills/served/index.ts";
import { MCP_SKILLS_TTL_MS } from "../../worker/limits.ts";

const CACHE = { ttlMs: MCP_SKILLS_TTL_MS, cacheScope: "private" };
const entryOf = (s) => ({ uri: s.uri, frontmatter: s.frontmatter, resources: s.files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })) });

test("server/discover's capabilities: tools, resources and the skills extension with no optional feature, a fresh object each time", () => {
  assert.equal(SKILLS_EXTENSION, "io.modelcontextprotocol/skills");
  const a = mcpDiscoverCapabilities();
  assert.equal(JSON.stringify(a), "{\"tools\":{},\"resources\":{},\"extensions\":{\"io.modelcontextprotocol/skills\":{}}}");
  const b = mcpDiscoverCapabilities();
  assert.notEqual(a, b);
  a.tools.x = 1;
  assert.deepEqual(mcpDiscoverCapabilities().tools, {}, "a change to one answer reaches no other");
});

test("skills/list: every skill in SERVED_SKILLS' order, each entry its URI, frontmatter and every file's URI, digest and size, SKILL.md first", () => {
  const r = skillsList();
  assert.deepEqual(Object.keys(r), ["skills", "ttlMs", "cacheScope"]);
  assert.deepEqual(r, { skills: SERVED_SKILLS.map(entryOf), ...CACHE });
  for (const e of r.skills) {
    assert.deepEqual(Object.keys(e), ["uri", "frontmatter", "resources"]);
    assert.deepEqual(Object.keys(e.frontmatter), ["name", "description", "metadata"]);
    assert.equal(e.resources[0].uri, e.uri, "SKILL.md first");
    assert.deepEqual(e.resources.slice(1).map((x) => x.uri), e.resources.slice(1).map((x) => x.uri).sort(), "the rest in path order");
    for (const x of e.resources) {
      assert.deepEqual(Object.keys(x), ["uri", "digest", "size"]);
      assert.match(x.digest, /^sha256:[0-9a-f]{64}$/);
    }
  }
  assert.equal(r.skills.length, 5);
  assert.equal(r.skills.reduce((n, e) => n + e.resources.length, 0), 22);
});

test("skills/get: one skill by its SKILL.md's URI, the same entry skills/list gives", () => {
  for (const s of SERVED_SKILLS) {
    const r = skillGet(s.uri);
    assert.deepEqual(Object.keys(r), ["skill", "ttlMs", "cacheScope"]);
    assert.deepEqual(r, { skill: entryOf(s), ...CACHE });
  }
});

test("resources/list: every file of every skill, a SKILL.md with its skill's name and description, any other with its own name", () => {
  const r = resourcesList();
  assert.deepEqual(Object.keys(r), ["resources", "ttlMs", "cacheScope"]);
  assert.deepEqual(r.ttlMs, MCP_SKILLS_TTL_MS);
  assert.equal(r.cacheScope, "private");
  const want = SERVED_SKILLS.flatMap((s) => s.files.map((f, i) => (i === 0
    ? { uri: f.uri, name: s.frontmatter.name, title: f.title, description: s.frontmatter.description, mimeType: "text/markdown", size: f.size }
    : { uri: f.uri, name: f.uri.split("/").pop(), title: f.title, mimeType: "text/markdown", size: f.size })));
  assert.deepEqual(r.resources, want);
  for (const x of r.resources) assert.deepEqual(Object.keys(x), "description" in x ? ["uri", "name", "title", "description", "mimeType", "size"] : ["uri", "name", "title", "mimeType", "size"]);
  for (const x of r.resources) assert.ok(x.title.length > 0 && !x.title.startsWith("#"), x.uri + ": its first # heading");
});

test("resources/templates/list: none", () => {
  assert.deepEqual(resourceTemplatesList(), { resourceTemplates: [], ...CACHE });
});

test("resources/read: one file's text, as Markdown, by its URI", () => {
  for (const s of SERVED_SKILLS) {
    for (const f of s.files) {
      const r = resourceRead(f.uri);
      assert.deepEqual(Object.keys(r), ["contents", "ttlMs", "cacheScope"]);
      assert.deepEqual(r, { contents: [{ uri: f.uri, mimeType: "text/markdown", text: f.text }], ...CACHE });
      assert.equal(new TextEncoder().encode(r.contents[0].text).length, f.size);
    }
  }
});

test("a URI no skill serves is none: unknown, a supporting file for skills/get, a directory, a trailing slash, another case, constructor, __proto__", () => {
  const supporting = SERVED_SKILLS.find((s) => s.files.length > 1).files[1].uri;
  assert.equal(skillGet(supporting), null, "a supporting file is no skill");
  assert.ok(resourceRead(supporting), "but it is a resource");
  const bad = ["skill://agent-chat/no-such/SKILL.md", "skill://agent-chat/taking-part", "skill://agent-chat/taking-part/", "skill://agent-chat/taking-part/SKILL.md/", "skill://agent-chat/Taking-Part/SKILL.md", "SKILL://agent-chat/taking-part/SKILL.md", "skill://agent-chat/taking-part/skill.md",
    "skill://agent-chat/playing-games/references", "skill://agent-chat/playing-games/references/", "skill://agent-chat/playing-games/../taking-part/SKILL.md", "constructor", "__proto__", "toString", "hasOwnProperty", "", "taking-part"];
  for (const uri of bad) {
    assert.equal(skillGet(uri), null, "skills/get " + JSON.stringify(uri));
    assert.equal(resourceRead(uri), null, "resources/read " + JSON.stringify(uri));
  }
});
