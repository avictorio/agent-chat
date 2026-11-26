// What the start page is built from (Room.startView, worker/room/Room.ts)
// and its "Since your last post" (Room.sinceLastPost, room/messages.ts), on
// the real Room class over node:sqlite (room-harness.mjs). startView is a
// look: it refuses as the lookup does, writes nothing, never opens an
// invite, and before the invite is open shows exactly what the preview
// does. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { mentionsName } from "../../worker/lib/text.ts";

const R = "unit";
/** SQLite's count of rows written so far on this database */
const changes = (h) => h.db.prepare("SELECT total_changes() AS n").get().n;
const invRow = (h, tok) => ({ ...h.db.prepare("SELECT used, seen, posted FROM inv WHERE token = ?").get(tok) });
const post = (h, who, text, opts = {}) => h.room.post(who, text, R, !!opts.owner, null, null, null, !!opts.draft);
/** an invite as an owner or member makes it: unused until opened */
const invite = (h, name, kind, by) => h.db.prepare("INSERT INTO inv (token, name, created, kind, invited_by) VALUES (?, ?, ?, ?, ?)").run("tok-" + name, name, Date.now() - 1000, kind, by || null);

/** previewInvite's answer as it was built before startView shared its
 *  body: the invite, the constitution's start, the members who joined. */
function previewAsBefore(h, tok) {
  const r = h.db.prepare("SELECT name, used, kind, invited_by, created FROM inv WHERE token = ?").get(tok);
  const con = h.db.prepare("SELECT text FROM con ORDER BY v DESC LIMIT 1").get();
  const members = h.db.prepare("SELECT name, kind FROM inv WHERE revoked IS NULL AND used IS NOT NULL ORDER BY created").all().map((m) => ({ name: m.name, kind: m.kind === "human" ? "human" : "agent" }));
  return {
    ok: true,
    invite: { name: r.name, kind: r.kind === "human" ? "human" : "agent", status: r.used ? "active" : "unused", invited_by: r.invited_by || null, invited: r.created, joined: r.used || null },
    purpose: con && con.text ? con.text.slice(0, 280) : null,
    members,
    opened: !!r.used,
  };
}

test("startView refuses exactly as the lookup does", () => {
  const h = makeRoom();
  h.db.prepare("INSERT INTO inv (token, name, created, revoked) VALUES (?, ?, ?, ?)").run("tok-gone", "Gone", Date.now(), Date.now());
  for (const tok of [undefined, null, "", "tok-nobody", "tok-gone"]) {
    const v = h.room.startView(tok, R);
    assert.equal(v.ok, false, String(tok));
    assert.deepEqual(v, h.room.lookupInvite(tok), String(tok));
  }
  assert.equal(h.room.startView("tok-gone", R).code, "invite_revoked");
  assert.equal(h.room.startView("", R).status, 401);
});

test("an unused invite sees exactly the preview, and the look writes nothing", async () => {
  const h = makeRoom();
  h.member("Anthony", "human");
  await post(h, "Anthony", "hello @Scout");
  h.room.setConstitution("Plan the Lima trip.", "Anthony");
  h.room.addDecision("Book the hotel", "", "Anthony");
  invite(h, "Scout", "agent", "Anthony");
  const before = changes(h);
  const v = h.room.startView("tok-Scout", R);
  assert.equal(changes(h), before, "no write at all");
  assert.deepEqual(v, { ...h.room.previewInvite("tok-Scout"), posted: false, hook: null, awaiting: [], awaiting_more: 0, since: null });
  assert.equal(v.invite.status, "unused");
  assert.deepEqual(invRow(h, "tok-Scout"), { used: null, seen: null, posted: null }, "the invite stays unopened and unseen");
  // an owner-key post under the name before the agent joined does not make the page say it posted
  await post(h, "Scout", "posted for Scout with the owner key", { owner: true });
  assert.ok(invRow(h, "tok-Scout").posted, "the post stamped the invite");
  const after = h.room.startView("tok-Scout", R);
  assert.equal(after.posted, false);
  assert.equal(after.since, null);
});

test("previewInvite answers as it did before startView shared its body", async () => {
  const h = makeRoom();
  h.member("Anthony", "human");
  invite(h, "Scout", "agent", "Anthony");
  invite(h, "Matheo", "human");
  assert.deepEqual(h.room.previewInvite("tok-Scout"), previewAsBefore(h, "tok-Scout"));
  h.room.setConstitution("x".repeat(400), "Anthony");
  for (const tok of ["tok-Scout", "tok-Matheo", "tok-Anthony"]) assert.deepEqual(h.room.previewInvite(tok), previewAsBefore(h, tok), tok);
});

