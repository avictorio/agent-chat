// Refactor tool for the Worker split (REFACTOR.md phase 2). Every command
// edits worker/index.js (the entry) and one module under worker/; nothing
// is ever imported back from the entry, so the modules form no cycle
// through it. Needs the dev dependencies acorn and acorn-walk (npm i).
//
// Move top-level declarations into a module, each with the comment block
// directly above it, exported:
//
//   node scripts/split-module.js move <target> <name,name,...> [--header "text"] [--dry]
//
// Move Room methods (names, or prefixes ending in *) into a module as an
// object of methods, installed back with Object.assign(Room.prototype, NAME)
// right after the class - `this`, call sites and Durable Object RPC are
// unchanged. Methods using `super`, getters, setters and statics stay put:
//
//   node scripts/split-module.js methods <target> <names> --export NAME [--header "text"] [--dry]
//
// Lift one entry of a top-level object literal (a game in GAME_ENGINES)
// into a module as its own export; the object keeps the key, pointing at it:
//
//   node scripts/split-module.js prop <OBJECT> <key> <target> --export NAME [--header "text"] [--dry]
//
// Move one route of routeRequest (picked by a unique piece of its source,
// e.g. its path pattern) into a handler; routeRequest keeps the test and
// delegates, so route order and fall-through are unchanged:
//
//   node scripts/split-module.js route <target> <handlerName> <match> [--header "text"] [--dry]
//
// Drop named imports a module no longer uses:
//
//   node scripts/split-module.js prune [--dry]
//
// Report names a module uses but neither declares nor imports (what a move
// could get wrong that `node --check` cannot see):
//
//   node scripts/split-module.js verify
//
// The moved code's imports come from the modules that export them (found by
// reading worker/), `cloudflare:workers`, or the entry's text-module imports
// (paths adjusted). A move whose code needs a name that stays in the entry
// is refused: move that name first, or with it.
"use strict";

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");

const ROOT = path.join(__dirname, "..");
const WORKER = path.join(ROOT, "worker");
const ENTRY = path.join(WORKER, "index.js");

const parse = (s) => acorn.parse(s, { ecmaVersion: "latest", sourceType: "module", locations: true });

// ---- scopes ----------------------------------------------------------------
const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const declCache = new WeakMap();
function patNames(p, out) {
  if (!p) return;
  if (p.type === "Identifier") out.add(p.name);
  else if (p.type === "ObjectPattern") p.properties.forEach((q) => patNames(q.type === "RestElement" ? q.argument : q.value, out));
  else if (p.type === "ArrayPattern") p.elements.forEach((q) => patNames(q, out));
  else if (p.type === "RestElement") patNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patNames(p.left, out);
}
// The names a scope-creating node declares, with real block scoping (a
// `const page` in one block does not hide an imported `page` elsewhere in
// the function):
//   function: params, its own name (expressions), and `var`s anywhere in
//             its body outside nested functions
//   block / switch / function body: let, const, class and function
//             declarations directly inside
//   for / for-in / for-of: let/const in the head
//   catch: its parameter
const SCOPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "BlockStatement",
  "StaticBlock", "SwitchStatement", "ForStatement", "ForInStatement", "ForOfStatement", "CatchClause"]);
function lexicalIn(stmts, out) {
  for (const s of stmts) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") s.declarations.forEach((d) => patNames(d.id, out));
    else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) out.add(s.id.name);
  }
}
function scopeDecls(node) {
  if (declCache.has(node)) return declCache.get(node);
  const out = new Set();
  if (FN.has(node.type)) {
    node.params.forEach((p) => patNames(p, out));
    if (node.type === "FunctionExpression" && node.id) out.add(node.id.name);
    (function vars(n) {
      if (!n || typeof n.type !== "string") return;
      if (n !== node.body && FN.has(n.type)) return;
      if (n.type === "VariableDeclaration" && n.kind === "var") n.declarations.forEach((d) => patNames(d.id, out));
      for (const k of Object.keys(n)) {
        if (k === "loc") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && vars(c));
        else if (v && typeof v.type === "string") vars(v);
      }
    })(node.body);
  } else if (node.type === "BlockStatement" || node.type === "StaticBlock") lexicalIn(node.body, out);
  else if (node.type === "SwitchStatement") node.cases.forEach((c) => lexicalIn(c.consequent, out));
  else if (node.type === "ForStatement") { if (node.init && node.init.type === "VariableDeclaration" && node.init.kind !== "var") node.init.declarations.forEach((d) => patNames(d.id, out)); }
  else if (node.type === "ForInStatement" || node.type === "ForOfStatement") { if (node.left.type === "VariableDeclaration" && node.left.kind !== "var") node.left.declarations.forEach((d) => patNames(d.id, out)); }
  else if (node.type === "CatchClause") patNames(node.param, out);
  declCache.set(node, out);
  return out;
}
// Is `name` declared by a scope enclosing the node at the end of `anc`?
function shadowed(name, anc) {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i];
    if (SCOPES.has(a.type) && scopeDecls(a).has(name)) return true;
  }
  return false;
}
// Is this Identifier a reference (not a property name, key or label)?
function isRef(n, anc) {
  const p = anc[anc.length - 2];
  if (!p) return true;
  if (p.type === "MemberExpression" && p.property === n && !p.computed) return false;
  if ((p.type === "Property" || p.type === "MethodDefinition" || p.type === "PropertyDefinition") && p.key === n && !p.computed && !p.shorthand) return false;
  if (p.type === "LabeledStatement" || p.type === "BreakStatement" || p.type === "ContinueStatement") return false;
  if (p.type === "ImportSpecifier" || p.type === "ImportDefaultSpecifier" || p.type === "ExportSpecifier") return false;
  if (p.type === "MetaProperty") return false;
  return true;
}
function refsOf(node, wanted) {
  const out = new Set();
  walk.fullAncestor(node, (n, st, anc) => {
    if (n.type !== "Identifier" || !wanted.has(n.name)) return;
    if (!isRef(n, anc) || shadowed(n.name, anc)) return;
    out.add(n.name);
  });
  return out;
}

