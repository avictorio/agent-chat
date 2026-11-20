// Unit tests for the Worker's pure game helpers (worker/games/): answer
// matching (Trivia, Sketch & Guess, Twenty Questions), the move-field
// parser, the engine table, boards and tallies the chat cards draw, image
// checks and the Letter Grid dictionary. The engines' Room methods are
// covered end to end by the API suite (tests/api.test.js).
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tvNorm, tvNear, tvMatch, clockWords, dataLines, seatAccepted } from "../../worker/games/shared.js";
import { GAME_ENGINES, GAME_ALIASES, gameEngine, moveFields } from "../../worker/games/engine.js";
import { c4BoardOf } from "../../worker/games/fourinarow.js";
import { room_ttTally } from "../../worker/games/twotruths.js";
import { sgDecodeImage, SG_IMAGE_MAX } from "../../worker/games/sketch.js";
import { tqNorm } from "../../worker/games/twenty.js";
import { lgDict, lgHasPrefix, lgLabel } from "../../worker/games/lettergrid.js";

test("tvNorm folds case, accents, punctuation, articles and number words", () => {
  assert.equal(tvNorm("The Eiffel Tower!"), "eiffel tower");
  assert.equal(tvNorm("Café  au   lait"), "cafe au lait");
  assert.equal(tvNorm("Seven wonders"), "7 wonders");
  assert.equal(tvNorm(null), "");
});

test("tvNear allows exactly one letter added, dropped or changed", () => {
  assert.equal(tvNear("lighthouse", "lighthouse"), true);
  assert.equal(tvNear("lighthouse", "lighthous"), true);
  assert.equal(tvNear("lighthouse", "lightbouse"), true);
  assert.equal(tvNear("lighthouse", "lighthousee"), true);
  assert.equal(tvNear("lighthouse", "ligthhouse"), false); // a swap is two changes
  assert.equal(tvNear("lighthouse", "light"), false);
});

test("tvMatch: equal once folded, or one letter off in answers of five letters or more", () => {
  assert.equal(tvMatch("eifel tower", ["Eiffel Tower"]), true);
  assert.equal(tvMatch("an eiffel tower", ["Eiffel Tower"]), true);
  assert.equal(tvMatch("car", ["cat"]), false); // short answers must be exact
  assert.equal(tvMatch("cat", ["Cat", "kitten"]), true);
  assert.equal(tvMatch("", ["cat"]), false);
  assert.equal(tvMatch("dog", ["", "cat"]), false);
});

test("clockWords, dataLines and seatAccepted", () => {
  assert.equal(clockWords(45), "45 s");
  assert.equal(clockWords(180), "3 min");
  assert.equal(clockWords(7200), "2 h");
  assert.deepEqual(dataLines("# a comment\n alpha \n\nbeta\n#x\n"), ["alpha", "beta"]);
  assert.equal(seatAccepted({}, { name: "Ada" }), true);
  assert.equal(seatAccepted({ accepted: { Ada: true } }, { name: "Ada" }), true);
  assert.equal(seatAccepted({ accepted: {} }, { name: "Ada" }), false);
});

test("the engine table: sixteen games, every alias resolves, old matches are Light Cycles", () => {
  assert.equal(Object.keys(GAME_ENGINES).length, 16);
  for (const [alias, key] of Object.entries(GAME_ALIASES)) assert.ok(GAME_ENGINES[key], alias + " -> " + key);
  assert.equal(gameEngine({ type: "duel" }), GAME_ENGINES.duel);
  assert.equal(gameEngine({}), GAME_ENGINES.lightcycles);
  assert.equal(gameEngine(null), GAME_ENGINES.lightcycles);
  for (const [key, e] of Object.entries(GAME_ENGINES)) {
    for (const fn of ["create", "summary", "full", "move", "rules"]) assert.equal(typeof e[fn], "function", key + "." + fn);
  }
});

test("moveFields keeps only the known move parts, capped", () => {
  assert.equal(moveFields(null), null);
  assert.equal(moveFields({ dir: "up", from: "Ada" }), null);
  const m = moveFields({ word: "x".repeat(99), path: ["A1", "B2"], wager: 0, junk: 1, statements: [1, 2, 3, 4, 5, 6] });
  assert.equal(m.word.length, 40);
  assert.deepEqual(m.path, ["A1", "B2"]);
  assert.equal(m.wager, 0);
  assert.equal(m.statements.length, 5);
  assert.equal("junk" in m, false);
  assert.deepEqual(moveFields({ accept: [null, "Paris", "x".repeat(200)] }).accept.map((a) => a.length), [0, 5, 120]);
});

test("c4BoardOf draws the rows top first: X the first seat, O the second", () => {
  const rows = c4BoardOf({ cols: [[0, 1], [0], [], [], [], [], [1]] });
  assert.equal(rows.length, 6);
  assert.equal(rows[5], "XX....O");
  assert.equal(rows[4], "O......");
  assert.equal(rows[0], ".......");
});

test("room_ttTally adds each round's points per player", () => {
  const st = { players: [{ name: "Ada" }, { name: "Rex" }, { name: "Poc" }], rounds: [{ points: { Ada: 2, Rex: 1 } }, { points: { Ada: 1 } }, {}] };
  assert.deepEqual(room_ttTally(st), { Ada: 3, Rex: 1, Poc: 0 });
});

test("sgDecodeImage trusts magic bytes, not labels, and caps the size", () => {
  const b64 = (bytes) => Buffer.from(bytes).toString("base64");
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
  assert.equal(sgDecodeImage("data:image/png;base64," + b64(png)).type, "image/png");
  assert.equal(sgDecodeImage(b64(png)).type, "image/png"); // bare base64
  assert.equal(sgDecodeImage("data:image/png;base64," + b64([0xff, 0xd8, 0xff, 0xe0])).type, "image/jpeg"); // the label is ignored
  assert.equal(sgDecodeImage(b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])).type, "image/webp");
  assert.match(sgDecodeImage(b64([0x3c, 0x73, 0x76, 0x67])).error, /PNG, JPEG, GIF or WebP/); // <svg
  assert.match(sgDecodeImage("not base64!").error, /data URL/);
  assert.match(sgDecodeImage("A".repeat(Math.ceil((SG_IMAGE_MAX * 4) / 3) + 100)).error, /up to/);
});

test("tqNorm names the same secret however it is written", () => {
  assert.equal(tqNorm("A Lighthouse!"), "lighthouse");
  assert.equal(tqNorm("the  BIG   red bus"), "big red bus");
});

test("Letter Grid: the dictionary is sorted for prefix search; cells are labelled A1 top left", () => {
  const { list, set } = lgDict();
  assert.ok(list.length > 1000, "dictionary loaded: " + list.length);
  assert.ok(list.every((w, i) => i === 0 || list[i - 1] <= w), "sorted");
  const word = list[Math.floor(list.length / 2)];
  assert.ok(set.has(word));
  assert.equal(lgHasPrefix(word.slice(0, 2)), true);
  assert.equal(lgHasPrefix("qqqqzzz"), false);
  assert.equal(lgLabel(0, 0), "A1");
  assert.equal(lgLabel(3, 2), "C4");
});
