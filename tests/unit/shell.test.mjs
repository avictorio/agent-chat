// The watcher script (worker/agents/agent-watch.sh) is shell that runs on
// agents' machines. The site serves it as one file, the same bytes for
// every caller of an origin (docs.ts watcher: the origin is its only
// filled value, shell-quoted), with its version and SHA-256 in headers,
// and a pin here ties the version to those bytes. shellQuote must make any
// string one literal word. The rest runs the script as served with bash
// against stand-in servers: no request without a room to watch, no token
// on any command line or in any environment, no copy of the messages kept,
// private state files, and the stream, cursor, awaiting and duplicate-line
// rules it has always had.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneLine, shellQuote } from "../../worker/lib/text.ts";
import { ESCAPED_SET, HOSTILE_NAMES } from "./start-views.mjs";
import { agentOnboarding } from "../../worker/agents/onboarding.ts";
import WATCHER from "../../worker/agents/agent-watch.sh";
import RECIPE from "../../worker/agents/agent-recipe.md";
import { recipeRoute } from "../../worker/routes/agents.ts";
import { WATCHER_VERSION, recipe, watcher, watcherOrigin, watcherPin } from "../../worker/agents/docs.ts";

const BASH = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

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

// The origin is the one value the site fills in: a bare word outside any
// quotes in the script, filled as a single-quoted literal (so whatever it
// held could not run), and AGENTCHAT_ORIGIN still overrides it for tests.
test("the watcher's one filled value is its origin, taken as text, and the environment still wins", () => {
  assert.deepEqual(WATCHER.match(/__[A-Z_]+__/g), ["__ORIGIN__"], "the script's only placeholder");
  const header = WATCHER.split("\n").filter((l) => /^ORIGIN=/.test(l));
  assert.equal(header.length, 1, "the one filled line");
  assert.ok(/\|\| ORIGIN=__ORIGIN__$/.test(header[0]), "the placeholder is a bare word, outside any quotes: " + header[0]);
  for (const s of HOSTILE) {
    const filled = header[0].replace("__ORIGIN__", shellQuote(s));
    const r = run(filled + "\nprintf '%s' \"$ORIGIN\"");
    assert.equal(r.out, s);
    assert.equal(r.marked, false, "the value did not run: " + s);
    assert.equal(run(filled + "\nprintf '%s' \"$ORIGIN\"", { AGENTCHAT_ORIGIN: "http://other.test" }).out, "http://other.test", "AGENTCHAT_ORIGIN overrides the filled value");
  }
  assert.ok(watcher("https://example.test").includes("\nORIGIN=\"${AGENTCHAT_ORIGIN:-}\"; [ -n \"$ORIGIN\" ] || ORIGIN='https://example.test'\n"), "watcher() fills it shell-quoted");
});

// The recipe tells an agent to write its registry line itself: the room's
// name, one space, its token, and many do it from a shell. A room name and
// a token (charset [A-Za-z0-9_-]) hold nothing a shell acts on, so the line
// is inert however it is quoted there; the member's name is not in it (the
// watcher asks the API), and the invite's note prints no line at all.
test("the registry line the recipe describes is inert in a shell", () => {
  const room = "lima-2", token = "AbC-dEf_0123456789abcdEF";
  const line = room + " " + token;
  for (const how of ["echo \"" + line + "\" >> rooms.txt", "cat >> rooms.txt <<EOF\n" + line + "\nEOF", "printf \"%s\\n\" \"" + line + "\" >> rooms.txt", "echo " + line + " >> rooms.txt"]) {
    const r = run(how + "\ncat rooms.txt");
    assert.equal(r.marked, false, "ran a command with: " + how);
    assert.equal(r.out, line + "\n", how);
  }
  for (const name of HOSTILE) {
    const note = agentOnboarding("https://example.test", room, name, token, { invitedBy: name });
    assert.ok(!note.includes("rooms.txt") && !note.split("\n").some((l) => l.trim() === line), "the note prints no registry line: " + JSON.stringify(name));
  }
});

test("the recipe's registry line carries no member name, and no __SELF__ or __ROOM__ is left for the script", () => {
  const start = RECIPE.indexOf("Your first line is this room:");
  const line = RECIPE.slice(start).split("\n").find((l) => l.includes("__ROOM__"));
  assert.ok(start > 0 && line, "the recipe shows the line");
  assert.ok(!line.includes("__NAME__"), line);
  assert.ok(!RECIPE.includes("__SELF__") && !WATCHER.includes("__SELF__") && !WATCHER.includes("__ROOM__"), "no __SELF__ or __ROOM__ left for the script");
});

/** GET path through recipeRoute, from origin, as the member name of a
 *  stand-in room whose access() answers ok (or refuse, when given). */
async function serve(path, { name = "Scout", invite = "tok-x", refuse = null, origin = "http://localhost" } = {}) {
  const asked = [];
  const stub = { access: async (...a) => { asked.push(a); return refuse || { ok: true, name, kind: "agent" }; } };
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL(origin + path);
  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/agent-recipe(?:\/(script))?\/?$/);
  const res = await recipeRoute({ request: new Request(url), env, url, path: url.pathname, owner: false, invite }, m);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { res, bytes, text: bytes.toString("utf8"), asked };
}

// The recipe's text prints the caller's name inside its sentences: folded
// onto its line, as the note and the start page fold it (a name may hold a
// NEL, where some readers break a line). The script holds no name at all.
test("the recipe's text folds the caller's name onto its line; the script holds no name", async () => {
  const name = "Nel\u0085Line two";
  const r = await serve("/api/rooms/lima/agent-recipe", { name });
  assert.ok(!r.text.includes("\u0085"), "the recipe prints a NEL");
  assert.ok(r.text.includes('You are the agent "Nel Line two".'), "the name, folded");
  assert.ok(!r.text.includes("tok-x"), "the recipe never holds the token");
  const script = await serve("/api/rooms/lima/agent-recipe/script", { name });
  assert.ok(!script.text.includes("Nel") && !script.text.includes("Line two"), "the script names no member");
  assert.equal(script.text, watcher("http://localhost"), "the script is the origin's one file");
});

