// scripts/move-files.js moves files with git mv and rewrites the imports
// that name them. The Worker's TypeScript imports "./x.js" for x.ts; the
// tool could not follow that spelling, so a Worker move rewrote no
// importer and still ran git mv, leaving every importer broken.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TOOL = resolve("scripts/move-files.js");

/** A throwaway git tree holding `files` ({path: text}) under worker/. */
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "move-files-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, "worker", p, ".."), { recursive: true });
    writeFileSync(join(dir, "worker", p), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  writeFileSync(join(dir, "map.txt"), "lib/log.ts -> core/logging.ts\n");
  return dir;
}
const move = (dir) => spawnSync(process.execPath, [TOOL, "worker", "map.txt"], { cwd: dir, encoding: "utf8" });

test("a Worker move rewrites the ./x.js imports of the moved .ts file, keeping the .js spelling", () => {
  const dir = tree({
    "index.ts": 'import { log } from "./lib/log.js";\nexport { log };\n',
    "lib/log.ts": 'import { now } from "./clock.js";\nexport const log = () => now();\n',
    "lib/clock.ts": "export const now = () => 1;\n",
  });
  try {
    const r = move(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, "worker/core/logging.ts")));
    assert.equal(readFileSync(join(dir, "worker/index.ts"), "utf8"), 'import { log } from "./core/logging.js";\nexport { log };\n');
    assert.equal(readFileSync(join(dir, "worker/core/logging.ts"), "utf8"), 'import { now } from "../lib/clock.js";\nexport const log = () => now();\n', "the moved file's own imports follow it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolved import stops the move before anything is written or moved", () => {
  const before = 'import { log } from "./lib/log.js";\nimport { gone } from "./gone.js";\n';
  const dir = tree({ "index.ts": before, "lib/log.ts": "export const log = 1;\n" });
  try {
    const r = move(dir);
    assert.notEqual(r.status, 0, "the tool reports failure");
    assert.match(r.stderr, /gone\.js/);
    assert.ok(existsSync(join(dir, "worker/lib/log.ts")) && !existsSync(join(dir, "worker/core/logging.ts")), "nothing moved");
    assert.equal(readFileSync(join(dir, "worker/index.ts"), "utf8"), before, "nothing rewritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
