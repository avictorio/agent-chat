// Helpers the game engines share: seats, clocks in words, data files, fuzzy answer matching (Trivia, Sketch & Guess).
export const dataLines = (txt) => String(txt).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

export const TV_NUMS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
// An answer folded for matching: case, accents, punctuation and articles
// dropped, number words as digits.
export function tvNorm(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "the" && w !== "a" && w !== "an")
    .map((w) => { const i = TV_NUMS.indexOf(w); return i >= 0 ? String(i) : w; })
    .join(" ");
}
// At most one letter added, dropped or changed.
export function tvNear(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// The lenient match: equal once folded, or one letter off in an answer of
// five letters or more.
export function tvMatch(given, keys) {
  const g = tvNorm(given);
  if (!g) return false;
  return keys.some((k) => {
    const n = tvNorm(k);
    return !!n && (g === n || (n.length >= 5 && tvNear(g, n)));
  });
}

/* ---------- game engines (groundwork, 2026-11-19) ----------
   Every game the Room plays is one entry here. The shared machinery -
   lobby and accept, clocks and the alarm, stream frames, room_state
   nudges, chat cards, result posts, cancel, standings - asks the match's
   engine instead of branching on its type; each game's own rules live in
   the Room methods its entry names. To add a game: write its create /
   move / advance / views, add an entry, then the docs section, the MCP
   descriptions and the web catalog (web/app/src/games/catalog.tsx).

   An entry:
     name, turnWord     how the game is named, and its clock step in logs
     logTick(st)        the current step number (tick, round, turn)
     clockSeconds(st)   the first deadline once the lobby fills
     create(room, creator, players, opts, roomName)    -> { status, game | error }
     summary(room, g) / full(room, g, who)             public and per-viewer state
     move(room, g, who, dir, roomName)                 -> { status, game | error, legal_moves? }
     advance(room, g, roomName)                        settle what the clock owes
     targets(pub)       who a running match waits on, from its summary
     card(g)            the light reference a match's chat card carries
     stateItem(r, st)   the match as room_state sees it: { id, type, status,
                        <turn field>, players: [{ name, alive, moved, accepted }] }
     turnOf(item)       that item's turn signature (a new value = a new decision)
     moveHint(item, me) the dir placeholder in an awaiting_you call
     result(room, g)    the Referee's result post
     rules(st)          how_to_play: this match's rules in a few lines, with
                        its settings - shown in every full state, so keep it
                        in step with the game's /api section and catalog
   Games on the simultaneous-rounds machinery (roundsCommit/roundsAdvance)
   add resolveRound(room, g) and standing(room, st). */
export const seatAccepted = (st, p) => (st.accepted ? !!st.accepted[p.name] : true);
// "90 s", "3 min", "1 h": a clock in words, for the rules texts.
export const clockWords = (sec) => (sec >= 3600 ? Math.round(sec / 3600) + " h" : sec >= 60 ? Math.round(sec / 60) + " min" : sec + " s");
