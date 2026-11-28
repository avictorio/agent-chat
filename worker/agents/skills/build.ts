// The skills every MCP address serves (worker/agents/skills.ts), built from
// the five templates (templates/NAME/SKILL.md), the facts (facts.ts) and the
// game reference's sections. It runs only under npm run skills
// (scripts/skills.mjs, which writes served/ and versions.json) and the unit
// tests (tests/unit/skills-build.test.mjs, which build again and compare): the
// Worker never imports it, and bundles the committed served/ files instead.
//
// Everything here is a pure function of repository files and constants: no
// environment, request, clock or storage, and buildSkills() takes no
// argument, so nothing of a room or a member can reach a skill.

import {
  SITE_ORIGIN,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_MAX,
  SKILL_FILES_MAX,
  SKILL_MD_LINES_MAX,
  SKILL_MD_MAX,
  SKILL_TOTAL_MAX,
  SKILLS_MAX,
} from "../../limits.js";
import { docs, docsValues, gamesDocs } from "../docs.js";
import { mcpAgentCatalog, mcpCatalog, mcpSigninCatalog, type McpTool } from "../mcp.js";
import { GAME_ENGINES } from "../../games/engine.js";
import { FACTS } from "./facts.js";
import type { SkillFrontmatter } from "./types.js";
import DOCS_TXT from "../docs.txt";
import GAMES_TXT from "../games.txt";
import TAKING_PART from "./templates/taking-part/SKILL.md";
import STAYING_PRESENT from "./templates/staying-present/SKILL.md";
import PLAYING_GAMES from "./templates/playing-games/SKILL.md";
import ROOM_BOARD from "./templates/room-board/SKILL.md";
import SHARING_FILES from "./templates/sharing-files/SKILL.md";

/** The skills, in the order skills/list gives them. */
export const SKILL_ORDER = ["taking-part", "staying-present", "playing-games", "room-board", "sharing-files"];
/** Every skill's URI starts so: the scheme, and the service's name as the authority. */
export const SKILL_PREFIX = "skill://agent-chat/";
const TEMPLATES: Record<string, string> = {
  "taking-part": TAKING_PART,
  "staying-present": STAYING_PRESENT,
  "playing-games": PLAYING_GAMES,
  "room-board": ROOM_BOARD,
  "sharing-files": SHARING_FILES,
};
/** The placeholders an included section may hold: game rules, which move
 *  only with a game's change. Any other fails the build. */
export const SKILL_PLACEHOLDERS = ["origin", "FL_TROOPS", "TT_MAX", "EC_MAX", "WW_TALK_MAX", "SG_IMAGE_KB", "TV_Q_MAX", "TV_A_MAX"];
/** Result fields and codes the skills name, each of which /api must name too. */
export const FIELD_WORDS = ["last_id", "has_more", "awaiting_you", "mcp_call", "how_to_play", "legal_moves", "base_updated", "client_msg_id", "publish_on_complete", "rate_limited", "retry_after"];
/** The addresses a skill may name in backticks, each of which /api must name too. */
export const PATH_LITERALS = ["/api/rooms/ROOM/mcp", "/api/mcp", "/api/mcp/signin"];
/** One reference file per game: its engine id (the file's name, and what
 *  create_game's game takes), its games.txt heading, and its title as GAMES -
 *  CHOOSING names it; games.txt's order. Every key of GAME_ENGINES once. */
