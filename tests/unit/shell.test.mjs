// The watcher script is shell that runs on agents' machines, and the values
// the site fills into it are other people's text (a member's name is chosen
// by whoever invited them). shellQuote must make any string one literal
// word, and the script's header must take its values that way.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../../worker/lib/text.ts";
import { agentOnboarding, registryLine } from "../../worker/agents/onboarding.ts";
import WATCHER from "../../worker/agents/agent-watch.sh";
import RECIPE from "../../worker/agents/agent-recipe.md";

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

// The registry line is text an agent is told to append "exactly" to
// rooms.txt, and many do it from a shell. Whatever the invite's name, the
// line must be inert however it is quoted there.
test("the watcher registry line is inert in a shell whatever the member is called", () => {
  const room = "lima-2", token = "AbC-dEf_0123456789abcdEF";
  for (const name of HOSTILE) {
    const block = agentOnboarding("https://example.test", room, name, token, { invitedBy: name });
    const lines = block.split("\n");
    const line = lines[lines.findIndex((l) => l.includes("Watcher registry line")) + 1].trim();
    assert.equal(line, registryLine(room, token));
    assert.equal(line, room + " " + token, "room and token only");
    for (const how of ["echo \"" + line + "\" >> rooms.txt", "cat >> rooms.txt <<EOF\n" + line + "\nEOF", "printf \"%s\\n\" \"" + line + "\" >> rooms.txt", "echo " + line + " >> rooms.txt"]) {
      const r = run(how + "\ncat rooms.txt");
      assert.equal(r.marked, false, "ran a command from the name " + JSON.stringify(name) + " with: " + how);
      assert.equal(r.out, line + "\n");
    }
  }
});

test("the recipe's registry line carries no member name", () => {
  const start = RECIPE.indexOf("Your first line is this room:");
  const line = RECIPE.slice(start).split("\n").find((l) => l.includes("__ROOM__"));
  assert.ok(start > 0 && line, "the recipe shows the line");
  assert.ok(!line.includes("__NAME__") && !line.includes("__SELF__"), line);
});

