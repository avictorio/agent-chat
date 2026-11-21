// Refactor tool for REFACTOR.md 5.2 (the client-side game registry): move one
// function out of createGameStore in web/app/src/features/games/games.ts
// into a game's folder, as an exported function that takes the store's
// helpers as its first argument (ctx).
//
//   node scripts/extract-renderer.mjs <fnName> <target.ts> [--dry]
//
// What it does, exactly:
// - finds `function <fnName>(...)` directly inside createGameStore;
// - rewrites every reference the function makes to createGameStore's own
//   declarations (helpers and state) as `ctx.<name>` - shorthand properties
//   are expanded - and the render-dedupe pair
//     if (!force && key === gameRenderKey) return; gameRenderKey = key;
//   as `if (!ctx.claimRender(key, force)) return;`;
// - refuses any other assignment to the store's state;
// - copies the imports the function needs (adjusting relative paths) and
//   reports module-level names it uses that are not imports (those must be
//   exported or moved first);
// - appends the function to <target> (created if missing) as
//   `export function <fnName>(ctx: GameViewCtx, ...)`, removes it from
//   games.ts, passes ctx at every call there and imports it;
// - prints the ctx members the function needs (GameViewCtx must have them).
// Run from the repo root. Needs web/node_modules (rolldown's parser).
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";

const ROOT = process.cwd();
const req = createRequire(path.join(ROOT, "web", "package.json"));
const { parseAst } = await import(pathToFileURL(req.resolve("rolldown/parseAst")).href);

const [fnName, targetArg, ...flags] = process.argv.slice(2);
if (!fnName || !targetArg) {
  console.error("usage: node scripts/extract-renderer.mjs <fnName> <target.ts> [--dry]");
  process.exit(2);
}
const dry = flags.includes("--dry");
const STORE = path.join(ROOT, "web/app/src/features/games/games.ts");
const TARGET = path.resolve(targetArg);
const CTX_TYPE_FROM = path.join(ROOT, "web/app/src/features/games/shared/viewctx");

let src = fs.readFileSync(STORE, "utf8");
const lang = (f) => (f.endsWith(".tsx") ? "tsx" : "ts");
const ast = parseAst(src, { lang: "ts" });

// ---------- module level: imports and declarations ----------
const imports = new Map(); // local -> { source, imported, type, kind }
const moduleDecls = new Set();
for (const n of ast.body) {
  if (n.type === "ImportDeclaration") {
    for (const s of n.specifiers) {
      imports.set(s.local.name, {
        source: n.source.value,
        imported: s.type === "ImportSpecifier" ? (s.imported.name || s.imported.value) : s.type === "ImportDefaultSpecifier" ? "default" : "*",
        typeOnly: n.importKind === "type" || s.importKind === "type",
      });
    }
    continue;
  }
  const d = n.type === "ExportNamedDeclaration" && n.declaration ? n.declaration : n;
  if (d.type === "FunctionDeclaration" && d.id) moduleDecls.add(d.id.name);
  if (d.type === "VariableDeclaration") for (const v of d.declarations) if (v.id.type === "Identifier") moduleDecls.add(v.id.name);
  if ((d.type === "TSTypeAliasDeclaration" || d.type === "TSInterfaceDeclaration") && d.id) moduleDecls.add(d.id.name);
}

// ---------- createGameStore's own declarations ----------
const storeFn = ast.body
  .map((n) => (n.type === "ExportNamedDeclaration" && n.declaration ? n.declaration : n))
  .find((d) => d.type === "FunctionDeclaration" && d.id && d.id.name === "createGameStore");
if (!storeFn) throw new Error("createGameStore not found");
const closure = new Map(); // name -> "let" | "const" | "function"
for (const st of storeFn.body.body) {
  if (st.type === "FunctionDeclaration" && st.id) closure.set(st.id.name, "function");
  if (st.type === "VariableDeclaration") for (const v of st.declarations) if (v.id.type === "Identifier") closure.set(v.id.name, st.kind);
}
// the store's options are a parameter, not a declaration: reach them through ctx too
for (const p of storeFn.params) if (p.type === "Identifier") closure.set(p.name, "param");
// ctx itself is what the moved function receives, never a member of it
closure.delete("ctx");
const fn = storeFn.body.body.find((st) => st.type === "FunctionDeclaration" && st.id && st.id.name === fnName);
if (!fn) throw new Error(fnName + " is not a function directly inside createGameStore");

