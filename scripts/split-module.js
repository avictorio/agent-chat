// Refactor tool for the Worker split (REFACTOR.md phase 2).
//
// Move named top-level declarations out of the Worker entry into a module:
//
//   node scripts/split-module.js move <target> <name,name,...> [--header "text"] [--dry]
//
//   e.g. node scripts/split-module.js move worker/lib/http.js json,html,CORS --header "HTTP helpers."
//
// - Each declaration moves with the comment block directly above it and is
//   exported from the target (appended to if it exists).
// - The target imports what the moved code needs: names exported by other
//   modules under worker/ (found by reading them), `cloudflare:workers`, or
//   the text modules the entry imports (paths adjusted).
// - A move whose code needs a name that stays in the entry is refused, so
//   no module ever imports from worker/index.js (no cycles through it).
// - The entry gains an import for every moved name it still uses.
//
// Check that every module resolves its names:
//
//   node scripts/split-module.js verify
//
// reports identifiers a module uses but neither declares nor imports
// (beyond the runtime's globals) - the mistake a move could make that
// `node --check` cannot see.
//
// Needs the dev dependencies acorn and acorn-walk (npm i at the repo root).
"use strict";

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");

const ROOT = path.join(__dirname, "..");
const WORKER = path.join(ROOT, "worker");
const ENTRY = path.join(WORKER, "index.js");

const parse = (s) => acorn.parse(s, { ecmaVersion: "latest", sourceType: "module", locations: true });

