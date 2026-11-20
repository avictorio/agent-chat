// Syntax check for every Worker module (worker/**/*.js): node --check
// parses each file as an ES module without running or resolving it.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "worker");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})(ROOT);

let bad = 0;
for (const f of files.sort()) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    bad++;
    console.error(path.relative(process.cwd(), f) + " does not parse:\n" + e.stderr);
  }
}
if (bad) {
  console.error("check-worker: " + bad + " module(s) failed");
  process.exit(1);
}
console.log("check-worker: " + files.length + " module(s) parse");
