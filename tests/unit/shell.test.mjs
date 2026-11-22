// The watcher script is shell that runs on agents' machines, and the values
// the site fills into it are other people's text (a member's name is chosen
// by whoever invited them). shellQuote must make any string one literal
// word, and the script's header must take its values that way.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../../worker/lib/text.ts";
import WATCHER from "../../worker/agents/agent-watch.sh";

const HOSTILE = [
  "$(touch MARK)",
  "`touch MARK`",
  "\"; touch MARK; \"",
  "'; touch MARK; '",
  "a'b$(touch MARK)'c",
  "${IFS}$(touch MARK)",
  "x\\$(touch MARK)",
  "x; touch MARK",
  "x | touch MARK",
  "x && touch MARK",
  "$((1+1)) {a,b} * ~ # !",
];
/** Runs a bash script in a fresh directory: its stdout, and whether it left a MARK file. */
function run(script, env) {
  const dir = mkdtempSync(join(tmpdir(), "shq-"));
  try {
    const out = execFileSync("bash", ["-euo", "pipefail", "-c", script], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    return { out, marked: existsSync(join(dir, "MARK")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("shellQuote makes any string one literal shell word", () => {
  for (const s of HOSTILE) {
    const r = run("X=" + shellQuote(s) + "; printf '%s' \"$X\"");
    assert.equal(r.out, s, "the value arrives as written: " + s);
    assert.equal(r.marked, false, "nothing ran: " + s);
  }
  // a newline cannot start a second command: control characters are dropped
  const r = run("X=" + shellQuote("x\ntouch MARK\n") + "; printf '%s' \"$X\"");
  assert.equal(r.out, "xtouch MARK");
  assert.equal(r.marked, false);
});

test("the watcher's header takes a hostile member name as text, and the environment still wins", () => {
  const header = WATCHER.split("\n").filter((l) => /^(ROOM|ORIGIN|SELF)=/.test(l));
  assert.equal(header.length, 3, "the three filled lines");
  for (const l of header) assert.ok(/\|\| (ROOM|ORIGIN|SELF)=__\w+__$/.test(l), "the placeholder is a bare word, outside any quotes: " + l);
  // no placeholder anywhere else in the script, and none inside quotes
  assert.equal((WATCHER.match(/__(ROOM|ORIGIN|SELF|NAME|SCRIPT_URL)__/g) || []).length, 3);
  for (const name of HOSTILE) {
    const filled = header.join("\n")
      .replace("__ROOM__", shellQuote("lima")).replace("__ORIGIN__", shellQuote("https://example.test")).replace("__SELF__", shellQuote(name));
    const r = run(filled + "\nprintf '%s|%s|%s' \"$ROOM\" \"$ORIGIN\" \"$SELF\"");
    assert.equal(r.out, "lima|https://example.test|" + name);
    assert.equal(r.marked, false, "the name did not run: " + name);
    const o = run(filled + "\nprintf '%s|%s' \"$ROOM\" \"$SELF\"", { AGENTCHAT_ROOM: "other", AGENTCHAT_SELF: "Zed" });
    assert.equal(o.out, "other|Zed", "AGENTCHAT_* overrides the filled value");
  }
});
