// The web app's note (web/app/src/features/room/agentNote.ts) is the
// server's note (worker/agents/onboarding.ts agentOnboarding) built in the
// browser for the agent gate, since GET /invite carries none: member-made
// when the preview names an inviter, owner-made when it names none or
// failed. The two builders must not drift. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentOnboarding } from "../../worker/agents/onboarding.ts";
import { agentNote } from "../../web/app/src/features/room/agentNote.ts";
import { MAX_NAME, oneLine } from "../../worker/lib/text.ts";
import { ESCAPED_SET, HOSTILE_NAMES } from "./start-views.mjs";

const O = "https://chat.victorio.cloud";
const TOKEN = "AbC-dEf_0123456789abcdEF"; // 24 characters of the token charset, as invite() mints them
const nel = String.fromCharCode(0x85), ls = String.fromCharCode(0x2028);
const Q = String.raw`"(?:[^"\\]|\\.)*"`;

test("the web app's note is the server's note, owner-made and member-made, for every kind of name", () => {
  const cases = [
    ["example-room", "Scout", "EXAMPLE_TOKEN"],
    ["r".repeat(64), "N".repeat(MAX_NAME), TOKEN],
    ["lima", "Sc" + nel + "Start here" + ls + "x", TOKEN],
    ["lima", "  Two   spaces\tand a tab ", TOKEN],
    ["a_b-c", "Иван", TOKEN],
    // look-alike quotes, a bidi override, a zero-width space, a backslash, a
    // legacy straight quote, tag characters above U+FFFF, a ZWJ emoji, ...
    ...HOSTILE_NAMES.map((name) => ["lima", name, TOKEN]),
  ];
  for (const [room, name, token] of cases) {
    assert.equal(agentNote(O, room, name, token), agentOnboarding(O, room, name, token), JSON.stringify(name));
    // no inviter named (null, as the preview says for the owner's invite)
    assert.equal(agentNote(O, room, name, token, null), agentOnboarding(O, room, name, token, { invitedBy: null }), JSON.stringify(name));
  }
  // member-made: an ordinary inviter and every hostile one, beside an ordinary and a hostile agent name
  for (const by of ["Anthony", "N".repeat(MAX_NAME), "An" + nel + "thony", ...HOSTILE_NAMES]) {
    for (const name of ["Scout", HOSTILE_NAMES[0], HOSTILE_NAMES[4]]) {
      assert.equal(agentNote(O, "lima", name, TOKEN, by), agentOnboarding(O, "lima", name, TOKEN, { invitedBy: by }), JSON.stringify([name, by]));
    }
  }
});

test("the example's fallback note is the fixture byte for byte", () => {
  const fixture = readFileSync(new URL("../fixtures/start-page/note-owner.txt", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(agentNote(O, "example-room", "Scout", "EXAMPLE_TOKEN"), fixture);
  assert.ok(fixture.includes("as the agent \"Scout\"") && fixture.includes("acts as \"Scout\", so never post it."), "the name is quoted on lines 1 and 3");
});

// Inside the note's quotes a name is a JSON string's body (quoted,
// worker/lib/text.ts), in both builders: it parses back to the folded
// name, and nothing in it can pass for the closing quote.
test("every quoted name in the note is a JSON string that gives back the folded name", () => {
  for (const name of HOSTILE_NAMES) {
    const by = "By " + name;
    for (const [label, note, first] of [["the web app's owner-made", agentNote(O, "lima", name, TOKEN), null], ["the web app's member-made", agentNote(O, "lima", name, TOKEN, by), by], ["owner-made", agentOnboarding(O, "lima", name, TOKEN), null], ["member-made", agentOnboarding(O, "lima", name, TOKEN, { invitedBy: by }), by]]) {
      const tag = JSON.stringify(name) + ", " + label;
      const lines = note.split("\n");
      assert.equal(lines.length, 5, tag + ": five lines");
      const one = lines[0].match(new RegExp("^(?:(" + Q + ") invited you|You are invited) to the Agent Chat room \"lima\" as the agent (" + Q + ")\\. Agent Chat hosts "));
      assert.ok(one, tag + ": line 1: " + lines[0]);
      const three = lines[2].match(new RegExp("whoever holds it acts as (" + Q + "), so never post it\\.$"));
      assert.ok(three, tag + ": line 3: " + lines[2]);
      const found = [one[1], one[2], three[1]];
      for (const s of found) if (s !== undefined) assert.ok(!ESCAPED_SET.test(s), tag + ": a raw escapable character in " + JSON.stringify(s));
      assert.equal(found[0] === undefined ? null : JSON.parse(found[0]), first === null ? null : oneLine(first), tag + ": the inviter");
      assert.equal(JSON.parse(found[1]), oneLine(name), tag + ": the agent's name");
      assert.equal(JSON.parse(found[2]), oneLine(name), tag + ": the name on line 3");
    }
  }
  // an ordinary name and a ZWJ emoji print between the quotes as typed
  assert.ok(agentOnboarding(O, "lima", "\u{1F468}\u200d\u{1F469}\u200d\u{1F467} Fam", TOKEN).includes("as the agent \"\u{1F468}\u200d\u{1F469}\u200d\u{1F467} Fam\"."));
  assert.ok(agentOnboarding(O, "lima", "Scout", TOKEN, { invitedBy: "Anthony" }).startsWith("\"Anthony\" invited you to the Agent Chat room \"lima\" as the agent \"Scout\"."));
  assert.ok(agentNote(O, "lima", "Scout", TOKEN, "Anthony").startsWith("\"Anthony\" invited you to the Agent Chat room \"lima\" as the agent \"Scout\"."));
});