export const GAME_REFERENCES: Array<[id: string, heading: string, title: string]> = [
  ["lightcycles", "GAMES - LIGHT CYCLES", "Light Cycles"],
  ["duel", "GAMES - DUEL", "Duel"],
  ["battleship", "GAMES - BATTLESHIP", "Battleship"],
  ["frontlines", "GAMES - FRONTLINES", "Frontlines"],
  ["coderace", "GAMES - CODE RACE", "Code Race"],
  ["fourinarow", "GAMES - FOUR IN A ROW", "Four in a Row"],
  ["trust", "GAMES - TRUST", "Trust"],
  ["auction", "GAMES - AUCTION", "Auction"],
  ["liarsdice", "GAMES - LIAR'S DICE", "Liar's Dice"],
  ["twotruths", "GAMES - TWO TRUTHS AND A LIE", "Two Truths and a Lie"],
  ["corpse", "GAMES - EXQUISITE CORPSE", "Exquisite Corpse"],
  ["twenty", "GAMES - TWENTY QUESTIONS", "Twenty Questions"],
  ["werewolf", "GAMES - WEREWOLF", "Werewolf"],
  ["lettergrid", "GAMES - LETTER GRID", "Letter Grid"],
  ["trivia", "GAMES - TRIVIA", "Trivia"],
  ["sketch", "GAMES - SKETCH & GUESS", "Sketch & Guess"],
];
/** The Agent Skills name rule (and the official client's SKILL_NAME_PATTERN). */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The one frontmatter form a template may have, and a served SKILL.md has:
 *  block mappings, the description double-quoted printable ASCII with no " or
 *  \ (so its YAML and its JSON hold the same characters), the version a
 *  quoted decimal (a string), then one empty line. */
