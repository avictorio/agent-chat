// Refactor tool for REFACTOR.md 5.2d (the client-side game registry): move
// the per-game branches of "type dispatch" functions into each game's
// folder, as optional hooks on its plug-in (GAMES in
// web/app/src/features/games/registry.ts).
//
//   node scripts/split-dispatch.mjs <file>:<function>=<hook> ... [--dry]
//
// A dispatch function here has one shape: a prelude, then a run of
//   if (g.type === "a" [|| g.type === "b" ...]) <return statement or block>
// with no else, then a tail (what every other game, Light Cycles and a
// match without a type get). For each such function the tool:
// - takes each branch's body as the method <hook> of each game it names
//   (a branch naming two games goes to both), in <game>/status.ts, inside
//   `export const <game>Status: GameStatus = { ... }` (created if missing);
//   a block branch must end in a return, so moving it never changes
//   whether the tail runs;
// - copies a prelude `const` the body reads into the method, the imports
//   it needs (paths rebased), and imports the module-level names of the
//   source file it uses (exporting them there if they were not);
// - replaces the run with `const own = GAMES[g.type]?.<hook>; if (own)
//   return own(<params>);`, so the prelude and the tail stay as they were
//   and a game without the hook still falls through to the tail;
// - prints the hook signatures (GameStatus in registry.ts must have them).
// The comments between branches go with the branch below them. Refuses
// anything else. Run from the repo root. Needs web/node_modules.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const req = createRequire(path.join(ROOT, "web", "package.json"));
const { parseAst } = await import(pathToFileURL(req.resolve("rolldown/parseAst")).href);

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const sites = args.filter((a) => !a.startsWith("--")).map((a) => {
  const m = /^(.+):(\w+)=(\w+)$/.exec(a);
  if (!m) throw new Error("expected <file>:<function>=<hook>, got " + a);
  return { file: path.resolve(m[1]), fn: m[2], hook: m[3] };
});
if (!sites.length) throw new Error("usage: node scripts/split-dispatch.mjs <file>:<function>=<hook> ... [--dry]");

const GAMES_DIR = path.join(ROOT, "web/app/src/features/games");
const REGISTRY = path.join(GAMES_DIR, "registry");
const GLOBALS = new Set(["Math", "Object", "Array", "String", "Number", "Boolean", "JSON", "Set", "Map", "Date", "Infinity", "NaN", "undefined", "isFinite", "parseInt", "parseFloat", "console", "Record", "Partial", "Array", "ReadonlyArray"]);
const KEYS_SKIP = new Set(["type", "start", "end", "loc", "range", "parent"]);
const lang = (f) => (f.endsWith(".tsx") ? "tsx" : "ts");
const rel = (from, to) => {
  let r = path.relative(path.dirname(from), to).split(path.sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  return r;
};

// ---------- names: what a piece of code reads that it does not declare ----------
function patternNames(p, out) {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern") for (const pr of p.properties) patternNames(pr.type === "RestElement" ? pr.argument : pr.value, out);
  else if (p.type === "ArrayPattern") for (const e of p.elements) patternNames(e, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  return out;
}
function blockDecls(stmts) {
  const names = [];
  for (const s of stmts) {
    if (s.type === "VariableDeclaration") for (const d of s.declarations) patternNames(d.id, names);
    if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) names.push(s.id.name);
  }
  return names;
}
function freeNames(node) {
  const values = new Set();
  const types = new Set();
  const typeWalk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(typeWalk);
    if (n.type === "TSTypeReference" && n.typeName && n.typeName.type === "Identifier") types.add(n.typeName.name);
    for (const k in n) if (!KEYS_SKIP.has(k)) typeWalk(n[k]);
  };
  const walk = (n, scope) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, scope));
    for (const k of ["typeAnnotation", "returnType", "typeParameters", "typeArguments"]) if (n[k]) typeWalk(n[k]);
    if (n.type && n.type.startsWith("TS") && !["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(n.type)) return typeWalk(n);
    switch (n.type) {
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "FunctionDeclaration": {
        const inner = new Set(scope);
        for (const p of n.params) {
          patternNames(p, []).forEach((x) => inner.add(x));
          typeWalk(p);
        }
        if (n.body && n.body.type === "BlockStatement") blockDecls(n.body.body).forEach((x) => inner.add(x));
        walk(n.body, inner);
        return;
      }
      case "BlockStatement": {
        const inner = new Set(scope);
        blockDecls(n.body).forEach((x) => inner.add(x));
        walk(n.body, inner);
        return;
      }
      case "VariableDeclarator":
        typeWalk(n.id);
        walk(n.init, scope);
        return;
      case "MemberExpression":
        walk(n.object, scope);
        if (n.computed) walk(n.property, scope);
        return;
      case "Property":
        if (n.computed) walk(n.key, scope);
        walk(n.value, scope);
        return;
      case "Identifier":
        if (!scope.has(n.name)) values.add(n.name);
        return;
      default:
        for (const k in n) if (!KEYS_SKIP.has(k)) walk(n[k], scope);
    }
  };
  walk(node, new Set());
  return { values, types };
}

