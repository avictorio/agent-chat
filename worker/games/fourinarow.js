// Four in a Row: connect four on a 7x6 board, with a ladder.
// Four in a Row: the classic board.

import { clockWords, seatAccepted } from "./shared.js";

export const C4_COLS = 7;
export const C4_ROWS = 6;

// Four in a Row's board rows, top first: X for the first seat, O for the
// second, . for empty (the chat card needs it without a Room to hand).
export function c4BoardOf(st) {
  const rows = [];
  for (let r = C4_ROWS - 1; r >= 0; r--) {
    let line = "";
    for (let c = 0; c < C4_COLS; c++) {
      const v = ((st.cols || [])[c] || [])[r];
      line += v === undefined ? "." : v === 0 ? "X" : "O";
    }
    rows.push(line);
  }
  return rows;
}

export const FourInARowMethods = {
  /* ---------- games: Four in a Row (2026-11-19) ----------
     SHA's spec, on the turn-order helper: two players, a 7x6 board, a
     disc dropped into a column falls to the lowest free cell; four of
     yours in a line - across, up or diagonal - wins, a full board is a
     draw. Who moves first is drawn at creation. dir is the column, 1-7
     (left to right). A turn waits turn_seconds (default an hour); an
     expired turn passes, the third forfeits, 20 passes draw. The Referee
     posts only the result; the board lives in the card and the arena. */
  c4Board(st) {
    return c4BoardOf(st);
  },

  // The four (or more) in a line through (c, r), as [[col, row], ...]
  // 1-based (column 1 = left, row 1 = bottom), or null.
  c4Line(st, c, r) {
    const me = st.cols[c][r];
    const at = (x, y) => (x >= 0 && x < C4_COLS && y >= 0 && y < C4_ROWS ? st.cols[x][y] : undefined);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const cells = [[c, r]];
      for (const s of [1, -1]) {
        let x = c + s * dx, y = r + s * dy;
        while (at(x, y) === me) { cells.push([x, y]); x += s * dx; y += s * dy; }
      }
      if (cells.length >= 4) return cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([x, y]) => [x + 1, y + 1]);
    }
    return null;
  },

  c4Open(st) {
    const out = [];
    for (let c = 0; c < C4_COLS; c++) if (st.cols[c].length < C4_ROWS) out.push(String(c + 1));
    return out;
  },

  c4Summary(g) {
    const st = g.st;
    return {
      id: g.id, type: "fourinarow", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      turn: st.turn, turn_of: g.status === "running" ? st.turn_of : null, turn_seconds: st.turn_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      cols: C4_COLS, rows: C4_ROWS, board: this.c4Board(st), first: st.order[0],
      last_move: st.moves.length ? st.moves[st.moves.length - 1] : null, line: st.line || null,
      winner: st.winner || null, draw: !!st.draw, forfeit: st.forfeit || null, declined_by: st.declined_by || null,
      players: st.players.map((p, i) => ({ name: p.name, color: p.color, hex: p.hex, piece: i === 0 ? "X" : "O", accepted: st.accepted ? !!st.accepted[p.name] : true, timeouts: (st.timeouts || {})[p.name] || 0 })),
    };
  },

  c4StateFull(g, who) {
    const out = this.c4Summary(g);
    const st = g.st;
    out.moves = st.moves;
    out.log = st.log.slice(-24);
    out.awaiting = g.status === "running" && st.turn_of ? [st.turn_of] : [];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const i = st.players.findIndex((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    const mine = i >= 0 && g.status === "running" && st.turn_of === st.players[i].name;
    out.you = i >= 0
      ? { playing: true, accepted: st.accepted ? !!st.accepted[st.players[i].name] : true, piece: i === 0 ? "X" : "O", your_turn: mine, timeouts: (st.timeouts || {})[st.players[i].name] || 0, legal_moves: mine ? this.c4Open(st) : [] }
      : { playing: false };
    return out;
  },

  async createFourInARow(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length !== 2) return { status: 400, error: "Four in a Row needs exactly 2 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    // who moves first is drawn now; the first seat plays X
    const names = Math.random() < 0.5 ? resolved.names : resolved.names.slice().reverse();
    let turnSeconds = Math.floor(Number(opts.tick_seconds) || 0);
    if (!turnSeconds) turnSeconds = 3600;
    turnSeconds = Math.min(86400, Math.max(30, turnSeconds));
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const st = {
      type: "fourinarow", turn_seconds: turnSeconds, turn: 1, order: names.slice(), turn_of: names[0],
      cols: Array.from({ length: C4_COLS }, () => []), moves: [], line: null, timeouts: {}, passes: 0, pass_limit: 20,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players,
      log: [{ tick: 0, text: "Four in a Row created by " + creator + " - " + names.join(" vs ") + "; " + names[0] + " moves first. The clock starts when both players accept." }],
      winner: null, draw: false, forfeit: null, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(" vs ");
    const cardText = "Four in a Row match #" + g.id + " - " + label + ". Drop discs on a 7x6 board; four in a line wins. " + names[0] + " moves first. Turn clock: " + clockWords(turnSeconds) + ". Lobby open - the match starts when both players accept; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.c4StateFull(g, creator) };
  },

  async c4Move(g, who, raw, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (st.turn_of !== me.name) return { status: 409, error: "It's " + st.turn_of + "'s turn" };
    const s = String(raw || "").trim().toLowerCase().replace(/^(drop|col(umn)?)\s*:?\s*/, "");
    let c = /^[1-7]$/.test(s) ? Number(s) - 1 : /^[a-g]$/.test(s) ? s.charCodeAt(0) - 97 : -1;
    if (c < 0) return { status: 400, error: "dir is a column, 1 to 7 from the left", legal_moves: this.c4Open(st) };
    if (st.cols[c].length >= C4_ROWS) return { status: 400, error: "Column " + (c + 1) + " is full", legal_moves: this.c4Open(st) };
    const seat = st.players.indexOf(me);
    st.cols[c].push(seat);
    const r = st.cols[c].length - 1;
    const at = Date.now();
    st.moves.push({ n: st.moves.length + 1, by: me.name, col: c + 1, row: r + 1, at: at });
    const line = this.c4Line(st, c, r);
    if (line) {
      g.status = "finished";
      st.winner = me.name;
      st.line = line;
      st.log.push({ tick: st.turn, text: me.name + " drops in column " + (c + 1) + " and connects four." });
    } else if (st.cols.every((col) => col.length >= C4_ROWS)) {
      g.status = "finished";
      st.winner = null;
      st.draw = true;
      st.log.push({ tick: st.turn, text: "The board is full - a draw." });
    } else {
      st.log.push({ tick: st.turn, text: me.name + " drops in column " + (c + 1) + "." });
      this.turnsNext(g);
    }
    this.saveGame(g);
    this.afterGameChange(g, room, me.name);
    await this.armGameAlarm();
    return { status: 200, game: this.c4StateFull(g, who), resolved: true };
  },

  c4ResultText(g) {
    const st = g.st;
    const [a, b] = st.players;
    const n = st.moves.length;
    if (st.draw) return "Four in a Row match #" + g.id + " is over - a draw between " + a.name + " and " + b.name + (st.cols.every((col) => col.length >= C4_ROWS) ? ": the board filled with no four in a line." : ": " + st.passes + " turns passed on the clock.") + " Moves: " + n + ".";
    if (st.forfeit) return "Four in a Row match #" + g.id + " is over - " + st.winner + " wins by forfeit: " + st.forfeit + " timed out three times. Moves: " + n + ".";
    const line = st.line || [];
    const dir = line.length >= 2 ? (line[0][1] === line[1][1] ? "across" : line[0][0] === line[1][0] ? "up a column" : "on a diagonal") : "in a line";
    return "Four in a Row match #" + g.id + " is over - " + st.winner + " connects four " + dir + " on move " + n + ", beating " + (st.winner === a.name ? b.name : a.name) + ".";
  },
};

export const fourinarowEngine = {
  name: "Four in a Row",
  turnWord: "turn",
  logTick: (st) => st.turn,
  clockSeconds: (st) => st.turn_seconds,
  create: (room, creator, players, opts, roomName) => room.createFourInARow(creator, players, opts, roomName),
  summary: (room, g) => room.c4Summary(g),
  full: (room, g, who) => room.c4StateFull(g, who),
  move: (room, g, who, dir, roomName) => room.c4Move(g, who, dir, roomName),
  advance: (room, g, roomName) => room.turnsAdvance(g, roomName),
  targets: (pub) => (pub.status === "running" && pub.turn_of ? [pub.turn_of] : []),
  card: (g) => ({ id: g.id, type: "fourinarow", status: g.status, turn: g.st.turn, turn_of: g.status === "running" ? g.st.turn_of : null, winner: g.st.winner || null, draw: !!g.st.draw, board: c4BoardOf(g.st), players: g.st.players.map((p, i) => ({ name: p.name, color: p.color, hex: p.hex, piece: i === 0 ? "X" : "O" })) }),
  stateItem: (r, st) => ({ id: r.id, type: "fourinarow", status: r.status, turn: st.turn, players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: r.status !== "running" || st.turn_of !== p.name, accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => gm.turn,
  moveHint: () => "<a column, 1-7 from the left>",
  result: (room, g) => room.c4ResultText(g),
  rules: (st) =>
    "Four in a Row: two players take turns dropping a disc into one of 7 columns; it falls to the lowest free cell of the 6 rows. Four of your discs in a line - across, up a column or on a diagonal - wins; a full board is a draw. " +
    st.order[0] + " moves first and plays X (board rows are listed top first: X, O or . for empty). Each turn has " + clockWords(st.turn_seconds || 3600) + "; a turn that runs out is a pass, the third timeout forfeits the match, and " + (st.pass_limit || 20) + " passes in all make it a draw. Send dir as the column number, 1 to 7 from the left; you.legal_moves lists the columns with room.",
};