test("an opened invite adds its posted flag, its hook, its awaiting_you and what came since, and writes nothing", async () => {
  const h = makeRoom();
  h.member("Anthony", "human");
  h.member("Scout", "agent");
  h.room.addDecision("Book the hotel", "", "Anthony");
  let before = changes(h);
  let v = h.room.startView("tok-Scout", R);
  assert.equal(changes(h), before);
  assert.equal(v.posted, false);
  assert.equal(v.since, null, "no post yet");
  assert.equal(v.hook, null, "no hook");
  const st = h.room.roomState("Scout", R);
  assert.deepEqual(v.awaiting, st.awaiting_you || []);
  assert.ok(v.awaiting.some((i) => i.type === "decision"), "the unsigned decision waits");
  assert.equal(v.awaiting_more, st.awaiting_you_more || 0);
  assert.deepEqual({ ...v, posted: undefined, hook: undefined, awaiting: undefined, awaiting_more: undefined, since: undefined }, { ...h.room.previewInvite("tok-Scout"), posted: undefined, hook: undefined, awaiting: undefined, awaiting_more: undefined, since: undefined });
  // a hook made by hand: the view is museView's
  const now = Date.now();
  h.db.prepare("INSERT INTO mh (member, name, room, link, routing, enabled, muted, created, updated, kind, url, last_status, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("scout", "Scout", R, "", "", 1, 0, now, now, "webhook", "https://agent.example.org/wake", 500, "HTTP 500");
  const s = await post(h, "Scout", "Hello, I am Scout.");
  await post(h, "Anthony", "@Scout welcome");
  await post(h, "Anthony", "dinner at eight");
  before = changes(h);
  v = h.room.startView("tok-Scout", R);
  assert.equal(changes(h), before, "no write at all");
  assert.deepEqual(v.hook, h.room.museView(h.room.museRow("scout")));
  assert.equal(v.hook.kind, "webhook");
  assert.equal(v.posted, true);
  assert.deepEqual(v.since, { after: s.id, count: 2, for_you: 1 });
  const st2 = h.room.roomState("Scout", R);
  assert.deepEqual(v.awaiting, st2.awaiting_you || []);
  assert.equal(v.awaiting_more, st2.awaiting_you_more || 0);
  assert.ok(!JSON.stringify(v).includes("tok-Scout"), "the view holds no token");
});

// "Since your last post" (C20): anchored on the id of the member's latest
// live message; the accepted over- and under-counts of sinceLastPost's
// comment each have a case. Each is checked through sinceLastPost and
// through the start page's view.
const fresh = () => { const h = makeRoom(); h.member("Scout", "agent"); h.member("Anthony", "human"); h.member("Émile", "agent"); return h; };
/** sinceLastPost for the name, checked to be what the page's view carries */
const since = (h, name) => {
  const s = h.room.sinceLastPost(name);
  const v = h.room.startView("tok-" + name, R);
  assert.deepEqual(v.since, v.posted ? s : null, "startView's since for " + name);
  return s;
};

test("since: null before the member has posted", async () => {
  const h = fresh();
  await post(h, "Anthony", "hi @Scout");
  assert.equal(since(h, "Scout"), null);
});

test("since: others' messages after the member's latest post, and those naming it in any case", async () => {
  const h = fresh();
  await post(h, "Anthony", "before @Scout");
  const s = await post(h, "Scout", "Hello, I am Scout.");
  await post(h, "Anthony", "Welcome @scout!");
  await post(h, "Anthony", "dinner at eight");
  await post(h, "Émile", "@Scout2 is not you, @Scouting neither");
  await post(h, "Scout", "<draft>", { draft: true });
  assert.deepEqual(since(h, "Scout"), { after: s.id, count: 3, for_you: 1 });
  // the read the page hands out returns exactly those three
  const page = await h.room.list(s.id, 50, 0, "Scout", R);
  assert.equal(page.messages.length, 3);
  assert.equal(page.messages.filter((m) => m.targets.includes("Scout")).length, 1);
});

test("since: nothing new", async () => {
  const h = fresh();
  const s = await post(h, "Scout", "hi");
  assert.deepEqual(since(h, "Scout"), { after: s.id, count: 0, for_you: 0 });
});

test("since: the latest post deleted moves the anchor back (an over-count)", async () => {
  const h = fresh();
  const a1 = await post(h, "Scout", "one");
  await post(h, "Anthony", "x");
  const a2 = await post(h, "Scout", "two");
  await post(h, "Anthony", "y");
  await h.room.deleteMessage(a2.id, "Scout", false);
  assert.deepEqual(since(h, "Scout"), { after: a1.id, count: 2, for_you: 0 });
});

test("since: null once every post of the member is gone", async () => {
  const h = fresh();
  const a = await post(h, "Scout", "one");
  await h.room.deleteMessage(a.id, "Scout", false);
  assert.equal(since(h, "Scout"), null);
});

test("since: a post the owner key made under the name moves the anchor (the one under-count)", async () => {
  const h = fresh();
  await post(h, "Scout", "one");
  await post(h, "Anthony", "@Scout are you there?");
  const o = await post(h, "scout", "posted with the owner key", { owner: true });
  assert.deepEqual(since(h, "Scout"), { after: o.id, count: 0, for_you: 0 });
});

test("since: a message that went live before the member's late post counts (an over-count), and the read returns both", async () => {
  const h = fresh();
  const d = await post(h, "Scout", "a draft", { draft: true });
  const o = await post(h, "Anthony", "meanwhile");
  await h.room.publishMessage(d.id, "Scout", false, R, undefined);
  assert.deepEqual(since(h, "Scout"), { after: d.id, count: 1, for_you: 0 });
  const page = await h.room.list(d.id, 50, 0, "Scout", R);
  assert.deepEqual(page.messages.map((m) => m.id), [o.id, d.id], "the read returns the member's own late post with it");
});

test("since: a name beyond A-Z is matched as mentions are", async () => {
  const h = fresh();
  await post(h, "Émile", "salut");
  await post(h, "Anthony", "merci @émile");
  await post(h, "Anthony", "@Emile is someone else");
  const s = since(h, "Émile");
  assert.equal(s.count, 2);
  assert.equal(s.for_you, 1);
});

test("since: accented and non-Latin names count every mention once per message", async () => {
  const h = makeRoom(); h.member("José", "agent"); h.member("Иван", "agent"); h.member("Anthony", "human");
  await post(h, "José", "hola");
  await post(h, "Иван", "привет");
  const texts = ["@josé and @JOSÉ and @Jose (someone else)", "@иван, a question", "@Ивановна is not counted by the pattern? mentionsName decides", "no mention @all"];
  for (const t of texts) await post(h, "Anthony", t);
  assert.deepEqual(since(h, "José"), { after: 1, count: 5, for_you: 1 });
  const iv = since(h, "Иван");
  assert.equal(iv.count, 4);
  assert.equal(iv.for_you, texts.filter((t) => mentionsName(t, "Иван")).length);
  // José's prefilter, "@Jos" and any one character, reads one of those texts
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM m WHERE text LIKE ?").get("%@Jos_%").n, 1);
});

test("since: others' drafts are not counted", async () => {
  const h = fresh();
  await post(h, "Scout", "hi");
  await post(h, "Anthony", "@Scout draft", { draft: true });
  assert.equal(since(h, "Scout").count, 0);
});

test("since: it writes nothing", async () => {
  const h = fresh();
  await post(h, "Scout", "hi");
  await post(h, "Anthony", "@Scout yo");
  const before = changes(h);
  h.room.sinceLastPost("Scout");
  assert.equal(changes(h), before);
});

test("since: media landing on an older message from others counts it again (an over-count)", async () => {
  const h = fresh();
  const o = await post(h, "Anthony", "a photo follows");
  const s = await post(h, "Scout", "hi");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...new Array(88).fill(0)]);
  const r = await h.room.attachImage(o.id, "Anthony", png.buffer, "image/png", false, R);
  assert.ok(r.status === undefined || r.status === 200, JSON.stringify(r));
  assert.deepEqual(since(h, "Scout"), { after: s.id, count: 1, for_you: 0 });
});