// ---------- per-game output, built up over every site ----------
const out = new Map(); // game -> { imports: Map<source, Map<imported, {local, typeOnly}>>, methods: [] }
const gameOut = (game) => {
  if (!out.has(game)) out.set(game, { imports: new Map(), methods: [] });
  return out.get(game);
};
const addImport = (o, source, imported, local, typeOnly) => {
  if (!o.imports.has(source)) o.imports.set(source, new Map());
  const m = o.imports.get(source);
  const prev = m.get(imported);
  m.set(imported, { local, typeOnly: prev ? prev.typeOnly && typeOnly : typeOnly });
};
const sourceEdits = new Map(); // file -> { src, edits: [{start, end, text}], exportNames: Set, needGames: bool }
const signatures = [];

function dedent(text, indent) {
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? l : l.startsWith(indent) ? l.slice(indent.length) : l.trimStart() === "" ? "" : l))
    .join("\n");
}
function typeTest(test) {
  // g.type === "x" (|| ...) -> ["x", ...] or null
  if (test.type === "LogicalExpression" && test.operator === "||") {
    const a = typeTest(test.left);
    const b = typeTest(test.right);
    return a && b ? [...a, ...b] : null;
  }
  if (test.type === "BinaryExpression" && test.operator === "===" && test.left.type === "MemberExpression" && !test.left.computed && test.left.object.type === "Identifier" && test.left.object.name === "g" && test.left.property.name === "type" && test.right.type === "Literal" && typeof test.right.value === "string") return [test.right.value];
  return null;
}
function mentionsType(node) {
  let hit = false;
  const w = (n) => {
    if (hit || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(w);
    const isType = (x) => x && x.type === "MemberExpression" && !x.computed && x.property.name === "type" && x.object.type === "Identifier" && x.object.name === "g";
    if (n.type === "BinaryExpression" && /^[!=]==?$/.test(n.operator) && (isType(n.left) || isType(n.right))) hit = true;
    for (const k in n) if (!KEYS_SKIP.has(k)) w(n[k]);
  };
  w(node);
  return hit;
}

for (const site of sites) {
  const st = sourceEdits.get(site.file) || { src: fs.readFileSync(site.file, "utf8"), edits: [], exportNames: new Set(), needGames: false };
  sourceEdits.set(site.file, st);
  const src = st.src;
  const ast = parseAst(src, { lang: lang(site.file) });

  // module level: imports and declarations
  const imports = new Map();
  const moduleDecls = new Map(); // name -> { node, exported }
  for (const n of ast.body) {
    if (n.type === "ImportDeclaration") {
      for (const s of n.specifiers) {
        imports.set(s.local.name, {
          source: n.source.value,
          imported: s.type === "ImportSpecifier" ? s.imported.name || s.imported.value : s.type === "ImportDefaultSpecifier" ? "default" : "*",
          typeOnly: n.importKind === "type" || s.importKind === "type",
        });
      }
      continue;
    }
    const exported = n.type === "ExportNamedDeclaration";
    const d = exported && n.declaration ? n.declaration : n;
    const names = [];
    if ((d.type === "FunctionDeclaration" || d.type === "TSTypeAliasDeclaration" || d.type === "TSInterfaceDeclaration") && d.id) names.push(d.id.name);
    if (d.type === "VariableDeclaration") for (const v of d.declarations) patternNames(v.id, names);
    for (const name of names) moduleDecls.set(name, { node: n, exported });
  }

  const top = ast.body.map((n) => (n.type === "ExportNamedDeclaration" && n.declaration ? n.declaration : n));
  const fn = top.find((d) => d.type === "FunctionDeclaration" && d.id && d.id.name === site.fn);
  if (!fn) throw new Error(site.fn + " is not a top-level function in " + site.file);
  const params = fn.params.map((p) => {
    if (p.type !== "Identifier") throw new Error(site.fn + ": only plain parameters are supported");
    return { name: p.name, text: src.slice(p.start, p.end) };
  });
  if (!params.length || params[0].name !== "g") throw new Error(site.fn + ": the first parameter must be g");
  const ret = fn.returnType ? src.slice(fn.returnType.start, fn.returnType.end) : "";
  if (!ret) throw new Error(site.fn + ": needs a declared return type");

  const body = fn.body.body;
  const first = body.findIndex((s) => s.type === "IfStatement" && typeTest(s.test));
  if (first < 0) throw new Error(site.fn + ": no type branch");
  let last = first;
  while (last + 1 < body.length && body[last + 1].type === "IfStatement" && typeTest(body[last + 1].test)) last++;
  const prelude = body.slice(0, first);
  const tail = body.slice(last + 1);
  for (const s of [...prelude, ...tail]) if (mentionsType(s)) throw new Error(site.fn + ": a statement outside the branch run reads g.type: " + src.slice(s.start, s.end).slice(0, 80));
  const preludeConsts = new Map(); // name -> declaration text
  for (const s of prelude) {
    if (s.type === "VariableDeclaration" && s.kind === "const" && s.declarations.length === 1 && s.declarations[0].id.type === "Identifier") preludeConsts.set(s.declarations[0].id.name, src.slice(s.start, s.end));
  }
  const preludeNames = new Set(blockDecls(prelude));

  const indent = /\n([ \t]*)$/.exec(src.slice(0, body[first].start))[1];
  let prevEnd = first > 0 ? body[first - 1].end : fn.body.start + 1;
  for (let i = first; i <= last; i++) {
    const s = body[i];
    const games = typeTest(s.test);
    if (s.alternate) throw new Error(site.fn + ": a type branch has an else");
    // a comment right above the branch goes with it
    const between = i === first ? "" : src.slice(prevEnd, s.start);
    const comment = between.trim() ? dedent(between.replace(/^\s*\n/, "").replace(/\s+$/, ""), indent).trim() : "";
    prevEnd = s.end;
    let text;
    const c = s.consequent;
    if (c.type === "ReturnStatement") text = dedent(src.slice(c.start, c.end), indent);
    else if (c.type === "BlockStatement") {
      const stmts = c.body;
      if (!stmts.length || stmts[stmts.length - 1].type !== "ReturnStatement") throw new Error(site.fn + " (" + games.join(", ") + "): a block branch must end in a return");
      const inner = /\n([ \t]*)$/.exec(src.slice(0, stmts[0].start));
      text = dedent(src.slice(stmts[0].start, c.end - 1).replace(/\s+$/, ""), inner ? inner[1] : indent + "  ");
      // a comment above the first statement
      const lead = src.slice(c.start + 1, stmts[0].start);
      if (lead.trim()) text = dedent(lead.replace(/^\s*\n/, "").replace(/\s+$/, ""), inner ? inner[1] : "").trim() + "\n" + text;
    } else throw new Error(site.fn + ": a branch must be a return or a block");

    // what the body reads
    const parsed = parseAst("function __w() {\n" + text + "\n}", { lang: "ts" });
    const { values, types } = freeNames(parsed.body[0].body);
    const paramNames = new Set(params.map((p) => p.name));
    const copied = [];
    const needs = { values: new Set(), types: new Set() };
    for (const v of values) {
      if (paramNames.has(v) || GLOBALS.has(v)) continue;
      if (preludeNames.has(v)) {
        if (!preludeConsts.has(v)) throw new Error(site.fn + ": the branch reads the prelude's " + v + ", which is not a single const");
        copied.push(preludeConsts.get(v));
        const inner = freeNames(parseAst(preludeConsts.get(v), { lang: "ts" }).body[0]);
        inner.values.forEach((x) => !paramNames.has(x) && !GLOBALS.has(x) && needs.values.add(x));
        inner.types.forEach((x) => needs.types.add(x));
        continue;
      }
      needs.values.add(v);
    }
    types.forEach((t) => needs.types.add(t));
    const methodText = (copied.length ? copied.join("\n") + "\n" : "") + text;
    const sig = site.hook + "(" + params.map((p) => p.text).join(", ") + ")" + ret;
    for (const game of games) {
      if (!fs.existsSync(path.join(GAMES_DIR, game))) throw new Error("no folder for " + game);
      const o = gameOut(game);
      const target = path.join(GAMES_DIR, game, "status.ts");
      for (const [set, typeOnly] of [[needs.values, false], [needs.types, true]]) {
        for (const name of set) {
          if (GLOBALS.has(name)) continue;
          if (imports.has(name)) {
            const im = imports.get(name);
            const source = im.source.startsWith(".") ? rel(target, path.resolve(path.dirname(site.file), im.source)) : im.source;
            addImport(o, source, im.imported, name, typeOnly || im.typeOnly);
          } else if (moduleDecls.has(name)) {
            if (!moduleDecls.get(name).exported) st.exportNames.add(name);
            addImport(o, rel(target, site.file.replace(/\.tsx?$/, "")), name, name, typeOnly);
          } else if (name === site.fn) {
            addImport(o, rel(target, site.file.replace(/\.tsx?$/, "")), name, name, false);
          } else throw new Error(site.fn + " (" + game + "): reads " + name + ", which is neither a parameter, a prelude const, an import nor a module-level name");
        }
      }
      if (o.methods.some((m) => m.hook === site.hook)) throw new Error(site.fn + ": " + game + " has two branches");
      o.methods.push({ hook: site.hook, sig, text: methodText, comment, from: path.relative(ROOT, site.file) + " " + site.fn });
    }
  }
  signatures.push(site.hook + "?(" + params.map((p) => p.text).join(", ") + ")" + ret + "  <- " + site.fn);

  // the dispatch, in place of the run
  const call = "const own = GAMES[g.type]?." + site.hook + ";\n" + indent + "if (own) return own(" + params.map((p) => p.name).join(", ") + ");";
  const runStart = body[first].start;
  // the run's span covers the comments between branches, which went with them
  st.edits.push({ start: runStart, end: body[last].end, text: call });
  st.needGames = true;
}

// ---------- write the sources ----------
for (const [file, st] of sourceEdits) {
  let s = st.src;
  // edits from the end, so offsets stay valid
  const edits = st.edits.slice().sort((a, b) => b.start - a.start);
  for (const e of edits) s = s.slice(0, e.start) + e.text + s.slice(e.end);
  for (const name of st.exportNames) {
    const re = new RegExp("^(function|const|let) " + name + "\\b", "m");
    if (!re.test(s)) throw new Error("cannot export " + name + " in " + file);
    s = s.replace(re, "export $1 " + name);
  }
  if (st.needGames && !/import \{[^}]*\bGAMES\b[^}]*\} from "[^"]*registry";/.test(s)) {
    const lines = s.split("\n");
    let at = 0;
    for (let i = 0; i < lines.length; i++) if (/^import .* from "[^"]+";$/.test(lines[i])) at = i + 1;
    lines.splice(at, 0, 'import { GAMES } from "' + rel(file, REGISTRY) + '";');
    s = lines.join("\n");
  }
  if (dry) console.log("--- " + path.relative(ROOT, file) + " (dry)");
  else fs.writeFileSync(file, s);
}