// The watcher's cursor is a delivery number. A draft published late keeps
// its low id but arrives under a higher "id:" line; a watcher that kept the
// id saw the message again on its next read and woke with it twice.
test("the watcher follows the stream's id: line, so a late-published message wakes it once", async () => {
  const LATE = { id: 3, ts: 1, from: "Ada", text: "published late" };
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const after = parseInt(u.searchParams.get("after") || "0", 10);
    if (u.pathname.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("retry: 2000\n\n");
      if (after < 12) res.write("id: 12\nevent: message\ndata: " + JSON.stringify(LATE) + "\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (u.pathname.endsWith("/me")) return res.end(JSON.stringify({ name: "Bob" }));
    res.end(JSON.stringify({ messages: after < 12 ? [LATE] : [], last_id: 12, has_more: false, room_state: {}, you: "Bob" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  try {
    const runtime = join(dir, "runtime.sh");
    writeFileSync(runtime, 'log() { :; }\nsilent() { printf "SILENT %s\\n" "$1"; }\nwake() { printf "WAKE %s\\n%s\\n" "$1" "$2"; }\n');
    const state = join(dir, "state");
    execFileSync("mkdir", ["-p", state]);
    writeFileSync(join(state, "lima.cursor"), "10");
    writeFileSync(join(state, "lima.self"), "Bob");
    const env = { PATH: process.env.PATH, HOME: dir, HATCH_HOOK_RUNTIME: runtime, AGENTCHAT_ROOM: "lima", AGENTCHAT_SELF: "Bob", AGENTCHAT_STATE_DIR: state, AGENTCHAT_ORIGIN: "http://127.0.0.1:" + server.address().port };
    const watch = () => new Promise((resolve, reject) => execFile("bash", ["-c", WATCHER], { env, encoding: "utf8", timeout: 30000 }, (e, out) => (e ? reject(e) : resolve(out))));
    const first = await watch();
    assert.ok(first.startsWith("WAKE new messages in lima"), first);
    const payload = JSON.parse(first.split("\n").slice(1).join("\n"));
    assert.deepEqual(payload.messages.map((m) => m.id), [3], "the message wakes the agent once");
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "12", "the cursor is the frame's id: line");
    const second = await watch();
    assert.ok(second.startsWith("SILENT no new messages"), "the next run has nothing new: " + second);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A room deleted and made again starts its numbers over. The watcher's
// cursor used to move only forward, so with a cursor of 500 kept from the
// old room it asked for "after 500" and heard nothing until the new room
// had handed out 500 numbers.
test("the watcher takes a lower last_id, so a room made again is heard", async () => {
  const NEW = { id: 4, ts: 1, from: "Ada", text: "in the new room" };
  let posted = false;
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const after = parseInt(u.searchParams.get("after") || "0", 10);
    const news = posted && after < 4;
    if (u.pathname.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("retry: 2000\n\n");
      if (news) res.write("id: 4\nevent: message\ndata: " + JSON.stringify(NEW) + "\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (u.pathname.endsWith("/me")) return res.end(JSON.stringify({ name: "Bob" }));
    res.end(JSON.stringify({ messages: news ? [NEW] : [], last_id: posted ? 4 : 3, has_more: false, room_state: {}, you: "Bob" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  try {
    const runtime = join(dir, "runtime.sh");
    writeFileSync(runtime, 'log() { :; }\nsilent() { printf "SILENT %s\\n" "$1"; }\nwake() { printf "WAKE %s\\n%s\\n" "$1" "$2"; }\n');
    const state = join(dir, "state");
    execFileSync("mkdir", ["-p", state]);
    writeFileSync(join(state, "lima.cursor"), "500");
    writeFileSync(join(state, "lima.self"), "Bob");
    const env = { PATH: process.env.PATH, HOME: dir, HATCH_HOOK_RUNTIME: runtime, AGENTCHAT_ROOM: "lima", AGENTCHAT_SELF: "Bob", AGENTCHAT_STATE_DIR: state, AGENTCHAT_ORIGIN: "http://127.0.0.1:" + server.address().port };
    const watch = () => new Promise((resolve, reject) => execFile("bash", ["-c", WATCHER], { env, encoding: "utf8", timeout: 30000 }, (e, out) => (e ? reject(e) : resolve(out))));
    const first = await watch();
    assert.ok(first.startsWith("SILENT no new messages"), first);
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "3", "the cursor follows the room's last_id down");
    posted = true;
    const second = await watch();
    assert.ok(second.startsWith("WAKE new messages in lima"), "the new room's next message wakes the agent: " + second);
    assert.deepEqual(JSON.parse(second.split("\n").slice(1).join("\n")).messages.map((m) => m.id), [4]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the watcher against a stand-in server: handler(req, url, res, token) answers every call. */
async function withWatcher(handler, setup, body) {
  const server = createServer((req, res) => handler(req, new URL(req.url, "http://x"), res, req.headers["x-invite-token"] || ""));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  try {
    const runtime = join(dir, "runtime.sh");
    writeFileSync(runtime, 'log() { printf "LOG %s\\n" "$1" >&2; }\nsilent() { printf "SILENT %s\\n" "$1"; }\nwake() { printf "WAKE %s\\n%s\\n" "$1" "$2"; }\n');
    const state = join(dir, "state");
    execFileSync("mkdir", ["-p", state]);
    setup(state);
    const env = { PATH: process.env.PATH, HOME: dir, HATCH_HOOK_RUNTIME: runtime, AGENTCHAT_ROOM: "lima", AGENTCHAT_SELF: "Bob", AGENTCHAT_STATE_DIR: state, AGENTCHAT_ORIGIN: "http://127.0.0.1:" + server.address().port };
    const watch = () => new Promise((resolve, reject) => execFile("bash", ["-c", WATCHER], { env, encoding: "utf8", timeout: 30000 }, (e, out, err) => (e ? reject(e) : resolve({ out, err }))));
    await body(watch, state);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A revoked agent re-invited to a room appends the new line next to the
// old one. Both lines used to start a poll of the room in the same
// scratch directory: one died on mkfifo, and when the survivor held the
// revoked token the room was reported failed on every run.
test("two registry lines for one room poll it once, with the last line's token", async () => {
  const MSG = { id: 6, ts: 1, from: "Ada", text: "welcome back" };
  await withWatcher((req, u, res, token) => {
    if (token !== "live") { res.writeHead(403, { "Content-Type": "application/json" }); return res.end('{"error":"revoked"}'); }
    const after = parseInt(u.searchParams.get("after") || "0", 10);
    if (u.pathname.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("retry: 2000\n\n");
      if (after < 6) res.write("id: 6\nevent: message\ndata: " + JSON.stringify(MSG) + "\n\n");
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages: after < 6 ? [MSG] : [], last_id: 6, has_more: false, room_state: {}, you: "Bob" }));
  }, (state) => {
    writeFileSync(join(state, "rooms.txt"), "lima dead\nlima live\n");
    writeFileSync(join(state, "lima.cursor"), "5");
    writeFileSync(join(state, "lima.self"), "Bob");
  }, async (watch, state) => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(state, "lima.cursor"), "5");
      const { out, err } = await watch();
      assert.ok(out.startsWith("WAKE new messages in lima"), out + err);
      const payload = JSON.parse(out.split("\n").slice(1).join("\n"));
      assert.equal(payload.room, "lima", "one room keeps the one-room payload shape");
      assert.deepEqual(payload.messages.map((m) => m.id), [6], "the message comes once");
      assert.ok(!/mkfifo/.test(err), err);
      assert.ok(/lists lima more than once/.test(err), "the duplicate is logged: " + err);
    }
  });
});

// A run woken by a game frame skipped the awaiting_you read, so the saved
// signature stayed the one from before the frame. The next quiet poll,
// while the woken agent was still thinking, woke it again for the same turn.
test("a game frame's wake saves the awaiting signature, so the same turn does not wake twice", async () => {
  let frame = true;
  const AWAIT = { type: "game", id: 7, turn: 3, action: "move" };
  await withWatcher((req, u, res) => {
    if (u.pathname.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("retry: 2000\n\n");
      if (frame) res.write("event: game\ndata: " + JSON.stringify({ type: "game", room: "lima", from: "Ada", game: { id: 7, turn: 3 } }) + "\n\n");
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages: [], last_id: 5, has_more: false, room_state: { awaiting_you: [AWAIT] }, you: "Bob" }));
  }, (state) => {
    writeFileSync(join(state, "lima.cursor"), "5");
    writeFileSync(join(state, "lima.self"), "Bob");
  }, async (watch, state) => {
    const first = await watch();
    assert.ok(first.out.startsWith("WAKE game update in lima"), first.out + first.err);
    const games = JSON.parse(first.out.split("\n").slice(1).join("\n")).games;
    assert.equal(games.length, 1, "the frame alone: its game is not repeated as an awaiting item " + JSON.stringify(games));
    assert.equal(games[0].game.id, 7);
    assert.equal(readFileSync(join(state, "lima.awaiting"), "utf8"), '[{"id":7,"turn":3}]', "the signature is saved");
    frame = false;
    const second = await watch();
    assert.ok(second.out.startsWith("SILENT no new messages"), "the same turn does not wake again: " + second.out);
  });
});
