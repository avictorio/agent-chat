// Syntax check for every Worker module (worker/**/*.ts): each must parse,
// through the same oxc TypeScript transform the web build uses (rolldown,
// from web/node_modules: `npm i --prefix web` once), without running or
// resolving it. The Worker is moving from JS to TypeScript: a .js module
// is allowed only in a folder not converted yet (JS_LEFT; node --check
// parses it), and never next to a .ts of the same name - wrangler's
// bundler would pick the stray .js.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const JS_LEFT = ["room", "games"];

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
    else if (/\.(ts|js|mjs|cjs|mts|cts)$/.test(e.name)) files.push(p);
  }
})(ROOT);

let bad = 0;
for (const f of files.sort()) {
  const rel = path.relative(process.cwd(), f);
  if (f.endsWith(".ts")) {
    const r = transformSync(f, fs.readFileSync(f, "utf8"), { lang: "ts" });
    if (r.errors && r.errors.length) {
      bad++;
      console.error(rel + " does not parse:\n" + r.errors.map((e) => e.message).join("\n"));
    }
    continue;
  }
  const dir = path.relative(ROOT, path.dirname(f)).split(path.sep)[0];
  if (!f.endsWith(".js") || !JS_LEFT.includes(dir)) {
    bad++;
    console.error(rel + ": the Worker's modules are TypeScript (.ts); no " + path.extname(f) + " here");
    continue;
  }
  if (fs.existsSync(f.replace(/\.js$/, ".ts"))) {
    bad++;
    console.error(rel + ": a stray .js next to its .ts (the bundler would take the .js)");
    continue;
  }
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    bad++;
    console.error(rel + " does not parse:\n" + e.stderr);
  }
}
if (bad) {
  console.error("check-worker: " + bad + " module(s) failed");
  process.exit(1);
}
console.log("check-worker: " + files.length + " module(s) parse");