// sinceLastPost reads only the texts its LIKE pattern lets through, then
// counts those mentionsName accepts. The pattern must hold every text
// mentionsName accepts, or a mention goes uncounted: for each name, every
// text posted by another counts for_you exactly as mentionsName says.
test("since: the text prefilter misses no mention, whatever the name", async () => {
  const names = ["Scout", "Émile", "Иван", "Zoë", "李雷", "R2_D2", "50%off", "Ann 🎉", "ſam", "Kelvin", "σοφία"];
  const texts = [];
  for (const n of names) for (const t of [n, n.toLowerCase(), n.toUpperCase()]) texts.push("hi @" + t + "!", "@" + t, "x@" + t + "y", "a @" + t + "s");
  texts.push("@Ивановна", "@иВаН", "@ZOË", "@zoë", "@ſam", "@SAM", "@Kelvin", "@ΣΟΦΊΑ", "@σοφια", "@ςοφία");
  for (const name of names) {
    const h = makeRoom();
    const s = await post(h, name, "hello");
    for (const t of texts) await post(h, "Other", t);
    const want = texts.filter((t) => mentionsName(t, name)).length;
    assert.ok(want > 0, name + ": the texts mention it");
    assert.deepEqual(h.room.sinceLastPost(name), { after: s.id, count: texts.length, for_you: want }, name);
  }
});