// ---- modules ---------------------------------------------------------------
function listModules() {
  const files = [];
  (function w(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) w(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  })(WORKER);
  return files.sort();
}
function topLevel(ast) {
  const decls = new Map(); // name -> statement
  const imports = new Map(); // local -> { source, kind }
  const exported = new Set();
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      for (const s of node.specifiers) imports.set(s.local.name, { source: node.source.value, kind: s.type });
      continue;
    }
    const d = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" ? node.declaration || node : node;
    const names = [];
    if (d && (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) names.push(d.id.name);
    else if (d && d.type === "VariableDeclaration") d.declarations.forEach((v) => names.push(v.id.name));
    for (const n of names) { decls.set(n, node); if (node.type === "ExportNamedDeclaration") exported.add(n); }
    if (node.type === "ExportNamedDeclaration" && node.specifiers) node.specifiers.forEach((s) => exported.add(s.exported.name));
  }
  return { decls, imports, exported };
}
function exportIndex(except) {
  const idx = new Map();
  for (const f of listModules()) {
    if (f === except) continue;
    for (const n of topLevel(parse(fs.readFileSync(f, "utf8"))).exported) {
      if (idx.has(n)) throw new Error(n + " is exported by both " + idx.get(n) + " and " + f);
      idx.set(n, f);
    }
  }
  return idx;
}
const relImport = (fromFile, toFile) => {
  let r = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  return r;
};
function importLine(names, from) {
  const list = [...names].sort();
  const one = "import { " + list.join(", ") + " } from \"" + from + "\";";
  if (one.length <= 100) return one;
  return "import {\n" + list.map((n) => "  " + n + ",\n").join("") + "} from \"" + from + "\";";
}
// Add imports to a module's text, merging with an existing named import from
// the same source. named: Map(source -> Set(names)); defaults: Map(local ->
// source) for text modules. New lines go after the last import, or after the
// file's leading comment block.
function ensureImports(text, named, defaults) {
  const decls = parse(text).body.filter((n) => n.type === "ImportDeclaration");
  const edits = [];
  const fresh = [];
  for (const [src, names] of named) {
    const ex = decls.find((d) => d.source.value === src && d.specifiers.length && d.specifiers.every((s) => s.type === "ImportSpecifier"));
    if (ex) {
      const have = new Set(ex.specifiers.map((s) => s.local.name));
      const all = new Set([...have, ...names]);
      if (all.size !== have.size) edits.push([ex.start, ex.end, importLine(all, src)]);
    } else fresh.push(importLine(names, src));
  }
  for (const [local, src] of defaults || []) {
    if (!decls.some((d) => d.specifiers.some((s) => s.local.name === local))) fresh.push("import " + local + " from \"" + src + "\";");
  }
  let out = text;
  for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + r + out.slice(b);
  if (!fresh.length) return out;
  const lines = out.split("\n");
  const imps = parse(out).body.filter((n) => n.type === "ImportDeclaration");
  let at;
  if (imps.length) at = imps[imps.length - 1].loc.end.line;
  else {
    at = 0;
    while (at < lines.length && lines[at].startsWith("//")) at++;
    if (at > 0) { lines.splice(at, 0, ""); at++; }
  }
  lines.splice(at, 0, ...fresh);
  const next = lines[at + fresh.length];
  if (!imps.length && next !== undefined && next.trim() !== "") lines.splice(at + fresh.length, 0, "");
  return lines.join("\n");
}
// The imports `file` needs for `need`, by source; and the names nothing
// outside the entry provides.
function wantedImports(file, need, exps, entryImports) {
  const named = new Map();
  const defaults = new Map();
  const stay = [];
  const add = (k, n) => { if (!named.has(k)) named.set(k, new Set()); named.get(k).add(n); };
  for (const r of need) {
    if (exps.has(r)) { if (exps.get(r) !== file) add(relImport(file, exps.get(r)), r); }
    else if (entryImports.has(r)) {
      const im = entryImports.get(r);
      if (im.source === "cloudflare:workers") add(im.source, r);
      else if (im.source.startsWith(".") && im.kind === "ImportDefaultSpecifier") defaults.set(r, relImport(file, path.resolve(WORKER, im.source)));
      else stay.push(r + " (imported from " + im.source + ")");
    } else stay.push(r);
  }
  return { named, defaults, stay };
}
// The comment lines directly above line index `a` (0-based), not above `floor`.
function climbComments(lines, a, floor) {
  let inBlock = false;
  while (a > floor) {
    const t = lines[a - 1].trim();
    if (inBlock) { a--; if (t.startsWith("/*")) inBlock = false; continue; }
    if (t.startsWith("//")) { a--; continue; }
    if (t.endsWith("*/")) { a--; if (!t.startsWith("/*")) inBlock = true; continue; }
    break;
  }
  return a;
}
// Join line spans: neighbours in the source stay together, others get one
// blank line between them. pieces: [{ sp: [a, b], text }]
function joinPieces(pieces) {
  let body = "";
  pieces.forEach((p, i) => {
    if (i > 0) body += p.sp[0] === pieces[i - 1].sp[1] + 1 ? "\n" : "\n\n";
    body += p.text;
  });
  return body;
}
// Remove line spans from the entry, collapsing doubled blank lines.
function cutSpans(lines, spans) {
  const keep = lines.slice();
  for (const sp of spans.slice().sort((x, y) => y[0] - x[0])) {
    keep.splice(sp[0], sp[1] - sp[0] + 1);
    while (sp[0] > 0 && sp[0] < keep.length && keep[sp[0] - 1].trim() === "" && keep[sp[0]].trim() === "") keep.splice(sp[0], 1);
  }
  return keep.join("\n");
}
// New or extended target text: header, imports, then the block.
function targetText(target, header, need, exps, entryImports, block) {
  const { named, defaults, stay } = wantedImports(target, need, exps, entryImports);
  if (stay.length) throw new Error("the moved code needs names that stay in the entry - move them first, or with it:\n  " + stay.sort().join("\n  "));
  const base = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\s*$/, "\n") + "\n" : header ? "// " + header + "\n" : "";
  return ensureImports(base + block, named, defaults);
}
// Drop entry imports of text modules nothing in the entry uses any more.
function dropUnusedTextImports(text) {
  const ast = parse(text);
  const { imports } = topLevel(ast);
  const unused = [];
  for (const [local, im] of imports) {
    if (im.kind !== "ImportDefaultSpecifier" || !im.source.startsWith(".")) continue;
    if (!refsOf(ast, new Set([local])).size) unused.push(local);
  }
  if (!unused.length) return text;
  return text.split("\n").filter((l) => !unused.some((u) => l.startsWith("import " + u + " from "))).join("\n");
}
function finish(targetRel, out, entryOut, dry, summary) {
  parse(out);
  parse(entryOut);
  console.log(summary);
  if (dry) return;
  const target = path.join(ROOT, targetRel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out);
  fs.writeFileSync(ENTRY, entryOut);
}
function loadEntry() {
  const src = fs.readFileSync(ENTRY, "utf8");
  const ast = parse(src);
  const tl = topLevel(ast);
  const exps = exportIndex(ENTRY);
  const known = new Set([...tl.decls.keys(), ...tl.imports.keys(), ...exps.keys()]);
  return { src, ast, lines: src.split("\n"), decls: tl.decls, imports: tl.imports, exps, known };
}
function checkTarget(targetRel) {
  const target = path.join(ROOT, targetRel);
  if (!target.startsWith(WORKER + path.sep) || target === ENTRY) throw new Error("target must be a module under worker/ other than the entry");
  return target;
}