// ---------- scope analysis inside the function ----------
const KEYS_SKIP = new Set(["type", "start", "end", "loc", "range", "parent", "typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments"]);
function patternNames(p, out) {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern") for (const pr of p.properties) patternNames(pr.type === "RestElement" ? pr.argument : pr.value, out);
  else if (p.type === "ArrayPattern") for (const e of p.elements) patternNames(e, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  else if (p.type === "TSParameterProperty") patternNames(p.parameter, out);
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
// collects references to closure names not shadowed by a local declaration
const refs = []; // { node, name, kind: 'ref'|'shorthand'|'assign' }
const typeRefs = new Set(); // type names used in annotations
function collectTypes(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(collectTypes);
  if (node.type === "TSTypeReference" && node.typeName && node.typeName.type === "Identifier") typeRefs.add(node.typeName.name);
  if (node.type === "TSTypeQuery" && node.exprName && node.exprName.type === "Identifier") typeRefs.add(node.exprName.name);
  for (const k in node) if (k !== "parent" && k !== "loc") collectTypes(node[k]);
}
function walk(node, scope) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, scope)); return; }
  for (const k of ["typeAnnotation", "returnType", "typeParameters", "typeArguments"]) if (node[k]) collectTypes(node[k]);
  if (node.type && node.type.startsWith("TS") && node.type !== "TSAsExpression" && node.type !== "TSNonNullExpression" && node.type !== "TSSatisfiesExpression" && node.type !== "TSTypeAssertion") { collectTypes(node); return; }
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      const inner = new Set(scope);
      collectTypes(node.params);
      for (const p of node.params) patternNames(p, []).forEach((n) => inner.add(n));
      for (const p of node.params) walkPatternDefaults(p, inner);
      if (node.type === "FunctionExpression" && node.id) inner.add(node.id.name);
      if (node.body && node.body.type === "BlockStatement") blockDecls(node.body.body).forEach((n) => inner.add(n));
      walk(node.body, inner);
      return;
    }
    case "BlockStatement":
    case "Program": {
      const inner = new Set(scope);
      blockDecls(node.body).forEach((n) => inner.add(n));
      walk(node.body, inner);
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const inner = new Set(scope);
      const decl = node.init || node.left;
      if (decl && decl.type === "VariableDeclaration") for (const d of decl.declarations) patternNames(d.id, []).forEach((n) => inner.add(n));
      for (const k of ["init", "test", "update", "left", "right", "body"]) walk(node[k], inner);
      return;
    }
    case "CatchClause": {
      const inner = new Set(scope);
      if (node.param) patternNames(node.param, []).forEach((n) => inner.add(n));
      walk(node.body, inner);
      return;
    }
    case "VariableDeclarator":
      collectTypes(node.id);
      walkPatternDefaults(node.id, scope);
      walk(node.init, scope);
      return;
    case "MemberExpression":
      walk(node.object, scope);
      if (node.computed) walk(node.property, scope);
      return;
    case "Property":
      if (node.computed) walk(node.key, scope);
      if (node.shorthand && node.value.type === "Identifier") {
        if (!scope.has(node.value.name) && closure.has(node.value.name)) refs.push({ node, name: node.value.name, kind: "shorthand" });
        return;
      }
      walk(node.value, scope);
      return;
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed) walk(node.key, scope);
      walk(node.value, scope);
      return;
    case "LabeledStatement":
      walk(node.body, scope);
      return;
    case "BreakStatement":
    case "ContinueStatement":
      return;
    case "AssignmentExpression":
      if (node.left.type === "Identifier" && !scope.has(node.left.name) && closure.has(node.left.name)) refs.push({ node: node.left, name: node.left.name, kind: "assign" });
      else walk(node.left, scope);
      walk(node.right, scope);
      return;
    case "UpdateExpression":
      if (node.argument.type === "Identifier" && !scope.has(node.argument.name) && closure.has(node.argument.name)) refs.push({ node: node.argument, name: node.argument.name, kind: "assign" });
      else walk(node.argument, scope);
      return;
    case "Identifier":
      if (!scope.has(node.name) && closure.has(node.name)) refs.push({ node, name: node.name, kind: "ref" });
      else if (!scope.has(node.name)) freeModule.add(node.name);
      return;
    default:
      for (const k in node) if (!KEYS_SKIP.has(k)) walk(node[k], scope);
  }
}
function walkPatternDefaults(p, scope) {
  if (!p) return;
  if (p.type === "AssignmentPattern") { walk(p.right, scope); walkPatternDefaults(p.left, scope); }
  else if (p.type === "ObjectPattern") for (const pr of p.properties) { if (pr.computed) walk(pr.key, scope); walkPatternDefaults(pr.type === "RestElement" ? pr.argument : pr.value, scope); }
  else if (p.type === "ArrayPattern") for (const e of p.elements) walkPatternDefaults(e, scope);
}
const freeModule = new Set();

