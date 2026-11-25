// Muse hooks in the room harness, woken through the real bridge in the same
// process, as the Worker runs them: the Room (room-harness.mjs), the
// bridge's router and its MuseLink and Directory on node:sqlite
// (tests/bridge/helpers/fake-do.mjs), Muse's API as a stub fetch and the VM
// as the bridge tests' fake Noise VM. Nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { bridgeFetch } from "../../worker/bridge/index.ts";
import { MuseLink } from "../../worker/bridge/link.ts";
import { Directory } from "../../worker/bridge/directory.ts";
import { generateBridgeKey, seal } from "../../worker/bridge/seal.ts";
import { deps } from "../../worker/bridge/util.ts";
import { derivedSessionId } from "../../worker/bridge/wake.ts";
import { ServiceFrame } from "../../worker/bridge/muse/envelope.ts";
import { MUSE_WAKES_AT_ONCE } from "../../worker/limits.ts";
import { FakeNamespace } from "../bridge/helpers/fake-do.mjs";
import { FakeVm } from "../bridge/helpers/fake-vm.mjs";

const R = "muse-unit";
const utf8 = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** true once fn() is, polled; false after ms */
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return !!fn(); };

/**
 * The bridge's bindings and a Muse with one account per link: links
 * (default 1) gadgets hand over "tok-muse-N", whose Muse leases VM "vm-N",
 * and each link's code is claimed. chats collects each chat request a VM
 * is sent (vms, the VM each went to); flight counts the chats a VM holds
 * unanswered, and the most at once. opts.ack(i) runs before a VM answers
 * its chat (the i-th): a test holds or slows Muse with it.
 */
async function museWorld(opts = {}) {
  const keys = await generateBridgeKey();
  const env = { MUSE_SEAL_KEY: keys.privateKey };
  env.MUSE_LINK = new FakeNamespace(MuseLink, env);
  env.MUSE_DIRECTORY = new FakeNamespace(Directory, env);
  const chats = [];
  const vms = [];
  const flight = { now: 0, most: 0 };
  const logs = [];
  const saved = { fetch: deps.fetch, connect: deps.connect, log: deps.log, limits: deps.limits };
  deps.log = (line) => logs.push(line);
  deps.limits = opts.limits || {};
  deps.fetch = async (url, init) => {
    const m = /^Bearer tok-muse-([0-9]+)$/.exec(init.headers.Authorization);
    return m
      ? new Response(JSON.stringify({ vm_list: [{ vm_id: "vm-" + m[1], vm_auth_token: "vmtok-" + m[1], vm_ws_url: "wss://x", default: true }] }))
      : new Response("no", { status: 401 });
  };
  deps.connect = async (url, headers) => {
    const vm = new FakeVm();
    const socket = await vm.connect(url, headers);
    (async () => {
      await vm.handshakeDone;
      const fr = await vm.nextFrame();
      const i = chats.length;
      chats.push(JSON.parse(new TextDecoder().decode(fr.value.body)));
      vms.push(new URL(url).searchParams.get("vm_id"));
      flight.most = Math.max(flight.most, ++flight.now);
      try {
        if (opts.ack) await opts.ack(i);
      } finally {
        flight.now--;
      }
      await vm.sendFrame(ServiceFrame.response(fr.streamId, { status: 200, body: utf8.encode('{"result":{"message_id":"m-1"}}'), endBody: true }));
    })().catch(() => { /* a socket the bridge closed first: nothing to answer */ });
    return socket;
  };
  const call = async (path, body) => {
    const r = await bridgeFetch(new Request("https://muse-bridge" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json() };
  };
  // each gadget's handover, then its code claimed: a link
  const links = [];
  for (let n = 1; n <= (opts.links || 1); n++) {
    const c = await call("/connect", { sealed: await seal({ accessToken: "tok-muse-" + n, nodeId: "gadget-unit" }, keys.publicKey), termsVersion: "v1" });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await call("/claim", { code: c.body.code })).status, 200);
    links.push(c.body.museLinkId);
  }
  return { env, chats, vms, flight, logs, call, links, link: links[0], restore: () => Object.assign(deps, saved) };
}

/** Every waiting wake in the room due now. */
function dueNow(h) {
  h.db.prepare("UPDATE mh SET due_at = ? WHERE due_at IS NOT NULL").run(Date.now());
}

/** A promise and the function that settles it. */
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}