// ---- move ------------------------------------------------------------------
function move(targetRel, namesArg, header, dry) {
  const target = checkTarget(targetRel);
  const E = loadEntry();
  const names = namesArg.split(",").map((s) => s.trim()).filter(Boolean);
  const stmts = [];
  for (const n of names) {
    const st = E.decls.get(n);
    if (!st) throw new Error("not a top-level declaration in the entry: " + n);
    if (st.type === "ExportDefaultDeclaration") throw new Error("refusing to move the default export");
    if (!stmts.includes(st)) stmts.push(st);
  }
  const moved = new Set();
  for (const st of stmts) {
    const d = st.declaration || st;
    if (d.type === "VariableDeclaration") d.declarations.forEach((v) => moved.add(v.id.name));
    else moved.add(d.id.name);
  }
  for (const n of moved) if (!names.includes(n)) throw new Error("the statement also declares " + n + ": list it too");
  const pieces = stmts.map((st) => {
    const a0 = st.loc.start.line - 1;
    const b = st.loc.end.line - 1;
    if (E.lines[a0].slice(0, st.loc.start.column).trim() !== "") throw new Error("code before the statement on its line: " + E.lines[a0]);
    const after = E.lines[b].slice(st.loc.end.column);
    if (after.trim() !== "" && !/^\s*\/\//.test(after)) throw new Error("code after the statement on its line: " + E.lines[b]);
    const a = climbComments(E.lines, a0, 0);
    const tl = E.lines.slice(a, b + 1);
    if (!tl[a0 - a].startsWith("export ")) tl[a0 - a] = "export " + tl[a0 - a];
    return { st, sp: [a, b], text: tl.join("\n") };
  }).sort((x, y) => x.sp[0] - y.sp[0]);
  const need = new Set();
  for (const p of pieces) for (const r of refsOf(p.st, E.known)) if (!moved.has(r)) need.add(r);
  const out = targetText(target, header, need, E.exps, E.imports, joinPieces(pieces) + "\n");
  let entryOut = dropUnusedTextImports(cutSpans(E.lines, pieces.map((p) => p.sp)));
  const still = refsOf(parse(entryOut), moved);
  if (still.size) entryOut = ensureImports(entryOut, new Map([[relImport(ENTRY, target), still]]));
  finish(targetRel, out, entryOut, dry, "move " + moved.size + " name(s) -> " + targetRel + "; the entry imports back " + still.size);
}

// ---- methods ---------------------------------------------------------------
function methods(targetRel, namesArg, exportName, header, dry) {
  const target = checkTarget(targetRel);
  if (!/^[A-Za-z_$][\w$]*$/.test(exportName || "")) throw new Error("--export NAME is required");
  const E = loadEntry();
  if (E.exps.has(exportName) || E.decls.has(exportName)) throw new Error(exportName + " is already declared");
  const classStmt = E.ast.body.find((n) => { const d = n.declaration || n; return d.type === "ClassDeclaration" && d.id && d.id.name === "Room"; });
  if (!classStmt) throw new Error("no class Room in the entry");
  const cls = classStmt.declaration || classStmt;
  const pats = namesArg.split(",").map((s) => s.trim()).filter(Boolean);
  const matches = (n) => pats.some((p) => (p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p));
  const members = cls.body.body;
  const picked = members.filter((m) => m.type === "MethodDefinition" && !m.computed && matches(m.key.name || m.key.value));
  for (const p of pats) if (!p.endsWith("*") && !picked.some((m) => (m.key.name || m.key.value) === p)) throw new Error("no Room method named " + p);
  if (!picked.length) throw new Error("no Room methods match");
  for (const m of picked) {
    const nm = m.key.name || m.key.value;
    if (m.kind !== "method" || m.static) throw new Error(nm + " is a " + (m.static ? "static " : "") + m.kind + ": only plain methods move");
    let usesSuper = false;
    walk.full(m.value, (x) => { if (x.type === "Super") usesSuper = true; });
    if (usesSuper) throw new Error(nm + " uses super: it stays in the class");
  }
  const pieces = picked.map((m) => {
    const a0 = m.loc.start.line - 1;
    const b = m.loc.end.line - 1;
    if (E.lines[a0].slice(0, m.loc.start.column).trim() !== "") throw new Error("code before the method on its line: " + E.lines[a0]);
    if (E.lines[b].slice(m.loc.end.column).trim() !== "") throw new Error("code after the method on its line: " + E.lines[b]);
    const i = members.indexOf(m);
    const floor = i > 0 ? members[i - 1].loc.end.line : cls.body.loc.start.line;
    const a = climbComments(E.lines, a0, floor);
    const tl = E.lines.slice(a, b + 1);
    tl[tl.length - 1] += ",";
    return { m, sp: [a, b], text: tl.join("\n") };
  }).sort((x, y) => x.sp[0] - y.sp[0]);
  const need = new Set();
  for (const p of pieces) for (const r of refsOf(p.m.value, E.known)) need.add(r);
  const out = targetText(target, header, need, E.exps, E.imports, "export const " + exportName + " = {\n" + joinPieces(pieces) + "\n};\n");
  let entryOut = cutSpans(E.lines, pieces.map((p) => p.sp));
  // install right after the class (after earlier installs), then import
  const cls2 = parse(entryOut).body.map((n) => n.declaration || n).find((d) => d.type === "ClassDeclaration" && d.id && d.id.name === "Room");
  const el = entryOut.split("\n");
  let at = cls2.loc.end.line;
  while (at < el.length && /^Object\.assign\(Room\.prototype, /.test(el[at])) at++;
  el.splice(at, 0, "Object.assign(Room.prototype, " + exportName + ");");
  entryOut = ensureImports(el.join("\n"), new Map([[relImport(ENTRY, target), new Set([exportName])]]));
  finish(targetRel, out, entryOut, dry, "methods: " + picked.length + " -> " + targetRel + " as " + exportName +
    (dry ? " (" + picked.map((m) => m.key.name || m.key.value).join(", ") + ")" : ""));
}

// ---- prop ------------------------------------------------------------------
function prop(objName, key, targetRel, exportName, header, dry) {
  const target = checkTarget(targetRel);
  if (!/^[A-Za-z_$][\w$]*$/.test(exportName || "")) throw new Error("--export NAME is required");
  const E = loadEntry();
  if (E.exps.has(exportName) || E.decls.has(exportName)) throw new Error(exportName + " is already declared");
  const st = E.decls.get(objName);
  const d = st && (st.declaration || st);
  const decl = d && d.type === "VariableDeclaration" && d.declarations.find((v) => v.id.name === objName);
  if (!decl || !decl.init || decl.init.type !== "ObjectExpression") throw new Error(objName + " is not a top-level object literal");
  const props = decl.init.properties;
  const p = props.find((q) => q.type === "Property" && !q.computed && (q.key.name || q.key.value) === key);
  if (!p) return propAssign(E, objName, key, target, targetRel, exportName, header, dry);
  const a0 = p.loc.start.line - 1;
  const b = p.loc.end.line - 1;
  if (E.lines[a0].slice(0, p.loc.start.column).trim() !== "") throw new Error("code before the property on its line");
  const tail = E.lines[b].slice(p.loc.end.column).trim();
  if (tail !== "" && tail !== ",") throw new Error("code after the property on its line");
  const i = props.indexOf(p);
  const a = climbComments(E.lines, a0, i > 0 ? props[i - 1].loc.end.line : decl.init.loc.start.line);
  const indent = E.lines[a0].match(/^ */)[0];
  const dedent = (l) => (l.startsWith(indent) ? l.slice(indent.length) : l);
  const comments = E.lines.slice(a, a0).map(dedent);
  const valueText = E.src.slice(p.value.start, p.value.end).split("\n").map((l, j) => (j === 0 ? l : dedent(l))).join("\n");
  const block = (comments.length ? comments.join("\n") + "\n" : "") + "export const " + exportName + " = " + valueText + ";\n";
  const out = targetText(target, header, refsOf(p.value, E.known), E.exps, E.imports, block);
  const el = E.lines.slice();
  el.splice(a, b - a + 1, indent + (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)) + ": " + exportName + ",");
  const entryOut = ensureImports(el.join("\n"), new Map([[relImport(ENTRY, target), new Set([exportName])]]));
  finish(targetRel, out, entryOut, dry, "prop " + objName + "." + key + " -> " + targetRel + " as " + exportName);
}
// The other form: a top-level `OBJECT.key = { ... };` statement. Its value
// moves; the statement stays, as `OBJECT.key = exportName;`, so the object's
// key order (and everything that lists it) is unchanged.
function propAssign(E, objName, key, target, targetRel, exportName, header, dry) {
  const stmt = E.ast.body.find((n) => n.type === "ExpressionStatement" && n.expression.type === "AssignmentExpression" &&
    n.expression.left.type === "MemberExpression" && !n.expression.left.computed &&
    n.expression.left.object.type === "Identifier" && n.expression.left.object.name === objName &&
    n.expression.left.property.name === key);
  if (!stmt) throw new Error(objName + " has no property " + key + " (in the literal or as " + objName + "." + key + " = ...)");
  const value = stmt.expression.right;
  const a0 = stmt.loc.start.line - 1;
  const b = stmt.loc.end.line - 1;
  if (E.lines[a0].slice(0, stmt.loc.start.column).trim() !== "") throw new Error("code before the statement on its line");
  if (E.lines[b].slice(stmt.loc.end.column).trim() !== "") throw new Error("code after the statement on its line");
  const a = climbComments(E.lines, a0, 0);
  const comments = E.lines.slice(a, a0);
  const block = (comments.length ? comments.join("\n") + "\n" : "") + "export const " + exportName + " = " + E.src.slice(value.start, value.end) + ";\n";
  const out = targetText(target, header, refsOf(value, E.known), E.exps, E.imports, block);
  const el = E.lines.slice();
  el.splice(a, b - a + 1, objName + "." + key + " = " + exportName + ";");
  const entryOut = ensureImports(el.join("\n"), new Map([[relImport(ENTRY, target), new Set([exportName])]]));
  finish(targetRel, out, entryOut, dry, "prop " + objName + "." + key + " (assigned) -> " + targetRel + " as " + exportName);
}

// ---- route -----------------------------------------------------------------
// Move one route of routeRequest into a handler. A route is either the pair
//   X = path.match(RE);  if (X) { BODY }      (X declared or assigned)
// or a single
//   if (TEST) { BODY }
// picked by a piece of its source text (`match`). BODY moves verbatim into
//   export async function NAME(rc, X) { const { request, env, ... } = rc; BODY }
// and routeRequest keeps the test, delegating:
//   if (X) { const r = await NAME(rc, X); if (r !== undefined) return r; }
// so order and fall-through are unchanged. routeRequest gets
// `const rc = { request, env, url, path, owner, invite, inviteHdr };` once.
const ROUTE_CTX = ["request", "env", "url", "path", "owner", "invite", "inviteHdr"];
function route(targetRel, name, match, header, dry) {
  const target = checkTarget(targetRel);
  if (!/^[A-Za-z_$][\w$]*$/.test(name || "")) throw new Error("a handler NAME is required");
  let E = loadEntry();
  if (E.exps.has(name) || E.decls.has(name)) throw new Error(name + " is already declared");
  const fnOf = (ast) => ast.body.find((n) => n.type === "FunctionDeclaration" && n.id.name === "routeRequest");
  let fn = fnOf(E.ast);
  if (!fn) throw new Error("no routeRequest in the entry");
  const blockOf = (f) => (f.body.body.length === 1 && f.body.body[0].type === "BlockStatement" ? f.body.body[0] : f.body);
  // the context object, once
  if (!/const rc = \{ request, env, url, path, owner, invite, inviteHdr \};/.test(E.src)) {
    const blk = blockOf(fn);
    const last = blk.body.find((s) => s.type === "VariableDeclaration" && s.declarations.some((d) => d.id.name === "inviteHdr"));
    if (!last) throw new Error("routeRequest has no inviteHdr declaration to follow");
    const el = E.lines.slice();
    const ind = el[last.loc.start.line - 1].match(/^ */)[0];
    el.splice(last.loc.end.line, 0, ind + "const rc = { request, env, url, path, owner, invite, inviteHdr };");
    const text = el.join("\n");
    E = Object.assign({}, E, { src: text, ast: parse(text), lines: text.split("\n") });
    fn = fnOf(E.ast);
  }
  const stmts = blockOf(fn).body;
  const srcOf = (n) => E.src.slice(n.start, n.end);
  const hits = stmts.filter((s) => srcOf(s).includes(match) && (s.type === "IfStatement" || s.type === "VariableDeclaration" || s.type === "ExpressionStatement"));
  if (hits.length !== 1) throw new Error("'" + match + "' picks " + hits.length + " statements in routeRequest; make it unique");
  let first = hits[0];
  let ifs;
  let varName = null;
  const assignTarget = (s) => {
    if (s.type === "VariableDeclaration" && s.declarations.length === 1 && s.declarations[0].init) return s.declarations[0].id.name;
    if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.left.type === "Identifier") return s.expression.left.name;
    return null;
  };
  // the if's test may be the match variable or use it (`X && method === "GET"`)
  const testUses = (s, v) => !!v && refsOf(s.test, new Set([v])).size > 0;
  if (first.type === "IfStatement") {
    ifs = first;
    const i = stmts.indexOf(first);
    const prev = i > 0 ? stmts[i - 1] : null;
    const pv = prev && assignTarget(prev);
    if (pv && testUses(ifs, pv)) { first = prev; varName = pv; }
  } else {
    varName = assignTarget(first);
    ifs = stmts[stmts.indexOf(first) + 1];
    if (!varName || !ifs || ifs.type !== "IfStatement" || !testUses(ifs, varName)) throw new Error("expected an if testing " + varName + " right after the match");
  }
  if (ifs.alternate) throw new Error("the route's if has an else branch");
  if (ifs.consequent.type !== "BlockStatement" || !ifs.consequent.body.length) throw new Error("the route's if needs a { ... } body");
  if (ifs.consequent.loc.start.line === ifs.consequent.loc.end.line) throw new Error("single-line route: leave it in routeRequest");
  const body = ifs.consequent.body;
  // the body's own names: context names destructured, the match variable a
  // parameter, routeRequest's other locals refused
  const locals = new Set();
  fn.params.forEach((p) => patNames(p, locals));
  for (const s of stmts) if (s.type === "VariableDeclaration") s.declarations.forEach((d) => patNames(d.id, locals));
  locals.add("rc");
  // names the body declares itself are its own, not routeRequest's
  const own = new Set();
  for (const s of body) {
    if (s.type === "VariableDeclaration") s.declarations.forEach((d) => patNames(d.id, own));
    if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) own.add(s.id.name);
  }
  if (own.has("rc")) throw new Error("the route declares its own rc");
  const usedLocals = new Set();
  for (const s of body) refsOf(s, locals).forEach((n) => { if (!own.has(n)) usedLocals.add(n); });
  const ctxUsed = ROUTE_CTX.filter((n) => usedLocals.has(n));
  const strayLocals = [...usedLocals].filter((n) => !ROUTE_CTX.includes(n) && n !== varName);
  if (strayLocals.length) throw new Error("the route uses routeRequest locals besides the context: " + strayLocals.join(", "));
  let bare = false;
  for (const s of body) walk.full(s, (x) => { if (x.type === "ReturnStatement" && !x.argument) bare = true; });
  if (bare) throw new Error("the route has a bare `return;` (it would read as fall-through)");
  const need = new Set();
  for (const s of body) refsOf(s, E.known).forEach((n) => need.add(n));
  ROUTE_CTX.forEach((n) => need.delete(n));
  if (varName) need.delete(varName);
  // comments directly above the route move with it
  const a0 = first.loc.start.line - 1;
  const a = climbComments(E.lines, a0, blockOf(fn).loc.start.line);
  const b = ifs.loc.end.line - 1;
  const comments = E.lines.slice(a, a0).map((l) => l.replace(/^ */, ""));
  const bodyStart = body[0].loc.start.line - 1;
  const bodyEnd = body[body.length - 1].loc.end.line - 1;
  const ind = E.lines[bodyStart].match(/^ */)[0].length;
  const shift = ind - 2;
  const bodyLines = E.lines.slice(bodyStart, bodyEnd + 1).map((l) => (l.slice(0, shift).trim() === "" ? l.slice(shift) : l));
  const head = "export async function " + name + "(rc" + (varName ? ", " + varName : "") + ") {";
  const destr = ctxUsed.length ? ["  const { " + ctxUsed.join(", ") + " } = rc;"] : [];
  const block = (comments.length ? comments.join("\n") + "\n" : "") + [head].concat(destr, bodyLines, ["}"]).join("\n") + "\n";
  const out = targetText(target, header, need, E.exps, E.imports, block);
  // routeRequest: keep the match and the test, delegate
  const rind = E.lines[a0].match(/^ */)[0];
  const keep = [];
  if (first !== ifs) keep.push(...E.lines.slice(first.loc.start.line - 1, first.loc.end.line));
  const test = E.src.slice(ifs.test.start, ifs.test.end);
  keep.push(rind + "if (" + test + ") { const r = await " + name + "(rc" + (varName ? ", " + varName : "") + "); if (r !== undefined) return r; }");
  const el = E.lines.slice();
  el.splice(a, b - a + 1, ...keep);
  const entryOut = ensureImports(el.join("\n"), new Map([[relImport(ENTRY, target), new Set([name])]]));
  finish(targetRel, out, entryOut, dry, "route " + name + " (" + (varName ? varName + " = " : "") + test.slice(0, 50) + ") -> " + targetRel);
}