// the render-dedupe pair, in the function's own text
let fnText = src.slice(fn.start, fn.end);
const PAIR = /if \(!force && key === gameRenderKey\) return;\n(\s*)gameRenderKey = key;/;
const hadPair = PAIR.test(fnText);

// analyse the function (with the pair replaced, so gameRenderKey is gone)
const fnTextPaired = fnText.replace(PAIR, "if (!ctx.claimRender(key, force)) return;");
const wrapped = "function __w() {\n" + fnTextPaired + "\n}";
const fnAst = parseAst(wrapped, { lang: "ts" }).body[0].body.body[0];
const fnScope = new Set();
walk(fnAst, fnScope);
const own = new Set([fnName]);
const bad = refs.filter((r) => r.kind === "assign");
if (bad.length) throw new Error(fnName + " assigns the store's state directly: " + [...new Set(bad.map((r) => r.name))].join(", ") + " - give ctx a setter first");
const members = [...new Set(refs.filter((r) => !own.has(r.name)).map((r) => r.name))].sort();

// rewrite references (back to front)
let out = wrapped;
for (const r of [...refs].filter((r) => !own.has(r.name)).sort((a, b) => b.node.start - a.node.start)) {
  if (r.kind === "shorthand") out = out.slice(0, r.node.start) + r.name + ": ctx." + r.name + out.slice(r.node.end);
  else out = out.slice(0, r.node.start) + "ctx." + r.name + out.slice(r.node.end);
}
out = out.slice("function __w() {\n".length, out.length - 2);
// recursion: calls to itself pass ctx along
out = out.replace(new RegExp("(^|[^.\\w])" + fnName + "\\(", "g"), (m, p1, off) => (off === out.indexOf("function " + fnName) + 8 ? m : p1 + fnName + "(ctx, "));
// the signature: ctx first, exported, dedented one level
out = out.replace(new RegExp("^function " + fnName + "\\("), "export function " + fnName + "(ctx: GameViewCtx, ");
out = out.replace(/\(ctx: GameViewCtx, \)/, "(ctx: GameViewCtx)");
out = out.split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n");

// the comment block directly above the function travels with it
const before = src.slice(0, fn.start);
const lineStart = before.lastIndexOf("\n", before.length - 1) + 1;
let cStart = lineStart;
const lines = before.slice(0, lineStart).split("\n");
lines.pop();
let k = lines.length - 1;
let blockStart = -1;
let inBlock = false;
for (; k >= 0; k--) {
  const t = lines[k].trim();
  if (inBlock) { if (t.startsWith("/*")) { blockStart = k; inBlock = false; continue; } continue; }
  if (t.endsWith("*/") && !t.startsWith("//")) { if (t.startsWith("/*")) { blockStart = k; continue; } inBlock = true; continue; }
  if (t.startsWith("//")) { blockStart = k; continue; }
  break;
}
let comment = "";
if (blockStart >= 0) {
  const commentLines = lines.slice(blockStart);
  comment = commentLines.map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n") + "\n";
  cStart = lines.slice(0, blockStart).join("\n").length + (blockStart > 0 ? 1 : 0);
}

// imports the function needs
const needImports = new Map(); // source -> Set of "name" | "type name"
const notImported = [];
for (const name of [...freeModule, ...typeRefs]) {
  if (imports.has(name)) {
    const im = imports.get(name);
    let s = im.source;
    if (s.startsWith(".")) {
      s = path.relative(path.dirname(TARGET), path.resolve(path.dirname(STORE), s)).split(path.sep).join("/");
      if (!s.startsWith(".")) s = "./" + s;
    }
    if (!needImports.has(s)) needImports.set(s, new Set());
    const spec = (im.imported === name || im.imported === "default" ? name : im.imported + " as " + name);
    needImports.get(s).add((typeRefs.has(name) && !freeModule.has(name)) || im.typeOnly ? "type " + spec : spec);
  } else if (moduleDecls.has(name)) notImported.push(name);
}
const ctxRel = (() => { let s = path.relative(path.dirname(TARGET), CTX_TYPE_FROM).split(path.sep).join("/"); return s.startsWith(".") ? s : "./" + s; })();
if (!needImports.has(ctxRel)) needImports.set(ctxRel, new Set());
needImports.get(ctxRel).add("type GameViewCtx");

