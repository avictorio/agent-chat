// A members listing's rows (worker/routes/members.ts memberReply, for GET
// /members and MCP get_members) on rows the real Room builds (members()):
// the owner key and people get every unrevoked member's invite link and the
// agent rows' notes; an agent gets its own row's link only, its own row
// found by its token, never by its name. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { memberReply } from "../../worker/routes/members.ts";

const O = "https://example.test", R = "lima";

/** a room with: the caller (an agent, active, an earlier invite under its
 *  name revoked), a person (active), another agent (active, invited by the
 *  person), an unused agent invite and a revoked person */
function room() {
  const h = makeRoom();
  const per = h.room.invite("Per", "human", null);
  h.room.access(per.token, false);
  h.room.revoke(h.room.invite("Ag", "agent", null).token);
  const me = h.room.invite("Ag", "agent", null);
  h.room.access(me.token, false);
  const other = h.room.invite("AgB", "agent", "Per", null, per.token);
  h.room.access(other.token, false);
  h.room.invite("AgC", "agent", null);
  h.room.revoke(h.room.invite("Gone", "human", null).token);
  return { rows: h.room.members().members, me: me.token, other: other.token };
}

test("an agent's rows: its own link only, and no note on any row", () => {
  const { rows, me } = room();
  const out = rows.map((x) => memberReply(x, O, R, undefined, me));
  const linked = out.filter((x) => x.invite_link);
  assert.equal(linked.length, 1, "one row has a link");
  assert.equal(linked[0].name, "Ag");
  assert.equal(linked[0].invite_link, O + "/r/" + R + "#invite=" + me);
  for (const x of out) assert.ok(!("agent_onboarding" in x), x.name + " carries a note");
  for (const x of out) assert.ok(!("invite_token" in x), x.name + " carries the raw token");
  assert.equal(out.length, rows.length, "every member is listed");
});

test("the owner key's and a person's rows: every unrevoked member's link, and the agent rows' notes naming their inviter", () => {
  const { rows } = room();
  const out = rows.map((x) => memberReply(x, O, R, undefined, null));
  for (const x of out) {
    const revoked = x.status === "revoked";
    assert.equal(!!x.invite_link, !revoked, x.name + " (" + x.status + "): link");
    assert.equal(!!x.agent_onboarding, !revoked && x.kind !== "human", x.name + " (" + x.status + "): note");
    if (x.invite_link) assert.ok(x.agent_onboarding === undefined || x.agent_onboarding.includes(x.invite_link.split("#invite=")[1]), x.name + ": the note holds the row's token");
  }
  const agB = out.find((x) => x.name === "AgB");
  assert.ok(agB.agent_onboarding.startsWith("\"Per\" invited you"), agB.agent_onboarding.split("\n")[0]);
  assert.ok(out.find((x) => x.name === "AgC").agent_onboarding.startsWith("You are invited"));
  assert.equal(out.filter((x) => x.name === "Gone").every((x) => !x.invite_link && !x.agent_onboarding), true, "a revoked row carries neither");
});

test("a row under the caller's name with another token gets no link", () => {
  const { rows, me, other } = room();
  const own = rows.find((x) => x.name === "Ag" && x.status === "active");
  const twin = { ...own, invite_token: other };
  assert.ok(!("invite_link" in memberReply(twin, O, R, undefined, me)), "matched by token, not by name");
  assert.ok(memberReply(own, O, R, undefined, me).invite_link, "the caller's own row");
  // an empty token for an agent fails closed: no row's link
  for (const x of rows) assert.ok(!("invite_link" in memberReply(x, O, R, undefined, "")), x.name);
});