// ---- verify ----------------------------------------------------------------
// Globals of the Workers runtime and the language that modules may use bare.
const GLOBALS = new Set(("undefined NaN Infinity globalThis Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Error TypeError RangeError SyntaxError ReferenceError " +
  "Promise Map Set WeakMap WeakSet WeakRef Proxy Reflect Intl ArrayBuffer SharedArrayBuffer DataView Uint8Array Uint8ClampedArray Int8Array Uint16Array Int16Array Uint32Array Int32Array " +
  "Float32Array Float64Array BigInt64Array BigUint64Array parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape " +
  "console crypto fetch Request Response Headers URL URLSearchParams FormData Blob File TextEncoder TextDecoder ReadableStream WritableStream TransformStream " +
  "FixedLengthStream IdentityTransformStream CompressionStream DecompressionStream HTMLRewriter WebSocket WebSocketPair AbortController AbortSignal " +
  "setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone atob btoa caches scheduler navigator performance EventTarget Event CustomEvent " +
  "arguments AggregateError EvalError URIError FinalizationRegistry DOMException CryptoKey SubtleCrypto").split(/\s+/));
function verify() {
  let bad = 0;
  const all = listModules();
  for (const f of all) {
    const ast = parse(fs.readFileSync(f, "utf8"));
    const { decls, imports } = topLevel(ast);
    const free = new Map();
    walk.fullAncestor(ast, (n, st, anc) => {
      if (n.type !== "Identifier" || !isRef(n, anc)) return;
      const nm = n.name;
      if (decls.has(nm) || imports.has(nm) || GLOBALS.has(nm) || shadowed(nm, anc)) return;
      const p = anc[anc.length - 2];
      if (p && p.type === "VariableDeclarator" && p.id === n) return;
      if (p && FN.has(p.type) && (p.id === n || p.params.includes(n))) return;
      if (p && (p.type === "ClassDeclaration" || p.type === "ClassExpression") && p.id === n) return;
      if (p && p.type === "CatchClause" && p.param === n) return;
      if (!free.has(nm)) free.set(nm, n.loc.start.line);
    });
    // every named import must exist in its module
    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration" || !node.source.value.startsWith(".")) continue;
      const file = path.resolve(path.dirname(f), node.source.value);
      if (!file.endsWith(".js")) continue;
      if (!fs.existsSync(file)) { free.set("(missing module " + node.source.value + ")", node.loc.start.line); continue; }
      const ex = topLevel(parse(fs.readFileSync(file, "utf8"))).exported;
      for (const s of node.specifiers) if (s.type === "ImportSpecifier" && !ex.has(s.imported.name)) free.set(s.imported.name + " (not exported by " + node.source.value + ")", node.loc.start.line);
    }
    if (free.size) {
      bad++;
      console.log(path.relative(ROOT, f) + ": " + [...free].map(([n, l]) => n + " (line " + l + ")").join(", "));
    }
  }
  if (bad) { console.log("verify: " + bad + " module(s) with unresolved names"); process.exit(1); }
  console.log("verify: every name in " + all.length + " module(s) resolves");
}

