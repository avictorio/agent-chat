// Refactor tool: move files with git mv and rewrite every relative import
// that points at them, or that they make, so the build sees the same graph.
// Moves only: no file's code changes beyond its import specifiers.
//
//   node scripts/move-files.js <root> <map-file> [--dry]
//
// <root> is the tree whose imports are rewritten (e.g. web/app/src). The map
// file has one move per line, "old -> new", both relative to <root>; blank
// lines and lines starting with # are ignored. A directory may be moved by
// naming it ("feed -> features/feed"). Specifiers keep their style: no
// extension stays no extension, and a ./ prefix is kept for same-folder
// imports. Imports reaching outside <root> (e.g. into contract/) are rewritten too.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const [rootArg, mapArg, ...flags] = process.argv.slice(2);
if (!rootArg || !mapArg) {
  console.error("usage: node scripts/move-files.js <root> <map-file> [--dry]");
  process.exit(2);
}
const dry = flags.includes("--dry");
const root = path.resolve(rootArg);
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".json"];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|css)$/;

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    if (f === "node_modules" || f === "dist") continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// The moves, expanded to files.
const moves = new Map(); // abs old file -> abs new file
const lines = fs.readFileSync(mapArg, "utf8").split("\n");
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^(\S+)\s*->\s*(\S+)$/);
  if (!m) { console.error("bad map line: " + line); process.exit(2); }
  const from = path.join(root, m[1]);
  const to = path.join(root, m[2]);
  if (!fs.existsSync(from)) { console.error("missing: " + m[1]); process.exit(1); }
  if (fs.statSync(from).isDirectory()) {
    for (const f of walk(from, [])) moves.set(f, path.join(to, path.relative(from, f)));
  } else moves.set(from, to);
}
const targets = new Set();
for (const [from, to] of moves) {
  if (targets.has(to)) { console.error("two files move to " + path.relative(root, to)); process.exit(1); }
  targets.add(to);
  if (fs.existsSync(to) && !moves.has(to)) { console.error("target exists: " + path.relative(root, to)); process.exit(1); }
}
const newOf = (abs) => moves.get(abs) || abs;

// Resolve a relative specifier from a file to the file it names.
function resolveSpec(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return { file: base, ext: true };
  for (const e of EXTS) if (fs.existsSync(base + e)) return { file: base + e, ext: false };
  for (const e of EXTS) {
    const idx = path.join(base, "index" + e);
    if (fs.existsSync(idx)) return { file: idx, ext: false, index: true };
  }
  return null;
}

function specFor(fromNew, targetNew, keepExt, index) {
  let target = targetNew;
  if (index) target = path.dirname(target);
  else if (!keepExt) target = target.replace(/\.(ts|tsx|js|jsx|mjs|css|json)$/, "");
  let rel = path.relative(path.dirname(fromNew), target).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

// Import, export-from, dynamic import, bare import and CSS @import specifiers.
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|@import\s+(?:url\()?)(["'])(\.{1,2}\/[^"'\n]*)\2/g;

const files = walk(root, []).filter((f) => SOURCE.test(f));
let changedFiles = 0;
let changedSpecs = 0;
const unresolved = [];
const rewrites = new Map(); // abs old file -> new text
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const fileNew = newOf(file);
  let n = 0;
  const out = src.replace(SPEC, (all, pre, q, spec) => {
    const r = resolveSpec(file, spec);
    if (!r) { unresolved.push(path.relative(root, file) + ": " + spec); return all; }
    if (!moves.has(file) && !moves.has(r.file)) return all;
    const next = specFor(fileNew, newOf(r.file), r.ext, r.index);
    if (next === spec) return all;
    n++;
    return pre + q + next + q;
  });
  if (n) { rewrites.set(file, out); changedFiles++; changedSpecs += n; }
}
if (unresolved.length) {
  console.error("unresolved relative imports (left as they are):\n  " + unresolved.join("\n  "));
}
console.log((dry ? "dry run: " : "") + moves.size + " file(s) move; " + changedSpecs + " specifier(s) in " + changedFiles + " file(s) rewritten");
if (dry) {
  for (const [from, to] of moves) console.log("  " + path.relative(root, from) + " -> " + path.relative(root, to));
  process.exit(0);
}
// Write the rewritten text first (at the old paths), then git mv.
for (const [file, text] of rewrites) fs.writeFileSync(file, text);
for (const [from, to] of moves) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  execFileSync("git", ["mv", from, to], { stdio: "inherit" });
}
// Remove directories the moves emptied.
for (const from of moves.keys()) {
  let d = path.dirname(from);
  while (d.startsWith(root) && d !== root && fs.existsSync(d) && fs.readdirSync(d).length === 0) {
    fs.rmdirSync(d);
    d = path.dirname(d);
  }
}