// ---------- write each game's status.ts ----------
const displayName = (game) => {
  const m = /^  name: "([^"]+)",$/m.exec(fs.readFileSync(path.join(GAMES_DIR, game, "catalog.ts"), "utf8"));
  return m ? m[1] : game;
};
for (const [game, o] of [...out].sort()) {
  const target = path.join(GAMES_DIR, game, "status.ts");
  const constName = game + "Status";
  let existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  const methods = o.methods
    .map((m) => {
      const head = (m.comment ? m.comment.split("\n").map((l) => "  " + l).join("\n") + "\n" : "") + "  " + m.sig + " {\n";
      return head + m.text.split("\n").map((l) => (l ? "    " + l : "")).join("\n") + "\n  },";
    })
    .join("\n\n");
  const importLines = (merge) => {
    // merge with the file's own imports when it exists
    if (merge) {
      for (const m of merge.matchAll(/^import (type )?\{ ([^}]+) \} from "([^"]+)";$/gm)) {
        for (const spec of m[2].split(",").map((x) => x.trim()).filter(Boolean)) {
          const typeOnly = !!m[1] || spec.startsWith("type ");
          const nm = spec.replace(/^type /, "");
          const [imported, local] = nm.includes(" as ") ? nm.split(" as ") : [nm, nm];
          addImport(o, m[3], imported, local, typeOnly);
        }
      }
    }
    addImport(o, "../registry", "GameStatus", "GameStatus", true);
    const lines = [];
    for (const [source, specs] of [...o.imports].sort((a, b) => a[0].localeCompare(b[0]))) {
      const all = [...specs].sort((a, b) => a[1].local.localeCompare(b[1].local));
      const spec = (x, withType) => (withType && x[1].typeOnly ? "type " : "") + (x[0] === x[1].local ? x[0] : x[0] + " as " + x[1].local);
      if (all.every((x) => x[1].typeOnly)) lines.push("import type { " + all.map((x) => spec(x, false)).join(", ") + ' } from "' + source + '";');
      else lines.push("import { " + all.map((x) => spec(x, true)).join(", ") + ' } from "' + source + '";');
    }
    return lines.join("\n");
  };
  let text;
  if (!existing) {
    text =
      importLines(null) +
      "\n\n// The status hooks for " + displayName(game) + " (GameStatus in registry.ts):\n" +
      "// what the app says about a match's state in this game's words. Each is\n" +
      "// optional; a game without one gets the default where the hook is called.\n\n" +
      "export const " + constName + ": GameStatus = {\n" + methods + "\n};\n";
  } else {
    const bodyStart = existing.indexOf("\n\n// ");
    const closing = existing.lastIndexOf("\n};");
    if (bodyStart < 0 || closing < 0) throw new Error("unexpected shape: " + target);
    text = importLines(existing.slice(0, bodyStart)) + existing.slice(bodyStart, closing) + "\n\n" + methods + existing.slice(closing);
  }
  if (dry) console.log("--- " + path.relative(ROOT, target) + " (dry)\n" + text);
  else fs.writeFileSync(target, text);
}
console.log("hooks:\n  " + signatures.join("\n  "));