// Inside the recipe's own double quotes ("__NAME__", every use of the name
// in its text) the name is folded and escaped as the note and the start
// page print it (quotedBody, worker/lib/text.ts): each parses back to the
// folded name as a JSON string, and nothing in it can pass for the closing
// quote. Whatever the name, the script is the same file.
test("the recipe's quoted names are JSON string bodies that give back the folded name; the script is the same for every name", async () => {
  const Q = String.raw`"(?:[^"\\]|\\.)*"`;
  assert.equal(RECIPE.split("__NAME__").length, RECIPE.split("\"__NAME__\"").length, "every __NAME__ in the recipe sits in its double quotes");
  const origin = "http://localhost";
  const pin = await watcherPin(origin);
  const filled = (t) => t.replace(/__SCRIPT_URL__/g, origin + "/api/rooms/lima/agent-recipe/script").replace(/__ORIGIN__/g, origin).replace(/__ROOM__/g, "lima").replace(/__WATCHER_VERSION__/g, pin.version).replace(/__WATCHER_SHA256__/g, pin.sha256);
  // the recipe as served before the route's substitutions: its limits filled in (docs.ts recipe)
  const shape = new RegExp("^" + recipe().split("\"__NAME__\"").map((part) => filled(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(" + Q + ")") + "$");
  for (const name of [...HOSTILE_NAMES, "Scout"]) {
    const text = (await serve("/api/rooms/lima/agent-recipe", { name })).text;
    const got = text.match(shape);
    assert.ok(got, JSON.stringify(name) + ": the recipe's text is the template with the quoted names filled in");
    assert.equal(got.length - 1, 4, "four quoted names");
    for (const q of got.slice(1)) {
      assert.ok(!ESCAPED_SET.test(q), JSON.stringify(name) + ": a raw escapable character in " + q);
      // as served: UTF-8 has no lone surrogate, so the response carries U+FFFD in its place
      assert.equal(JSON.parse(q), new TextDecoder().decode(new TextEncoder().encode(oneLine(name))), JSON.stringify(name));
    }
    if (name === "Scout") assert.ok(text.includes("You are the agent \"Scout\"."), "an ordinary name prints as it is");
    assert.equal((await serve("/api/rooms/lima/agent-recipe/script", { name })).text, watcher(origin), JSON.stringify(name) + ": the same script");
  }
});

// One file for everyone on an origin: an agent and its person can say
// "this is the file I approved", and the bytes name no room, no member
// and no token. The gate is as before: a refused token gets the refusal.
test("the script served to two members of two rooms is byte-identical, with no placeholder, room, name or token", async () => {
  const a = await serve("/api/rooms/lima/agent-recipe/script", { name: "Scout", invite: "tok-aaa-111" });
  const b = await serve("/api/rooms/oslo-2/agent-recipe/script", { name: "$(touch MARK)", invite: "tok-bbb-222" });
  assert.equal(a.res.status, 200);
  assert.ok(a.bytes.equals(b.bytes), "the same bytes");
  assert.equal(a.text, watcher("http://localhost"));
  assert.ok(!/__[A-Z_]+__/.test(a.text), "no placeholder left");
  for (const s of ["lima", "oslo-2", "Scout", "touch MARK", "tok-aaa-111", "tok-bbb-222"]) assert.ok(!a.text.includes(s), "the script holds " + s);
  assert.deepEqual([a.asked, b.asked], [[["tok-aaa-111", false]], [["tok-bbb-222", false]]], "each through the room's gate");
  // another origin is another file: its origin is filled in
  assert.notEqual((await serve("/api/rooms/lima/agent-recipe/script", { origin: "https://example.test" })).text, a.text);
  const refused = await serve("/api/rooms/lima/agent-recipe/script", { refuse: { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." } });
  assert.equal(refused.res.status, 403);
  assert.equal(refused.res.headers.get("X-Watcher-SHA256"), null, "a refusal carries no script and no pin");
  assert.ok(!refused.text.includes("WATCHER_VERSION"));
});

test("the script's headers carry its version line and the SHA-256 of its body; the recipe shows the same two", async () => {
  const r = await serve("/api/rooms/lima/agent-recipe/script");
  const line = (r.text.match(/^WATCHER_VERSION="([^"\n]+)"$/m) || [])[1];
  assert.ok(line, "the script carries its version line");
  assert.ok(r.text.split("\n").findIndex((l) => l.startsWith("WATCHER_VERSION=")) < 20, "near its top");
  assert.match(line, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/, "a date, with .2, .3 for a later change the same day");
  assert.equal(WATCHER_VERSION, line, "the Worker reads it from the script");
  assert.equal(r.res.headers.get("X-Watcher-Version"), line);
  assert.equal(r.res.headers.get("X-Watcher-SHA256"), createHash("sha256").update(r.bytes).digest("hex"), "the SHA-256 of the body as sent");
  assert.equal(r.res.headers.get("Cache-Control"), "no-store");
  assert.equal(r.res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  const text = (await serve("/api/rooms/lima/agent-recipe")).text;
  assert.ok(text.includes("This site serves version " + line + ", SHA-256\n  " + r.res.headers.get("X-Watcher-SHA256") + " (step 2"), "the recipe names the pair");
  assert.ok(text.includes("   must show " + r.res.headers.get("X-Watcher-SHA256") + " (before the file's name), and then\n") && text.includes("   must print " + line + ". Anything else"), "step 2's checks name it");
  assert.ok(!/__WATCHER_/.test(text), "no pin placeholder left");
});

// The ORIGIN a copy carries is where it sends tokens from then on: a
// request over http, or through another port, still gets https on the
// default port for any host but loopback (docs.ts watcherOrigin), and the
// pin is the pin of those bytes, so the start page's hash matches what
// the route serves. A local test server keeps its own origin.
test("the script's ORIGIN is https for every host but loopback, and the pin is of what is served", async () => {
  const line = (t) => t.split("\n").find((l) => l.startsWith("ORIGIN="));
  const https = await serve("/api/rooms/lima/agent-recipe/script", { origin: "https://example.test" });
  for (const o of ["http://example.test", "http://example.test:8080", "https://example.test:8443"]) {
    const r = await serve("/api/rooms/lima/agent-recipe/script", { origin: o });
    assert.equal(line(r.text), "ORIGIN=\"${AGENTCHAT_ORIGIN:-}\"; [ -n \"$ORIGIN\" ] || ORIGIN='https://example.test'", o);
    assert.ok(r.bytes.equals(https.bytes), o + ": the https request's bytes");
    assert.equal(r.res.headers.get("X-Watcher-SHA256"), https.res.headers.get("X-Watcher-SHA256"), o);
    assert.deepEqual(await watcherPin(o), await watcherPin("https://example.test"), o + ": the pin the start page prints");
    assert.equal((await watcherPin(o)).sha256, createHash("sha256").update(r.bytes).digest("hex"), o + ": the pin is the hash of the bytes served");
  }
  for (const o of ["http://127.0.0.1:8787", "http://localhost:1234", "http://[::1]:9000", "http://localhost"]) {
    const r = await serve("/api/rooms/lima/agent-recipe/script", { origin: o });
    assert.equal(line(r.text), "ORIGIN=\"${AGENTCHAT_ORIGIN:-}\"; [ -n \"$ORIGIN\" ] || ORIGIN='" + o + "'", o + " stays as it is");
  }
  assert.equal(watcherOrigin("http://chat.victorio.cloud"), "https://chat.victorio.cloud");
});

// Every pair the watcher has been served as for the live origin, oldest
// first. A change to the script's bytes fails this test until
// WATCHER_VERSION moves (the date it last changed, .2, .3 for a later
// change the same day) and the new pair is added at the end: a version is
// never pinned to new bytes. The start page prints the pair, so its
// fixtures (tests/fixtures/start-page/) are made again from startPage too.
const PINNED = [
  ["2026-11-26", "723b6a628e12d51fad2c4f9ed55174c622189495c316061b77c229a4a586815d"],
];
/** a version's parts, to compare: the date, then the same day's number (1 for none) */
const versionKey = (v) => { const [d, n] = v.split("."); return [d, n === undefined ? 1 : Number(n)]; };
test("the watcher's version and SHA-256 are pinned: new bytes need a new version", async () => {
  const pin = await watcherPin("https://chat.victorio.cloud");
  for (let i = 1; i < PINNED.length; i++) {
    const [a, b] = [versionKey(PINNED[i - 1][0]), versionKey(PINNED[i][0])];
    assert.ok(b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]), PINNED[i][0] + " is not later than " + PINNED[i - 1][0]);
  }
  assert.equal(new Set(PINNED.map((p) => p[1])).size, PINNED.length, "two versions pinned to the same bytes");
  assert.deepEqual([pin.version, pin.sha256], PINNED[PINNED.length - 1], "the watcher's bytes changed: move WATCHER_VERSION in worker/agents/agent-watch.sh, add its pair at the end of PINNED, and make the start page's fixtures again");
});

test("--version prints the version and exits, with no hook runtime and nothing written", () => {
  const dir = mkdtempSync(join(tmpdir(), "watchv-"));
  try {
    const file = join(dir, "agent-chat-watch.sh");
    writeFileSync(file, watcher("https://chat.victorio.cloud"));
    assert.equal(execFileSync(BASH, [file, "--version"], { env: { PATH: process.env.PATH, HOME: dir }, encoding: "utf8" }), WATCHER_VERSION + "\n");
    assert.deepEqual(readdirSync(dir), ["agent-chat-watch.sh"], "no state dir made");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The hook runtime's three calls, as a stand-in: the result to stdout,
 *  log lines to stderr, the script's own stderr (a runtime may log either
 *  way, so every log line must reach it). */
const RUNTIME = 'log() { printf "LOG %s\\n" "$1" >&2; }\nsilent() { printf "SILENT %s\\n" "$1"; }\nwake() { printf "WAKE %s\\n%s\\n" "$1" "$2"; }\n';

/** Runs the watcher as served for a stand-in server's origin. handler(req,
 *  url, res, token) answers every call; setup(state, dir) prepares the
 *  state dir; body(watch, state, ctx) runs it: watch(env) resolves {out,
 *  err}, ctx holds the requests the server got ({path, token}), the
 *  scratch dir and the server's origin. opts: runtime (more of the
 *  stand-in runtime), env (more of the run's environment), path (its PATH). */
async function withWatcher(handler, setup, body, opts = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const token = req.headers["x-invite-token"] || "";
    requests.push({ path: u.pathname, token });
    handler(req, u, res, token);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  try {
    const runtime = join(dir, "runtime.sh");
    writeFileSync(runtime, RUNTIME + (opts.runtime || ""));
    const origin = "http://127.0.0.1:" + server.address().port;
    const script = join(dir, "agent-chat-watch.sh");
    writeFileSync(script, watcher(origin));
    const state = join(dir, "state");
    mkdirSync(state);
    setup(state, dir);
    const env = { PATH: opts.path || process.env.PATH, HOME: dir, HATCH_HOOK_RUNTIME: runtime, AGENTCHAT_STATE_DIR: state, ...opts.env };
    const watch = (more) => new Promise((resolve, reject) => execFile(BASH, [script], { env: { ...env, ...more }, encoding: "utf8", timeout: 30000 }, (e, out, err) => (e ? reject(Object.assign(e, { out, err })) : resolve({ out, err }))));
    await body(watch, state, { requests, dir, origin });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stand-in room: its stream replays msgs past the cursor (each under its
 *  id: line), its reads answer them with last_id and room_state. */
function roomAnswers(msgs, { lastId, roomState = {}, you = "Bob" } = {}) {
  const last = lastId === undefined ? Math.max(0, ...msgs.map((m) => m.seq)) : lastId;
  return (req, u, res) => {
    const after = parseInt(u.searchParams.get("after") || "0", 10);
    const news = msgs.filter((m) => m.seq > after);
    if (u.pathname.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("retry: 2000\n\n");
      for (const m of news) res.write("id: " + m.seq + "\nevent: message\ndata: " + JSON.stringify(m.data) + "\n\n");
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (u.pathname.endsWith("/me")) return res.end(JSON.stringify({ name: you }));
    res.end(JSON.stringify({ messages: u.searchParams.has("after") ? news.map((m) => m.data) : [], last_id: last, has_more: false, room_state: roomState, you }));
  };
}

// The watcher's cursor is a delivery number. A draft published late keeps
// its low id but arrives under a higher "id:" line; a watcher that kept the
// id saw the message again on its next read and woke with it twice.
test("the watcher follows the stream's id: line, so a late-published message wakes it once", async () => {
  const LATE = { id: 3, ts: 1, from: "Ada", text: "published late" };
  await withWatcher(roomAnswers([{ seq: 12, data: LATE }]), (state) => {
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
    writeFileSync(join(state, "lima.cursor"), "10");
    writeFileSync(join(state, "lima.self"), "Bob");
  }, async (watch, state) => {
    const first = (await watch()).out;
    assert.ok(first.startsWith("WAKE new messages in lima"), first);
    const payload = JSON.parse(first.split("\n").slice(1).join("\n"));
    assert.deepEqual(payload.messages.map((m) => m.id), [3], "the message wakes the agent once");
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "12", "the cursor is the frame's id: line");
    const second = (await watch()).out;
    assert.ok(second.startsWith("SILENT no new messages"), "the next run has nothing new: " + second);
  });
});

// A room deleted and made again starts its numbers over. The watcher's
// cursor used to move only forward, so with a cursor of 500 kept from the
// old room it asked for "after 500" and heard nothing until the new room
// had handed out 500 numbers.
test("the watcher takes a lower last_id, so a room made again is heard", async () => {
  const NEW = { id: 4, ts: 1, from: "Ada", text: "in the new room" };
  let posted = false;
  const before = roomAnswers([], { lastId: 3 }), after = roomAnswers([{ seq: 4, data: NEW }]);
  await withWatcher((req, u, res) => (posted ? after : before)(req, u, res), (state) => {
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
    writeFileSync(join(state, "lima.cursor"), "500");
    writeFileSync(join(state, "lima.self"), "Bob");
  }, async (watch, state) => {
    const first = (await watch()).out;
    assert.ok(first.startsWith("SILENT no new messages"), first);
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "3", "the cursor follows the room's last_id down");
    posted = true;
    const second = (await watch()).out;
    assert.ok(second.startsWith("WAKE new messages in lima"), "the new room's next message wakes the agent: " + second);
    assert.deepEqual(JSON.parse(second.split("\n").slice(1).join("\n")).messages.map((m) => m.id), [4]);
  });
});

// A revoked agent re-invited to a room appends the new line next to the
// old one. Both lines used to start a poll of the room in the same
// scratch directory: one died on mkfifo, and when the survivor held the
// revoked token the room was reported failed on every run.
test("two registry lines for one room poll it once, with the last line's token", async () => {
  const MSG = { id: 6, ts: 1, from: "Ada", text: "welcome back" };
  const room = roomAnswers([{ seq: 6, data: MSG }]);
  await withWatcher((req, u, res, token) => {
    if (token !== "live") { res.writeHead(403, { "Content-Type": "application/json" }); return res.end('{"error":"revoked"}'); }
    room(req, u, res);
  }, (state) => {
    writeFileSync(join(state, "rooms.txt"), "lima dead\nlima live\n");
    writeFileSync(join(state, "lima.self"), "Bob");
  }, async (watch, state, { requests }) => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(state, "lima.cursor"), "5");
      const { out, err } = await watch();
      assert.ok(out.startsWith("WAKE new messages in lima"), out + err);
      const payload = JSON.parse(out.split("\n").slice(1).join("\n"));
      assert.equal(payload.room, "lima", "a registry of one room keeps that room's own payload shape");
      assert.deepEqual(payload.messages.map((m) => m.id), [6], "the message comes once");
      assert.ok(!/mkfifo/.test(err), err);
      assert.ok(/lists lima more than once/.test(err), "the duplicate is logged: " + err);
    }
    assert.ok(requests.length > 0 && requests.every((q) => q.token === "live"), "only the last line's token is sent");
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
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
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

// A stream that cannot open degrades to one REST long-poll; a dry run
// primes in memory and writes nothing to the state dir.
test("a dry run with the stream down uses the REST fallback and writes nothing to the state dir", async () => {
  const MSG = { id: 9, ts: 1, from: "Ada", text: "over REST" };
  const room = roomAnswers([{ seq: 9, data: MSG }]);
  await withWatcher((req, u, res) => {
    // the stream's stand-in address: refused, so the stream yields nothing
    if (u.pathname === "/broken") { res.writeHead(404); return res.end(); }
    room(req, u, res);
  }, (state) => {
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
  }, async (watch, state, { requests, origin }) => {
    const dry = { HATCH_HOOK_DRY_RUN: "1", AGENTCHAT_STREAM_BASE: origin + "/broken" };
    // no cursor: the run primes at last_id 9 in memory, and the fallback finds nothing after it
    const { out, err } = await watch(dry);
    assert.match(err, /LOG initialized cursor for lima at 9/);
    assert.match(err, /stream unavailable in lima; used REST fallback/);
    assert.ok(out.startsWith("SILENT dry-run: no new messages"), out + err);
    assert.ok(requests.some((q) => q.path === "/broken") && requests.some((q) => q.path === "/api/rooms/lima/messages"), "the stream was tried, then the room read");
    assert.deepEqual(readdirSync(state), ["rooms.txt"], "the dry run wrote nothing to the state dir");
    // with a cursor behind the message, the dry run would wake
    writeFileSync(join(state, "lima.cursor"), "8");
    const woke = await watch(dry);
    assert.ok(woke.out.startsWith("WAKE dry-run: would wake on room activity\n{\"count\":1}"), woke.out + woke.err);
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "8", "a dry run moves no cursor");
  });
});

// Each room's poll closes the stream's descriptor with stderr silenced for
// that step alone ({ exec 3<&-; } 2>/dev/null): a redirect on exec itself
// lasts, and sent the rest of the poll's stderr to /dev/null, so a runtime
// whose log writes to stderr never saw the REST fallback's note or a room
// that failed. Its stderr holds those log lines and nothing else: no
// report of the stream curl killed at the end of its slice, no curl or jq
// error, no token.
test("a runtime that logs to stderr sees every log line of a poll, and nothing else", async () => {
  const TOK = { lima: "tok-lima-0123456789", oslo: "tok-oslo-revoked-987", rome: "tok-rome-5555555555" };
  const MSG = { id: 6, ts: 1, from: "Ada", text: "on a held stream" };
  await withWatcher((req, u, res) => {
    const room = u.pathname.split("/")[3];
    const after = parseInt(u.searchParams.get("after") || "0", 10);
    if (room === "oslo") { res.writeHead(403, { "Content-Type": "application/json" }); return res.end('{"error":"revoked","code":"invite_revoked"}'); }
    if (room === "rome" && u.pathname.endsWith("/stream")) { res.writeHead(404); return res.end(); }
    if (room === "lima" && u.pathname.endsWith("/stream")) {
      // held open: the end of the slice cuts it, and the poll kills its curl
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("retry: 2000\n\n");
      if (after < 6) res.write("id: 6\nevent: message\ndata: " + JSON.stringify(MSG) + "\n\n");
      return;
    }
    roomAnswers(room === "lima" ? [{ seq: 6, data: MSG }] : [], { lastId: room === "lima" ? 6 : 3 })(req, u, res);
  }, (state) => {
    writeFileSync(join(state, "rooms.txt"), Object.entries(TOK).map(([r, t]) => r + " " + t).join("\n") + "\n");
    for (const [r, c] of [["lima", "5"], ["oslo", "1"], ["rome", "3"]]) {
      writeFileSync(join(state, r + ".cursor"), c);
      writeFileSync(join(state, r + ".self"), "Bob");
    }
  }, async (watch) => {
    const { out, err } = await watch();
    assert.ok(out.startsWith("WAKE new messages in lima"), out + err);
    assert.deepEqual(err.split("\n").filter(Boolean).sort(), ["LOG polled 3 room(s)", "LOG room fetch failed for oslo", "LOG stream unavailable in rome; used REST fallback"], "stderr: " + err);
    for (const t of Object.values(TOK)) assert.ok(!err.includes(t) && !out.includes(t), "a token was printed");
  });
});

// With no registry, or none of its lines naming a room, there is nothing
// to watch: the run makes no call at all (removing the last line stops the
// watcher), logs one line and ends successfully. Beside an invite.token
// (a one-room setup) the line says how to carry it over, never the token.
test("with no registry, an empty one or a comments-only one, a run makes no request and exits 0", async () => {
  const curlLog = (dir) => join(dir, "curl.log");
  let curlShim = "";
  await withWatcher((req, u, res) => roomAnswers([])(req, u, res), (state, dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const real = execFileSync(BASH, ["-c", "command -v curl"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "curl"), "#!" + BASH + "\nprintf 'curl\\n' >> " + shellQuote(curlLog(dir)) + "\nexec " + shellQuote(real) + " \"$@\"\n", { mode: 0o755 });
    curlShim = bin;
  }, async (watch, state, { requests, dir }) => {
    const path = curlShim + ":" + process.env.PATH;
    const cases = [
      ["no registry", null, /^LOG nothing to watch: there is no \S+\/rooms\.txt \(one line per room: its name, a space, your token for it\)$/],
      ["an empty registry", "", /^LOG nothing to watch: \S+\/rooms\.txt names no room$/],
      ["a registry of comments and blank lines", "# lima tok-lima\n\n   # oslo tok-oslo\n\t\n", /^LOG nothing to watch: \S+\/rooms\.txt names no room$/],
    ];
    for (const [label, registry, line] of cases) {
      rmSync(join(state, "rooms.txt"), { force: true });
      if (registry !== null) { writeFileSync(join(state, "rooms.txt"), registry); chmodSync(join(state, "rooms.txt"), 0o644); }
      for (const dry of ["1", "0"]) {
        const { out, err } = await watch({ PATH: path, HATCH_HOOK_DRY_RUN: dry });
        assert.equal(out, dry === "1" ? "SILENT dry-run: nothing to watch\n" : "SILENT nothing to watch\n", label);
        assert.deepEqual(err.split("\n").filter(Boolean).length, 1, label + ": one log line: " + err);
        assert.match(err.trim(), line, label);
        // the registry it read is made private by a live run, even one with nothing to watch
        if (registry !== null) assert.equal(statSync(join(state, "rooms.txt")).mode & 0o777, dry === "1" ? 0o644 : 0o600, label + ", dry " + dry);
      }
    }
    // an older one-room setup: invite.token beside no registry
    rmSync(join(state, "rooms.txt"), { force: true });
    writeFileSync(join(state, "invite.token"), "tok-legacy-0123456789");
    const { out, err } = await watch({ PATH: path });
    assert.equal(out, "SILENT nothing to watch\n");
    assert.equal(err.split("\n").filter(Boolean).length, 1, err);
    assert.match(err.trim(), /^LOG nothing to watch: there is no (\S+)\/rooms\.txt\. \1\/invite\.token holds the token of a one-room setup: to keep watching that room, write its name, a space and that token as a line of \1\/rooms\.txt$/);
    assert.ok(!err.includes("tok-legacy") && !out.includes("tok-legacy"), "the token is never printed");
    assert.equal(requests.length, 0, "the stand-in server got no request");
    assert.ok(!existsSync(curlLog(dir)), "curl never ran");
    assert.deepEqual(readdirSync(state).sort(), ["invite.token"], "nothing written, nothing deleted");
  });
});

// The commands the script runs, every one: with PATH holding only these
// shims, a command not among them is caught by the stand-in runtime's
// command_not_found_handle.
const COMMANDS = ["awk", "cat", "chmod", "curl", "cut", "jq", "mkdir", "mkfifo", "mktemp", "mv", "rm", "tr", "wc"];
/** A directory of shims, one per command: each appends its name, its
 *  arguments and its environment (export -p, a builtin) to log in one
 *  write, then runs the command PATH finds in its place, with the test's
 *  own PATH back (a wrapper found there may look the command up again). */
function shimDir(dir, log) {
  const bin = join(dir, "shims");
  mkdirSync(bin);
  for (const name of COMMANDS) {
    const real = execFileSync(BASH, ["-c", "command -v " + name], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, name), [
      "#!" + BASH,
      "r=\"EXEC ${0##*/}\"",
      "for a in \"$@\"; do printf -v q '%q' \"$a\"; r+=\" $q\"; done",
      "while IFS= read -r l; do r+=$'\\n'\"ENV $l\"; done < <(export -p)",
      "printf '%s\\n' \"$r\" >> " + shellQuote(log),
      "export PATH=" + shellQuote(process.env.PATH),
      "exec " + shellQuote(real) + " \"$@\"",
      "",
    ].join("\n"), { mode: 0o755 });
  }
  return bin;
}

// A command line is readable by any local user (ps), so a token must never
// be on one. Every command the script runs is shimmed here, curl first:
// none gets either room's token as an argument or in its environment,
// every request still carries the right one in its header, and the header
// file goes with the run's temporary directory.
test("a run with a registry keeps the token off every command line and out of every environment, while the server gets it", async () => {
  const TOK = { lima: "tok-LIMA-secret-0123456789", oslo: "tok-OSLO-secret-9876543210" };
  const MSG = { lima: { id: 6, ts: 1, from: "Ada", text: "hello lima" }, oslo: { id: 2, ts: 1, from: "Cy", text: "hello oslo" } };
  let log = "", bin = "";
  await withWatcher((req, u, res) => {
    const room = u.pathname.split("/")[3];
    return roomAnswers([{ seq: MSG[room].id, data: MSG[room] }])(req, u, res);
  }, (state, dir) => {
    log = join(dir, "exec.log");
    bin = shimDir(dir, log);
    writeFileSync(join(state, "rooms.txt"), "lima " + TOK.lima + "\noslo\t" + TOK.oslo + "\n");
  }, async (watch, state, { requests, dir }) => {
    const missing = join(dir, "missing.log");
    const first = await watch({ PATH: bin, MISSING_LOG: missing });
    assert.ok(first.out.startsWith("SILENT no new messages"), "the first run primes both rooms: " + first.out + first.err);
    // behind each room's message now: the second run wakes with both
    writeFileSync(join(state, "lima.cursor"), "5");
    writeFileSync(join(state, "oslo.cursor"), "1");
    const second = await watch({ PATH: bin, MISSING_LOG: missing });
    assert.ok(second.out.startsWith("WAKE activity in 2 watched rooms"), second.out + second.err);
    assert.deepEqual(JSON.parse(second.out.split("\n").slice(1).join("\n")).rooms.map((r) => [r.room, r.messages.map((m) => m.text)]), [["lima", ["hello lima"]], ["oslo", ["hello oslo"]]]);
    const ran = readFileSync(log, "utf8");
    assert.ok(!existsSync(missing), "a command ran that no shim records: " + (existsSync(missing) ? readFileSync(missing, "utf8") : ""));
    // the calls to the site (each run also asks curl its version once)
    const curls = ran.split("\n").filter((l) => l.startsWith("EXEC curl ") && l !== "EXEC curl --version");
    assert.equal(ran.split("\n").filter((l) => l === "EXEC curl --version").length, 2, "curl is asked its version once a run");
    assert.ok(curls.length >= 8, "curl ran for both rooms on both runs: " + curls.length);
    for (const tok of Object.values(TOK)) {
      assert.ok(!ran.includes(tok) && !ran.includes(tok.slice(4, 16)), "a command got the token as an argument or in its environment");
    }
    for (const l of curls) assert.match(l, / -H @\S+\/line\.[01]\/token\.header /, "each curl reads the header from the run's file: " + l);
    // every request the stand-in got carried its room's token in the header
    assert.ok(requests.length >= 8);
    for (const q of requests) assert.equal(q.token, TOK[q.path.split("/")[3]], q.path);
    // the header files went with the run's temporary directory
    for (const l of curls) assert.ok(!existsSync(l.match(/ -H @(\S+)/)[1]), "the header file is left behind");
  }, { runtime: "command_not_found_handle() { printf '%s\\n' \"$1\" >> \"$MISSING_LOG\"; return 127; }\n" });
});

const MISSING = "command_not_found_handle() { printf '%s\\n' \"$1\" >> \"$MISSING_LOG\"; return 127; }\n";

// A registry line is taken only as "room token": a room name as the site
// writes one (lower case: a minted token is 24 characters of the token
// alphabet, so a swapped line would pass an either-case pattern) and a
// token. Each malformed line below put a token into a URL, a log line, a
// file name or jq's arguments, wrote outside the state dir, called the
// site without a token, or had curl glob one line into several requests:
// each is skipped and logged by its number alone, the good line beside
// them still works, and a registry of bad lines alone names no room.
test("malformed registry lines are skipped by number: no request carries or names their tokens, nothing is written outside the state dir", async () => {
  const T = { comment: "TokCommentSecret0000001", swapped: "TokSwappedSecret0000002", alone: "TokAloneSecret000000003", escape: "TokEscapeSecret00000004", glob: "TokGlobSecret0000000005", brace: "TokBraceSecret000000006", good: "TokGoodSecret0000000007" };
  const BAD = [
    "﻿# lima " + T.comment, // 1: a byte order mark before a comment: still a comment
    T.swapped + " lima", // 2: the fields swapped
    T.alone, // 3: a token alone
    "../../escape " + T.escape, // 4: a path out of the state dir
    "x[1-3] " + T.glob, // 5: a curl glob
    "{a,b} " + T.brace, // 6: a brace list
    "lima", // 7: a room and no token
  ];
  let log = "", bin = "", state = "";
  await withWatcher((req, u, res) => roomAnswers([], { lastId: 3 })(req, u, res), (unused, dir) => {
    log = join(dir, "exec.log");
    bin = shimDir(dir, log);
    // two levels below a folder of the test's own, so ../../escape stays in it
    state = join(dir, "up", "one", "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "oslo.cursor"), "3");
    writeFileSync(join(state, "oslo.self"), "Bob");
  }, async (watch, unused, { requests, dir }) => {
    const up = join(dir, "up");
    writeFileSync(join(state, "rooms.txt"), [...BAD, "oslo " + T.good].join("\n") + "\n");
    const env = { PATH: bin, MISSING_LOG: join(dir, "missing.log"), AGENTCHAT_STATE_DIR: state };
    const { out, err } = await watch(env);
    assert.ok(out.startsWith("SILENT no new messages"), out + err);
    assert.deepEqual(err.split("\n").filter(Boolean), [2, 3, 4, 5, 6, 7].map((n) => "LOG rooms.txt line " + n + " is not \"room token\"; skipped").concat(["LOG polled 1 room(s)"]), err);
    assert.ok(requests.length > 0 && requests.every((q) => q.path.startsWith("/api/rooms/oslo/") && q.token === T.good), JSON.stringify(requests));
    const ran = readFileSync(log, "utf8");
    for (const [k, t] of Object.entries(T)) {
      assert.ok(!ran.includes(t), k + ": the token is in a command's arguments or environment");
      assert.ok(!out.includes(t) && !err.includes(t), k + ": the token is in the output or the log");
      assert.ok(!requests.some((q) => q.path.includes(t)), k + ": the token is in a URL");
    }
    const siteCalls = ran.split("\n").filter((l) => l.startsWith("EXEC curl ") && l !== "EXEC curl --version");
    assert.ok(siteCalls.length >= 2 && siteCalls.every((l) => l.startsWith("EXEC curl -g ")), "every call to the site carries -g: " + siteCalls.join("\n"));
    assert.deepEqual(readdirSync(state).sort(), ["oslo.cursor", "oslo.self", "rooms.txt"], "no state file for a skipped line");
    assert.deepEqual([readdirSync(up), readdirSync(join(up, "one"))], [["one"], ["state"]], "nothing written outside the state dir");
    assert.ok(!existsSync(join(dir, "missing.log")), "an unshimmed command ran");
    // the bad lines alone name no room: no call
    const before = requests.length;
    writeFileSync(join(state, "rooms.txt"), BAD.join("\n") + "\n");
    const none = await watch(env);
    assert.equal(none.out, "SILENT nothing to watch\n");
    assert.match(none.err, /LOG nothing to watch: \S+\/rooms\.txt names no room\n$/);
    assert.equal(requests.length, before, "no request");
  }, { runtime: MISSING });
});

// A registry saved with CRLF line ends reads as its LF twin: the CR is a
// separator, so no CRLF blank line becomes a room "\r" (a call on every
// run) and no third-field name ends in one (a name "Carol\r" is not
// Carol, so her own posts woke her).
test("a CRLF registry behaves as its LF twin, and CRLF blank lines make no call", async () => {
  const OWN = { id: 7, ts: 1, from: "Carol", text: "my own post" };
  const OTHER = { id: 8, ts: 2, from: "Bob", text: "someone else" };
  let msgs = [];
  await withWatcher((req, u, res) => roomAnswers(msgs)(req, u, res), () => {}, async (watch, state, { requests }) => {
    const runs = {};
    for (const [eol, label] of [["\n", "LF"], ["\r\n", "CRLF"]]) {
      writeFileSync(join(state, "rooms.txt"), "# my rooms" + eol + eol + "lima tok-lima Carol" + eol);
      writeFileSync(join(state, "lima.cursor"), "6");
      msgs = [{ seq: 7, data: OWN }];
      const own = await watch();
      msgs = [{ seq: 7, data: OWN }, { seq: 8, data: OTHER }];
      const other = await watch();
      runs[label] = [own.out, own.err, other.out, other.err, readFileSync(join(state, "lima.cursor"), "utf8"), readdirSync(state).sort()];
      assert.ok(own.out.startsWith("SILENT no new messages"), label + ": Carol's own post does not wake Carol: " + own.out + own.err);
      assert.deepEqual(JSON.parse(other.out.split("\n").slice(1).join("\n")).messages.map((m) => m.from), ["Bob"], label);
    }
    assert.deepEqual(runs.CRLF, runs.LF, "the CRLF registry behaves as its LF twin");
    const before = requests.length;
    writeFileSync(join(state, "rooms.txt"), "\r\n\r\n \r\n");
    const blank = await watch();
    assert.equal(blank.out, "SILENT nothing to watch\n", blank.out + blank.err);
    assert.equal(requests.length, before, "CRLF blank lines make no call");
  });
});

// Message and game text never goes on a command line, where other local
// users read it: jq reads the payload from the poll's files and the
// awaiting items on stdin. Messages, a game frame and an awaiting item,
// each carrying a marker, reach the payload, and no recorded argument
// list or environment holds a marker.
test("no message or game text is ever a command's argument", async () => {
  const MARK = "Mark3rPrivateText";
  const MSG = { id: 6, ts: 1, from: "Ada", text: MARK + " in a message" };
  const AWAIT = { type: "game", id: 9, turn: 2, action: "move", call: { method: "POST", path: "/api/rooms/lima/games/9/moves", body: { from: "Bob", dir: "<" + MARK + " move>", turn: 2 } } };
  let log = "", bin = "";
  await withWatcher((req, u, res) => {
    const after = parseInt(u.searchParams.get("after") || "0", 10);
    if (u.pathname.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("retry: 2000\n\n");
      if (after < 6) res.write("id: 6\nevent: message\ndata: " + JSON.stringify(MSG) + "\n\n");
      res.write("event: game\ndata: " + JSON.stringify({ type: "game", room: "lima", from: "Ada", game: { id: 4, turn: 3, note: MARK + " in a frame" } }) + "\n\n");
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages: [], last_id: 6, has_more: false, room_state: { awaiting_you: [AWAIT] }, you: "Bob" }));
  }, (state, dir) => {
    log = join(dir, "exec.log");
    bin = shimDir(dir, log);
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
    writeFileSync(join(state, "lima.cursor"), "5");
    writeFileSync(join(state, "lima.self"), "Bob");
  }, async (watch, state, { dir }) => {
    const { out, err } = await watch({ PATH: bin, MISSING_LOG: join(dir, "missing.log") });
    assert.ok(out.startsWith("WAKE new messages in lima"), out + err);
    const p = JSON.parse(out.split("\n").slice(1).join("\n"));
    assert.equal(p.messages[0].text, MSG.text);
    assert.deepEqual(p.games.map((g) => (g.game ? g.game.note : g.awaiting_games[0].call.body.dir)), [MARK + " in a frame", "<" + MARK + " move>"]);
    assert.ok(!existsSync(join(dir, "missing.log")), "an unshimmed command ran");
    assert.ok(!readFileSync(log, "utf8").includes(MARK), "message or game text in a command's arguments or environment");
  }, { runtime: MISSING });
});

// One argument over the kernel's limit (MAX_ARG_STRLEN, 128 KiB) fails
// the command: 20 messages of 8,000 characters failed the payload after
// the cursor was saved, so they were never delivered. The payload is
// built from files, and the cursor is saved only once it is built: a run
// whose payload fails moves no cursor, and the next run delivers the
// whole batch.
test("a large batch is delivered whole, and the cursor moves only with it", async () => {
  const MSGS = Array.from({ length: 20 }, (_, i) => ({ seq: 6 + i, data: { id: 6 + i, ts: 1, from: "Ada", text: "m" + i + ":" + "x".repeat(8000) } }));
  await withWatcher(roomAnswers(MSGS), (state, dir) => {
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
    writeFileSync(join(state, "lima.cursor"), "5");
    writeFileSync(join(state, "lima.self"), "Bob");
    // a jq that fails the payload (the calls that read the poll's files)
    const real = execFileSync(BASH, ["-c", "command -v jq"], { encoding: "utf8" }).trim();
    mkdirSync(join(dir, "fail"));
    writeFileSync(join(dir, "fail", "jq"), "#!" + BASH + "\nfor a in \"$@\"; do [ \"$a\" = --slurpfile ] && exit 1; done\nexec " + shellQuote(real) + " \"$@\"\n", { mode: 0o755 });
  }, async (watch, state, { dir }) => {
    const failed = await watch({ PATH: join(dir, "fail") + ":" + process.env.PATH }).then(() => null, (e) => e);
    assert.ok(failed && failed.code !== 0, "the run whose payload failed exits with an error");
    assert.ok(!/WAKE/.test(failed.out), failed.out);
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "5", "no cursor saved without its payload");
    const { out, err } = await watch();
    assert.ok(out.startsWith("WAKE new messages in lima"), out.slice(0, 200) + err);
    const p = JSON.parse(out.split("\n").slice(1).join("\n"));
    assert.deepEqual(p.messages.map((m) => m.text), MSGS.map((m) => m.data.text), "all 20, whole");
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "25", "the cursor moved with the delivered batch");
  });
});

// Every call reads its token header from a file (-H @file), which curl
// does from 7.55: an older one sends no token, so a run that finds one
// says so once and makes no call.
test("with curl older than 7.55 a run logs why and makes no call; 7.55 is enough", async () => {
  const real = execFileSync(BASH, ["-c", "command -v curl"], { encoding: "utf8" }).trim();
  await withWatcher(roomAnswers([], { lastId: 5 }), (state) => {
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
    writeFileSync(join(state, "lima.cursor"), "5");
    writeFileSync(join(state, "lima.self"), "Bob");
  }, async (watch, state, { requests, dir }) => {
    const calls = join(dir, "curl.log");
    const curlAt = (version) => {
      const bin = join(dir, "curl-" + version);
      mkdirSync(bin);
      writeFileSync(join(bin, "curl"), "#!" + BASH + "\nif [ \"$1\" = --version ]; then echo 'curl " + version + " (x86_64-apple-darwin17.0) libcurl/" + version + "'; exit 0; fi\nprintf 'call\\n' >> " + shellQuote(calls) + "\nexec " + shellQuote(real) + " \"$@\"\n", { mode: 0o755 });
      return bin + ":" + process.env.PATH;
    };
    const old = curlAt("7.54.1");
    for (const [dry, want] of [["0", "SILENT curl 7.54.1 is older than 7.55\n"], ["1", "SILENT dry-run: curl 7.54.1 is older than 7.55\n"]]) {
      const { out, err } = await watch({ PATH: old, HATCH_HOOK_DRY_RUN: dry });
      assert.equal(out, want);
      assert.equal(err, "LOG curl 7.54.1 is older than 7.55: the watcher needs curl 7.55 or later to send your token from a file; install a newer curl. Until then it makes no call.\n");
    }
    assert.equal(requests.length, 0, "no request");
    assert.ok(!existsSync(calls), "curl was asked its version only");
    const { out } = await watch({ PATH: curlAt("7.55.0") });
    assert.ok(out.startsWith("SILENT no new messages"), out);
    assert.ok(requests.length > 0, "7.55 calls the site");
  });
});

// Everything kept is created private, and no copy of the messages is
// kept: the wake payload carries them. A ROOM.jsonl an older copy wrote is
// not this run's file: it is neither written to nor removed, only made
// private (the next test).
test("a live run keeps no ROOM.jsonl, makes its state private, and leaves an older spool's content alone", async () => {
  const MSG = { id: 6, ts: 1, from: "Ada", text: "hello" };
  const AWAIT = { type: "game", id: 7, turn: 1, action: "move" };
  await withWatcher(roomAnswers([{ seq: 6, data: MSG }], { roomState: { awaiting_you: [AWAIT] } }), (state, dir) => {
    writeFileSync(join(dir, "rooms.txt"), "lima tok-lima\noslo tok-oslo\n");
    rmSync(state, { recursive: true });
    mkdirSync(join(dir, "old"));
    writeFileSync(join(dir, "old", "lima.jsonl"), "{\"id\":1}\n", { mode: 0o644 });
  }, async (watch, state, { dir }) => {
    const registry = join(dir, "rooms.txt");
    // the first run primes both rooms, and the game that came to await the member wakes it
    const first = await watch({ AGENTCHAT_REGISTRY: registry });
    assert.ok(first.out.startsWith("WAKE activity in 2 watched rooms"), first.out + first.err);
    assert.deepEqual(JSON.parse(first.out.split("\n").slice(1).join("\n")).rooms.map((r) => [r.room, r.messages, r.games]), [["lima", undefined, [{ awaiting_games: [AWAIT], via: "room_state" }]], ["oslo", undefined, [{ awaiting_games: [AWAIT], via: "room_state" }]]]);
    assert.equal(statSync(state).mode & 0o777, 0o700, "the state dir it made is its user's alone");
    // behind lima's message: the next run collects it, and keeps no copy
    writeFileSync(join(state, "lima.cursor"), "5");
    const second = await watch({ AGENTCHAT_REGISTRY: registry });
    assert.ok(second.out.startsWith("WAKE new messages in lima"), second.out + second.err);
    assert.deepEqual(JSON.parse(second.out.split("\n").slice(1).join("\n")).rooms[0].messages.map((m) => m.text), ["hello"]);
    const files = readdirSync(state).sort();
    assert.deepEqual(files, ["lima.awaiting", "lima.cursor", "lima.self", "oslo.awaiting", "oslo.cursor", "oslo.self"], "no ROOM.jsonl: " + files.join(" "));
    for (const f of files) assert.equal(statSync(join(state, f)).mode & 0o777, 0o600, f + " is not private");
    assert.equal(readFileSync(join(state, "lima.self"), "utf8"), "Bob", "the name comes from the API");
    // an older copy's spool is not this run's to write or remove
    const old = join(dir, "old");
    writeFileSync(join(old, "lima.cursor"), "5");
    const again = await watch({ AGENTCHAT_REGISTRY: registry, AGENTCHAT_STATE_DIR: old });
    assert.ok(again.out.startsWith("WAKE"), again.out + again.err);
    assert.equal(readFileSync(join(old, "lima.jsonl"), "utf8"), "{\"id\":1}\n", "an older spool's content is left as it was");
    assert.equal(statSync(join(old, "lima.jsonl")).mode & 0o777, 0o600, "and it is private");
  });
});

// Files an older copy made (before umask 077) may be readable by others,
// the registry holds the tokens and the state dir's file names are room
// names: a live run sets the state dir to 700 and the registry, an
// invite.token, every ROOM.jsonl there and each listed room's cursor,
// name and awaiting files to 600, changing no content and removing
// nothing. A cursor of a room the registry does not list is not the
// run's to touch. A dry run leaves the state dir as it found it, modes
// included.
test("a live run makes the state dir, the registry and the state files private, an older copy's included; a dry run changes no mode", async () => {
  await withWatcher(roomAnswers([], { lastId: 5 }), (state) => {
    const files = { "rooms.txt": "lima tok-lima\n", "lima.cursor": "5", "lima.self": "Bob", "lima.awaiting": "[]", "lima.jsonl": "{\"id\":1}\n", "gone.cursor": "9", "gone.jsonl": "{\"id\":2}\n", "invite.token": "tok-legacy" };
    for (const [f, text] of Object.entries(files)) { writeFileSync(join(state, f), text); chmodSync(join(state, f), 0o644); }
    chmodSync(state, 0o755);
  }, async (watch, state) => {
    const snapshot = () => Object.fromEntries(readdirSync(state).sort().map((f) => [f, [statSync(join(state, f)).mode & 0o777, readFileSync(join(state, f), "utf8")]]));
    const before = snapshot();
    const dry = await watch({ HATCH_HOOK_DRY_RUN: "1" });
    assert.ok(dry.out.startsWith("SILENT dry-run: no new messages"), dry.out + dry.err);
    assert.deepEqual(snapshot(), before, "a dry run changes no file, mode or content");
    assert.equal(statSync(state).mode & 0o777, 0o755, "nor the state dir's mode");
    const live = await watch();
    assert.ok(live.out.startsWith("SILENT no new messages"), live.out + live.err);
    const after = snapshot();
    assert.equal(statSync(state).mode & 0o777, 0o700, "the state dir is private");
    assert.deepEqual(Object.keys(after), Object.keys(before), "nothing removed, nothing added");
    for (const f of ["rooms.txt", "lima.cursor", "lima.self", "lima.awaiting", "lima.jsonl", "gone.jsonl", "invite.token"]) assert.equal(after[f][0], 0o600, f + " is not private");
    assert.deepEqual(after["gone.cursor"], before["gone.cursor"], "an unlisted room's cursor is left as it was");
    for (const f of ["rooms.txt", "lima.self", "lima.awaiting", "lima.jsonl", "gone.jsonl", "invite.token"]) assert.equal(after[f][1], before[f][1], f + "'s content changed");
  });
});

// A mode that cannot change (a registry another user owns, a read-only
// disk) leaves that file as it is: the run goes on. Here chmod itself fails.
test("a chmod that fails does not stop the run", async () => {
  const MSG = { id: 6, ts: 1, from: "Ada", text: "still delivered" };
  await withWatcher(roomAnswers([{ seq: 6, data: MSG }]), (state, dir) => {
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima\n");
    writeFileSync(join(state, "lima.cursor"), "5");
    writeFileSync(join(state, "lima.self"), "Bob");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "chmod"), "#!" + BASH + "\necho \"chmod: changing permissions of '$2': Operation not permitted\" >&2\nexit 1\n", { mode: 0o755 });
  }, async (watch, state, { dir }) => {
    const { out, err } = await watch({ PATH: join(dir, "bin") + ":" + process.env.PATH });
    assert.ok(out.startsWith("WAKE new messages in lima"), out + err);
    assert.ok(!/Operation not permitted/.test(err), "chmod's own complaint is silenced: " + err);
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "6");
  });
});

// A name given as a registry line's third field (older registries) is the
// member's name in that room: the run asks no one and caches nothing.
test("a third-field name is still used: own posts do not wake, and the API is not asked", async () => {
  const OWN = { id: 7, ts: 1, from: "Carol", text: "my own post" };
  const OTHER = { id: 8, ts: 2, from: "Bob", text: "someone else" };
  let msgs = [{ seq: 7, data: OWN }];
  await withWatcher((req, u, res) => roomAnswers(msgs, { you: "Bob" })(req, u, res), (state) => {
    writeFileSync(join(state, "rooms.txt"), "lima tok-lima Carol\n");
    writeFileSync(join(state, "lima.cursor"), "6");
  }, async (watch, state, { requests }) => {
    const own = await watch();
    assert.ok(own.out.startsWith("SILENT no new messages"), "Carol's own post does not wake Carol: " + own.out + own.err);
    assert.equal(readFileSync(join(state, "lima.cursor"), "utf8"), "7", "the cursor moves past it");
    msgs = [{ seq: 7, data: OWN }, { seq: 8, data: OTHER }];
    const other = await watch();
    assert.ok(other.out.startsWith("WAKE new messages in lima"), other.out + other.err);
    assert.deepEqual(JSON.parse(other.out.split("\n").slice(1).join("\n")).messages.map((m) => m.from), ["Bob"]);
    assert.ok(!requests.some((q) => q.path.endsWith("/me")), "the API was not asked the name");
    assert.ok(!existsSync(join(state, "lima.self")), "no name cached");
  });
});