// ---- scope helpers -------------------------------------------------------
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
// Names a function or catch clause declares (block scopes are folded into
// their function: close enough for an import list, and it errs towards
// treating a name as local).
function localDecls(fn) {
  if (declCache.has(fn)) return declCache.get(fn);
  const out = new Set();
  if (fn.type === "CatchClause") { patNames(fn.param, out); declCache.set(fn, out); return out; }
  if (fn.type === "ClassExpression" || fn.type === "ClassDeclaration") { declCache.set(fn, out); return out; }
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
// Is this Identifier a reference (not a property name, label, or key)?
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

// ---- module index ----------------------------------------------------------
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
  const decls = new Map(); // name -> statement node
  const imports = new Map(); // local -> {source, kind}
  const exported = new Set();
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      for (const s of node.specifiers) imports.set(s.local.name, { source: node.source.value, kind: s.type });
      continue;
    }
    const isExport = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";
    const d = isExport ? node.declaration || node : node;
    let names = [];
    if (d && (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) names = [d.id.name];
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
    const { exported } = topLevel(parse(fs.readFileSync(f, "utf8")));
    for (const n of exported) {
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

// ---- move -----------------------------------------------------------------
function move(targetRel, namesArg, header, dry) {
  const target = path.join(ROOT, targetRel);
  if (!target.startsWith(WORKER + path.sep)) throw new Error("target must be under worker/");
  const src = fs.readFileSync(ENTRY, "utf8");
  const ast = parse(src);
  const { decls, imports } = topLevel(ast);
  const exps = exportIndex(ENTRY);
  const known = new Set([...decls.keys(), ...imports.keys(), ...exps.keys()]);
  const names = namesArg.split(",").map((s) => s.trim()).filter(Boolean);

  const stmts = [];
  for (const n of names) {
    const st = decls.get(n);
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

  // line spans with the comment block directly above
  const lines = src.split("\n");
  const lineStart = [0];
  for (let i = 0; i < lines.length; i++) lineStart.push(lineStart[i] + lines[i].length + 1);
  const span = (st) => {
    let a = st.loc.start.line - 1;
    const b = st.loc.end.line - 1;
    if (src.slice(lineStart[a], st.start).trim() !== "") throw new Error("code before the statement on its line: " + lines[a]);
    const after = src.slice(st.end, lineStart[b + 1] - 1);
    if (after.trim() !== "" && !/^\s*\/\//.test(after)) throw new Error("code after the statement on its line: " + lines[b]);
    let inBlock = false;
    while (a > 0) {
      const t = lines[a - 1].trim();
      if (inBlock) { a--; if (t.startsWith("/*")) inBlock = false; continue; }
      if (t.startsWith("//")) { a--; continue; }
      if (t.endsWith("*/")) { a--; if (!t.startsWith("/*")) inBlock = true; continue; }
      break;
    }
    return [a, b];
  };
  const spans = stmts.map((st) => ({ st, sp: span(st) })).sort((x, y) => x.sp[0] - y.sp[0]);

  // what the moved code needs
  const need = new Set();
  for (const { st } of spans) for (const r of refsOf(st, known)) if (!moved.has(r)) need.add(r);
  const fromFiles = new Map(); // file or specifier -> Set
  const textImports = [];
  const stay = [];
  const add = (k, n) => { if (!fromFiles.has(k)) fromFiles.set(k, new Set()); fromFiles.get(k).add(n); };
  for (const r of need) {
    if (exps.has(r)) { if (exps.get(r) !== target) add(exps.get(r), r); }
    else if (imports.has(r)) {
      const im = imports.get(r);
      if (im.source === "cloudflare:workers") add("cloudflare:workers", r);
      else if (im.source.startsWith(".") && im.kind === "ImportDefaultSpecifier") textImports.push({ local: r, abs: path.resolve(WORKER, im.source) });
      else stay.push(r + " (imported from " + im.source + ")");
    } else stay.push(r);
  }
  if (stay.length) throw new Error("the moved code needs names that stay in the entry - move them too, or first:\n  " + stay.sort().join("\n  "));

  // target text
  const targetImports = [];
  for (const t of textImports) targetImports.push("import " + t.local + " from \"" + relImport(target, t.abs) + "\";");
  for (const [k, set] of fromFiles) targetImports.push(importLine(set, k === "cloudflare:workers" ? k : relImport(target, k)));
  const body = spans.map(({ st, sp }) => {
    const tl = lines.slice(sp[0], sp[1] + 1);
    const at = st.loc.start.line - 1 - sp[0];
    if (!tl[at].startsWith("export ")) tl[at] = "export " + tl[at];
    return tl.join("\n");
  }).join("\n\n");
  let out;
  if (fs.existsSync(target)) {
    const ex = fs.readFileSync(target, "utf8");
    const exLines = ex.split("\n");
    let last = -1;
    exLines.forEach((l, i) => { if (/^import |^} from /.test(l)) last = i; });
    const addLines = targetImports.filter((l) => !ex.includes(l));
    if (addLines.length) exLines.splice(last + 1, 0, ...addLines);
    out = exLines.join("\n").replace(/\s*$/, "\n") + "\n" + body + "\n";
  } else {
    out = (header ? "// " + header + "\n\n" : "") + (targetImports.length ? targetImports.join("\n") + "\n\n" : "") + body + "\n";
  }

  // entry text: drop the spans, collapse doubled blank lines
  const keep = lines.slice();
  for (const { sp } of spans.slice().reverse()) {
    keep.splice(sp[0], sp[1] - sp[0] + 1);
    while (sp[0] > 0 && sp[0] < keep.length && keep[sp[0] - 1].trim() === "" && keep[sp[0]].trim() === "") keep.splice(sp[0], 1);
  }
  let entryOut = keep.join("\n");
  const still = refsOf(parse(entryOut), moved);
  // text imports the entry no longer uses
  let el = entryOut.split("\n");
  for (const t of textImports) {
    const uses = (entryOut.match(new RegExp("\\b" + t.local + "\\b", "g")) || []).length;
    if (uses === 1) el = el.filter((l) => !l.startsWith("import " + t.local + " from "));
  }
  entryOut = el.join("\n");
  if (still.size) {
    const from = relImport(ENTRY, target);
    const esc = from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const re = new RegExp("import \\{([^}]*)\\} from \"" + esc + "\";\\n?");
    const mm = entryOut.match(re);
    const merged = new Set(still);
    if (mm) { mm[1].split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => merged.add(n)); entryOut = entryOut.replace(re, ""); }
    const bl = entryOut.split("\n");
    let last = -1;
    for (let i = 0; i < bl.length; i++) {
      if (/^import |^} from /.test(bl[i])) last = i;
      else if (last >= 0 && bl[i].trim() !== "" && !/^ {2}[\w$]+,$/.test(bl[i])) break;
    }
    bl.splice(last + 1, 0, importLine(merged, from));
    entryOut = bl.join("\n");
  }
  parse(entryOut);
  parse(out);
  console.log("move " + moved.size + " name(s) -> " + targetRel + "; imports in the module: " + (targetImports.length || "none") + "; the entry imports back " + still.size);
  if (dry) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out);
  fs.writeFileSync(ENTRY, entryOut);
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
  for (const f of listModules()) {
    const ast = parse(fs.readFileSync(f, "utf8"));
    const { decls, imports } = topLevel(ast);
    const free = new Map();
    walk.fullAncestor(ast, (n, st, anc) => {
      if (n.type !== "Identifier") return;
      if (!isRef(n, anc)) return;
      const nm = n.name;
      if (decls.has(nm) || imports.has(nm) || GLOBALS.has(nm)) return;
      // declarations themselves (params, local vars) are scoped names
      if (shadowed(nm, anc)) return;
      const p = anc[anc.length - 2];
      if (p && (p.type === "VariableDeclarator" && p.id === n)) return;
      if (p && (FN.has(p.type) && (p.id === n || p.params.includes(n)))) return;
      if (p && (p.type === "ClassDeclaration" || p.type === "ClassExpression") && p.id === n) return;
      if (p && p.type === "CatchClause" && p.param === n) return;
      if (!free.has(nm)) free.set(nm, n.loc.start.line);
    });
    if (free.size) {
      bad++;
      console.log(path.relative(ROOT, f) + ": not declared or imported: " + [...free].map(([n, l]) => n + " (line " + l + ")").join(", "));
    }
  }
  if (bad) { console.log("verify: " + bad + " module(s) with unresolved names"); process.exit(1); }
  console.log("verify: every name in " + listModules().length + " module(s) resolves");
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "move") {
    const hi = args.indexOf("--header");
    const header = hi >= 0 ? args[hi + 1] : null;
    move(args[0], args[1], header, args.includes("--dry"));
  } else if (cmd === "verify") verify();
  else { console.error("usage: split-module.js move <target> <names> [--header text] [--dry] | verify"); process.exit(2); }
} catch (e) {
  console.error("split-module: " + e.message);
  process.exit(1);
}
