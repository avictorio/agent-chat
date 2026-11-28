// npm run skills: builds the skills every MCP address serves
// (worker/agents/skills/build.ts, from the templates, facts.ts and the texts
// it names) and writes worker/agents/skills/served/: each file, and index.ts,
// the one module the Worker imports for them. A new version of a skill is
// appended to worker/agents/skills/versions.json, which only grows. It refuses,
// writing nothing, when a skill's files changed and its metadata.version did
// not move (or moved by more than one), naming the skill and what to do.
//
// npm run skills -- --check writes nothing: it exits 1 naming every file that
// differs from a fresh build (tests/unit/skills-build.test.mjs checks the same).
//
// Runs the Worker's modules in Node through the unit tests' loader hooks
// (package.json's "skills" script), as bridge:keygen does.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkills, digestOf, manifestDigest, renderIndex, skillEntry, versionRule } from "../worker/agents/skills/build.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "worker", "agents", "skills");
const SERVED = path.join(DIR, "served");
const VERSIONS = path.join(DIR, "versions.json");
const check = process.argv.includes("--check");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

let skills;
try { skills = buildSkills(); } catch (e) { console.error("skills: " + (e && e.message)); process.exit(1); }
const digests = new Map();
for (const s of skills) for (const f of s.files) digests.set(f.uri, await digestOf(f.text));
const manifests = [];
for (const s of skills) manifests.push({ name: s.name, version: s.frontmatter.metadata.version, digest: await manifestDigest(skillEntry(s, digests)) });
let record = {};
if (existsSync(VERSIONS)) {
  try { record = JSON.parse(readFileSync(VERSIONS, "utf8")); } catch (e) { console.error("skills: " + rel(VERSIONS) + " does not parse (" + e.message + "): put it back as it was committed"); process.exit(1); }
}
const v = versionRule(record, manifests);
if (!v.ok) { console.error("skills: " + v.problem + ". Nothing was written."); process.exit(1); }

/** every file this build writes, by absolute path */
const want = new Map();
for (const s of skills) for (const f of s.files) want.set(path.join(SERVED, s.name, ...f.path.split("/")), f.text);
want.set(path.join(SERVED, "index.ts"), renderIndex(skills, digests));
want.set(VERSIONS, JSON.stringify(v.record, null, 2) + "\n");

/** every file under served/ now, by absolute path */
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const present = walk(SERVED);
const stale = [...want].filter(([p, text]) => !existsSync(p) || readFileSync(p, "utf8") !== text).map(([p]) => p);
const extra = present.filter((p) => !want.has(p));

if (check) {
  if (!stale.length && !extra.length) { console.log("skills: served/ and versions.json are those of a fresh build (" + want.size + " files)"); process.exit(0); }
  for (const p of stale) console.error("skills: " + rel(p) + " differs from a fresh build");
  for (const p of extra) console.error("skills: " + rel(p) + " is no file of the build");
  console.error("skills: run npm run skills");
  process.exit(1);
}
for (const p of extra) rmSync(p);
// directories left empty by a removed file
const dirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => [...dirs(path.join(dir, e.name)), path.join(dir, e.name)]) : []);
for (const d of dirs(SERVED)) if (!readdirSync(d).length) rmdirSync(d);
for (const p of stale) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, want.get(p)); }
for (const a of v.added) console.log("skills: new version " + a + " recorded in " + rel(VERSIONS));
console.log("skills: " + (stale.length + extra.length ? "wrote " + stale.length + " file(s), removed " + extra.length : "nothing to write") + "; " + want.size + " files in all");