console.log(fnName + ": ctx members " + JSON.stringify(members) + (hadPair ? " (+ claimRender)" : ""));
if (notImported.length) console.log("  module-level names in games.ts it uses (export or move them first): " + notImported.join(", "));
if (dry) process.exit(0);
if (notImported.length) { console.error("refusing: move or export those first"); process.exit(1); }

// ---------- write the target ----------
let tgt = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";
const tAst = tgt ? parseAst(tgt, { lang: lang(TARGET) }) : { body: [] };
const have = new Map();
for (const n of tAst.body) if (n.type === "ImportDeclaration") have.set(n.source.value, n);
let addImports = "";
for (const [s, names] of needImports) {
  const cur = have.get(s);
  if (cur) {
    const existing = new Set(cur.specifiers.map((sp) => (cur.importKind === "type" || sp.importKind === "type" ? "type " : "") + (sp.imported && (sp.imported.name || sp.imported.value) !== sp.local.name ? (sp.imported.name || sp.imported.value) + " as " : "") + sp.local.name));
    const all = [...new Set([...existing, ...names])].sort((a, b) => a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")));
    const allType = all.every((x) => x.startsWith("type "));
    const text = allType ? "import type { " + all.map((x) => x.slice(5)).join(", ") + " } from " + JSON.stringify(s) + ";" : "import { " + all.join(", ") + " } from " + JSON.stringify(s) + ";";
    tgt = tgt.slice(0, cur.start) + text + tgt.slice(cur.end);
    // positions after this edit shift; reparse for the next one
    const re = parseAst(tgt, { lang: lang(TARGET) });
    have.clear();
    for (const n of re.body) if (n.type === "ImportDeclaration") have.set(n.source.value, n);
  } else {
    const all = [...names].sort((a, b) => a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")));
    const allType = all.every((x) => x.startsWith("type "));
    addImports += (allType ? "import type { " + all.map((x) => x.slice(5)).join(", ") + " } from " : "import { " + all.join(", ") + " } from ") + JSON.stringify(s) + ";\n";
  }
}
if (addImports) {
  const re = parseAst(tgt || "", { lang: lang(TARGET) });
  const lastImp = re.body.filter((n) => n.type === "ImportDeclaration").pop();
  if (lastImp) tgt = tgt.slice(0, lastImp.end) + "\n" + addImports.trimEnd() + tgt.slice(lastImp.end);
  else tgt = addImports + (tgt ? "\n" + tgt : "");
}
tgt = tgt.replace(/\s*$/, "\n") + "\n" + comment + out.trimEnd() + "\n";

// ---------- remove from games.ts, pass ctx at the calls, import it ----------
let store = src.slice(0, cStart) + src.slice(fn.end).replace(/^\n(\s*\n)?/, "\n");
store = store.replace(new RegExp("([^.\\w])" + fnName + "\\(", "g"), "$1" + fnName + "(ctx, ");
let tRel = path.relative(path.dirname(STORE), TARGET).split(path.sep).join("/").replace(/\.tsx?$/, "");
if (!tRel.startsWith(".")) tRel = "./" + tRel;
const sAst = parseAst(store, { lang: "ts" });
const sImp = sAst.body.filter((n) => n.type === "ImportDeclaration");
const existing = sImp.find((n) => n.source.value === tRel);
if (existing) {
  const names = new Set(existing.specifiers.map((sp) => sp.local.name));
  names.add(fnName);
  store = store.slice(0, existing.start) + "import { " + [...names].sort().join(", ") + " } from " + JSON.stringify(tRel) + ";" + store.slice(existing.end);
} else {
  const last = sImp[sImp.length - 1];
  store = store.slice(0, last.end) + "\nimport { " + fnName + " } from " + JSON.stringify(tRel) + ";" + store.slice(last.end);
}
fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, tgt);
fs.writeFileSync(STORE, store);
console.log("  moved to " + path.relative(ROOT, TARGET));