test("a message wakes a member's Muse through the bridge once; a disconnected link turns the hook off", async () => {
  const w = await museWorld();
  try {
    const h = makeRoom({ env: w.env });
    h.member("Ada");
    h.member("Bob");
    const set = h.room.museSetHook("tok-Ada", w.link, "agent-chat", R);
    assert.equal(set.ok, true, JSON.stringify(set));
    const due = () => { dueNow(h); return h.room.museDeliver(); };

    await h.room.post("Bob", "hello, Ada's Muse", R, false);
    await h.room.post("Ada", "Ada's own words", R, false);
    await due();
    assert.equal(w.chats.length, 1);
    const chat = w.chats[0];
    assert.equal(chat.session_id, await derivedSessionId(w.link, "agent-chat"));
    assert.equal(chat.device_id, "gadget-unit");
    assert.ok(chat.message.startsWith("[Agent Chat]\n```\n{\n  \"room\": \"muse-unit\","), chat.message);
    assert.ok(chat.message.includes("\"text\": \"hello, Ada's Muse\""));
    assert.ok(!chat.message.includes("Ada's own words"), "her own message does not wake her");
    let hook = h.room.museStatus("tok-Ada").hook;
    assert.deepEqual([hook.pending, hook.last_status, hook.enabled], [0, 200, true]);

    // nothing waiting: nothing sent again
    await due();
    assert.equal(w.chats.length, 1);

    // the gadget disconnects: the next wake gets 410 and the hook goes off
    assert.equal((await w.call("/disconnect", { museLinkId: w.link })).body.removed, true);
    await h.room.post("Bob", "after the disconnect", R, false);
    await due();
    assert.equal(w.chats.length, 1);
    hook = h.room.museStatus("tok-Ada").hook;
    assert.deepEqual([hook.enabled, hook.off_reason, hook.pending, hook.last_status], [false, "link_gone", 0, 410]);

    // the bridge logged no token, link id or message text
    const all = w.logs.join("\n");
    for (const s of ["tok-muse", "vmtok-1", w.link, "hello, Ada"]) assert.ok(!all.includes(s), "logged " + s.slice(0, 6));
  } finally {
    w.restore();
  }
});

test("a removed hook is taken off the link's room count", async () => {
  const w = await museWorld();
  try {
    const h = makeRoom({ env: w.env });
    h.member("Ada");
    assert.equal(h.room.museSetHook("tok-Ada", w.link, "main", R).ok, true);
    assert.equal((await w.call("/rooms", { museLinkId: w.link, room: R, hooked: true })).body.rooms, 1);
    assert.equal(h.room.museRemove("tok-Ada").removed, true);
    await h.settled();
    assert.equal((await w.call("/status", { museLinkId: w.link })).body.rooms, 0);
  } finally {
    w.restore();
  }
});

// The alarm used to send every due wake, one after another, before it
// advanced the match clocks: a Muse that was slow to answer held a match
// deadline that was due in the same run for as long as its wakes took.
test("the alarm advances a due match clock while a wake still hangs", async () => {
  const held = gate();
  const w = await museWorld({ ack: () => held.p });
  try {
    const h = makeRoom({ env: w.env });
    for (const n of ["Ada", "Bob", "Poc", "Rex"]) h.member(n);
    assert.equal(h.room.museSetHook("tok-Ada", w.link, "agent-chat", R).ok, true);
    const c = await h.room.createGame("Poc", ["Poc", "Rex"], { game: "duel", best_of: 1 }, R);
    assert.equal(c.status, 201, c.error);
    assert.equal((await h.room.gameAccept(c.game.id, "Rex", R)).status, 200);
    await h.room.post("Bob", "a wake for Ada", R, false);
    dueNow(h);
    // the duel's round clock runs out unthrown: the alarm calls it off
    const g = h.room.gameRow(c.game.id);
    g.st.deadline = Date.now() - 1;
    h.room.saveGame(g);
    const status = () => h.one("SELECT status FROM gm WHERE id = ?", c.game.id).status;

    const alarm = h.room.alarm();
    assert.ok(await until(() => w.chats.length === 1), "the wake reached the Muse");
    assert.equal(w.flight.now, 1, "and hangs there");
    assert.equal(status(), "cancelled", "the match's clock ran first, not after the wake");
    held.open();
    await alarm;
    assert.equal(h.room.museStatus("tok-Ada").hook.pending, 0);
  } finally {
    held.open();
    w.restore();
  }
});

test("wakes for different members go out together", async () => {
  const w = await museWorld({ links: 2, ack: () => sleep(150) });
  try {
    const h = makeRoom({ env: w.env });
    for (const n of ["Ada", "Bob", "Cy"]) h.member(n);
    assert.equal(h.room.museSetHook("tok-Ada", w.links[0], "agent-chat", R).ok, true);
    assert.equal(h.room.museSetHook("tok-Cy", w.links[1], "agent-chat", R).ok, true);
    await h.room.post("Bob", "for both", R, false);
    dueNow(h);
    await h.room.museDeliver();
    assert.deepEqual(w.vms.slice().sort(), ["vm-1", "vm-2"]);
    assert.equal(w.flight.most, 2, "both Muses held a wake at the same time");
    for (const t of ["tok-Ada", "tok-Cy"]) assert.equal(h.room.museStatus(t).hook.pending, 0);
  } finally {
    w.restore();
  }
});

