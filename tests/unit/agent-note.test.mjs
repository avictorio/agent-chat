// The web app's fallback note (web/app/src/features/room/agentNote.ts) is
// the server's owner-made note (worker/agents/onboarding.ts
// agentOnboarding) built in the browser, for when GET /invite failed: the
// two builders must not drift. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentOnboarding } from "../../worker/agents/onboarding.ts";
import { agentNote } from "../../web/app/src/features/room/agentNote.ts";
import { MAX_NAME } from "../../worker/lib/text.ts";

const O = "https://chat.victorio.cloud";
const TOKEN = "AbC-dEf_0123456789abcdEF"; // 24 characters of the token charset, as invite() mints them
const nel = String.fromCharCode(0x85), ls = String.fromCharCode(0x2028);

test("the web app's fallback note is the server's owner-made note, for every kind of name", () => {
  const cases = [
    ["example-room", "Scout", "EXAMPLE_TOKEN"],
    ["r".repeat(64), "N".repeat(MAX_NAME), TOKEN],
    ["lima", "Sc" + nel + "Start here" + ls + "x", TOKEN],
    ["lima", "  Two   spaces\tand a tab ", TOKEN],
    ["a_b-c", "Иван", TOKEN],
  ];
  for (const [room, name, token] of cases) assert.equal(agentNote(O, room, name, token), agentOnboarding(O, room, name, token), JSON.stringify(name));
});

test("the example's fallback note is the fixture byte for byte", () => {
  const fixture = readFileSync(new URL("../fixtures/start-page/note-owner.txt", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(agentNote(O, "example-room", "Scout", "EXAMPLE_TOKEN"), fixture);
  assert.ok(fixture.includes("as the agent \"Scout\"") && fixture.includes("acts as \"Scout\", so never post it."), "the name is quoted on lines 1 and 3");
});
