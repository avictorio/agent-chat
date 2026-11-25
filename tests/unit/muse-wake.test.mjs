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
import { FakeNamespace } from "../bridge/helpers/fake-do.mjs";
import { FakeVm } from "../bridge/helpers/fake-vm.mjs";

const R = "muse-unit";
const utf8 = new TextEncoder();

/** The bridge's bindings and a Muse that leases one VM to "tok-muse";
 *  chats collects each chat request the VM is sent. */
async function museWorld() {
  const keys = await generateBridgeKey();
  const env = { MUSE_SEAL_KEY: keys.privateKey };
  env.MUSE_LINK = new FakeNamespace(MuseLink, env);
  env.MUSE_DIRECTORY = new FakeNamespace(Directory, env);
  const chats = [];
  const logs = [];
  const saved = { fetch: deps.fetch, connect: deps.connect, log: deps.log };
  deps.log = (line) => logs.push(line);
  deps.fetch = async (url, init) => init.headers.Authorization === "Bearer tok-muse"
    ? new Response(JSON.stringify({ vm_list: [{ vm_id: "vm-1", vm_auth_token: "vmtok-1", vm_ws_url: "wss://x", default: true }] }))
    : new Response("no", { status: 401 });
  deps.connect = async (url, headers) => {
    const vm = new FakeVm();
    const socket = await vm.connect(url, headers);
    (async () => {
      await vm.handshakeDone;
      const fr = await vm.nextFrame();
      chats.push(JSON.parse(new TextDecoder().decode(fr.value.body)));
      await vm.sendFrame(ServiceFrame.response(fr.streamId, { status: 200, body: utf8.encode('{"result":{"message_id":"m-1"}}'), endBody: true }));
    })();
    return socket;
  };
  const call = async (path, body) => {
    const r = await bridgeFetch(new Request("https://muse-bridge" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json() };
  };
  // the gadget's handover, then the code claimed: a link
  const c = await call("/connect", { sealed: await seal({ accessToken: "tok-muse", nodeId: "gadget-unit" }, keys.publicKey), termsVersion: "v1" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await call("/claim", { code: c.body.code })).status, 200);
  return { env, chats, logs, call, link: c.body.museLinkId, restore: () => Object.assign(deps, saved) };
}

test("a message wakes a member's Muse through the bridge once; a disconnected link turns the hook off", async () => {
  const w = await museWorld();
  try {
    const h = makeRoom({ env: w.env });
    h.member("Ada");
    h.member("Bob");
    const set = h.room.museSetHook("tok-Ada", w.link, "agent-chat", R);
    assert.equal(set.ok, true, JSON.stringify(set));
    const due = () => { h.db.prepare("UPDATE mh SET due_at = ? WHERE due_at IS NOT NULL").run(Date.now()); return h.room.museDeliver(); };

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
