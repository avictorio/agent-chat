// Seat colours (gameColors) against the colours the Werewolf and Trust
// arenas use to mean something. Seats 7 to 9 were first Werewolf's guard
// pick blue and its werewolf red, which is also Trust's "red = defected":
// the eighth player of a Trust was drawn as a defector under that caption.
// The meaning colours are read from the arenas' source, so this follows them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeRoom } from "./room-harness.mjs";

const src = (p) => readFileSync(new URL("../../web/app/src/features/games/" + p, import.meta.url), "utf8");
const hexes = (text) => (text.match(/#[0-9a-fA-F]{6}\b/g) || []).map((h) => h.toLowerCase());
/** the text from the line that starts with start up to the first line after it that starts with end */
const block = (text, start, end) => {
  const i = text.indexOf(start);
  assert.ok(i >= 0, "found " + start);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
};

function meaningColours() {
  const ww = src("werewolf/WerewolfArena3D.tsx");
  const tr = src("trust/TrustArena3D.tsx");
  const css = src("trust/trust.css");
  const out = {
    // the roles (and the villager), the night picks
    "werewolf roles": hexes(block(ww, "const VILLAGER", "const roleInfo")),
    "werewolf picks": hexes(block(ww, "const PICK_HEX", "\n")),
    // cooperate / betray in the scene, and the colours of C and D in the page
    "trust outcomes": hexes(["const TRUST", "const BETRAY", "const DIM_RED"].map((k) => block(tr, k, "\n")).join("")),
    "trust page": hexes(css.split("\n").filter((l) => /\.tr-(cap|pick\.|cell\.)/.test(l)).join("\n")),
  };
  for (const [k, v] of Object.entries(out)) assert.ok(v.length >= 2, k + " read from the source: " + v);
  return out;
}

const seats = () => makeRoom().room.gameColors();

test("no seat is drawn in a colour an arena uses for a role, a pick or an outcome", () => {
  const meaning = meaningColours();
  for (const { color, hex } of seats()) {
    for (const [what, list] of Object.entries(meaning)) assert.ok(!list.includes(hex.toLowerCase()), color + " " + hex + " is one of the " + what);
  }
});

// sRGB to CIELAB, for "how far apart do these look" (normal vision)
const lin = (c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const rgb = (h) => [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
function lab(h) {
  const [r, g, b] = rgb(h);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dist = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

test("every seat colour reads on the arenas' dark ground, each its own", () => {
  const kinds = src("shared/kinds.css");
  const grounds = [":root", ".kind-werewolf", ".kind-trust"].map((k) => hexes(block(kinds, k + " {", "\n")).pop());
  const cs = seats();
  assert.ok(cs.length >= 9, "as many as Werewolf seats");
  for (const { color, hex } of cs) {
    for (const g of grounds) assert.ok((lum(hex) + 0.05) / (lum(g) + 0.05) >= 7, color + " is at least 7:1 on " + g);
  }
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) assert.ok(dist(cs[i].hex, cs[j].hex) >= 15, cs[i].color + " and " + cs[j].color + " look apart");
  // the seats added for Werewolf's 7 to 9 and Trust's 7 and 8 are held
  // clear of every meaning colour, not only unequal to it (the first six
  // predate the rule: cyan sits near Trust's own teal accent). Near-white
  // label tints (the text on a chosen C or D button) carry no hue to
  // confuse, so the distance leaves them out; the equality test keeps them.
  const chroma = (h) => Math.hypot(lab(h)[1], lab(h)[2]);
  const meaning = Object.values(meaningColours()).flat().filter((m) => chroma(m) >= 20);
  for (const { color, hex } of cs.slice(6)) {
    for (const m of meaning) assert.ok(dist(hex, m) >= 20, color + " " + hex + " looks too like " + m);
  }
});
