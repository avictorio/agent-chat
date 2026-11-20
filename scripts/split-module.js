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
// Names a function or catch clause declares (block scopes fold into their
// function: close enough for import lists, and it errs towards "local").
function localDecls(fn) {
  if (declCache.has(fn)) return declCache.get(fn);
  const out = new Set();
  if (fn.type === "CatchClause") { patNames(fn.param, out); declCache.set(fn, out); return out; }
  fn.params.forEach((p) => patNames(p, out));
  if (fn.type === "FunctionExpression" && fn.id) out.add(fn.id.name);
  (function scan(n) {
    if (!n || typeof n.type !== "string") return;
    if (n !== fn.body && FN.has(n.type)) { if (n.type === "FunctionDeclaration") out.add(n.id.name); return; }
    if (n.type === "VariableDeclaration") n.declarations.forEach((d) => patNames(d.id, out));
    if (n.type === "ClassDeclaration" && n.id) out.add(n.id.name);
    for (const k of Object.keys(n)) {
      if (k === "loc") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && scan(c));
      else if (v && typeof v.type === "string") scan(v);
    }
  })(fn.body);
  declCache.set(fn, out);
  return out;
}
function shadowed(name, anc) {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i];
    if ((FN.has(a.type) || a.type === "CatchClause") && localDecls(a).has(name)) return true;
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

// ---- cli -------------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
try {
  if (cmd === "move") move(args[0], args[1], opt("--header"), args.includes("--dry"));
  else if (cmd === "methods") methods(args[0], args[1], opt("--export"), opt("--header"), args.includes("--dry"));
  else if (cmd === "prop") prop(args[0], args[1], args[2], opt("--export"), opt("--header"), args.includes("--dry"));
  else if (cmd === "verify") verify();
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