// ---- prune -----------------------------------------------------------------
// Drop named imports a module no longer uses (moves leave them behind in
// the entry when the last user of a name moves out).
function prune(dry) {
  let total = 0;
  for (const f of listModules()) {
    const text = fs.readFileSync(f, "utf8");
    const ast = parse(text);
    const imps = ast.body.filter((n) => n.type === "ImportDeclaration");
    const names = new Set();
    imps.forEach((d) => d.specifiers.forEach((s) => names.add(s.local.name)));
    const used = new Set();
    for (const n of ast.body) if (n.type !== "ImportDeclaration") refsOf(n, names).forEach((x) => used.add(x));
    const edits = [];
    for (const d of imps) {
      if (!d.specifiers.length || d.specifiers.some((s) => s.type !== "ImportSpecifier")) {
        // a default (text module) import: drop the whole line when unused
        if (d.specifiers.length === 1 && d.specifiers[0].type === "ImportDefaultSpecifier" && !used.has(d.specifiers[0].local.name)) edits.push([d, null]);
        continue;
      }
      const keep = d.specifiers.filter((s) => used.has(s.local.name)).map((s) => s.local.name);
      if (keep.length === d.specifiers.length) continue;
      edits.push([d, keep.length ? importLine(keep, d.source.value) : null]);
    }
    if (!edits.length) continue;
    let out = text;
    for (const [d, r] of edits.sort((x, y) => y[0].start - x[0].start)) {
      let end = d.end;
      if (r === null && out[end] === "\n") end++;
      out = out.slice(0, d.start) + (r === null ? "" : r) + out.slice(end);
    }
    const dropped = edits.reduce((n, [d, r]) => n + d.specifiers.length - (r === null ? 0 : parse(r).body[0].specifiers.length), 0);
    total += dropped;
    console.log(path.relative(ROOT, f) + ": " + dropped + " unused import(s)");
    parse(out);
    if (!dry) fs.writeFileSync(f, out);
  }
  console.log("prune: " + total + " unused import(s)" + (dry ? " (dry run)" : " removed"));
}

// ---- cli -------------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
try {
  if (cmd === "move") move(args[0], args[1], opt("--header"), args.includes("--dry"));
  else if (cmd === "methods") methods(args[0], args[1], opt("--export"), opt("--header"), args.includes("--dry"));
  else if (cmd === "prop") prop(args[0], args[1], args[2], opt("--export"), opt("--header"), args.includes("--dry"));
  else if (cmd === "route") route(args[0], args[1], args[2], opt("--header"), args.includes("--dry"));
  else if (cmd === "verify") verify();
  else if (cmd === "prune") prune(args.includes("--dry"));
  else {
    console.error("usage: split-module.js move <target> <names> [--header text] [--dry]\n" +
      "       split-module.js methods <target> <names|prefix*> --export NAME [--header text] [--dry]\n" +
      "       split-module.js prop <OBJECT> <key> <target> --export NAME [--header text] [--dry]\n" +
      "       split-module.js verify");
    process.exit(2);
  }
} catch (e) {
  console.error("split-module: " + e.message);
  process.exit(1);
}
