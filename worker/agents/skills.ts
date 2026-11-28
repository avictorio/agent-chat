// The skills every MCP address serves (skills/list, skills/get,
// resources/list, resources/templates/list, resources/read over the
// revisions without initialize; routes/agents.ts mcpServe dispatches them).
// The answers are made only of SERVED_SKILLS, the files npm run skills
// generated and the repository commits (skills/served/): the same bytes at
// every address and for every caller. Nothing of a room, a credential or a
// member reaches these functions; they take only the URI a caller sent, which
// selects a constant or nothing. This module imports only the limits and the
// served files (tests/unit/skills-build.test.mjs checks), so no room module
// can reach a skill and the Worker bundles no template, fact or build code.

import { MCP_SKILLS_TTL_MS } from "../limits.js";
import { SERVED_SKILLS } from "./skills/served/index.js";
import type { ServedFile, ServedSkill } from "./skills/types.js";

/** The extension's identifier, as server/discover declares it. */
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** Every file is Markdown, sent as text. */
const MIME = "text/markdown";

/** server/discover's capabilities: the tools, the resources the skills'
 *  files are, and the skills extension with no optional feature (no
 *  resources/directory/read). A fresh object for each answer. */
export function mcpDiscoverCapabilities() {
  return { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION]: {} } };
}

/** A skill's entry: its SKILL.md's URI, its frontmatter, and every file's URI,
 *  digest and size, SKILL.md first. */
function entryOf(s: ServedSkill) {
  return {
    uri: s.uri,
    frontmatter: { name: s.frontmatter.name, description: s.frontmatter.description, metadata: { version: s.frontmatter.metadata.version } },
    resources: s.files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })),
  };
}
type Entry = ReturnType<typeof entryOf>;
/** A file as resources/list lists it: a SKILL.md with its skill's name and
 *  description, any other file with its own name. */
function rowOf(f: ServedFile) {
  return f.description === undefined
    ? { uri: f.uri, name: f.name, title: f.title, mimeType: MIME, size: f.size }
    : { uri: f.uri, name: f.name, title: f.title, description: f.description, mimeType: MIME, size: f.size };
}

let built: { entries: Entry[], skills: Map<string, Entry>, files: Map<string, ServedFile>, rows: ReturnType<typeof rowOf>[] } | null = null;
/** The entries and the two lookups (skills by their SKILL.md's URI, files by
 *  URI), built once per isolate from the served constants. Lookups are exact
 *  matches in these Maps, never a property or a path: a directory URI, a
 *  trailing slash, another case, constructor or __proto__ is no skill and no
 *  file. */
function skillsBuilt() {
  if (!built) {
    const entries = SERVED_SKILLS.map(entryOf);
    built = {
      entries,
      skills: new Map(entries.map((e) => [e.uri, e])),
      files: new Map(SERVED_SKILLS.flatMap((s) => s.files.map((f) => [f.uri, f] as const))),
      rows: SERVED_SKILLS.flatMap((s) => s.files.map(rowOf)),
    };
  }
  return built;
}

// Each result body below is what an answer carries besides resultType and
// _meta (mcpServe adds both). The files change only with a deploy: an hour's
// ttlMs, and private, since they are answered only for a credential.

/** skills/list: every skill, one page. */
export function skillsList() {
  return { skills: skillsBuilt().entries, ttlMs: MCP_SKILLS_TTL_MS, cacheScope: "private" };
}
/** skills/get: one skill by its SKILL.md's URI; null for any other URI. */
export function skillGet(uri: string) {
  const skill = skillsBuilt().skills.get(uri);
  return skill ? { skill, ttlMs: MCP_SKILLS_TTL_MS, cacheScope: "private" } : null;
}
/** resources/list: every file of every skill, one page. */
export function resourcesList() {
  return { resources: skillsBuilt().rows, ttlMs: MCP_SKILLS_TTL_MS, cacheScope: "private" };
}
/** resources/templates/list: none. */
export function resourceTemplatesList() {
  return { resourceTemplates: [], ttlMs: MCP_SKILLS_TTL_MS, cacheScope: "private" };
}
/** resources/read: one file's text by its URI; null for any other URI. */
export function resourceRead(uri: string) {
  const f = skillsBuilt().files.get(uri);
  return f ? { contents: [{ uri: f.uri, mimeType: MIME, text: f.text }], ttlMs: MCP_SKILLS_TTL_MS, cacheScope: "private" } : null;
}