test("past the run's allowance the wakes still due stay queued, and the alarm comes right back for them", async () => {
  const n = MUSE_WAKES_AT_ONCE + 1;
  const w = await museWorld({ links: n, ack: () => sleep(120) });
  try {
    const h = makeRoom({ env: w.env });
    h.member("Bob");
    for (let i = 0; i < n; i++) {
      h.member("M" + i);
      assert.equal(h.room.museSetHook("tok-M" + i, w.links[i], "agent-chat", R).ok, true);
    }
    await h.room.post("Bob", "for everyone", R, false);
    dueNow(h);
    const armed = [];
    h.room.ctx.storage.setAlarm = async (at) => { armed.push(at - Date.now()); };
    const deliver = h.room.museDeliver;
    h.room.museDeliver = function () { return deliver.call(this, { allowanceMs: 40 }); };

    await h.room.alarm();
    assert.equal(w.chats.length, MUSE_WAKES_AT_ONCE, "as many as go at once started within the allowance, and no more");
    assert.equal(w.flight.most, MUSE_WAKES_AT_ONCE);
    const left = h.all("SELECT member, due_at FROM mh WHERE cursor = 0");
    assert.equal(left.length, 1, JSON.stringify(left));
    assert.ok(left[0].due_at <= Date.now(), "still due");
    assert.equal(h.room.museStatus("tok-" + left[0].member.replace(/^m/, "M")).hook.pending, 1, "its item waits");
    assert.ok(armed.length && armed.at(-1) <= 1000, "the alarm is armed for right after: " + armed.at(-1));

    // the run after sends it
    await h.room.alarm();
    assert.equal(w.chats.length, n);
    assert.equal(h.all("SELECT member FROM mh WHERE cursor = 0").length, 0);
  } finally {
    w.restore();
  }
});

test("a failure in the clocks or the wakes stops neither the other nor the re-arm", async (t) => {
  const quiet = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = quiet; });
  const w = await museWorld();
  try {
    const h = makeRoom({ env: w.env });
    for (const n of ["Ada", "Bob", "Poc", "Rex"]) h.member(n);
    assert.equal(h.room.museSetHook("tok-Ada", w.link, "agent-chat", R).ok, true);
    let arms = 0;
    const arm = h.room.armGameAlarm;
    h.room.armGameAlarm = function () { arms++; return arm.call(this); };

    // the clocks step throws as a whole: the wake still goes, the alarm is re-armed
    h.room.advanceClocks = async () => { throw new Error("broken clocks"); };
    await h.room.post("Bob", "despite the clocks", R, false);
    dueNow(h);
    await h.room.alarm();
    assert.equal(w.chats.length, 1);
    assert.equal(arms, 1);
    delete h.room.advanceClocks;

    // the wakes step throws: the clocks still run, the alarm is re-armed
    const c = await h.room.createGame("Poc", ["Poc", "Rex"], { game: "duel", best_of: 1 }, R);
    assert.equal((await h.room.gameAccept(c.game.id, "Rex", R)).status, 200);
    const g = h.room.gameRow(c.game.id);
    g.st.deadline = Date.now() - 1;
    h.room.saveGame(g);
    h.room.museDeliver = async () => { throw new Error("broken wakes"); };
    arms = 0;
    await h.room.alarm();
    assert.equal(h.one("SELECT status FROM gm WHERE id = ?", c.game.id).status, "cancelled");
    assert.equal(arms, 1);
  } finally {
    w.restore();
  }
});

test("a wake that throws waits out a backoff instead of being picked again at once", async (t) => {
  const quiet = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = quiet; });
  const w = await museWorld();
  try {
    const h = makeRoom({ env: w.env });
    for (const n of ["Ada", "Bob"]) h.member(n);
    assert.equal(h.room.museSetHook("tok-Ada", w.link, "agent-chat", R).ok, true);
    await h.room.post("Bob", "one", R, false);
    dueNow(h);
    let tries = 0;
    h.room.museWake = async () => { tries++; throw new Error("broken wake"); };
    await h.room.museDeliver({ allowanceMs: 200 });
    assert.equal(tries, 1, "tried once in the run, not over and over");
    const row = h.one("SELECT fails, due_at FROM mh WHERE member = 'ada'");
    assert.equal(row.fails, 1);
    assert.ok(row.due_at > Date.now() + 1000, "due again after the backoff");
  } finally {
    w.restore();
  }
});
