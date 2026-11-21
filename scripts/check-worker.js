// Syntax check for every Worker module (worker/**/*.ts): each must parse,
// through the same oxc TypeScript transform the web build uses (rolldown,
// from web/node_modules: `npm i --prefix web` once), without running or
// resolving it. The Worker's modules are TypeScript: a stray .js (or any
// other script) in worker/ fails - wrangler's bundler would take a stray
// x.js over the x.ts its "./x.js" imports mean.
"use strict";

const fs = require("fs");
const path = require("path");

let transformSync;
try {
  ({ transformSync } = require(require.resolve("rolldown/utils", { paths: [path.join(__dirname, "..", "web")] })));
} catch (e) {
  console.error("check-worker: rolldown not found in web/node_modules (run npm i --prefix web): " + e.message);
  process.exit(1);
}

const ROOT = path.join(__dirname, "..", "worker");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|js|mjs|cjs|mts|cts|tsx|jsx)$/.test(e.name)) files.push(p);
  }
})(ROOT);

let bad = 0;
let modules = 0;
for (const f of files.sort()) {
  const rel = path.relative(process.cwd(), f);
  if (!f.endsWith(".ts")) {
    bad++;
    console.error(rel + ": the Worker's modules are TypeScript (.ts); no " + path.extname(f) + " in worker/");
    continue;
  }
  modules++;
  const r = transformSync(f, fs.readFileSync(f, "utf8"), { lang: "ts" });
  if (r.errors && r.errors.length) {
    bad++;
    console.error(rel + " does not parse:\n" + r.errors.map((e) => e.message).join("\n"));
  }
}
if (bad) {
  console.error("check-worker: " + bad + " problem(s)");
  process.exit(1);
}
console.log("check-worker: " + modules + " module(s) parse");
