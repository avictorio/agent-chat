// The Agent keys view checks the agent's name in the browser
// (web/app/src/features/home/agentName.ts) as the server checks a new
// member's name (worker/lib/text.ts cleanName and memberNameProblem, and the
// "Referee" rule of the members route and POST /api/agents/invite): the
// same name kept, and the same sentence for each refusal. And the served
// texts a person's key comes with ask for no User-Agent and put no token
// in a URL. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_NAME_MAX, agentNameProblem, cleanAgentName } from "../../web/app/src/features/home/agentName.ts";
import { MAX_NAME, cleanName, memberNameProblem, nameFold } from "../../worker/lib/text.ts";
import { dropNote, personKeyClaudeCode, personKeyHandoff, personKeyNote, unusedNote } from "../../worker/agents/onboarding.ts";
import { HOSTILE_NAMES } from "./start-views.mjs";

const REFEREE = "\"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member.";

test("the view keeps a name as the server stores it, and refuses it with the server's sentence", () => {
  assert.equal(AGENT_NAME_MAX, MAX_NAME);
  const names = [
    "Scout", "  Scout  ", "Two   spaces\tand a tab", "N".repeat(MAX_NAME + 5), "😀".repeat(30), "Zoë", "Ζωή", "ｆｕｌｌ", "émile", "`",
    "a<b", "a>b", "a\"b", "a'b", "a&b", "a`b", "a\u0007b", "a\u007fb", "a,b", "a:b", "\ud800x", "a�b",
    "toString", "__proto__", "constructor", "HASOWNPROPERTY", "Referee", "REFEREE", "ｒｅｆｅｒｅｅ", "", "   ",
    ...HOSTILE_NAMES,
  ];
  for (const raw of names) {
    const server = cleanName(raw), view = cleanAgentName(raw);
    assert.equal(view, server, JSON.stringify(raw) + ": the same name kept");
    const want = !server ? "Give the agent a name." : memberNameProblem(server) || (nameFold(server) === "referee" ? REFEREE : null);
    assert.equal(agentNameProblem(view), want, JSON.stringify(raw));
  }
});

test("the texts a person's key comes with ask for no User-Agent and put no token in a URL", () => {
  const texts = [personKeyNote(false), personKeyNote(true), personKeyClaudeCode("https://chat.victorio.cloud/api/mcp"), personKeyHandoff("https://chat.victorio.cloud", ["lima", "oslo"]), unusedNote(["lima"]), unusedNote(["lima", "oslo"]), dropNote([]), dropNote(["lima"]), dropNote(null)];
  for (const t of texts) {
    assert.ok(!/user[- ]?agent/i.test(t), t.slice(0, 60));
    assert.ok(!/[?&]invite=|#invite=/.test(t), t.slice(0, 60));
  }
  // the key goes where KEY is, once, in each text the view fills in
  assert.equal(personKeyClaudeCode("https://x/api/mcp").split("Bearer KEY").length, 2);
  assert.equal(personKeyHandoff("https://x", ["a"]).split("Bearer KEY").length, 2);
  // Muse's hand-off: a custom connector and its API Key box, never the chat
  assert.ok(personKeyHandoff("https://x", ["a"]).includes("custom connector") && personKeyHandoff("https://x", ["a"]).includes("\"API Key\" box it shows, never into the chat"));
  // the disconnect's note says the wakes are off only when none is left
  assert.ok(dropNote([]).includes("the Muse wakes it set up are off"));
  for (const left of [["lima"], null]) assert.ok(!dropNote(left).includes("are off"), JSON.stringify(left));
});
