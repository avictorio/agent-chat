// The texts the skills' facts are held to (worker/agents/skills/facts.ts),
// rendered as the site serves them, and the sentence a fact's words sit in.
// tests/unit/skills-build.test.mjs renders this checkout's; the differential
// check (tests/api/differential.js) renders two checkouts' to see a served
// sentence change under a fact that stays the same. Loaded through the unit
// tests' module hooks (tests/unit/register.mjs).
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Every fact source of the checkout at root: source(k) gives its text as
 *  served (start pages from tests/unit/start-views.mjs, the watcher's pin
 *  version "0" and SHA-256 of zeros, every text at the site's origin) and the
 *  tool and argument names it stands for. A "docs#HEADING" or "games#HEADING"
 *  source is that section of /api or /api/games. With lenient (another
 *  checkout, which may be older), a module or export it lacks gives "" rather
 *  than an error. */
export async function factSources(root, { lenient = false } = {}) {
  const load = async (p) => {
    try { return await import(pathToFileURL(path.join(root, p)).href); } catch (e) { if (lenient) return {}; throw e; }
  };
  const LIM = await load("worker/limits.ts");
  const ST = await load("worker/agents/start.ts");
  const views = await load("tests/unit/start-views.mjs");
  const D = await load("worker/agents/docs.ts");
  const OB = await load("worker/agents/onboarding.ts");
  const M = await load("worker/agents/mcp.ts");
  const O = LIM.SITE_ORIGIN || "";
  const PIN = { version: "0", sha256: "0".repeat(64) };
  const safe = (f) => { try { return f() || ""; } catch (e) { if (lenient) return ""; throw e; } };
  const catalog = (f) => safe(() => (f ? f() : []));
  const CATALOGS = { tool: catalog(M.mcpCatalog), "agent-tool": catalog(M.mcpAgentCatalog), "signin-tool": catalog(M.mcpSigninCatalog) };
  CATALOGS.arg = CATALOGS.tool; CATALOGS["agent-arg"] = CATALOGS["agent-tool"]; CATALOGS["signin-arg"] = CATALOGS["signin-tool"];
  const page = (view, viaKey, viaSignin) => safe(() => ST.startPage(view, O, views.ROOM, PIN, ST.START_LIMITS, false, viaKey, viaSignin));
  const cache = new Map();
  /** @param k a FactSource */
  function source(k) {
    if (cache.has(k)) return cache.get(k);
    const [kind, section] = k.split("#");
    let text, names = [];
    if (kind === "start:unjoined") text = page(views.base, false, false);
    else if (kind === "start:joined") text = page(views.joined, false, false);
    else if (kind === "start:key") text = page(views.base, true, false);
    else if (kind === "start:signin") text = page(views.base, false, true);
    else if (kind === "docs") text = safe(() => D.docs(O));
    else if (kind === "games") text = safe(() => D.gamesDocs(O));
    else if (kind === "llms") text = safe(() => D.primer(O));
    else if (kind === "instructions:room") text = safe(() => OB.mcpInstructions(O, "ok"));
    else if (kind === "instructions:key") text = safe(() => OB.agentInstructions(O, "ok"));
    else if (kind === "instructions:signin") text = safe(() => OB.signinInstructions(O));
    else {
      let m;
      if ((m = /^onboarding:(\w+)$/.exec(kind))) { const v = OB[m[1]]; text = typeof v === "function" ? safe(() => v(O)) : typeof v === "string" ? v : ""; }
      else if ((m = /^((?:agent-|signin-)?tool):(\w+)$/.exec(kind))) { text = (CATALOGS[m[1]].find((t) => t.name === m[2]) || {}).description || ""; names = [m[2]]; }
      else if ((m = /^((?:agent-|signin-)?arg):(\w+)\.(\w+)$/.exec(kind))) { const t = CATALOGS[m[1]].find((x) => x.name === m[2]); text = (t && t.inputSchema.properties[m[3]] && t.inputSchema.properties[m[3]].description) || ""; names = [m[2], m[3]]; }
      else throw new Error("unknown fact source " + k + " (facts.ts FactSource names the kinds)");
    }
    if (section !== undefined) {
      if (kind !== "docs" && kind !== "games") throw new Error(k + ": only docs and games have sections");
      text = sectionNamed(text, section);
    }
    const r = { text, names };
    cache.set(k, r);
    return r;
  }
  return { source, CATALOGS, origin: O };
}

/** A section of a served text: from its heading line (NAME, or NAME (...))
 *  to the line before the next line at the margin, trailing empty lines left
 *  out; "" when there is none. */
export function sectionNamed(text, name) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l === name || l.startsWith(name + " ("));
  if (i < 0) return "";
  let j = i + 1;
  while (j < lines.length && (lines[j] === "" || lines[j].startsWith(" "))) j++;
  return lines.slice(i, j).join("\n").replace(/\n+$/, "");
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
/** A text as its sentences, each with runs of whitespace as one space, and
 *  the same text with them joined by one space, with where each starts and
 *  ends there. A sentence ends at . ! or ? before whitespace, at an empty
 *  line, and at a line break beside a line at the margin (a heading of /api,
 *  any line of a start page); a line break between two indented lines of /api
 *  wraps one paragraph. */
export function sentencesOf(text) {
  const lines = text.split("\n");
  const chunks = [];
  let cur = [];
  const atMargin = (l) => /^\S/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const breakHere = i > 0 && (l.trim() === "" || lines[i - 1].trim() === "" || atMargin(l) || atMargin(lines[i - 1]));
    if (breakHere && cur.length) { chunks.push(cur.join(" ")); cur = []; }
    if (l.trim() !== "") cur.push(l);
  }
  if (cur.length) chunks.push(cur.join(" "));
  const sentences = chunks.flatMap((c) => norm(c).split(/(?<=[.!?])\s+/)).filter((s) => s.length);
  const spans = [];
  let at = 0;
  for (const s of sentences) { spans.push([at, at + s.length]); at += s.length + 1; }
  return { sentences, joined: sentences.join(" "), spans };
}

/** Where needle (runs of whitespace as one space; with fold, case folded
 *  too) sits in text: its every place, and for the first, the sentences it
 *  covers, the part of its first sentence before it (head) and of its last
 *  after it (tail). null when it is not there. */
export function placeOf(text, needle, { fold = false } = {}) {
  const { joined, spans } = sentencesOf(text);
  const hay = fold ? joined.toLowerCase() : joined;
  const want = fold ? norm(needle).toLowerCase() : norm(needle);
  if (!want) return null;
  const at = [];
  for (let i = hay.indexOf(want); i >= 0; i = hay.indexOf(want, i + 1)) at.push(i);
  if (!at.length) return null;
  const i = at[0], j = i + want.length;
  const first = spans.find(([s, e]) => s <= i && i < e) || [i, j];
  const last = spans.find(([s, e]) => s < j && j <= e) || first;
  return { count: at.length, head: joined.slice(first[0], i), tail: joined.slice(j, last[1]), sentence: joined.slice(first[0], last[1]) };
}