const FRONTMATTER_RE = /^---\nname: ([^\n]*)\ndescription: "([^"\\\n]*)"\nmetadata:\n {2}version: "([^"\\\n]*)"\n---\n\n/;

/** A built file of a skill: its path in the skill, its URI, the name and title
 *  resources/list gives it, the description (SKILL.md only), and its text. */
export type BuiltFile = { path: string, uri: string, name: string, title: string, description?: string, text: string };
/** A built skill: its name, its SKILL.md's URI, its frontmatter, its files
 *  (SKILL.md first, then the rest in path order) and the facts it uses. */
export type BuiltSkill = { name: string, uri: string, frontmatter: SkillFrontmatter, files: BuiltFile[], facts: string[] };
/** What a broken rule is about: the test of tests/unit/skills-build.test.mjs that names it. */
export type SkillRule = "directive" | "names" | "form" | "games" | "room-text";
export type SkillProblem = { rule: SkillRule, message: string };

const norm = (s: string) => s.replace(/\s+/g, " ");
const isSnake = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** The tool catalogs a skill's names are checked against: the room's, the
 *  agent key's and the sign-in's. */
function catalogs(): McpTool[][] {
  return [mcpCatalog(), mcpAgentCatalog(), mcpSigninCatalog()];
}
function toolOf(name: string): McpTool[] {
  return catalogs().map((c) => c.find((t) => t.name === name)).filter((t): t is McpTool => !!t);
}
/** Whether ARG is an argument of TOOL in one of the catalogs. */
function argOf(tool: string, arg: string) {
  return toolOf(tool).some((t) => Object.hasOwn(t.inputSchema.properties, arg));
}
/** Whether VALUE is in the enum of TOOL's action argument in one of the catalogs. */
function actionOf(tool: string, value: string) {
  return toolOf(tool).some((t) => {
    const a = Object.hasOwn(t.inputSchema.properties, "action") ? (t.inputSchema.properties.action as { enum?: unknown[] }) : null;
    return !!a && Array.isArray(a.enum) && a.enum.includes(value);
  });
}

/** A fact's text with its {{arg TOOL.ARG}} and {{action TOOL.VALUE}}
 *  rendered as the backticked name; each named one that no schema has is
 *  pushed to missing. */
function renderFactText(text: string, missing?: string[]) {
  return text.replace(/\{\{(arg|action) (\w+)\.(\w+)\}\}/g, (_all, kind: string, tool: string, word: string) => {
    if (!(kind === "arg" ? argOf(tool, word) : actionOf(tool, word))) missing?.push(kind + " " + tool + "." + word);
    return "`" + word + "`";
  });
}
/** A fact's text as a skill serves it. @param id a key of FACTS */
export function factText(id: string) {
  const f = Object.hasOwn(FACTS, id) ? FACTS[id] : undefined;
  if (!f) throw new Error("no fact " + id + " in worker/agents/skills/facts.ts");
  return renderFactText(f.text);
}
/** A fact's terms: its snake_case words, backticked spans, digit runs (a
 *  leading minus kept) and double-quoted strings. */
export function termsOf(text: string): string[] {
  return [...new Set([
    ...(text.match(isSnake) || []),
    ...[...text.matchAll(/`([^`]+)`/g)].map((x) => x[1]),
    ...(text.match(/-?\d+/g) || []),
    ...[...text.matchAll(/"([^"]+)"/g)].map((x) => x[1]),
  ])];
}
/** A fact's negation and quantifier words: each of LIMIT_WORDS (facts.ts) it
 *  holds as a whole word in any case, and every word ending in n't. */
export function limitWordsOf(text: string, words: readonly string[]): string[] {
  return [...new Set([...words.filter((w) => new RegExp("\\b" + w + "\\b", "i").test(text)), ...(text.match(/\b\w+n't\b/gi) || []).map((w) => w.toLowerCase())])];
}
/** Whether the word (one of limitWordsOf's) is in the text, as a whole word in any case. */
export function holdsWord(text: string, word: string) {
  return new RegExp("\\b" + word + "\\b", "i").test(text);
}

/** A section of docs.txt or games.txt (raw or served): from its heading line
 *  to the line before the next line at the margin, trailing empty lines left
 *  out; "" when there is no such heading. */
export function sectionOf(text: string, heading: string) {
  const lines = text.split("\n");
  const i = lines.indexOf(heading);
  if (i < 0) return "";
  let j = i + 1;
  while (j < lines.length && (lines[j] === "" || lines[j].startsWith(" "))) j++;
  return lines.slice(i, j).join("\n").replace(/\n+$/, "");
}
/** Whether a heading NAME, or NAME (...), opens a section of docs.txt or games.txt. */
function headingExists(name: string) {
  const heads = (DOCS_TXT + "\n" + GAMES_TXT).split("\n").filter((l) => /^[A-Z]/.test(l));
  return heads.includes(name) || heads.some((h) => h.startsWith(name + " ("));
}

/** A section included in a reference file: its placeholders filled from
 *  docsValues, which only SKILL_PLACEHOLDERS may be; null with the problem
 *  pushed otherwise. */
function included(raw: string, heading: string, served: string, problems: SkillProblem[]) {
  const sec = sectionOf(raw, heading);
  if (!sec) { problems.push({ rule: "games", message: "no section " + heading + " in docs.txt or games.txt: GAME_REFERENCES (worker/agents/skills/build.ts) names a heading that is gone" }); return null; }
  const values: Record<string, unknown> = docsValues(SITE_ORIGIN);
  const bad: string[] = [];
  const filled = sec.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => { if (!SKILL_PLACEHOLDERS.includes(k)) bad.push(k); return String(values[k]); });
  if (bad.length) { problems.push({ rule: "form", message: heading + " holds {{" + bad.join("}}, {{") + "}}, which a skill may not include: only SKILL_PLACEHOLDERS (worker/agents/skills/build.ts), the game rules, may appear in an included section" }); return null; }
  if (filled.includes("```")) { problems.push({ rule: "form", message: heading + " holds three backticks, which would end the reference file's fence" }); return null; }
  // the same bytes the site serves for that section
  if (filled !== sectionOf(served, heading)) { problems.push({ rule: "form", message: heading + " as filled here differs from the served section: docsValues and the build fill it differently" }); return null; }
  return filled;
}
const fence = (s: string) => "```text\n" + s + "\n```\n";

/** The words of the site a skill may name: every tool of the three catalogs,
 *  and every argument name and enum value of their schemas. */
function knownNames() {
  const tools = new Set<string>(), schema = new Set<string>();
  for (const c of catalogs()) {
    for (const t of c) {
      tools.add(t.name);
      for (const [k, v] of Object.entries(t.inputSchema.properties)) {
        schema.add(k);
        const e = (v as { enum?: unknown[] }).enum;
        for (const x of Array.isArray(e) ? e : []) if (typeof x === "string") schema.add(x);
      }
    }
  }
  return { tools, schema };
}

/** The frontmatter as a served SKILL.md begins. */
function frontmatterText(f: SkillFrontmatter) {
  return "---\nname: " + f.name + "\ndescription: \"" + f.description + "\"\nmetadata:\n  version: \"" + f.metadata.version + "\"\n---\n\n";
}

/** One skill's template expanded, and its own words (the template's body with
 *  every directive taken out), or null with the problem pushed. */
function expand(name: string, problems: SkillProblem[]) {
  const tpl = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : undefined;
  if (tpl === undefined) { problems.push({ rule: "form", message: name + " is in SKILL_ORDER but has no template: add worker/agents/skills/templates/" + name + "/SKILL.md and import it in build.ts" }); return null; }
  const m = FRONTMATTER_RE.exec(tpl);
  if (!m) { problems.push({ rule: "form", message: name + "'s template does not begin with the one frontmatter form: ---, name: NAME, description: \"...\" (printable ASCII, no \" or \\), metadata: / version: \"N\", ---, then an empty line" }); return null; }
  const frontmatter: SkillFrontmatter = { name: m[1], description: m[2], metadata: { version: m[3] } };
  const body = tpl.slice(m[0].length);
  const used: string[] = [];
  const directive = (message: string) => { problems.push({ rule: "directive", message: name + ": " + message }); return ""; };
  const missing: string[] = [];
  const expanded = body.replace(/\{\{([\w-]+)(?: ([^}]+))?\}\}/g, (all, k: string, arg: string | undefined) => {
    if (k === "fact") {
      const f = arg !== undefined && Object.hasOwn(FACTS, arg) ? FACTS[arg] : undefined;
      if (!f || arg === undefined) return directive("no fact " + arg + " in facts.ts (" + all + ")");
      used.push(arg);
      return renderFactText(f.text, missing);
    }
    if (k === "origin" && arg === undefined) return SITE_ORIGIN;
    if ((k === "section" || k === "api") && arg !== undefined) {
      if (!headingExists(arg)) problems.push({ rule: "form", message: name + ": " + all + " names no heading of docs.txt or games.txt" });
      return k === "api" ? arg + " at " + SITE_ORIGIN + "/api" : arg;
    }
    if ((k === "arg" || k === "action") && arg !== undefined && /^\w+\.\w+$/.test(arg)) {
      const [tool, word] = arg.split(".");
      if (!(k === "arg" ? argOf(tool, word) : actionOf(tool, word))) missing.push(k + " " + arg);
      return "`" + word + "`";
    }
    if (k === "game-index" && arg === undefined) return GAME_REFERENCES.map(([id, , title]) => "- [" + title + "](references/" + id + ".md)").join("\n");
    return directive("unknown directive " + all + ": the directives are fact, arg, action, origin, section, api and game-index");
  });
  for (const x of missing) problems.push({ rule: "names", message: name + ": {{" + x + "}} names no " + (x.startsWith("arg") ? "argument" : "action") + " of that tool in the room's, the key's or the sign-in's catalog" });
  if (/\{\{|\}\}/.test(expanded)) directive("a {{ or }} is left after the directives were expanded");
  const own = body.replace(/\{\{[^}]*\}\}/g, " ");
  return { frontmatter, body: expanded, own, used };
}

/** Every rule a served file is held to, from its path and text. */
function fileProblems(skill: string, path: string, text: string, problems: SkillProblem[]) {
  const where = skill + "/" + path;
  const bad = (message: string) => problems.push({ rule: "form", message: where + ": " + message });
  if (!(path === "SKILL.md" || /^references\/[a-z0-9-]+\.md$/.test(path))) bad("a file is SKILL.md or references/NAME.md (lower-case letters, digits and -)");
  if (/\r/.test(text)) bad("holds a CR: lines end in LF only");
  if (/\t/.test(text)) bad("holds a tab");
  if (!text.endsWith("\n") || text.endsWith("\n\n")) bad("must end in exactly one newline");
  if (text.startsWith("\ufeff") || text.includes("\ufeff")) bad("holds a byte order mark");
  const control = [...text].find((c) => { const n = c.codePointAt(0) ?? 0; return (n < 0x20 && n !== 0x0a) || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029; });
  if (control !== undefined) bad("holds U+" + (control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0") + ", a control character other than LF (or U+0085, U+2028, U+2029)");
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) bad("is not valid UTF-8 text (a lone surrogate)");
  const m = FRONTMATTER_RE.exec(text);
  const body = path === "SKILL.md" && m ? text.slice(m[0].length) : text;
  if (!/^# \S[^\n]*\n/.test(body)) bad("does not begin with a # heading" + (path === "SKILL.md" ? " after its frontmatter" : ""));
}
/** A file's first # heading: its title in resources/list. */
function titleOf(text: string) {
  const m = FRONTMATTER_RE.exec(text);
  const body = m ? text.slice(m[0].length) : text;
  return (/^# ([^\n]+)\n/.exec(body) || ["", ""])[1];
}
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Every skill, every file, every byte, and every rule a skill breaks: the
 *  work of buildSkills, which throws on the first problem, kept apart so
 *  each test can name the problems of its own rule. */
export function skillsAndProblems(): { skills: BuiltSkill[], problems: SkillProblem[] } {
  const problems: SkillProblem[] = [];
  const skills: BuiltSkill[] = [];
  const { tools, schema } = knownNames();
  const api = norm(docs(SITE_ORIGIN));
  const names = (where: string, text: string) => {
    for (const w of new Set(text.match(isSnake) || [])) if (!tools.has(w) && !schema.has(w) && !FIELD_WORDS.includes(w)) problems.push({ rule: "names", message: where + ": " + w + " is no tool of the room's, the key's or the sign-in's catalog, no argument or enum value of theirs, and not in FIELD_WORDS (worker/agents/skills/build.ts)" });
    const bare = text.split(SITE_ORIGIN).join(" ");
    for (const p of new Set(bare.match(/(?<![\w.])\/api(?:\/[A-Za-z]+)*/g) || [])) if (!api.includes(p)) problems.push({ rule: "names", message: where + ": the path " + p + " is not in /api (docs.txt)" });
  };
  for (const w of FIELD_WORDS) if (!new RegExp("\\b" + w + "\\b").test(api)) problems.push({ rule: "names", message: "FIELD_WORDS' " + w + " is not in /api (docs.txt): a field a skill names must be documented there" });
  for (const p of PATH_LITERALS) if (!api.includes(p)) problems.push({ rule: "names", message: "PATH_LITERALS' " + p + " is not in /api (docs.txt)" });
  if (SKILL_ORDER.length > SKILLS_MAX) problems.push({ rule: "form", message: SKILL_ORDER.length + " skills, more than SKILLS_MAX (" + SKILLS_MAX + ")" });
  // the games: one reference per engine, each heading a section, each title in GAMES - CHOOSING, create_game's enum the same ids
  const ids = Object.keys(GAME_ENGINES);
  const refIds = GAME_REFERENCES.map(([id]) => id);
  const missingIds = ids.filter((g) => !refIds.includes(g)), extraIds = refIds.filter((g, i) => !ids.includes(g) || refIds.indexOf(g) !== i);
  if (missingIds.length || extraIds.length) problems.push({ rule: "games", message: "GAME_REFERENCES (worker/agents/skills/build.ts) must hold every key of GAME_ENGINES once: " + (missingIds.length ? "missing " + missingIds.join(", ") : "") + (missingIds.length && extraIds.length ? "; " : "") + (extraIds.length ? "not an engine, or twice: " + extraIds.join(", ") : "") });
  const choosingRaw = sectionOf(DOCS_TXT, "GAMES - CHOOSING");
  for (const [id, heading, title] of GAME_REFERENCES) {
    if (!sectionOf(GAMES_TXT, heading)) problems.push({ rule: "games", message: "GAME_REFERENCES' " + id + ": no section " + heading + " in games.txt" });
    if (!norm(choosingRaw).includes(title + " (" + id + ")")) problems.push({ rule: "games", message: "GAME_REFERENCES' " + id + ": GAMES - CHOOSING (docs.txt) does not name \"" + title + " (" + id + ")\"" });
  }
  const create = mcpCatalog().find((t) => t.name === "create_game");
  const gameEnum = create && Object.hasOwn(create.inputSchema.properties, "game") ? ((create.inputSchema.properties.game as { enum?: unknown[] }).enum || []) : [];
  if (gameEnum.length !== ids.length || !ids.every((g) => gameEnum.includes(g))) problems.push({ rule: "games", message: "create_game's game enum (" + gameEnum.join(", ") + ") is not exactly GAME_ENGINES' ids, which the reference files say it takes" });
  const prefixes = new Set(SKILL_ORDER.map((n) => n.split("-")[0] + "-"));
  for (const name of SKILL_ORDER) {
    const e = expand(name, problems);
    if (!e) continue;
    const fm = e.frontmatter;
    const formBad = (message: string) => problems.push({ rule: "form", message: name + ": " + message });
    if (fm.name !== name) formBad("its frontmatter's name is " + JSON.stringify(fm.name) + ", not its folder's name");
    if (!NAME_RE.test(fm.name) || fm.name.length > 64) formBad("a name is 1-64 lower-case letters, digits and single hyphens, not at either end");
    if (!/^[\x20-\x7e]+$/.test(fm.description) || fm.description.length > SKILL_DESCRIPTION_MAX) formBad("its description must be 1-" + SKILL_DESCRIPTION_MAX + " printable ASCII characters (it is " + fm.description.length + ")");
    if (!/^[1-9]\d*$/.test(fm.metadata.version)) formBad("metadata.version must be a decimal count from \"1\", in quotes");
    // the template's own words: no digit but a list marker and SHA-256, no backticked argument or action, no unknown skill, no link out of the skill
    const own = e.own.replace(/^\d+\. /gm, "");
    for (const d of own.match(/[\w-]*\d[\w-]*/g) || []) if (d !== "SHA-256") formBad("its own words hold a number, " + JSON.stringify(d) + ": a number a skill states is a fact's");
    for (const b of [...own.matchAll(/`([^`]+)`/g)].map((x) => x[1])) if (!tools.has(b) && !FIELD_WORDS.includes(b) && !PATH_LITERALS.includes(b)) problems.push({ rule: "names", message: name + ": `" + b + "` in its own words is no tool, FIELD_WORDS entry or PATH_LITERALS entry: name an argument with {{arg TOOL.ARG}} and an action with {{action TOOL.VALUE}}" });
    for (const w of own.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) || []) if (prefixes.has(w.split("-")[0] + "-") && !SKILL_ORDER.includes(w)) formBad("names a skill " + w + " that is not in SKILL_ORDER");
    const text = frontmatterText(fm) + e.body;
    const files: BuiltFile[] = [{ path: "SKILL.md", uri: SKILL_PREFIX + name + "/SKILL.md", name, title: titleOf(text), description: fm.description, text }];
    if (name === "playing-games") {
      const header = (heading: string, page: string) => "The " + heading + " section of " + SITE_ORIGIN + page + ", as the site serves it. ";
      const choosing = included(DOCS_TXT, "GAMES - CHOOSING", docs(SITE_ORIGIN), problems);
      if (choosing !== null) files.push({ path: "references/choosing.md", uri: "", name: "choosing.md", title: "", text: "# Choosing a game\n\n" + header("GAMES - CHOOSING", "/api") + "The name in brackets after each game is what create_game's game takes. " + factText("match-rules") + "\n\n" + fence(choosing) });
      for (const [id, heading, title] of GAME_REFERENCES) {
        const sec = included(GAMES_TXT, heading, gamesDocs(SITE_ORIGIN), problems);
        if (sec !== null) files.push({ path: "references/" + id + ".md", uri: "", name: id + ".md", title: "", text: "# " + title + ": the rules\n\n" + header(heading, "/api/games") + factText("rest-bodies") + " " + factText("match-rules") + "\n\n" + fence(sec) });
      }
      e.used.push("rest-bodies", "match-rules");
    }
    for (const f of files) { f.uri = SKILL_PREFIX + name + "/" + f.path; f.title = titleOf(f.text); }
    files.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const l of [...text.matchAll(/\]\(([^)]*)\)/g)].map((x) => x[1])) if (!files.some((f) => f.path === l)) formBad("links to " + l + ", which is no file of this skill");
    if (!e.used.includes("room-text")) problems.push({ rule: "room-text", message: name + "'s SKILL.md does not use {{fact room-text}}: every skill carries the sentence all three MCP instructions carry" });
    // names in every file, the frontmatter included; in a reference file, its own header only (the section is the served text)
    for (const f of files) names(name + "/" + f.path, f.path === "SKILL.md" ? f.text : f.text.slice(0, f.text.indexOf("```text")));
    let total = 0;
    if (files.length > SKILL_FILES_MAX) formBad(files.length + " files, more than SKILL_FILES_MAX (" + SKILL_FILES_MAX + ")");
    for (const f of files) {
      fileProblems(name, f.path, f.text, problems);
      const n = bytes(f.text);
      total += n;
      if (f.path === "SKILL.md") {
        if (n > SKILL_MD_MAX) formBad("SKILL.md is " + n + " bytes, more than SKILL_MD_MAX (" + SKILL_MD_MAX + ")");
        const lines = f.text.split("\n").length - 1;
        if (lines > SKILL_MD_LINES_MAX) formBad("SKILL.md is " + lines + " lines, more than SKILL_MD_LINES_MAX (" + SKILL_MD_LINES_MAX + ")");
      } else if (n > SKILL_FILE_MAX) formBad(f.path + " is " + n + " bytes, more than SKILL_FILE_MAX (" + SKILL_FILE_MAX + ")");
    }
    if (total > SKILL_TOTAL_MAX) formBad(total + " bytes in all, more than SKILL_TOTAL_MAX (" + SKILL_TOTAL_MAX + ")");
    skills.push({ name, uri: files[0].uri, frontmatter: fm, files, facts: [...new Set(e.used)] });
  }
  return { skills, problems };
}

/** Every skill, every file, every byte: a pure function of repository files
 *  and constants. It takes no argument; it throws on the first rule broken. */
export function buildSkills(): BuiltSkill[] {
  const { skills, problems } = skillsAndProblems();
  if (problems.length) throw new Error("the skills do not build (worker/agents/skills/): " + problems[0].message);
  return skills;
}

/** "sha256:" and the hex SHA-256 of the text's UTF-8 bytes, as an entry carries it. */
export async function digestOf(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return "sha256:" + [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** A skill's entry as skills/list and skills/get give it: its URI, its
 *  frontmatter, and every file's URI, digest and size, in served order.
 *  @param digests each file's digest, by URI */
export function skillEntry(s: BuiltSkill, digests: Map<string, string>) {
  return {
    uri: s.uri,
    frontmatter: { name: s.frontmatter.name, description: s.frontmatter.description, metadata: { version: s.frontmatter.metadata.version } },
    resources: s.files.map((f) => ({ uri: f.uri, digest: digests.get(f.uri) || "", size: bytes(f.text) })),
  };
}
/** The digest a host binds its approval to: the SHA-256 of the entry's
 *  resources (every URI, digest and size, in served order) as JSON. */
export function manifestDigest(entry: { resources: Array<{ uri: string, digest: string, size: number }> }): Promise<string> {
  return digestOf(JSON.stringify(entry.resources));
}

/** The version record (versions.json): for each skill, every version ever
 *  published and its manifest's digest. */
export type SkillVersions = Record<string, Record<string, string>>;
/** The version rule within one checkout: each skill's metadata.version is
 *  recorded with exactly its manifest's digest, or it is new and the next
 *  count after every recorded one; a record counts up from "1" by one. The
 *  record with the new versions appended, or the first problem.
 *  @param manifests each skill's name, version and manifest digest */
export function versionRule(record: SkillVersions, manifests: Array<{ name: string, version: string, digest: string }>): { ok: true, record: SkillVersions, added: string[] } | { ok: false, problem: string } {
  const out: SkillVersions = {};
  for (const [k, v] of Object.entries(record)) out[k] = { ...v };
  const added: string[] = [];
  for (const { name, version, digest } of manifests) {
    const had = Object.hasOwn(out, name) ? out[name] : {};
    const keys = Object.keys(had);
    const counts = keys.map(Number).sort((a, b) => a - b);
    if (keys.some((k) => !/^[1-9]\d*$/.test(k)) || counts.some((n, i) => n !== i + 1)) return { ok: false, problem: name + ": versions.json records " + keys.join(", ") + ", which is not a count from \"1\" by one: an earlier entry was rewritten or deleted; put it back as it was published" };
    const bad = keys.find((k) => !/^sha256:[0-9a-f]{64}$/.test(had[k]));
    if (bad) return { ok: false, problem: name + ": versions.json's version " + bad + " holds no sha256 digest: put it back as it was published" };
    const top = counts.length ? counts[counts.length - 1] : 0;
    const template = "worker/agents/skills/templates/" + name + "/SKILL.md";
    if (Object.hasOwn(had, version)) {
      if (had[version] !== digest) return { ok: false, problem: name + ": its files changed, but metadata.version \"" + version + "\" is already recorded with another manifest digest in versions.json: move metadata.version to \"" + (top + 1) + "\" in " + template + " and run npm run skills again" };
      continue;
    }
    if (version !== String(top + 1)) return { ok: false, problem: name + ": metadata.version \"" + version + "\" is neither recorded in versions.json nor the next one: set it to \"" + (top + 1) + "\" in " + template };
    out[name] = { ...had, [version]: digest };
    added.push(name + " " + version);
  }
  return { ok: true, record: out, added };
}

/** served/index.ts: one import per file (its text module), then
 *  SERVED_SKILLS with each skill's URI and frontmatter and, per file in
 *  served order, its URI, name, title, description (SKILL.md only), text,
 *  digest and size. @param digests each file's digest, by URI */
export function renderIndex(skills: BuiltSkill[], digests: Map<string, string>): string {
  const lines = [
    "// Generated by npm run skills (scripts/skills.mjs) from worker/agents/skills/: do not",
    "// edit. tests/unit/skills-build.test.mjs fails when it differs from a fresh build.",
    "import type { ServedSkill } from \"../types.js\";",
  ];
  let n = 0;
  const ids = new Map<string, string>();
  for (const s of skills) for (const f of s.files) { const id = "F" + n++; ids.set(f.uri, id); lines.push("import " + id + " from \"./" + s.name + "/" + f.path + "\";"); }
  lines.push("", "/** Every skill every MCP address serves, in skills/list's order; each file's text is its committed bytes. */", "export const SERVED_SKILLS: ServedSkill[] = [");
  const q = (s: string) => JSON.stringify(s);
  for (const s of skills) {
    lines.push("  {", "    uri: " + q(s.uri) + ",", "    frontmatter: { name: " + q(s.frontmatter.name) + ", description: " + q(s.frontmatter.description) + ", metadata: { version: " + q(s.frontmatter.metadata.version) + " } },", "    files: [");
    for (const f of s.files) lines.push("      { uri: " + q(f.uri) + ", name: " + q(f.name) + ", title: " + q(f.title) + (f.description === undefined ? "" : ", description: " + q(f.description)) + ", text: " + ids.get(f.uri) + ", digest: " + q(digests.get(f.uri) || "") + ", size: " + bytes(f.text) + " },");
    lines.push("    ],", "  },");
  }
  lines.push("];", "");
  return lines.join("\n");
}
