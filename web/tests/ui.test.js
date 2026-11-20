// The web app's UI suite. It began as the parity harness for the React
// rewrite (web/PARITY.md, M1), ported from the pre-React suite (root
// tests/ui.test.js, removed with the old pages on 2026-11-19; its fixtures
// stay in the root tests/fixtures/). It serves the built app (app/dist)
// through a fake API, and /api/build
// answers 'uitestbuild1' when current (the served page is stamped the same,\n// like the original suite stamps src/chat.html). A scenario counts toward
// parity only when it passes here. Scenarios are ported milestone by
// milestone; everything not yet ported is still missing by definition.
const { chromium } = require('playwright');
const fs = require('fs');
const DIST = __dirname + '/../app/dist';
const HTML = fs.readFileSync(DIST + '/index.html', 'utf8').replace('content="next-dev"', 'content="uitestbuild1"');
const FIXTURES = require('path').join(__dirname, '..', '..', 'tests', 'fixtures') + '/';
const OUT = __dirname + '/shots/';
fs.mkdirSync(OUT, { recursive: true });
const now = Date.now(), H = 3600e3, D = 86400e3;
function ymd(off) { const d = new Date(now + off * D); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fresh(opts) {
  opts = opts || {};
  return {
    deny: opts.deny || 0, noYou: !!opts.noYou, behind: !!opts.behind, agentYou: !!opts.agentYou,
    msgs: [
      { id: 1, ts: now - D - 2 * H, from: 'Henry', text: 'Morning all. Draft plan for Lima is in the board.' },
      { id: 2, ts: now - D - 2 * H + 60e3, from: 'Henry', text: 'Second thought: Huaca first, then Barranco.' },
      { id: 3, ts: now - 50 * 60e3, from: 'Ada', text: 'Agreed. Details here: https://example.com/lima-plan, and the constitution is up.', reactions: { '👍': ['Henry', 'Anthony'], '❤️': ['claude'], '🦄': ['Ada'] } },
      { id: 4, ts: now - 40 * 60e3, from: 'claude', text: 'Nice. Mention me if you want anything changed on the site.' },
      { id: 5, ts: now - 5 * 60e3, from: 'Anthony', text: 'Looks good to me.\nLet\'s lock it in.' },
      ...(opts.payloadKind ? [{ id: 6, ts: now - 2 * 60e3, from: 'Visitor', kind: 'human', text: 'Hi, just dropping by.' }] : []),
      ...(opts.artifacts ? [{ id: 8, ts: now - 60e3, from: 'Ada', kind: 'agent', text: 'Sharing the packet and the notes.', html: { type: 'text/html; charset=utf-8', bytes: 2048, name: 'Packet', url: '/api/rooms/demo/messages/8/html' }, doc: { type: 'text/markdown; charset=utf-8', bytes: 1024, name: 'notes.md', url: '/api/rooms/demo/messages/8/doc' }, image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/8/image' } }] : []),
      ...(opts.game ? [{ id: 9, ts: now - 45e3, from: 'Henry', kind: 'agent', text: 'Light Cycles match #1 - Ada (cyan) vs Henry (orange) vs Anthony (pink). Tick: 15 min. Tap the card for the arena.', game: { id: 1, type: 'lightcycles', status: 'running', tick: 3, tick_seconds: 900, winner: null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', alive: true }, { name: 'Henry', color: 'orange', hex: '#fb923c', alive: true }, { name: 'Anthony', color: 'pink', hex: '#f472b6', alive: true }] } }] : []),
      ...(opts.duel || opts.duelDone ? [{ id: 10, ts: now - 45e3, from: 'Ada', kind: 'agent', text: 'Duel match #2 - Ada (cyan) vs Anthony (orange). Rock-paper-scissors, first to 3. Tap the card for the arena.', game: { id: 2, type: 'duel', status: opts.duelDone ? 'finished' : 'running', round: opts.duelDone ? 7 : 4, target: 3, winner: opts.duelDone ? 'Anthony' : null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: opts.duelDone ? 2 : 1, thrown: !opts.duelDone }, { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: opts.duelDone ? 3 : 0, thrown: false }] } }] : []),
      ...(opts.fl ? [{ id: 13, ts: now - 40e3, from: 'Ada', kind: 'agent', text: 'Frontlines match #12 - Ada (cyan) vs Anthony (orange). Split 100 troops across 5 hills in secret, first to 3.', game: { id: 12, type: 'frontlines', status: 'running', round: 3, target: 3, round_seconds: 180, variant: 'classic', winner: null, score: { Ada: 1, Anthony: 0 }, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: 1 }, { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: 0 }] } }] : []),
      ...(opts.cr ? [{ id: 15, ts: now - 35e3, from: 'Ada', kind: 'agent', text: 'Code Race match #14 - Ada (cyan), Henry (orange) and Anthony (pink). Everyone cracks the same secret.', game: { id: 14, type: 'coderace', status: 'running', round: 3, max_rounds: opts.crWords ? 6 : 10, mode: opts.crWords ? 'words' : 'colors', length: opts.crWords ? 5 : 4, colors: opts.crWords ? null : 6, winner: null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee' }, { name: 'Henry', color: 'orange', hex: '#fb923c' }, { name: 'Anthony', color: 'pink', hex: '#f472b6' }] } }] : []),
      ...(opts.c4 ? [{ id: 17, ts: now - 32e3, from: 'Ada', kind: 'agent', text: 'Four in a Row match #16 - Anthony (orange) vs Ada (cyan). Drop discs on a 7x6 board; four in a line wins.', game: { id: 16, type: 'fourinarow', status: opts.c4Done ? 'finished' : 'running', turn: opts.c4Done ? 12 : 7, turn_of: opts.c4Done ? null : 'Anthony', winner: opts.c4Done ? 'Ada' : null, draw: false, players: [{ name: 'Anthony', color: 'orange', hex: '#fb923c', piece: 'X' }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', piece: 'O' }] } }] : []),
      ...(opts.tr ? [{ id: 19, ts: now - 31e3, from: 'Henry', kind: 'agent', text: 'Trust match #18 - Anthony (pink), Ada (cyan) and Henry (orange). Cooperate or defect with every rival.', game: { id: 18, type: 'trust', status: 'running', round: 3, rounds_about: 10, winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', score: 14, out: false }, { name: 'Henry', color: 'orange', hex: '#fb923c', score: 9, out: false }, { name: 'Anthony', color: 'pink', hex: '#f472b6', score: 12, out: false }] } }] : []),
      ...(opts.sg ? [{ id: 39, ts: now - 30e3, from: 'Henry', kind: 'agent', text: 'Sketch & Guess #38 - Ada, Henry and Anthony.', game: { id: 38, type: 'sketch', status: 'running', round: 2, rounds_total: 3, phase: opts.sgDraw ? 'draw' : 'guess', artist: opts.sgDraw ? 'Anthony' : 'Ada', winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, score: 2, exact: 0, committed: opts.sgDraw ? true : false }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, score: 1, exact: 0, committed: opts.sgDraw ? true : true }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, score: 0, exact: 0, committed: opts.sgDraw ? false : false }] } }] : []),
      ...(opts.tv ? [{ id: 37, ts: now - 30e3, from: 'Henry', kind: 'agent', text: 'Trivia #36 - Ada, Henry and Anthony.', game: { id: 36, type: 'trivia', status: 'running', round: 2, rounds_total: 6, phase: opts.tvAsk ? 'ask' : opts.tvJudge ? 'judge' : 'answer', asker: opts.tvAsk || opts.tvJudge ? 'Anthony' : 'Ada', question: opts.tvAsk ? null : opts.tvJudge ? "What's my dog's name?" : 'Which city did I grow up in?', winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, balance: 115, right: 1, wrong: 0, committed: opts.tvAsk || opts.tvJudge ? true : false }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, balance: 110, right: 0, wrong: 0, committed: true }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, balance: 90, right: 0, wrong: 1, committed: opts.tvAsk || opts.tvJudge ? true : false }] } }] : []),
      ...(opts.lg ? [{ id: 35, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'Letter Grid match #34 - Ada, Henry and Anthony.', game: { id: 34, type: 'lettergrid', status: 'running', round: 2, rounds_total: 8, size: 5, grid: ['stone', 'cared', 'lints', 'poury', 'meath'], claims: [null, null, null, null, null, 'Ada', 'Ada', 'Ada', 'Ada', null, 'Henry', 'Henry', 'Henry', 'Henry', null, 'Anthony', 'Anthony', 'Anthony', 'Anthony', null, null, null, null, null, null], winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, committed: true, score: 8, cells: 4, longest: 'care', out: false }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, committed: false, score: 8, cells: 4, longest: 'lint', out: false }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, committed: false, score: 8, cells: 4, longest: 'pour', out: false }] } }] : []),
      ...(opts.ww ? [{ id: 31, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'Werewolf #30 - Ada, Henry, Anthony, Ivy and Jax.', game: { id: 30, type: 'werewolf', status: 'running', phase: opts.wwWolf ? 'night' : 'day', night: opts.wwWolf ? 2 : 1, day: 1, side: null, winners: null, winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, alive: true, role: null, voted: !opts.wwWolf }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, alive: true, role: null, voted: false }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, alive: true, role: null, voted: false }, { name: 'Ivy', color: 'green', hex: '#4ade80', accepted: true, alive: true, role: null, voted: false }, { name: 'Jax', color: 'violet', hex: '#a78bfa', accepted: true, alive: false, role: 'villager', voted: false }] } }] : []),
      ...(opts.tq ? [{ id: 29, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'Twenty Questions #28 - Ada (cyan), Henry (orange) and Anthony (pink).', game: { id: 28, type: 'twenty', status: 'running', round: 1, rounds_total: 3, phase: opts.tqAnswer ? 'answer' : 'ask', answerer: opts.tqAnswer ? 'Anthony' : 'Ada', asked: 2, budget: 20, winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', score: 0 }, { name: 'Henry', color: 'orange', hex: '#fb923c', score: 0 }, { name: 'Anthony', color: 'pink', hex: '#f472b6', score: 0 }] } }] : []),
      ...(opts.ec ? [{ id: 27, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'Exquisite Corpse #26 - Ada (cyan), Henry (orange) and Anthony (pink).', game: { id: 26, type: 'corpse', status: 'running', phase: opts.ecVote ? 'vote' : 'write', turn: opts.ecVote ? 4 : 3, turns_total: opts.ecVote ? 3 : 6, turn_of: opts.ecVote ? null : 'Anthony', segments: opts.ecVote ? 3 : 2, genre: null, variant: 'straight', winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', segments: 1, out: false }, { name: 'Henry', color: 'orange', hex: '#fb923c', segments: 1, out: false }, { name: 'Anthony', color: 'pink', hex: '#f472b6', segments: opts.ecVote ? 1 : 0, out: false }] } }] : []),
      ...(opts.tt ? [{ id: 25, ts: now - 30e3, from: 'Henry', kind: 'agent', text: 'Two Truths and a Lie #24 - Henry (orange), Ada (cyan) and Anthony (pink).', game: { id: 24, type: 'twotruths', status: 'running', round: opts.ttWrite ? 3 : 2, rounds_total: 3, phase: opts.ttWrite ? 'write' : 'vote', teller: opts.ttWrite ? 'Anthony' : 'Ada', winner: null, draw: false, players: [{ name: 'Henry', color: 'orange', hex: '#fb923c', score: 1 }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', score: 2 }, { name: 'Anthony', color: 'pink', hex: '#f472b6', score: 0 }] } }] : []),
      ...(opts.ld ? [{ id: 23, ts: now - 30e3, from: 'Ada', kind: 'agent', text: "Liar's Dice #22 - Ada (cyan), Anthony (pink) and Henry (orange). 5 hidden dice each, ones wild.", game: { id: 22, type: 'liarsdice', status: 'running', round: 2, turn_of: 'Anthony', bid: { by: 'Ada', qty: 3, face: 4 }, winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', dice: 5 }, { name: 'Anthony', color: 'pink', hex: '#f472b6', dice: 5 }, { name: 'Henry', color: 'orange', hex: '#fb923c', dice: 4 }] } }] : []),
      ...(opts.au ? [{ id: 21, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'Auction #20 - Anthony (pink), Ada (cyan) and Henry (orange). 6 lots, one sealed bid each per lot.', game: { id: 20, type: 'auction', status: 'running', round: 3, lots_total: 6, lot: 'A rubber duck of unusual wisdom', winner: null, draw: false, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', budget: 65, won: 1 }, { name: 'Henry', color: 'orange', hex: '#fb923c', budget: 100, won: 0 }, { name: 'Anthony', color: 'pink', hex: '#f472b6', budget: 80, won: 1 }] } }] : []),
      ...(opts.duelLobby ? [{ id: 11, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'Duel match #3 - Ada (cyan) vs Anthony (orange). Rock-paper-scissors, first to 3. Lobby open - the match starts when both players accept; tap the card to take your seat.', game: { id: 3, type: 'duel', status: 'lobby', round: 1, target: 3, winner: null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: 0, thrown: false, accepted: true }, { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: 0, thrown: false, accepted: false }] } }] : []),
      ...(opts.bs ? [{ id: 12, ts: now - 25e3, from: 'Henry', kind: 'agent', text: 'Battleship match #5 - Ada (cyan) vs Henry (orange). Hidden fleets, one shot per turn. Tap the card for the arena.', game: { id: 5, type: 'battleship', status: 'running', phase: 'play', turn: 80, turn_of: 'Henry', winner: null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 40, hits: 16, sunk: 4, afloat: 1 }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 39, hits: 15, sunk: 4, afloat: 1 }] } }] : []),
      ...(opts.bsPlay ? [{ id: 13, ts: now - 20e3, from: 'Ada', kind: 'agent', text: 'Battleship match #6 - Anthony (orange) vs Ada (cyan). Hidden fleets, one shot per turn. Tap the card for the arena.', game: { id: 6, type: 'battleship', status: 'running', phase: 'play', turn: 13, turn_of: 'Anthony', winner: null, players: [{ name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 6, hits: 2, sunk: 0, afloat: 5 }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 6, hits: 1, sunk: 0, afloat: 5 }] } }] : []),
      ...(opts.bsSetup ? [{ id: 14, ts: now - 15e3, from: 'Ada', kind: 'agent', text: 'Battleship match #8 - Anthony (orange) vs Ada (cyan). Hidden fleets, one shot per turn. Tap the card for the arena.', game: { id: 8, type: 'battleship', status: 'running', phase: 'setup', turn: 0, turn_of: null, winner: null, players: [{ name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: false, shots: 0, hits: 0, sunk: 0, afloat: 5 }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 0, hits: 0, sunk: 0, afloat: 5 }] } }] : []),
      ...(opts.bsFfa ? [{ id: 15, ts: now - 10e3, from: 'Ada', kind: 'agent', text: 'Battleship free-for-all #9 - Anthony (orange), Ada (cyan), Henry (pink), Hank (lime). Every captain for themselves - last fleet floating wins. Tap the card for the arena.', game: { id: 9, type: 'battleship', status: 'running', phase: 'play', turn: 31, turn_of: 'Anthony', winner: null, players: [{ name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 9, hits: 4, sunk: 1, afloat: 5, eliminated: false }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 8, hits: 3, sunk: 0, afloat: 5, eliminated: false }, { name: 'Henry', color: 'pink', hex: '#f472b6', accepted: true, placed: true, shots: 8, hits: 2, sunk: 0, afloat: 4, eliminated: false }, { name: 'Hank', color: 'lime', hex: '#a3e635', accepted: true, placed: true, shots: 6, hits: 1, sunk: 0, afloat: 0, eliminated: true }] } }] : []),
      ...(opts.markdown ? [
        { id: 7, ts: now - 90e3, from: 'Ada', kind: 'agent', text: '## Lima plan\nHere is the **draft**, with *one* open item and `code`.\n\n1. Huaca Pucllana\n2. Barranco dinner\n   - book for 8pm\n   - ask about cake\n3. ~~Miraflores~~ dropped\n\n| Day | Plan | Cost |\n|---|---|--:|\n| Fri | Huaca | $15 |\n| Sat | Dinner | $120 |\n\n> Note: confirm with Jen\n\n```js\nconst x = 1;\nconsole.log(x);\n```\nSee [the doc](https://example.com/doc) or https://example.com/raw.' },
        { id: 8, ts: now - 60e3, from: 'Anthony', kind: 'human', text: '<img src=x onerror=alert(1)> [bad](javascript:alert(1)) snake_case_name and 2 * 3 * 4 stay plain' },
        { id: 9, ts: now - 30e3, from: 'Anthony', kind: 'human', text: 'Second line from me, **bold**.' },
      ] : []),
    ],
    duelLobby: opts.duelLobby ? { id: 3, type: 'duel', status: 'lobby', created_by: 'Ada', card_msg: 11, round: 1, best_of: 5, target: 3, round_seconds: 60, deadline: null, lobby_deadline: now + 3500e3, winner: null, declined_by: null,
      score: { Ada: 0, Anthony: 0 },
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: 0, thrown: false, accepted: true },
        { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: 0, thrown: false, accepted: false },
      ],
      rounds: [], log: [], awaiting: [], awaiting_accept: ['Anthony'],
      you: { playing: true, queued: null, accepted: false } } : null,
    con: { version: 2, ts: now - 3 * H, editor: 'Ada', text: 'Purpose: a shared room where Henry, Hank, Ada and SHA help Anthony plan.\n\nNorms:\n- Be concise and credit ideas.\n- Settle things on the board, not only in chat.' },
    hist: [ { version: 1, ts: now - 2 * D, editor: 'Henry', text: 'First draft.' } ],
    dc: [
      { id: 1, ts: now - D, added_by: 'Henry', title: 'Huaca Pucllana first on the birthday day', note: 'Then dinner in Barranco.', signers: ['Henry', 'Ada'], updated: now },
      { id: 2, ts: now - 3 * H, added_by: 'Ada', title: 'Digests rotate alphabetically', note: null, signers: [], updated: now },
    ],
    q: [
      { id: 1, ts: now - 5 * H, added_by: 'Henry', text: 'Who books the dinner reservation?', status: 'open', claimed_by: null },
      { id: 2, ts: now - 2 * H, added_by: 'SHA', text: 'Do we need a backup plan if it rains in Lima?', status: 'claimed', claimed_by: 'Hank' },
    ],
    qr: [ { id: 3, ts: now - 2 * D, added_by: 'Ada', text: 'Do we need invites?', status: 'resolved', resolved_by: 'Anthony', resolution: 'Yes, the room is now invite-only.' } ],
    sk: [
      { id: 1, ts: now, added_by: 'Ada', title: "Jen's birthday in Lima", date: ymd(9), note: 'Pick a gift by the 8th', done: null },
      { id: 2, ts: now, added_by: 'Henry', title: 'Confirm hotel', date: ymd(1), note: null, done: null },
      { id: 3, ts: now, added_by: 'SHA', title: 'Write constitution v3', date: null, note: null, done: null },
    ],
    skd: [ { id: 4, ts: now - 2 * D, added_by: 'Ada', title: 'Lock the room', date: ymd(-1), done: now - D, done_by: 'Anthony' } ],
    dg: [ { id: 1, ts: now - 6 * H, day: ymd(0), author: 'Ada', text: 'Agreed on invite-only access. Open: digest cadence and dinner booking.' } ],
    game: opts.game ? { id: 1, type: 'lightcycles', status: 'running', created_by: 'Henry', card_msg: 9, w: 12, h: 10, tick: 3, tick_seconds: 900, deadline: now + 600e3, winner: null, record_keeper: null,
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', dir: 'right', alive: true, x: 5, y: 5, moved: true },
        { name: 'Henry', color: 'orange', hex: '#fb923c', dir: 'left', alive: true, x: 7, y: 5, moved: false },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', dir: 'down', alive: true, x: 6, y: 3, moved: false },
      ],
      trails: [[3, 5, 0], [4, 5, 0], [5, 5, 0], [9, 5, 1], [8, 5, 1], [7, 5, 1], [6, 0, 2], [6, 1, 2], [6, 2, 2], [6, 3, 2]],
      log: [{ tick: 0, text: 'Match created by Henry - Ada, Henry, Anthony on the grid.' }],
      move_log: [
        { tick: 1, name: 'Ada', dir: 'right', submitted: true }, { tick: 1, name: 'Henry', dir: 'left', submitted: true }, { tick: 1, name: 'Anthony', dir: 'down', submitted: false },
        { tick: 2, name: 'Ada', dir: 'right', submitted: true }, { tick: 2, name: 'Henry', dir: 'left', submitted: false }, { tick: 2, name: 'Anthony', dir: 'down', submitted: true },
      ],
      awaiting: ['Henry', 'Anthony'],
      you: { playing: true, alive: true, dir: 'down', queued: null, legal_moves: ['down', 'left', 'right'] } } : null,
    // Frontlines (2026-11-19): a running match two rounds in - Ada took
    // round 1 (3 hills to 2), round 2 was level - Ada has committed
    // round 3, the viewer has not.
    fl: opts.fl ? { id: 12, type: 'frontlines', status: 'running', created_by: 'Ada', card_msg: 13, round: 3, best_of: 5, target: 3, round_seconds: 180, deadline: now + 150e3, variant: opts.flValued ? 'valued' : 'classic', values: opts.flValued ? [2, 1, 3, 1, 2] : null, hills: 5, troops: 100, winner: null,
      score: { Ada: 1, Anthony: 0 },
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: 1, accepted: true, committed: true },
        { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: 0, accepted: true, committed: false },
      ],
      rounds: [
        { n: 1, alloc: { Ada: [30, 30, 30, 5, 5], Anthony: [20, 20, 20, 20, 20] }, hills: ['Ada', 'Ada', 'Ada', 'Anthony', 'Anthony'], held: { Ada: 3, Anthony: 2 }, points: { Ada: 3, Anthony: 2 }, values: null, winner: 'Ada', forfeit: null, at: now - 300e3 },
        { n: 2, alloc: { Ada: [25, 25, 25, 25, 0], Anthony: [25, 30, 20, 25, 0] }, hills: [null, 'Anthony', 'Ada', null, null], held: { Ada: 1, Anthony: 1 }, points: { Ada: 1, Anthony: 1 }, values: null, winner: null, forfeit: null, at: now - 120e3 },
      ],
      log: [], awaiting: ['Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, queued: null, legal_moves: ['five whole numbers adding up to 100', 'even', 'random'] } } : null,
    sg: opts.sg ? { id: 38, type: 'sketch', status: 'running', created_by: 'Henry', card_msg: 39, round: 2, rounds_total: 3, rotations: 1, phase: opts.sgDraw ? 'draw' : 'guess', artist: opts.sgDraw ? 'Anthony' : 'Ada',
      image: opts.sgDraw ? null : { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', type: 'image/png' }, draw_seconds: 3600, guess_seconds: 600, deadline: now + 3000e3, lobby_deadline: null, order: ['Henry', 'Ada', 'Anthony'],
      winner: null, draw: false, places: null, declined_by: null,
      players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, score: 2, exact: 0, committed: opts.sgDraw ? true : false }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, score: 1, exact: 0, committed: opts.sgDraw ? true : true }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, score: 0, exact: 0, committed: opts.sgDraw ? false : false }],
      rounds: [{ n: 1, artist: 'Henry', prompt: 'a cat stuck in a tree', image: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', type: 'image/png' }, guesses: { Ada: { guess: 'cat up a tree', right: true, exact: false, how: 'referee', ms: 40e3 }, Anthony: { guess: 'a squirrel', right: false, exact: false, how: 'referee', ms: 50e3 } }, right: ['Ada'], missed: [], points: { Ada: 2, Henry: 1 }, judge: 'referee', judge_note: null, roast: null, forfeit: false, at: now - 60e3 }],
      log: [], awaiting: [], awaiting_accept: [],
      you: opts.sgDraw ? { playing: true, accepted: true, artist: true, prompt: 'a lighthouse in a storm', legal_moves: [] } : { playing: true, accepted: true, artist: false, queued: null, legal_moves: [] } } : null,
    tv: opts.tv ? { id: 36, type: 'trivia', status: 'running', created_by: 'Henry', card_msg: 37, round: 2, rounds_total: 6, rotations: 2, round_seconds: 3600, deadline: now + 3000e3, lobby_deadline: null,
      phase: opts.tvAsk ? 'ask' : opts.tvJudge ? 'judge' : 'answer', asker: opts.tvAsk || opts.tvJudge ? 'Anthony' : 'Ada', question: opts.tvAsk ? null : opts.tvJudge ? "What's my dog's name?" : 'Which city did I grow up in?',
      order: ['Henry', 'Ada', 'Anthony'], start: 100, max_wager: 25, split_bonus: 10, winner: null, draw: false, places: null, declined_by: null,
      players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, balance: 115, right: 1, wrong: 0, committed: opts.tvAsk || opts.tvJudge ? true : false }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, balance: 110, right: 0, wrong: 0, committed: true }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, balance: 90, right: 0, wrong: 1, committed: opts.tvAsk || opts.tvJudge ? true : false }],
      rounds: [{ n: 1, asker: 'Henry', question: 'What colour is my bike?', answer: 'red', accept: ['crimson'], answers: { Ada: { answer: 'Red', wager: 15, right: true, judged: false, at: now - 70e3 }, Anthony: { answer: 'blue', wager: 10, right: false, judged: false, at: now - 65e3 } }, right: ['Ada'], wrong: ['Anthony'], missed: [], deltas: { Ada: 15, Anthony: -10, Henry: 10 }, split: true, bonus: 10, totals: { Ada: 115, Henry: 110, Anthony: 90 }, forfeit: false, at: now - 60e3 }],
      log: [], awaiting: [], awaiting_accept: [],
      you: opts.tvAsk ? { playing: true, accepted: true, asker: true, balance: 90, max_wager: 25, legal_moves: [] } : opts.tvJudge ? { playing: true, accepted: true, asker: true, balance: 90, max_wager: 25, answer: 'Rex', accept: [], to_judge: [{ name: 'Ada', answer: 'Rexy', accepted: false }], legal_moves: ['accept Ada', 'done'] } : { playing: true, accepted: true, asker: false, balance: 90, max_wager: 25, queued: null, legal_moves: [] } } : null,
    lg: opts.lg ? { id: 34, type: 'lettergrid', status: 'running', created_by: 'Ada', card_msg: 35, round: 2, rounds_total: 8, round_seconds: 3600, deadline: now + 3000e3, lobby_deadline: null,
      size: 5, min_len: 3, grid: ['stone', 'cared', 'lints', 'poury', 'meath'], claims: [null, null, null, null, null, 'Ada', 'Ada', 'Ada', 'Ada', null, 'Henry', 'Henry', 'Henry', 'Henry', null, 'Anthony', 'Anthony', 'Anthony', 'Anthony', null, null, null, null, null, null], word_count: 140, top_words: null, winner: null, draw: false, places: null, declined_by: null,
      players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, committed: true, score: 8, cells: 4, longest: 'care', out: false }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, committed: false, score: 8, cells: 4, longest: 'lint', out: false }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, committed: false, score: 8, cells: 4, longest: 'pour', out: false }],
      rounds: [{ n: 1, at: now - 60e3, words: { Ada: { word: 'care', path: [[1, 0], [1, 1], [1, 2], [1, 3]], letters: 4, bonus: 4, claimed: [5, 6, 7, 8], contested: [], dup: false, at: now - 70e3 }, Henry: { word: 'lint', path: [[2, 0], [2, 1], [2, 2], [2, 3]], letters: 4, bonus: 4, claimed: [10, 11, 12, 13], contested: [], dup: false, at: now - 65e3 }, Anthony: { word: 'pour', path: [[3, 0], [3, 1], [3, 2], [3, 3]], letters: 4, bonus: 4, claimed: [15, 16, 17, 18], contested: [], dup: false, at: now - 62e3 } }, missed: [], dropped: [], points: { Ada: 8, Henry: 8, Anthony: 8 }, totals: { Ada: 8, Henry: 8, Anthony: 8 } }],
      log: [], awaiting: ['Henry', 'Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, queued: null, out: false, played: ['pour'], legal_moves: [] } } : null,
    ww: opts.ww ? { id: 30, type: 'werewolf', status: 'running', created_by: 'Ada', card_msg: 31, phase: opts.wwWolf ? 'night' : 'day', night: opts.wwWolf ? 2 : 1, day: 1, phase_seconds: 86400, deadline: now + 80000e3, lobby_deadline: null,
      order: ['Ada', 'Henry', 'Anthony', 'Ivy', 'Jax'], roles_in_play: { werewolf: 1, seer: 1, guardian: 0, villager: 3 }, alive_count: 4,
      events: [{ night: 1, kind: 'death', who: 'Jax', role: 'villager', at: now - 90e3 }].concat(opts.wwWolf ? [{ day: 1, kind: 'tie', votes: {}, at: now - 60e3 }] : []),
      votes: opts.wwWolf ? null : { Ada: 'Henry' },
      talk: [{ n: 1, by: 'Ada', text: 'Henry was near the well last night.', ch: 'town', phase: 'day', day: 1, at: now - 50e3 }],
      side: null, winners: null, winner: null, draw: false, places: null, declined_by: null,
      players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, alive: true, role: null, voted: !opts.wwWolf }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, alive: true, role: null, voted: false }, { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, alive: true, role: null, voted: false }, { name: 'Ivy', color: 'green', hex: '#4ade80', accepted: true, alive: true, role: null, voted: false }, { name: 'Jax', color: 'violet', hex: '#a78bfa', accepted: true, alive: false, role: 'villager', voted: false }],
      log: [], awaiting: opts.wwWolf ? [] : ['Henry', 'Anthony', 'Ivy'], awaiting_accept: [],
      den: opts.wwWolf ? [{ n: 2, by: 'Ivy', text: 'Ada suspects us.', ch: 'den', phase: 'night', day: 2, at: now - 20e3 }] : undefined,
      you: opts.wwWolf ? { playing: true, accepted: true, role: 'werewolf', alive: true, pack: ['Ivy'], pack_picks: { Ivy: 'Ada' }, act: null, legal_moves: ['kill Ada', 'kill Henry'] } : { playing: true, accepted: true, role: 'villager', alive: true, vote: null, legal_moves: ['vote Ada', 'vote Henry', 'vote Anthony', 'vote Ivy'] } } : null,
    tq: opts.tq ? { id: 28, type: 'twenty', status: 'running', created_by: 'Ada', card_msg: 29, round: 1, rounds_total: 3, rotations: 1, phase: opts.tqAnswer ? 'answer' : 'ask', answerer: opts.tqAnswer ? 'Anthony' : 'Ada', round_seconds: 3600, deadline: now + 3000e3, lobby_deadline: null, order: opts.tqAnswer ? ['Anthony', 'Ada', 'Henry'] : ['Ada', 'Henry', 'Anthony'],
      budget: 20, asked: 2, remaining: 18, mode: 'table',
      qa: [{ n: 1, by: 'Henry', kind: 'q', q: 'Is it alive?', a: 'no', note: null, flagged: false }, { n: 2, by: 'Henry', kind: 'q', q: 'Is it bigger than a breadbox?', a: 'yes', note: 'much', flagged: false }, { n: 3, by: opts.tqAnswer ? 'Ada' : 'Anthony', kind: 'q', q: 'Is it a building?', a: null, note: null, flagged: true }].concat(opts.tqAnswer ? [{ n: 4, by: 'Henry', kind: 'q', q: 'Is it made of metal?', a: null, note: null, flagged: false }] : []),
      pending: opts.tqAnswer ? { n: 4, by: 'Henry', kind: 'q', q: 'Is it made of metal?', a: null, note: null, flagged: false } : null,
      last_round: null, rounds: [], winner: null, draw: false, places: null, declined_by: null,
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, score: 0, asked: 0 },
        { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, score: 0, asked: 2 },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, score: 0, asked: 0 },
      ],
      log: [], awaiting: opts.tqAnswer ? ['Anthony'] : ['Henry', 'Anthony'], awaiting_accept: [],
      you: opts.tqAnswer ? { playing: true, accepted: true, answerer: true, secret: 'a lighthouse', legal_moves: ['yes', 'no', 'unanswerable'] } : { playing: true, accepted: true, answerer: false, legal_moves: ['<a yes/no question>', 'guess: <your answer>'] } } : null,
    ec: opts.ec ? { id: 26, type: 'corpse', status: 'running', created_by: 'Ada', card_msg: 27, phase: opts.ecVote ? 'vote' : 'write', turn: opts.ecVote ? 4 : 3, turns_total: opts.ecVote ? 3 : 6, rotations: opts.ecVote ? 1 : 2, turn_of: opts.ecVote ? null : 'Anthony', turn_seconds: 86400, deadline: now + 80000e3, lobby_deadline: null,
      order: ['Ada', 'Henry', 'Anthony'], variant: 'straight', genre: null, segments: opts.ecVote ? 3 : 2,
      seed: opts.ecVote ? 'The lighthouse keeper had not seen a ship in eleven years.' : null,
      story: opts.ecVote ? [{ n: 1, by: 'Ada', text: 'Then the fog rolled in, carrying a smell of cinnamon.' }, { n: 2, by: 'Henry', text: 'The mayor declared it a holiday. Nobody knew why.' }, { n: 3, by: 'Anthony', text: 'By midnight the gulls had formed a committee.' }] : null,
      constraints: null, votes: null, honours: null, winner: null, draw: false, places: null, declined_by: null,
      beats: opts.ecVote ? [{ turn: 1, by: 'Ada', wrote: true }, { turn: 2, by: 'Henry', wrote: true }, { turn: 3, by: 'Anthony', wrote: true }] : [{ turn: 1, by: 'Ada', wrote: true }, { turn: 2, by: 'Henry', wrote: true }],
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, segments: 1, out: false, skips: 0, committed: !!opts.ecVote, votes: null },
        { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, segments: 1, out: false, skips: 0, committed: false, votes: null },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, segments: opts.ecVote ? 1 : 0, out: false, skips: 0, committed: false, votes: null },
      ],
      log: [], awaiting: opts.ecVote ? ['Henry', 'Anthony'] : ['Anthony'], awaiting_accept: [],
      you: opts.ecVote ? { playing: true, accepted: true, out: false, writer: false, segments: [3], vote: null, legal_moves: ['1', '2'] } : { playing: true, accepted: true, out: false, writer: true, segments: [], tail: 'The mayor declared it a holiday. Nobody knew why.', legal_moves: [] } } : null,
    tt: opts.tt ? { id: 24, type: 'twotruths', status: 'running', created_by: 'Henry', card_msg: 25, round: opts.ttWrite ? 3 : 2, rounds_total: 3, rotations: 1, phase: opts.ttWrite ? 'write' : 'vote', teller: opts.ttWrite ? 'Anthony' : 'Ada', round_seconds: 3600, deadline: now + 3000e3, lobby_deadline: null, order: ['Henry', 'Ada', 'Anthony'],
      statements: opts.ttWrite ? null : ['I once lost a duel to a dog', 'I have never been to Huacachina', 'I can juggle five oranges'],
      winner: null, draw: false, places: null, declined_by: null,
      players: [
        { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, score: 1, spots: 0, committed: true },
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, score: 2, spots: 1, committed: !!opts.ttWrite },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, score: 0, spots: 0, committed: false },
      ],
      rounds: [
        { n: 1, at: now - 600e3, teller: 'Henry', statements: ['I have met a goat on a train', 'I speak three languages', 'I have been to the moon'], lie: 3, votes: { Ada: 3, Anthony: 1 }, right: ['Ada'], fooled: 1, points: { Ada: 2, Henry: 1 }, vote_ms: { Ada: 60000 }, missed: [], forfeit: false, note: null },
      ],
      log: [], awaiting: opts.ttWrite ? ['Anthony'] : ['Anthony'], awaiting_accept: [],
      you: opts.ttWrite ? { playing: true, accepted: true, teller: true, legal_moves: [] } : { playing: true, accepted: true, teller: false, vote: null, legal_moves: ['1', '2', '3'] } } : null,
    ld: opts.ld ? { id: 22, type: 'liarsdice', status: 'running', created_by: 'Ada', card_msg: 23, turn: 5, round: 2, turn_of: 'Anthony', turn_seconds: 3600, deadline: now + 3000e3, lobby_deadline: null,
      dice_each: 5, ones_wild: true, dice_total: 14, order: ['Ada', 'Anthony', 'Henry'],
      bid: { by: 'Ada', qty: 3, face: 4, at: now - 60e3 }, bids: [{ by: 'Henry', qty: 2, face: 4, at: now - 120e3 }, { by: 'Ada', qty: 3, face: 4, at: now - 60e3 }],
      winner: null, draw: false, places: null, forfeit: null, declined_by: null,
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, dice: 5, out: false, timeouts: 0 },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, dice: 5, out: false, timeouts: 0 },
        { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, dice: 4, out: false, timeouts: 0 },
      ],
      rounds: [
        { n: 1, at: now - 600e3, cups: { Ada: [1, 2, 4, 4, 6], Anthony: [2, 3, 3, 5, 6], Henry: [1, 1, 3, 5, 6] }, bids: [{ by: 'Ada', qty: 2, face: 6 }, { by: 'Anthony', qty: 3, face: 6 }, { by: 'Henry', qty: 7, face: 6 }], reason: 'call', call: { by: 'Ada', bid: { by: 'Henry', qty: 7, face: 6 } }, face: 6, count: 6, stands: false, loser: 'Henry', out: false, dice_left: 4 },
      ],
      log: [], awaiting: ['Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, dice: [1, 3, 4, 4, 6], out: false, your_turn: true, timeouts: 0, legal_moves: ['4x2', '4x3', '4x4', '3x5', '3x6', 'liar'] } } : null,
    au: opts.au ? { id: 20, type: 'auction', status: 'running', created_by: 'Ada', card_msg: 21, round: 3, lots_total: 6, lot: 'A rubber duck of unusual wisdom', budget: 100, round_seconds: 180, deadline: now + 150e3, lobby_deadline: null,
      winner: null, draw: false, places: null, declined_by: null,
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, committed: true, budget: 65, spent: 35, won: 1 },
        { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, committed: false, budget: 100, spent: 0, won: 0 },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, committed: false, budget: 80, spent: 20, won: 1 },
      ],
      rounds: [
        { n: 1, at: now - 600e3, lot: 'A slightly haunted hammock', bids: { Ada: 35, Henry: 10, Anthony: 30 }, winner: 'Ada', price: 35, tie: null, missed: [] },
        { n: 2, at: now - 300e3, lot: 'The last slice of pizza, still warm', bids: { Ada: 0, Henry: 15, Anthony: 20 }, winner: 'Anthony', price: 20, tie: null, missed: [] },
      ],
      log: [], awaiting: ['Henry', 'Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, queued: null, budget: 80, legal_moves: ['a whole number from 0 to 80', 'pass'] } } : null,
    tr: opts.tr ? { id: 18, type: 'trust', status: 'running', created_by: 'Henry', card_msg: 19, round: 3, rounds_about: 10, last_round: null, round_seconds: 180, deadline: now + 150e3, lobby_deadline: null,
      payoffs: { CC: 3, CD: 0, DC: 5, DD: 1 }, winner: null, draw: false, places: null, declined_by: null,
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, committed: true, score: 14, out: false, coop: 0.5 },
        { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, committed: false, score: 9, out: false, coop: 0.75 },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, committed: false, score: 12, out: false, coop: 1 },
      ],
      rounds: [
        { n: 1, at: now - 600e3, moves: { Ada: { Henry: 'C', Anthony: 'C' }, Henry: { Ada: 'C', Anthony: 'C' }, Anthony: { Ada: 'C', Henry: 'C' } }, missed: [], dropped: [], points: { Ada: 6, Henry: 6, Anthony: 6 }, totals: { Ada: 6, Henry: 6, Anthony: 6 } },
        { n: 2, at: now - 300e3, moves: { Ada: { Henry: 'D', Anthony: 'D' }, Henry: { Ada: 'C', Anthony: 'D' }, Anthony: { Ada: 'C', Henry: 'C' } }, missed: [], dropped: [], points: { Ada: 8, Henry: 3, Anthony: 6 }, totals: { Ada: 14, Henry: 9, Anthony: 12 } },
      ],
      log: [], awaiting: ['Henry', 'Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, queued: null, out: false, rivals: ['Ada', 'Henry'], legal_moves: ['C', 'D', 'Ada:C, Henry:D'] } } : null,
    c4: opts.c4 ? (() => {
      // Anthony (X) to move at turn 7; Ada (O) just dropped in column 4.
      // Done (a separate game, 12 moves): Ada's diagonal from (3,1) to
      // (6,4) wins on move 12.
      const g = { id: 16, type: 'fourinarow', status: 'running', created_by: 'Ada', card_msg: 17, turn: 7, turn_of: 'Anthony', turn_seconds: 3600, deadline: now + 3000e3, lobby_deadline: null, cols: 7, rows: 6, first: 'Anthony',
        board: ['.......', '.......', '.......', '.......', 'X..O...', 'O.XOX..'],
        last_move: { n: 6, by: 'Ada', col: 4, row: 2, at: now - 60e3 }, line: null, winner: null, draw: false, forfeit: null, declined_by: null,
        players: [{ name: 'Anthony', color: 'orange', hex: '#fb923c', piece: 'X', accepted: true, timeouts: 0 }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', piece: 'O', accepted: true, timeouts: 1 }],
        moves: [{ n: 1, by: 'Anthony', col: 3, row: 1 }, { n: 2, by: 'Ada', col: 4, row: 1 }, { n: 3, by: 'Anthony', col: 5, row: 1 }, { n: 4, by: 'Ada', col: 1, row: 1 }, { n: 5, by: 'Anthony', col: 1, row: 2 }, { n: 6, by: 'Ada', col: 4, row: 2 }],
        log: [], awaiting: ['Anthony'], awaiting_accept: [],
        you: { playing: true, accepted: true, piece: 'X', your_turn: true, timeouts: 0, legal_moves: ['1', '2', '3', '4', '5', '6', '7'] } };
      if (opts.c4Done) {
        const seq = [['Anthony', 5, 1], ['Ada', 3, 1], ['Anthony', 6, 1], ['Ada', 4, 1], ['Anthony', 5, 2], ['Ada', 4, 2], ['Anthony', 6, 2], ['Ada', 1, 1], ['Anthony', 1, 2], ['Ada', 5, 3], ['Anthony', 6, 3], ['Ada', 6, 4]];
        g.moves = seq.map(([by, col, row], i) => ({ n: i + 1, by, col, row }));
        Object.assign(g, { status: 'finished', turn: 12, turn_of: null, winner: 'Ada', deadline: null, awaiting: [],
          board: ['.......', '.......', '.....O.', '....OX.', 'X..OXX.', 'O.OOXX.'], line: [[3, 1], [4, 2], [5, 3], [6, 4]],
          last_move: g.moves[11] });
        g.you = { playing: true, accepted: true, piece: 'X', your_turn: false, timeouts: 0, legal_moves: [] };
      }
      return g;
    })() : null,
    cr: opts.cr ? (() => {
      const words = !!opts.crWords;
      const pal = [['R', 'red', '#ef4444'], ['G', 'green', '#22c55e'], ['B', 'blue', '#3b82f6'], ['Y', 'yellow', '#facc15'], ['O', 'orange', '#f97316'], ['P', 'purple', '#a855f7']].map(([k, name, hex]) => ({ k, name, hex }));
      const rounds = words
        ? [
            { n: 1, at: now - 600e3, guesses: { Ada: { fb: 'Y..G.' }, Henry: { fb: '.Y...' }, Anthony: { guess: 'crane', fb: '..G.Y', at: now - 610e3 } }, solved: [], missed: [], dropped: [] },
            { n: 2, at: now - 300e3, guesses: { Ada: { fb: 'GG.G.' }, Henry: { fb: 'YY.Y.' }, Anthony: { guess: 'plate', fb: 'Y.GGY', at: now - 310e3 } }, solved: [], missed: [], dropped: [] },
          ]
        : [
            { n: 1, at: now - 600e3, guesses: { Ada: { fb: [1, 1] }, Henry: { fb: [0, 2] }, Anthony: { guess: 'RGBY', fb: [1, 2], at: now - 610e3 } }, solved: [], missed: [], dropped: [] },
            { n: 2, at: now - 300e3, guesses: { Ada: { fb: [2, 1] }, Henry: { fb: [1, 1] }, Anthony: { guess: 'RRGO', fb: [2, 0], at: now - 310e3 } }, solved: [], missed: [], dropped: [] },
          ];
      const g = { id: 14, type: 'coderace', status: 'running', created_by: 'Ada', card_msg: 15, round: 3, max_rounds: words ? 6 : 10, round_seconds: 3600, deadline: now + 3000e3, lobby_deadline: null,
        mode: words ? 'words' : 'colors', length: words ? 5 : 4, colors: words ? null : 6, palette: words ? null : pal, winner: null, declined_by: null, places: null, secret: null,
        players: [
          { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, committed: true, solved: null, out: false, guesses: 2, best: 21 },
          { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, committed: false, solved: null, out: false, guesses: 2, best: 11 },
          { name: 'Anthony', color: 'pink', hex: '#f472b6', accepted: true, committed: false, solved: null, out: false, guesses: 2, best: 20 },
        ],
        rounds, log: [], awaiting: ['Henry', 'Anthony'], awaiting_accept: [],
        you: { playing: true, accepted: true, queued: null, solved: null, out: false, legal_moves: words ? ['one 5-letter word from the word list, e.g. crane'] : ['4 colours in order from R G B Y O P, e.g. R G B Y', 'random'] } };
      // the race over (colors): Ada cracked R G B O in round 3, Anthony in
      // 4, Henry never; every guess is out in the open now
      if (opts.crDone) {
        const open = { Ada: ['RRBB', 'RGBB', 'RGBO'], Henry: ['GRYY', 'GBRR', 'BBRR', 'YYRR'] };
        g.rounds.forEach((r) => Object.keys(open).forEach((n) => { if (r.guesses[n]) r.guesses[n].guess = open[n][r.n - 1]; }));
        g.rounds.push({ n: 3, at: now - 200e3, guesses: { Ada: { guess: 'RGBO', fb: [4, 0] }, Henry: { guess: 'BBRR', fb: [1, 1] }, Anthony: { guess: 'RGBY', fb: [3, 0] } }, solved: ['Ada'], missed: [], dropped: [] });
        g.rounds.push({ n: 4, at: now - 100e3, guesses: { Henry: { guess: 'YYRR', fb: [0, 1] }, Anthony: { guess: 'RGBO', fb: [4, 0] } }, solved: ['Anthony'], missed: [], dropped: [] });
        Object.assign(g, { status: 'finished', round: 4, winner: 'Ada', places: ['Ada', 'Anthony', 'Henry'], secret: ['R', 'G', 'B', 'O'], deadline: null, awaiting: [] });
        g.players[0].solved = 3; g.players[2].solved = 4; g.players[1].guesses = 4;
        g.players.forEach((p) => (p.committed = false));
        g.you = { playing: true, accepted: true, queued: null, solved: 4, out: false, legal_moves: [] };
      }
      return g;
    })() : null,
    duel: (opts.duel || opts.duelDone) ? { id: 2, type: 'duel', status: opts.duelDone ? 'finished' : 'running', created_by: 'Ada', card_msg: 10, round: opts.duelDone ? 7 : 4, best_of: 5, target: 3, round_seconds: 600, deadline: now + 400e3, winner: opts.duelDone ? 'Anthony' : null,
      score: opts.duelDone ? { Ada: 2, Anthony: 3 } : { Ada: 1, Anthony: 0 },
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: opts.duelDone ? 2 : 1, thrown: !opts.duelDone },
        { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: opts.duelDone ? 3 : 0, thrown: false },
      ],
      rounds: opts.duelDone ? [
        { n: 1, throws: { Ada: 'scissors', Anthony: 'paper' }, winner: 'Ada', at: now - 40e3, throws_at: { Ada: now - 41e3, Anthony: now - 40e3 } },
        { n: 2, throws: { Ada: 'rock', Anthony: 'rock' }, winner: null, at: now - 35e3, throws_at: { Ada: now - 36e3, Anthony: now - 35e3 } },
        { n: 3, throws: { Ada: 'paper', Anthony: 'paper' }, winner: null, at: now - 30e3, throws_at: { Ada: now - 31e3, Anthony: now - 30e3 } },
        { n: 4, throws: { Ada: 'rock', Anthony: 'scissors' }, winner: 'Ada', at: now - 25e3, throws_at: { Ada: now - 26e3, Anthony: now - 25e3 } },
        { n: 5, throws: { Ada: 'paper', Anthony: 'scissors' }, winner: 'Anthony', at: now - 20e3, throws_at: { Ada: now - 21e3, Anthony: now - 20e3 } },
        { n: 6, throws: { Ada: 'scissors', Anthony: 'scissors' }, winner: null, at: now - 15e3, throws_at: { Ada: now - 16e3, Anthony: now - 15e3 } },
        { n: 7, throws: { Ada: 'paper', Anthony: 'scissors' }, winner: 'Anthony', at: now - 10e3, throws_at: { Ada: now - 11e3, Anthony: now - 10e3 } },
      ] : [
        { n: 1, throws: { Ada: 'scissors', Anthony: 'paper' }, winner: 'Ada', at: now - 30e3, throws_at: { Ada: now - 31e3, Anthony: now - 30e3 } },
        { n: 2, throws: { Ada: 'rock', Anthony: 'rock' }, winner: null, at: now - 25e3, throws_at: { Ada: now - 26e3, Anthony: now - 25e3 } },
        { n: 3, throws: { Ada: 'paper', Anthony: 'paper' }, winner: null, at: now - 20e3, throws_at: { Ada: now - 21e3, Anthony: now - 20e3 } },
      ],
      you: { playing: true, queued: null } } : null,
    bs: opts.bs ? { id: 5, type: 'battleship', status: 'running', created_by: 'Ada', card_msg: 12, phase: 'play', turn: 80, turn_of: 'Henry', turn_seconds: 3600, deadline: now + 3500e3, lobby_deadline: null, winner: null, declined_by: null,
      last_move: { by: 'Ada', cell: 'A7', result: 'hit', sunk: null, turn: 79 },
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 40, hits: 16, sunk: 4, afloat: 1 },
        { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 39, hits: 15, sunk: 4, afloat: 1 },
      ],
      boards: [
        { name: 'Ada', hex: '#22d3ee', incoming: { A3: 'hit', A4: 'hit', A5: 'hit', A6: 'hit', A7: 'hit', C7: 'hit', D7: 'hit', E7: 'hit', F7: 'hit', E2: 'hit', E3: 'hit', E4: 'hit', I4: 'hit', I5: 'hit', I9: 'hit', E5: 'miss', F5: 'miss', G5: 'miss', H5: 'miss', H6: 'miss', D3: 'miss', D4: 'miss', F4: 'miss', G3: 'miss', B4: 'miss', C2: 'miss', B7: 'miss', I3: 'miss', H3: 'miss', G7: 'miss', A8: 'miss', C6: 'miss', C8: 'miss', F2: 'miss', D2: 'miss', E1: 'miss', F1: 'miss', J2: 'miss', B8: 'miss' }, sunk_ships: [{ size: 5, cells: ['A3', 'A4', 'A5', 'A6', 'A7'] }, { size: 4, cells: ['C7', 'D7', 'E7', 'F7'] }, { size: 3, cells: ['E2', 'E3', 'E4'] }, { size: 2, cells: ['I4', 'I5'] }] },
        { name: 'Henry', hex: '#fb923c', incoming: { B5: 'hit', B6: 'hit', B7: 'hit', C5: 'hit', D5: 'hit', C9: 'hit', D9: 'hit', E9: 'hit', I4: 'hit', I5: 'hit', I6: 'hit', I7: 'hit', I8: 'hit', A9: 'hit', A8: 'hit', A7: 'hit', A2: 'miss', B3: 'miss', B9: 'miss', C4: 'miss', C8: 'miss', D1: 'miss', D6: 'miss', D8: 'miss', E6: 'miss', E8: 'miss', F3: 'miss', F9: 'miss', G10: 'miss', H1: 'miss', H7: 'miss', I9: 'miss', J3: 'miss', D10: 'miss', G5: 'miss', F4: 'miss', F2: 'miss', A5: 'miss', J6: 'miss', H2: 'miss' }, sunk_ships: [{ size: 5, cells: ['I4', 'I5', 'I6', 'I7', 'I8'] }, { size: 3, cells: ['C9', 'D9', 'E9'] }, { size: 3, cells: ['B5', 'B6', 'B7'] }, { size: 2, cells: ['C5', 'D5'] }] },
      ],
      log: [{ tick: 78, text: 'Henry fires I9 - hit.', by: 'Henry', cell: 'I9', result: 'hit', sunk: null }, { tick: 79, text: "Ada fires A7 - hit, and Henry's 5-ship is sunk.", by: 'Ada', cell: 'A7', result: 'hit', sunk: 5 }],
      awaiting: ['Henry'], awaiting_accept: [],
      you: { playing: false } } : null,
    bsPlay: opts.bsPlay ? { id: 6, type: 'battleship', status: 'running', created_by: 'Ada', card_msg: 13, phase: 'play', turn: 13, turn_of: 'Anthony', turn_seconds: 3600, deadline: now + 3500e3, lobby_deadline: null, winner: null, declined_by: null, misses: { Anthony: 2 },
      last_move: { by: 'Ada', cell: 'H5', result: 'hit', sunk: null, turn: 12 },
      players: [
        { name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 6, hits: 2, sunk: 0, afloat: 5 },
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 6, hits: 1, sunk: 0, afloat: 5 },
      ],
      boards: [
        { name: 'Anthony', hex: '#fb923c', incoming: { H5: 'hit', A2: 'miss', J10: 'miss', D4: 'miss', B7: 'miss', F9: 'miss' }, sunk_ships: [] },
        { name: 'Ada', hex: '#22d3ee', incoming: { C5: 'hit', C6: 'hit', D5: 'miss', A1: 'miss', J9: 'miss', G8: 'miss' }, sunk_ships: [] },
      ],
      log: [{ tick: 11, text: 'Anthony fires C6 - hit.' }, { tick: 12, text: 'Ada fires H5 - hit.' }],
      awaiting: ['Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, phase: 'play', your_turn: true,
        fleet: [
          { size: 5, cells: ['B2', 'C2', 'D2', 'E2', 'F2'], hits: [], sunk: false },
          { size: 4, cells: ['H4', 'H5', 'H6', 'H7'], hits: ['H5'], sunk: false },
          { size: 3, cells: ['A9', 'B9', 'C9'], hits: [], sunk: false },
          { size: 3, cells: ['J1', 'J2', 'J3'], hits: [], sunk: false },
          { size: 2, cells: ['E5', 'F5'], hits: [], sunk: false },
        ],
        shots: { C5: 'hit', C6: 'hit', D5: 'miss', A1: 'miss', J9: 'miss', G8: 'miss' },
        incoming: { H5: 'hit', A2: 'miss', J10: 'miss', D4: 'miss', B7: 'miss', F9: 'miss' },
        sunk_ships: [], opponent_afloat: 5,
        legal_moves: ['fire: any cell A1-J10 you have not fired at yet, e.g. fire: C5'] } } : null,
    bsSetup: opts.bsSetup ? { id: 8, type: 'battleship', status: 'running', created_by: 'Ada', card_msg: 14, phase: 'setup', turn: 0, turn_of: null, turn_seconds: 3600, deadline: now + 3500e3, lobby_deadline: null, winner: null, declined_by: null,
      last_move: null,
      players: [
        { name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: false, shots: 0, hits: 0, sunk: 0, afloat: 5 },
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 0, hits: 0, sunk: 0, afloat: 5 },
      ],
      boards: [
        { name: 'Anthony', hex: '#fb923c', incoming: {}, sunk_ships: [] },
        { name: 'Ada', hex: '#22d3ee', incoming: {}, sunk_ships: [] },
      ],
      log: [{ tick: 0, text: 'Both captains have taken their seats - fleets are being placed.' }],
      awaiting: ['Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, phase: 'setup', your_turn: false, fleet: null,
        legal_moves: ['place: A1H,C3V,E5H,G7V,I9H (fleet order 5,4,3,3,2) or place: random'] } } : null,
    bsFfa: opts.bsFfa ? { id: 9, type: 'battleship', status: 'running', created_by: 'Ada', card_msg: 15, phase: 'play', turn: 31, turn_of: 'Anthony', turn_seconds: 3600, deadline: now + 3500e3, lobby_deadline: null, winner: null, declined_by: null, misses: { Henry: 1 }, variant: 'classic', salvo_left: null, sonar: null, fleet_sizes: [5, 4, 3, 3, 2], w: 10, h: 10,
      last_move: { by: 'Ada', target: 'Anthony', cell: 'H5', result: 'hit', sunk: null, turn: 30 },
      eliminated: ['Hank'],
      players: [
        { name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 9, hits: 4, sunk: 1, afloat: 5, eliminated: false },
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 8, hits: 3, sunk: 0, afloat: 5, eliminated: false },
        { name: 'Henry', color: 'pink', hex: '#f472b6', accepted: true, placed: true, shots: 8, hits: 2, sunk: 0, afloat: 4, eliminated: false },
        { name: 'Hank', color: 'lime', hex: '#a3e635', accepted: true, placed: true, shots: 6, hits: 1, sunk: 0, afloat: 0, eliminated: true },
      ],
      boards: [
        { name: 'Anthony', hex: '#fb923c', incoming: { H5: 'hit', A2: 'miss', J10: 'miss' }, sunk_ships: [], eliminated: false },
        { name: 'Ada', hex: '#22d3ee', incoming: { C5: 'hit', D5: 'miss', B9: 'miss' }, sunk_ships: [], eliminated: false },
        { name: 'Henry', hex: '#f472b6', incoming: { B2: 'hit', B3: 'hit', G8: 'miss' }, sunk_ships: [], eliminated: false },
        { name: 'Hank', hex: '#a3e635', incoming: { J1: 'hit', J2: 'hit', E5: 'miss' }, sunk_ships: [{ size: 2, cells: ['J1', 'J2'] }], eliminated: true },
      ],
      log: [{ tick: 29, text: "Anthony fires J2 at Hank - hit, and Hank's 2-ship is sunk.", by: 'Anthony', target: 'Hank', cell: 'J2', result: 'hit', sunk: 2 }, { tick: 29, text: "Hank's last ship is gone - Hank is eliminated (1 of 3 out). Their board is a wreck chart now." }, { tick: 30, text: 'Ada fires H5 at Anthony - hit.', by: 'Ada', target: 'Anthony', cell: 'H5', result: 'hit', sunk: null }],
      awaiting: ['Anthony'], awaiting_accept: [],
      you: { playing: true, accepted: true, phase: 'play', your_turn: true, eliminated: false,
        fleet: [
          { size: 5, cells: ['B2', 'C2', 'D2', 'E2', 'F2'], hits: [], sunk: false },
          { size: 4, cells: ['H4', 'H5', 'H6', 'H7'], hits: ['H5'], sunk: false },
          { size: 3, cells: ['A9', 'B9', 'C9'], hits: [], sunk: false },
          { size: 3, cells: ['J1', 'J2', 'J3'], hits: [], sunk: false },
          { size: 2, cells: ['E5', 'F5'], hits: [], sunk: false },
        ],
        shots: {}, incoming: { H5: 'hit', A2: 'miss', J10: 'miss' },
        sunk_ships: [], opponent_afloat: null,
        targets: [
          { name: 'Ada', hex: '#22d3ee', eliminated: false, afloat: 5, shots: { C5: 'hit', D5: 'miss' }, sunk_ships: [] },
          { name: 'Henry', hex: '#f472b6', eliminated: false, afloat: 4, shots: { B2: 'hit', B3: 'hit' }, sunk_ships: [] },
          { name: 'Hank', hex: '#a3e635', eliminated: true, afloat: 0, shots: { J1: 'hit', J2: 'hit' }, sunk_ships: [{ size: 2, cells: ['J1', 'J2'] }] },
        ],
        legal_moves: ['Ada:A1', 'Ada:A2', 'Henry:A1', 'Hank-free waters are not listed'] } } : null,
    mb: { invite_only: true, members: [
      { name: 'Anthony', kind: 'human', status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 5 * 60e3, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Anthony' },
      { name: 'Henry', kind: 'agent', avatar: 'https://chat.victorio.cloud/api/rooms/demo/avatars/Henry?v=1', invited_by: null, status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 2 * H, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Henry', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Henry".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Ada', kind: 'agent', status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 40 * 60e3, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Ada', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Ada".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Hank', kind: 'agent', invited_by: 'Henry', status: 'unused', invited: now - 2 * D, joined: null, last_seen: null, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Hank', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Hank".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Old bot', kind: 'agent', status: 'revoked', invited: now - 5 * D, joined: now - 4 * D, last_seen: now - 4 * D, revoked: now - 3 * D },
    ] },
    nid: 100,
    av: { henry: { buf: require('fs').readFileSync(__dirname + '/../../tests/fixtures/henry.gif'), type: 'image/gif' } },
    shelf: opts.shelf ? [
      { id: 8, ts: now - 60e3, from: 'Ada', kind: 'doc', type: 'text/markdown; charset=utf-8', bytes: 1024, name: 'notes.md', text: 'Sharing the packet and the notes.', transcript: null, url: '/api/rooms/demo/messages/8/doc?exp=1&sig=x' },
      { id: 8, ts: now - 60e3, from: 'Ada', kind: 'html', type: 'text/html; charset=utf-8', bytes: 2048, name: 'Packet', text: 'Sharing the packet and the notes.', transcript: null, url: '/api/rooms/demo/messages/8/html?exp=1&sig=x' },
      { id: 8, ts: now - 60e3, from: 'Ada', kind: 'image', type: 'image/png', bytes: 4321, name: null, text: 'Sharing the packet and the notes.', transcript: null, url: '/api/rooms/demo/messages/8/image?exp=1&sig=x' },
      { id: 5, ts: now - 5 * 60e3, from: 'Anthony', kind: 'video', type: 'video/mp4', bytes: 904321, name: null, text: 'Looks good to me.\nLet\'s lock it in.', transcript: null, url: '/api/rooms/demo/messages/5/video?exp=1&sig=x' },
      { id: 3, ts: now - 50 * 60e3, from: 'Ada', kind: 'audio', type: 'audio/mpeg', bytes: 22100, name: null, text: 'Agreed. Details here.', transcript: 'Agreed - the constitution is up.', url: '/api/rooms/demo/messages/3/audio?exp=1&sig=x' },
    ] : [],
  };
}
function roomState(S) {
  return { v: 1, constitution_version: S.con.version,
    open_questions: S.q.map(x => ({ id: x.id, text: x.text, added_by: x.added_by, claimed_by: x.claimed_by })),
    decisions_awaiting_signatures: S.dc.filter(d => d.signers.length < 3).map(d => ({ id: d.id, title: d.title, signed_by: d.signers, missing: ['Anthony', 'Henry', 'Ada'].filter(n => d.signers.indexOf(n) < 0) })),
    stakes_due: S.sk.filter(s => s.date && s.date <= ymd(7)).map(s => ({ id: s.id, title: s.title, date: s.date, days_away: 1 })),
    memory: { latest_digest_day: ymd(0), latest_digest_by: 'Ada', digests_today: S.dg.length, awaiting_digest_from: 'Henry', digest_due_at: now + 10 * H } };
}
async function setup(page, S, calls) {
  await page.route('https://chat.victorio.cloud/**', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname; const m = req.method();
    let body = {}; try { body = req.postData() ? JSON.parse(req.postData()) : {}; } catch (e) {}
    calls && calls.push(m + ' ' + p + u.search + (req.postData() ? ' ' + req.postData() : ''));
    const J = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
    S.av = S.av || {};
    const findGame = (id) => [S.duel, S.game, S.duelLobby, S.bs, S.bsPlay, S.bsSetup, S.bsFfa, S.fl, S.cr, S.c4, S.tr, S.au, S.ld, S.tt, S.ec, S.tq, S.ww, S.lg, S.tv, S.sg].find(g => g && g.id == id) || null;
    let am;
    if ((am = p.match(/\/avatars\/([^\/]+)$/))) { const a = S.av[decodeURIComponent(am[1]).toLowerCase()]; return a ? route.fulfill({ status: 200, contentType: a.type, body: a.buf }) : route.fulfill({ status: 404, body: 'none' }); }
    if (p.endsWith('/avatar')) {
      calls && calls.push(m + ' ' + p + ' ' + (req.headers()['content-type'] || '') + ' ' + ((req.postDataBuffer() || []).length));
      const me = S.mb.members.find(x => x.name === 'Anthony');
      if (m === 'DELETE') { delete S.av.anthony; me.avatar = null; return J({ ok: 1 }); }
      const buf = req.postDataBuffer(); const type = req.headers()['content-type'];
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return J({ error: 'Avatars must be PNG, JPEG, WebP or GIF' }, 415);
      S.av.anthony = { buf, type }; me.avatar = 'https://chat.victorio.cloud/api/rooms/demo/avatars/Anthony?v=' + Date.now(); return J({ ok: 1 });
    }
    if (p === '/emoji.json') return route.fulfill({ status: 200, contentType: 'application/json', body: require('fs').readFileSync(__dirname + '/../../tests/fixtures/emoji-compact.json') });
    if (p.startsWith('/assets/')) { try { const body = require('fs').readFileSync(DIST + p); return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body }); } catch (e) { return route.fulfill({ status: 404, body: 'nf' }); } }
    if (p.startsWith('/r/') || p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (p === '/api/build') return J({ build: S.behind ? 'uitestbuild2' : 'uitestbuild1' });
    if (p.startsWith('/api/') && S.deny) return J({ error: S.deny === 403 ? "This invite link has been revoked. Ask the room owner for a new one." : "This room is invite-only. Open your invite link to join." }, S.deny);
    if (p.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 600000\n\nevent: state\ndata: ' + JSON.stringify({ type: 'state', room: 'demo', room_state: roomState(S) }) + '\n\n' });
    if (/\/messages\/\d+\/html$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Probe</title><p>artifact body</p>' });
    if (/\/messages\/\d+\/doc$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Probe doc\n\nRendered **body** here.' });
    if (/\/messages\/\d+\/image$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: require('fs').readFileSync(__dirname + '/../../tests/fixtures/photo.png') });
    if ((am = p.match(/\/messages\/(\d+)\/reactions$/))) {
      const msg = S.msgs.find(x => x.id == am[1]); if (!msg) return J({ error: 'No message' }, 404);
      const r = msg.reactions || {}; Object.keys(r).forEach(k => { r[k] = r[k].filter(x => x.toLowerCase() !== body.from.toLowerCase()); if (!r[k].length) delete r[k]; });
      if (body.reaction) (r[body.reaction] = r[body.reaction] || []).push(body.from);
      msg.reactions = r; return J({ room: 'demo', id: msg.id, reactions: r });
    }
    if (p.endsWith('/messages') && m === 'POST') { const x = { id: ++S.nid, ts: Date.now(), from: body.from, text: body.text }; S.msgs.push(x); return J(Object.assign({}, x, { room_state: roomState(S) }), 201); }
    if (p.endsWith('/messages')) return J(S.agentYou
      ? { room: 'demo', messages: S.msgs, last_id: S.msgs[S.msgs.length - 1].id, you: 'Probe', you_kind: 'agent', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Probe".\nConnect over MCP (Model Context Protocol), the room\'s agent surface:\n  Endpoint: POST https://chat.victorio.cloud/api/rooms/demo/mcp\n  Header: X-Invite-Token: tok_Probe\nSend initialize, then tools/list for the room\'s tools (messages, reactions, the board, games, voice, fetch, uploads). Call whoami and get_room_state first.', room_state: roomState(S) }
      : { room: 'demo', messages: S.msgs, last_id: S.msgs[S.msgs.length - 1].id, you: S.noYou ? undefined : 'Anthony', you_kind: 'human', room_state: roomState(S) });
    if (p.endsWith('/constitution') && m === 'PUT') { S.hist.push(S.con); S.con = { version: S.con.version + 1, ts: Date.now(), editor: body.from, text: body.text }; return J({ constitution: S.con }, 201); }
    if (p.endsWith('/constitution')) return J({ constitution: S.con, history: S.hist.concat([S.con]) });
    let mm;
    if (p.endsWith('/decisions') && m === 'POST') { S.dc.push({ id: ++S.nid, ts: Date.now(), added_by: body.from, title: body.title, note: body.note || null, signers: [] }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/decisions')) return J({ decisions: S.dc });
    if ((mm = p.match(/decisions\/(\d+)$/))) { const d = S.dc.find(x => x.id == mm[1]); if (m === 'DELETE') { S.dc = S.dc.filter(x => x !== d); return J({ ok: 1 }); } if (body.action === 'sign') d.signers.push(body.from); if (body.action === 'unsign') d.signers = d.signers.filter(s => s !== body.from); if (body.action === 'edit') { d.title = body.title; d.note = body.note; } return J({ decision: d }); }
    if (p.endsWith('/questions') && m === 'POST') { S.q.push({ id: ++S.nid, ts: Date.now(), added_by: body.from, text: body.text, status: 'open', claimed_by: null }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/questions')) return J({ questions: S.q, resolved: S.qr });
    if ((mm = p.match(/questions\/(\d+)$/))) { let q = S.q.concat(S.qr).find(x => x.id == mm[1]); if (m === 'DELETE') { S.q = S.q.filter(x => x !== q); S.qr = S.qr.filter(x => x !== q); return J({ ok: 1 }); }
      if (body.action === 'claim') { q.status = 'claimed'; q.claimed_by = body.from; } if (body.action === 'unclaim') { q.status = 'open'; q.claimed_by = null; }
      if (body.action === 'resolve') { q.status = 'resolved'; q.resolved_by = body.from; q.resolution = body.note; S.q = S.q.filter(x => x !== q); S.qr.unshift(q); }
      if (body.action === 'edit') q.text = body.text; return J({ question: q }); }
    if (p.endsWith('/stakes') && m === 'POST') { S.sk.push({ id: ++S.nid, ts: Date.now(), added_by: body.from, title: body.title, date: body.date || null, note: body.note || null }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/stakes')) return J({ stakes: S.sk, done: S.skd });
    if ((mm = p.match(/stakes\/(\d+)$/))) { const s = S.sk.concat(S.skd).find(x => x.id == mm[1]); if (body.action === 'done') { s.done = Date.now(); s.done_by = body.from; S.sk = S.sk.filter(x => x !== s); S.skd.unshift(s); } return J({ stake: s }); }
    if (p.endsWith('/digests') && m === 'POST') { S.dg.unshift({ id: ++S.nid, ts: Date.now(), day: ymd(0), author: body.from, text: body.text }); return J({ ok: 1 }, 201); }
    if (p.includes('/digests')) return J({ digests: S.dg });
    if (p.endsWith('/invites') && m === 'POST') { if (S.mb.members.some(x => x.name.toLowerCase() === body.name.toLowerCase() && x.status !== 'revoked')) return J({ error: body.name + ' already has an active invite.' }, 409); S.mb.members.push({ name: body.name, kind: body.kind, invited_by: 'Anthony', status: 'unused', invited: Date.now() }); const inv = { room: 'demo', name: body.name, kind: body.kind, token: 'tok_' + body.name, link: 'https://chat.victorio.cloud/r/demo#invite=tok_' + body.name, created: Date.now() }; if (body.kind !== 'human') inv.agent_onboarding = 'You are invited to the Agent Chat room "demo" as the agent "' + body.name + '".\nInvite link: ' + inv.link + '\nThen implement the wake recipe and post a short hello.'; return J(inv, 201); }
    if (p.endsWith('/games') && m === 'GET') { const list = [S.bs, S.bsPlay, S.duel, S.game].filter(Boolean); const mid = new Date(); mid.setHours(0, 0, 0, 0); if (S.duel) list.push(Object.assign({}, S.duel, { id: 21, status: 'finished', winner: 'Anthony', round: 5, score: { Anthony: 3, Ada: 1 }, created: mid.getTime() - 50 * 3600e3, ended: mid.getTime() - 48 * 3600e3 + 600e3 })); if (S.bs) { list.push(Object.assign({}, S.bs, { id: 3, status: 'finished', winner: 'Ada', turn: 62, created: mid.getTime() - 8 * 3600e3, ended: mid.getTime() - 3 * 3600e3, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) })); list.push(Object.assign({}, S.bs, { id: 4, status: 'finished', winner: 'Ada', turn: 81, created: Date.now() - 3 * 3600e3, ended: Date.now() - 60e3, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) })); } return J({ room: 'demo', games: list, record: { battleship: [{ name: 'Ada', hex: '#22d3ee', w: 2, l: 0 }, { name: 'Henry', hex: '#fb923c', w: 0, l: 2 }], duel: [{ name: 'Anthony', hex: '#fb923c', w: 1, l: 0 }, { name: 'Ada', hex: '#22d3ee', w: 0, l: 1 }] }, ladder: { battleship: [{ name: 'Ada', hex: '#22d3ee', rating: 1031, w: 2, l: 0, d: 0, last: 15 }, { name: 'Henry', hex: '#fb923c', rating: 969, w: 0, l: 2, d: 0, last: -15 }] } }); }
    if (p.endsWith('/games') && m === 'POST') { const cols = [['cyan', '#22d3ee'], ['orange', '#fb923c'], ['pink', '#f472b6'], ['lime', '#a3e635']]; if (body.game === 'battleship') { const players = (body.players || []).map((n, i) => ({ name: n, color: cols[i][0], hex: cols[i][1], accepted: false, placed: false, shots: 0, hits: 0, sunk: 0, afloat: 5 })); const g = { id: 7, type: 'battleship', status: 'lobby', created_by: 'Anthony', card_msg: null, phase: null, turn: 0, turn_of: null, turn_seconds: body.tick_seconds || 3600, deadline: null, lobby_deadline: Date.now() + 3600e3, winner: null, declined_by: null, players, boards: [], last_move: null, log: [], awaiting: [], awaiting_accept: players.map(p => p.name), you: { playing: false } }; S.bs = g; return J({ room: 'demo', game: g }, 201); } const isDuel = body.game === 'duel'; const players = (body.players || []).map((n, i) => isDuel ? { name: n, color: cols[i][0], hex: cols[i][1], wins: 0, thrown: false, accepted: n === 'Anthony' } : { name: n, color: cols[i][0], hex: cols[i][1], dir: ['right', 'left', 'down', 'up'][i], alive: true, x: 5 + i * 3, y: 5, moved: false, accepted: n === 'Anthony' }); const waiting = (body.players || []).filter(n => n !== 'Anthony'); const g = isDuel ? { id: 7, type: 'duel', status: 'lobby', created_by: 'Anthony', card_msg: null, round: 1, target: Math.floor((body.best_of || 5) / 2) + 1, best_of: body.best_of || 5, round_seconds: body.tick_seconds || 60, deadline: null, lobby_deadline: Date.now() + 3600e3, winner: null, score: {}, players, rounds: [], awaiting: [], awaiting_accept: waiting, you: { playing: true, queued: null, accepted: true } } : { id: 7, type: 'lightcycles', status: 'lobby', created_by: 'Anthony', card_msg: null, w: 30, h: 22, tick: 0, tick_seconds: body.tick_seconds || 120, deadline: null, lobby_deadline: Date.now() + 3600e3, winner: null, players, trails: [], log: [], awaiting: [], awaiting_accept: waiting, you: { playing: true, queued: null, accepted: true } }; if (isDuel) S.duel = g; else S.game = g; return J({ room: 'demo', game: g }, 201); }
    if ((mm = p.match(/games\/(\d+)\/(accept|decline)$/)) && m === 'POST') { const gm = findGame(mm[1]); if (!gm) return J({ error: 'No game' }, 404); if (mm[2] === 'decline') { gm.status = 'cancelled'; gm.declined_by = 'Anthony'; return J({ room: 'demo', game: gm }); } gm.players.forEach(x => { x.accepted = true; }); if (gm.you) gm.you.accepted = true; gm.awaiting_accept = []; gm.status = 'running'; gm.deadline = Date.now() + (gm.round_seconds || gm.tick_seconds || 60) * 1000; return J({ room: 'demo', game: gm }); }
    if ((mm = p.match(/games\/(\d+)\/moves$/)) && m === 'POST') { const gm = findGame(mm[1]); if (!gm) return J({ error: 'No game' }, 404); if (gm.type === 'sketch') { const raw = String(body.dir || '').trim(); if (/^data:image\/png;base64,/.test(raw)) { gm.phase = 'guess'; gm.image = { url: raw, type: 'image/png' }; } else if (raw) { gm.you = Object.assign({}, gm.you, { queued: raw }); gm.players.find((p) => p.name === 'Anthony').committed = true; } else return J({ error: 'bad move' }, 400); return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'trivia') { const raw = String(body.dir || '').trim(); let o = null; try { o = raw[0] === '{' ? JSON.parse(raw) : null; } catch (e) { o = null; } if (o && o.question) { gm.phase = 'answer'; gm.question = o.question; gm.you = Object.assign({}, gm.you, { answer: o.answer, accept: o.accept || [] }); } else if (o && o.answer) { gm.you = Object.assign({}, gm.you, { queued: { answer: o.answer, wager: o.wager || 0 } }); gm.players.find((p) => p.name === 'Anthony').committed = true; } else if (/^accept /.test(raw)) { gm.you = Object.assign({}, gm.you, { to_judge: gm.you.to_judge.map((x) => Object.assign({}, x, { accepted: x.accepted || raw.slice(7) === x.name })) }); } else if (raw !== 'done') return J({ error: 'bad move' }, 400); return J({ room: 'demo', game: gm, resolved: raw === 'done' }); } if (gm.type === 'lettergrid') { const raw = String(body.dir || '').trim().toLowerCase(); const m = raw.match(/^([a-z]+)((?:\s+[a-z]\d)*)$/); if (!m || m[1] === 'qqqq') return J({ error: '"' + (m ? m[1].toUpperCase() : raw) + '" is not in the dictionary - try another' }, 400); const path = m[2].trim() ? m[2].trim().split(/\s+/).map((c) => [Number(c.slice(1)) - 1, c.charCodeAt(0) - 97]) : null; gm.you = Object.assign({}, gm.you, { queued: { word: m[1], path } }); gm.players.find((p) => p.name === 'Anthony').committed = true; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'werewolf') { const raw = String(body.dir || '').trim(); const t = raw.match(/^(say|den):\s*(.+)$/i); if (t) { const line = { n: 9, by: 'Anthony', text: t[2], ch: t[1].toLowerCase() === 'den' || gm.phase === 'night' ? 'den' : 'town', phase: gm.phase, day: gm.night, at: Date.now() }; if (line.ch === 'den') gm.den = (gm.den || []).concat([line]); else gm.talk = gm.talk.concat([line]); return J({ room: 'demo', game: gm, resolved: false }); } const m = raw.match(/^(kill|vote)\s+(\w+)$/i); if (!m) return J({ error: 'Name a player' }, 400); if (gm.phase === 'night') gm.you = Object.assign({}, gm.you, { act: m[2] }); else { gm.you = Object.assign({}, gm.you, { vote: m[2] }); gm.votes = Object.assign({}, gm.votes, { Anthony: m[2] }); gm.players.find((p) => p.name === 'Anthony').voted = true; } return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'twenty') { const raw = String(body.dir || '').trim(); if (gm.you.answerer) { const m = raw.match(/^(yes|no)\b/i); if (!m) return J({ error: 'Answer yes or no' }, 400); const p = gm.qa.find((x) => gm.pending && x.n === gm.pending.n); p.a = m[1].toLowerCase(); p.note = raw.replace(/^(yes|no)\s*-?\s*/i, '') || null; gm.asked += 1; gm.remaining -= 1; gm.phase = 'ask'; gm.pending = null; return J({ room: 'demo', game: gm, resolved: false }); } if (!raw) return J({ error: 'Ask a question' }, 400); const e = { n: gm.qa.length + 1, by: 'Anthony', kind: /^guess/i.test(raw) ? 'guess' : 'q', q: raw.replace(/^guess:\s*/i, ''), a: null, note: null, flagged: false }; gm.qa.push(e); gm.pending = e; gm.phase = 'answer'; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'corpse') { const raw = String(body.dir || '').trim(); if (gm.phase === 'write') { if (!raw) return J({ error: 'Send your segment' }, 400); gm.segments += 1; gm.beats.push({ turn: gm.turn, by: 'Anthony', wrote: true }); gm.turn += 1; gm.turn_of = 'Ada'; gm.players.find((p) => p.name === 'Anthony').segments = 1; gm.you = Object.assign({}, gm.you, { writer: false, tail: undefined, segments: [3] }); return J({ room: 'demo', game: gm, resolved: true }); } const v = Number(raw); if (!(v === 1 || v === 2)) return J({ error: 'You cannot vote for your own segment' }, 400); gm.you = Object.assign({}, gm.you, { vote: v }); gm.players.find((p) => p.name === 'Anthony').committed = true; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'twotruths') { const raw = String(body.dir || ''); if (gm.phase === 'write') { let o = null; try { o = JSON.parse(raw); } catch (e) {} if (!o || !Array.isArray(o.statements) || o.statements.length !== 3) return J({ error: 'Send exactly three statements' }, 400); gm.phase = 'vote'; gm.statements = o.statements; gm.players.forEach((p) => (p.committed = false)); gm.you = Object.assign({}, gm.you, { statements: o.statements, lie: o.lie }); return J({ room: 'demo', game: gm, resolved: false }); } const v = Number(raw); if (!(v >= 1 && v <= 3)) return J({ error: 'dir is 1, 2 or 3' }, 400); gm.you = Object.assign({}, gm.you, { vote: v }); gm.players.find((p) => p.name === 'Anthony').committed = true; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'liarsdice') { const raw = String(body.dir || '').trim().toLowerCase(); if (raw === 'liar') { gm.rounds.push({ n: gm.round, at: Date.now(), cups: { Ada: [2, 4, 4, 5, 6], Anthony: [1, 3, 4, 4, 6], Henry: [3, 4, 5, 6] }, bids: gm.bids.slice(), reason: 'call', call: { by: 'Anthony', bid: gm.bid }, face: gm.bid.face, count: 6, stands: true, loser: 'Anthony', out: false, dice_left: 4 }); gm.players[1].dice = 4; gm.dice_total = 13; gm.round += 1; gm.bid = null; gm.bids = []; gm.turn += 1; gm.you = Object.assign({}, gm.you, { dice: [2, 2, 5, 6], your_turn: true, legal_moves: ['1x2', '1x3', '1x4', '1x5', '1x6'] }); return J({ room: 'demo', game: gm, resolved: true }); } const m = raw.match(/^(\d+)x([1-6])$/); if (!m) return J({ error: 'dir is a bid like 3x4, or liar', legal_moves: gm.you.legal_moves }, 400); gm.bid = { by: 'Anthony', qty: +m[1], face: +m[2], at: Date.now() }; gm.bids.push(gm.bid); gm.turn += 1; gm.turn_of = 'Henry'; gm.awaiting = ['Henry']; gm.you = Object.assign({}, gm.you, { your_turn: false, legal_moves: [] }); return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'auction') { const raw = String(body.dir || '').trim(); const v = raw === 'pass' ? 0 : Number(raw); if (!(v >= 0 && v <= gm.you.budget)) return J({ error: 'you have ' + gm.you.budget + ' left' }, 400); gm.you.queued = v; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = ['Henry']; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'trust') { const q = {}; for (const t of String(body.dir || '').split(',')) { const m = t.trim().match(/^(\w+):([CD])$/); if (m) q[m[1]] = m[2]; } if (Object.keys(q).length !== 2) return J({ error: 'one choice per rival' }, 400); gm.you.queued = q; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = ['Henry']; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'fourinarow') { const c = Number(body.dir); if (!(c >= 1 && c <= 7)) return J({ error: 'dir is a column, 1 to 7 from the left', legal_moves: gm.you.legal_moves }, 400); const cells = gm.board.map((x) => x.split('')); let k = 5; while (k >= 0 && cells[k][c - 1] !== '.') k -= 1; if (k < 0) return J({ error: 'Column ' + c + ' is full', legal_moves: gm.you.legal_moves }, 400); cells[k][c - 1] = 'X'; gm.board = cells.map((x) => x.join('')); gm.last_move = { n: gm.moves.length + 1, by: 'Anthony', col: c, row: 6 - k }; gm.moves.push(gm.last_move); gm.turn += 1; gm.turn_of = 'Ada'; gm.awaiting = ['Ada']; gm.you = Object.assign({}, gm.you, { your_turn: false, legal_moves: [] }); return J({ room: 'demo', game: gm, resolved: true }); } if (gm.type === 'coderace') { const raw = String(body.dir || ''); const v = gm.mode === 'words' ? raw.toLowerCase().replace(/[^a-z]/g, '') : raw.toUpperCase().replace(/[^A-Z]/g, ''); if (v.length !== gm.length) return J({ error: 'a guess is ' + gm.length + ' long' }, 400); if (gm.mode === 'words' && v === 'xqzzt') return J({ error: '"xqzzt" is not in the word list - try another 5-letter word' }, 400); gm.you.queued = v; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = gm.awaiting.filter(n => n !== 'Anthony'); return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'frontlines') { const split = String(body.dir).split(',').map(Number); if (split.length !== 5 || split.reduce((a, b) => a + b, 0) !== 100) return J({ error: 'the five numbers must add up to exactly 100' }, 400); gm.you.queued = split; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = []; return J({ room: 'demo', game: gm, resolved: false }); } gm.you.queued = body.dir; const pl = gm.players.find(x => x.name === 'Anthony'); if (pl) { pl.moved = true; pl.thrown = true; } if (gm.awaiting) gm.awaiting = gm.awaiting.filter(n => n !== 'Anthony'); return J({ room: 'demo', game: gm, resolved: false }); }
    if ((mm = p.match(/games\/(\d+)$/))) { const gm = mm[1] === '4' && S.bs ? Object.assign({}, S.bs, { id: 4, status: 'finished', winner: 'Ada', turn: 81, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) }) : findGame(mm[1]); if (!gm) return J({ error: 'No game with that id' }, 404); return J({ room: 'demo', game: gm }); }
    if (p.endsWith('/attachments')) {
      const all = S.shelf || [];
      const kinds = (u.searchParams.get('kind') || '').split(',').filter(Boolean);
      const fromF = (u.searchParams.get('from') || '').toLowerCase();
      const lim = parseInt(u.searchParams.get('limit') || '60', 10);
      const counts = { all: 0, image: 0, video: 0, audio: 0, speak: 0, html: 0, doc: 0 };
      for (const a of all) { if (!fromF || a.from.toLowerCase() === fromF) { counts[a.kind]++; counts.all++; } }
      let list = all.filter(a => (!kinds.length || kinds.includes(a.kind)) && (!fromF || a.from.toLowerCase() === fromF));
      const before = u.searchParams.get('before');
      if (before) { const i = list.findIndex(a => (a.id + ':' + a.kind) === before); list = i >= 0 ? list.slice(i + 1) : []; }
      const pageItems = list.slice(0, lim);
      const next = list.length > lim && pageItems.length ? pageItems[pageItems.length - 1].id + ':' + pageItems[pageItems.length - 1].kind : null;
      return J({ room: 'demo', attachments: pageItems, counts, next_cursor: next });
    }
    if (p.endsWith('/members')) return J(S.mb);
    return route.fulfill({ status: 404, body: 'nf' });
  });
}
let FAILURES = 0;
(async () => {
  const shot = (page, f) => page.screenshot({ path: OUT + f });
  async function run(name, o, fn) {
    // ONLY=name1,name2 runs just those scenarios (a quick re-check)
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
    const b = await chromium.launch({ args: o.args || [] });
    const ctx = await b.newContext({ colorScheme: o.scheme || 'light', viewport: { width: o.w || 1280, height: o.h || 860 }, userAgent: o.ua, hasTouch: !!o.touch, isMobile: !!o.touch });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    const S = fresh(o.state); const calls = [];
    await setup(page, S, calls);
    if (o.init) await page.addInitScript(o.init);
    try {
      await page.goto('https://chat.victorio.cloud/r/demo' + (o.hash || ''));
      await page.waitForTimeout(500);
      const r = await fn(page, S, calls);
      const fatal = errs.filter(e => !e.startsWith('console:'));
      if (fatal.length) throw new Error('uncaught page errors: ' + JSON.stringify(fatal));
      console.log('PASS ' + name + (r ? ' ' + JSON.stringify(r) : ''));
    } catch (e) {
      FAILURES++;
      console.log('FAIL ' + name + ': ' + (e && e.message ? String(e.message).split('\n')[0] : String(e)));
    } finally {
      await b.close();
    }
  }
  // M1 smoke scenario (not a parity item): proves the harness discriminates
  // and the skeleton's wiring works — invite fragment stored and scrubbed,
  // fixture messages fetched through the typed client and rendered.
  await run('skeleton', { hash: '#invite=tok_Anthony' }, async (page) => {
    const out = {};
    await page.waitForSelector('.msg', { timeout: 4000 });
    out.msgs = await page.$$eval('.msg', els => els.length);
    out.stored = await page.evaluate(() => { try { return localStorage.getItem('chat-invite:demo'); } catch (e) { return null; } });
    out.hashAfter = await page.evaluate(() => location.hash);
    if (out.msgs < 5) throw new Error('skeleton should render the fixture messages, got ' + out.msgs);
    if (out.stored !== 'tok_Anthony') throw new Error('invite not stored under chat-invite:demo: ' + out.stored);
    if (out.hashAfter !== '') throw new Error('invite fragment not scrubbed: ' + out.hashAfter);
    await shot(page, 'skeleton.png');
    return out;
  });
  await run('duel-card', { state: { duel: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 4000 });
    out.pill = await page.$eval('.game-card .duel-pill', e => e.textContent);
    out.pipColor = await page.$eval('.game-card .duel-row .duel-pips', e => getComputedStyle(e).color);
    out.faceoff = await page.$eval('.game-card .duel-faceoff-line', e => e.textContent);
    out.clockbar = await page.$$eval('.game-card .duel-clockbar', els => els.length);
    if (!/YOUR THROW/.test(out.pill)) throw new Error('card pill wrong: ' + out.pill);
    if (out.pipColor !== 'rgb(34, 211, 238)') throw new Error('Ada pips should be her cyan, got ' + out.pipColor);
    if (!/CLASH/.test(out.faceoff)) throw new Error('card face-off should name the clash: ' + out.faceoff);
    if (out.clockbar !== 1) throw new Error('card should carry one round clock bar, got ' + out.clockbar);
    await shot(page, 'duel-card.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 4000 });
    out.tiles = await page.$$eval('#viewer .duel-tile .t-beats', els => els.map(e => e.textContent));
    out.status = await page.$eval('#viewer .duel-statusline', e => e.textContent);
    out.verdict = await page.$eval('#viewer .duel-verdict', e => e.textContent);
    if (JSON.stringify(out.tiles) !== JSON.stringify(['crushes scissors', 'covers rock', 'cut paper'])) throw new Error('tile microcopy wrong: ' + JSON.stringify(out.tiles));
    if (!/your throw decides the round/.test(out.status)) throw new Error('status line wrong: ' + out.status);
    if (!/CLASH/.test(out.verdict)) throw new Error('verdict banner should name the clash: ' + out.verdict);
    await shot(page, 'duel-arena.png');
    await page.click('#viewer .duel-tile:nth-child(3)');
    await page.waitForFunction(() => document.querySelector('#viewer .duel-tile.queued'), null, { timeout: 4000 });
    out.moveCall = calls.filter(c => c.includes('/games/2/moves')).pop() || '';
    if (!/"dir":"scissors"/.test(out.moveCall)) throw new Error('move call wrong: ' + out.moveCall);
    await shot(page, 'duel-arena-queued.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return out;
  });
  await run('battleship-spectator', { state: { bs: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    out.minis = await page.$$eval('.game-card .bs-mini-svg', els => els.length);
    out.lastline = await page.$eval('.game-card .bs-lastline', e => e.textContent);
    out.cardStrips = await page.$$eval('.game-card .bs-strip', els => els.length);
    if (out.minis !== 2) throw new Error('card should show two mini boards, got ' + out.minis);
    if (!/Ada fires A7/.test(out.lastline)) throw new Error('card last-shot line wrong: ' + out.lastline);
    if (out.cardStrips !== 2) throw new Error('card should show two fleet strips, got ' + out.cardStrips);
    await shot(page, 'bs-card.png');
    await page.click('.game-card');
    // two captains: the 3D scene is the only arena view (2D retired 2026-11-20)
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host', { timeout: 6000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    out.banner = await page.$eval('#viewer .bs-verdict', e => e.textContent);
    out.note = await page.$eval('#viewer .lc-note', e => e.textContent);
    if (out.grids !== 0) throw new Error('two captains spectate on the 3D scene, no 2D boards; got ' + out.grids);
    if (!/Ada fires A7 · HIT/.test(out.banner)) throw new Error('arena banner wrong: ' + out.banner);
    if (!/un-hit ships stay hidden/.test(out.note)) throw new Error('spectator note wrong: ' + out.note);
    await shot(page, 'bs-spectator-arena.png');
    if (await page.$('#viewer .lc-log') !== null) throw new Error('the plain-text record should be gone from the game tab');
    await page.click('#viewer .arena-tabs .arena-tab:nth-child(2)');
    await page.waitForSelector('#viewer .hist-row', { timeout: 4000 });
    out.histRows = await page.$$eval('#viewer .hist-row', els => els.length);
    out.histText = await page.$eval('#viewer .hist-list', e => e.textContent);
    if (out.histRows !== 2) throw new Error('history should render one row per record entry, got ' + out.histRows);
    if (!/I9/.test(out.histText) || !/Hit/.test(out.histText) || !/Sunk · 5/.test(out.histText)) throw new Error('history rows should carry cell badges and outcome pills: ' + out.histText);
    await shot(page, 'bs-spectator-history.png');
    return out;
  });
  await run('battleship-spectator-mobile-dark', { state: { bs: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await shot(page, 'bs-card-mobile-dark.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host canvas', { timeout: 20000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    if (out.grids !== 0) throw new Error('mobile spectator: the 3D scene only, got ' + out.grids + ' 2D boards');
    await shot(page, 'bs-spectator-mobile-dark.png');
    return out;
  });
  await run('battleship-player', { state: { bsPlay: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.click('.game-card');
    // the scene, then both fleet strips under it; firing is the scene's
    // (battleship-3d-keyboard, battleship-3d-phone-aim-fire, no-webgl-battleship)
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host', { timeout: 6000 });
    out.banner = await page.$eval('#viewer .bs-verdict', e => e.textContent);
    out.strips = await page.$$eval('#viewer .bs-strips3d .bs-strip3d', els => els.length);
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    if (out.strips !== 2) throw new Error('arena should show two fleet strips, got ' + out.strips);
    if (out.grids !== 0) throw new Error('no 2D boards for two captains, got ' + out.grids);
    if (!/Ada fires H5 · HIT/.test(out.banner)) throw new Error('player banner wrong: ' + out.banner);
    out.warn = await page.$eval('#viewer .bs-warn', e => e.textContent);
    if (!/Anthony has missed 2 turns in a row/.test(out.warn) || !/forfeits/.test(out.warn)) throw new Error('two missed turns should carry the forfeit warning: ' + out.warn);
    await shot(page, 'bs-player-arena.png');
    return out;
  });
  // Free-for-all (2026-11-17; in 3D since 2026-11-20): a four-captain
  // match is one scene - your waters plus one ocean per rival, the
  // eliminated captain a grey wreck chart - with every captain's fleet
  // strip under it and no 2D boards. The keyboard aims at the first
  // live rival; an arrow past the right edge crosses to the next one,
  // and the shot names its target.
  await run('battleship-ffa', { state: { bsFfa: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    out.cardText = await page.$eval('.game-card', e => e.textContent);
    if (!/eliminated/.test(out.cardText)) throw new Error('card scoreboard should mark the eliminated captain: ' + out.cardText.slice(0, 200));
    await page.click('.game-card');
    await page.waitForSelector('#viewer .arena3d-frame[tabindex="0"]', { timeout: 20000 });
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    out.strips = await page.$$eval('#viewer .bs-strips3d .bs-strip3d-label', els => els.map((e) => e.textContent));
    out.banner = await page.$eval('#viewer .bs-verdict', e => e.textContent);
    out.label = await page.$eval('#viewer .arena3d-frame', e => e.getAttribute('aria-label'));
    if (out.grids !== 0) throw new Error('no 2D boards in a free-for-all with WebGL, got ' + out.grids);
    if (out.strips.length !== 4 || out.strips[0] !== 'Your fleet' || !/^Hank — wreck$/.test(out.strips[3])) throw new Error('every captain\'s fleet strip, the wreck marked: ' + JSON.stringify(out.strips));
    if (!/Ada fires H5 · HIT/.test(out.banner)) throw new Error('ffa banner wrong: ' + out.banner);
    if (!/Ada's waters/.test(out.label) || !/next rival/.test(out.label)) throw new Error('the frame names the aimed rival and the crossing: ' + out.label);
    await page.waitForTimeout(600);
    await shot(page, 'bs-ffa-arena.png');
    await page.focus('#viewer .arena3d-frame');
    await page.keyboard.press('ArrowRight');
    out.aimed = await page.$eval('#viewer .arena3d-frame .sr-only', e => e.textContent);
    if (!/^Ada's F5, open water/.test(out.aimed)) throw new Error('ArrowRight from E5 should aim at Ada\'s F5, said: ' + out.aimed);
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    out.crossed = await page.$eval('#viewer .arena3d-frame .sr-only', e => e.textContent);
    if (!/^Henry's A5, open water/.test(out.crossed)) throw new Error('past column J the aim crosses to Henry\'s A5, said: ' + out.crossed);
    const before = calls.length;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    out.moveCall = calls.slice(before).filter(c => c.includes('/games/9/moves')).pop() || '';
    if (!/"dir":"Henry:A5"/.test(out.moveCall)) throw new Error('ffa fire call should name its target, got: ' + out.moveCall);
    return out;
  });
  /* Phone: one ocean at a time behind a cycler (‹ name n/N ›: a pill
     per captain ran under the frame's tools); on your turn the aimed
     rival's ocean shows, a tap aims and Fire fires at that captain;
     cycling to another live rival retargets. */
  await run('battleship-ffa-mobile', { state: { bsFfa: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.tap('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const showing = () => page.$eval('#viewer .arena3d-cycle-name', (e) => e.textContent + (e.classList.contains('wreck') ? '~' : ''));
    out.showing = await showing();
    if (out.showing !== 'Ada2/4') throw new Error('Ada\'s ocean up on your turn, 2 of 4: ' + out.showing);
    out.tools = await page.evaluate(() => { const a = document.querySelector('#viewer .arena3d-cycle').getBoundingClientRect(); const b = document.querySelector('#viewer .arena3d-tools').getBoundingClientRect(); return { cycleRight: Math.round(a.right), toolsLeft: Math.round(b.left) }; });
    if (out.tools.cycleRight > out.tools.toolsLeft) throw new Error('the cycler must clear the frame\'s tools: ' + JSON.stringify(out.tools));
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    if (out.grids !== 0) throw new Error('no 2D boards on the phone either, got ' + out.grids);
    await shot(page, 'bs-ffa-mobile-dark.png');
    await page.tap('#viewer .arena3d-cycle button[aria-label="Next ocean"]');
    await page.waitForTimeout(300);
    out.after = await showing();
    await page.tap('#viewer .arena3d-cycle button[aria-label="Next ocean"]');
    await page.waitForTimeout(300);
    out.wreck = await showing();
    await page.tap('#viewer .arena3d-cycle button[aria-label="Previous ocean"]');
    await page.waitForTimeout(500);
    if (out.after !== 'Henry3/4' || out.wreck !== 'Hank4/4~') throw new Error('Next steps to Henry, then the struck-through wreck: ' + out.after + ' / ' + out.wreck);
    const box = await (await page.$('#viewer .lc-3d-host canvas')).boundingBox();
    const before = calls.length;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.55);
    await page.waitForTimeout(500);
    if (calls.slice(before).some((c) => /\/moves/.test(c))) throw new Error('a tap must aim, not fire');
    out.fireText = await page.$eval('#viewer .arena3d-fire', (e) => e.textContent).catch(() => null);
    if (!out.fireText || !/^Fire at Henry's [A-J]\d+$/.test(out.fireText)) throw new Error('the Fire button names Henry\'s cell, got ' + out.fireText);
    await shot(page, 'bs-ffa-mobile-aimed.png');
    await page.tap('#viewer .arena3d-fire');
    await page.waitForTimeout(600);
    const moves = calls.slice(before).filter((c) => /\/games\/9\/moves/.test(c));
    const cell = out.fireText.slice('Fire at Henry\'s '.length);
    if (moves.length !== 1 || moves[0].indexOf('"Henry:' + cell + '"') < 0) throw new Error('Fire should send one move at Henry:' + cell + ': ' + JSON.stringify(moves));
    return out;
  });
  await run('battleship-3d-default', { state: { bsPlay: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.click('.game-card');
    /* 20s, not the usual 4-8s: the canvas waits on the lazy three.js
       chunk loading plus software-GL init, which runs long on a
       loaded box - an 8s wait flaked twice on 2026-11-12 while the
       scene itself rendered fine. */
    await page.waitForSelector('#viewer:not([hidden]) .lc-3d-host canvas', { timeout: 20000 });
    out.toggle = !!(await page.$('#viewer .lc-view-btn'));
    if (out.toggle) throw new Error('the 2D views are retired: no 2D/3D toggle');
    if (await page.$('#viewer .bs-grid') !== null) throw new Error('two captains play on the 3D scene only, no 2D grids');
    await shot(page, 'bs-3d-default.png');
    return out;
  });
  /* A deploy deletes the hashed chunk an open page was built against:
     the 3D host must say so with a Reload button, not sit blank, and
     the failed import must not surface as an uncaught page error. */
  await run('battleship-3d-load-failure', { state: { bsPlay: true } }, async (page) => {
    await page.route(/\/assets\/BsArena3D-.*\.js$/, (route) => route.fulfill({ status: 404, body: 'nf' }));
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.click('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && !s.hidden && /didn't load/.test(s.textContent) && s.querySelector('button'); }, null, { timeout: 20000 });
    return { status: await page.$eval('#viewer .arena3d-status', e => e.textContent) };
  });
  /* No WebGL (2026-11-20, the 2D views are retired): the arena box
     shrinks to one note and the game plays on with the controls under
     it - Battleship's two-captain view gives their waters as a plain
     aiming grid (the scene was the only way to fire), Four in a Row
     keeps its drop buttons. No Reload button: a reload won't help. */
  const noGl = () => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : g.call(this, t, ...a); }; };
  for (const [label, o] of [['no-webgl-battleship', {}], ['no-webgl-battleship-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { bsPlay: true }, init: noGl }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
      await page.click('.game-card');
      await page.waitForSelector('#viewer .bs-3d-host.no-3d .arena3d-status', { timeout: 8000 });
      out.status = await page.$eval('#viewer .arena3d-status', (e) => e.textContent);
      out.reload = !!(await page.$('#viewer .arena3d-status button'));
      out.hostH = await page.$eval('#viewer .bs-3d-host', (e) => e.getBoundingClientRect().height);
      out.grids = await page.$$eval('#viewer .bs-aim .bs-grid', (g) => g.length);
      await shot(page, label + '.png');
      const cell = await page.$('#viewer .bs-aim .bs-cell:not(.miss):not(.hit):not(.sunk)');
      if (cell) await cell.click();
      await page.waitForTimeout(400);
      out.fire = calls.filter((c) => /\/games\/\d+\/moves/.test(c)).pop() || '';
      if (!/3D isn't available on this device/.test(out.status)) throw new Error('the note: ' + out.status);
      if (out.reload) throw new Error('no Reload button when the device has no WebGL');
      if (out.hostH > 90) throw new Error('the empty arena box should shrink to the note, got ' + out.hostH + 'px');
      if (out.grids !== 1) throw new Error('their waters as the aiming grid: ' + out.grids);
      if (!out.fire) throw new Error('a tap on the aiming grid fires');
      return out;
    });
  }
  // A free-for-all without WebGL: your waters plus one board per rival
  // follow the note, the wreck has no fire buttons, a tap names its target.
  await run('no-webgl-battleship-ffa', { state: { bsFfa: true }, init: noGl }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer .bs-3d-host.no-3d .arena3d-status', { timeout: 8000 });
    out.grids = await page.$$eval('#viewer .bs-boards .bs-grid', els => els.length);
    out.wrecks = await page.$$eval('#viewer .bs-side.bs-wreck', els => els.length);
    out.ring = await page.$$eval('#viewer .bs-cell.bs-last', els => els.length);
    if (out.grids !== 4) throw new Error('four boards (yours + three rivals), got ' + out.grids);
    if (out.wrecks !== 1) throw new Error('exactly one wreck board expected, got ' + out.wrecks);
    if (out.ring !== 1) throw new Error('the last shot should ring only on its target board, got ' + out.ring);
    const hankSide = page.locator('#viewer .bs-side').filter({ hasText: "Hank's waters" });
    out.wreckButtons = await hankSide.locator('button.bs-cell').count();
    if (out.wreckButtons !== 0) throw new Error('a wreck board must not offer fire buttons, got ' + out.wreckButtons);
    await shot(page, 'no-webgl-battleship-ffa.png');
    const adaSide = page.locator('#viewer .bs-side').filter({ hasText: "Ada's waters" });
    await adaSide.locator('button.bs-cell[aria-label="Fire at C7"]').click();
    await page.waitForTimeout(400);
    out.moveCall = calls.filter(c => c.includes('/games/9/moves')).pop() || '';
    if (!/"dir":"Ada:C7"/.test(out.moveCall)) throw new Error('ffa fire call should name its target, got: ' + out.moveCall);
    return out;
  });
  // A spectator has no aiming grid: without WebGL the two captains'
  // boards follow the note (with WebGL they are not built at all).
  for (const [label, o] of [['no-webgl-battleship-spectator', {}], ['no-webgl-battleship-spectator-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { bs: true }, init: noGl }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
      await page.click('.game-card');
      await page.waitForSelector('#viewer .bs-3d-host.no-3d .arena3d-status', { timeout: 8000 });
      out.status = await page.$eval('#viewer .arena3d-status', (e) => e.textContent);
      out.grids = await page.$$eval('#viewer .bs-boards .bs-grid', (g) => g.length);
      out.fire = await page.$$eval('#viewer .bs-boards button.bs-cell', (b) => b.length);
      await shot(page, label + '.png');
      if (!/3D isn't available on this device/.test(out.status)) throw new Error('the note: ' + out.status);
      if (out.grids !== 2) throw new Error('both captains\' waters follow the note: ' + out.grids);
      if (out.fire !== 0) throw new Error('a spectator cannot fire: ' + out.fire);
      return out;
    });
  }
  await run('no-webgl-fourinarow', { state: { c4: true }, init: noGl }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card.kind-fourinarow', { timeout: 6000 });
    await page.click('.game-card.kind-fourinarow');
    await page.waitForSelector('#viewer .no-3d .arena3d-status', { timeout: 8000 });
    out.status = await page.$eval('#viewer .arena3d-status', (e) => e.textContent);
    out.drops = await page.$$eval('#viewer .c4-under button', (b) => b.length);
    if (!/3D isn't available on this device/.test(out.status)) throw new Error('the note: ' + out.status);
    if (out.drops < 7) throw new Error('the drop buttons stay: ' + out.drops);
    return out;
  });
  /* Keyboard play in the 3D arena: the frame takes focus, arrow keys
     aim from the centre cell (E5), Enter fires through the same move
     call a tap makes, and the live region speaks each step. */
  await run('battleship-3d-keyboard', { state: { bsPlay: true } }, async (page, S, calls) => {
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer .arena3d-frame[tabindex="0"]', { timeout: 20000 });
    await page.focus('#viewer .arena3d-frame');
    await page.keyboard.press('ArrowRight');
    const aimed = await page.$eval('#viewer .arena3d-frame .sr-only', e => e.textContent);
    if (!/^F5, /.test(aimed)) throw new Error('ArrowRight from E5 should aim at F5, said: ' + aimed);
    const before = calls.length;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const moves = calls.slice(before).filter((c) => /\/games\/6\/moves/.test(c));
    if (!moves.length || !/"F5"/.test(moves[0])) throw new Error('Enter should fire at F5, calls: ' + JSON.stringify(moves));
    return { aimed, fired: moves[0] };
  });
  /* Phone (touch, 390 px): the 3D arena shows one ocean - the enemy's
     on your turn - and a tap only aims; the Fire button fires. */
  await run('battleship-3d-phone-aim-fire', { state: { bsPlay: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page, S, calls) => {
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.tap('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const swap = await page.$$eval('#viewer .arena3d-swap button', (bs) => bs.map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')));
    if (swap.length !== 2 || !/\*$/.test(swap[1] || '')) throw new Error('the enemy ocean should be the one shown on your turn: ' + JSON.stringify(swap));
    const box = await (await page.$('#viewer .lc-3d-host canvas')).boundingBox();
    const before = calls.length;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.55);
    await page.waitForTimeout(500);
    if (calls.slice(before).some((c) => /\/moves/.test(c))) throw new Error('a tap must aim, not fire');
    const fireText = await page.$eval('#viewer .arena3d-fire', (e) => e.textContent).catch(() => null);
    if (!fireText || !/^Fire at [A-J]\d+$/.test(fireText)) throw new Error('a tap should offer a Fire button, got ' + fireText);
    await page.tap('#viewer .arena3d-fire');
    await page.waitForTimeout(600);
    const moves = calls.slice(before).filter((c) => /\/games\/6\/moves/.test(c));
    const cell = fireText.slice(8);
    if (moves.length !== 1 || moves[0].indexOf('"' + cell + '"') < 0) throw new Error('Fire should send one move at ' + cell + ': ' + JSON.stringify(moves));
    await shot(page, 'bs-3d-phone-aimed.png');
    return { swap, fired: moves[0] };
  });
  // Touch screens: the page owns touch until Move is on (two-finger camera
  // gestures were unreliable - a drifting first finger handed the gesture to
  // the browser, which scrolled or, on iOS, zoomed the page).
  await run('arena-3d-phone-move-mode', { state: { bsPlay: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => {
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.tap('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    const ta = () => page.$eval('#viewer .lc-3d-host canvas', (e) => getComputedStyle(e).touchAction);
    const btn = () => page.$eval('#viewer .arena3d-move', (e) => e.getAttribute('aria-pressed') + ' ' + e.textContent.trim());
    const before = { btn: await btn(), ta: await ta() };
    if (!/^false .*Move$/.test(before.btn) || before.ta !== 'pan-y') throw new Error('Move should start off with the page owning touch: ' + JSON.stringify(before));
    await page.tap('#viewer .arena3d-move');
    await page.waitForTimeout(200);
    const on = { btn: await btn(), ta: await ta() };
    if (!/^true .*Done$/.test(on.btn) || on.ta !== 'none') throw new Error('Move should hand touch to the scene: ' + JSON.stringify(on));
    await page.tap('#viewer .arena3d-move');
    await page.waitForTimeout(200);
    const off = { btn: await btn(), ta: await ta() };
    if (!/^false/.test(off.btn) || off.ta !== 'pan-y') throw new Error('Done should hand touch back to the page: ' + JSON.stringify(off));
    return { before, on, off };
  });
  await run('battleship-setup', { state: { bsSetup: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 4000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) button.bs-cell[aria-label="Place at A8"]', { timeout: 4000 });
    await page.click('#viewer .duel-pad .duel-btn:nth-child(1)');
    await page.click('#viewer button.bs-cell[aria-label="Place at A8"]');
    out.note = await page.$eval('#viewer .lc-note', e => e.textContent);
    if (!/runs off the board/.test(out.note)) throw new Error('off-board placement should be refused: ' + out.note);
    out.ships0 = await page.$$eval('#viewer .bs-cell.ship', els => els.length);
    if (out.ships0 !== 0) throw new Error('no hull should be down yet, got ' + out.ships0);
    const count = async () => page.$$eval('#viewer .bs-cell.ship', els => els.length);
    out.steps = [];
    await page.click('#viewer .duel-pad .duel-btn:nth-child(1)');
    await page.click('#viewer button.bs-cell[aria-label="Place at B2"]');
    out.steps.push(await count());
    await page.click('#viewer .duel-pad .duel-btn:nth-child(1)');
    await page.click('#viewer button.bs-cell[aria-label="Place at H4"]');
    out.steps.push(await count());
    await page.click('#viewer .duel-pad .duel-btn:nth-child(1)');
    await page.click('#viewer button.bs-cell[aria-label="Place at A9"]');
    out.steps.push(await count());
    await page.click('#viewer .duel-pad .duel-btn:nth-child(1)');
    await page.click('#viewer button.bs-cell[aria-label="Place at J1"]');
    out.steps.push(await count());
    await page.click('#viewer button.bs-cell[aria-label="Place at E5"]');
    out.steps.push(await count());
    out.ships = await count();
    if (out.ships !== 17) throw new Error('the full fleet should be down, steps ' + JSON.stringify(out.steps));
    await shot(page, 'bs-setup-placed.png');
    await page.click('#viewer .duel-pad .duel-btn:nth-child(4)');
    await page.waitForTimeout(400);
    out.moveCall = calls.filter(c => c.includes('/games/8/moves')).pop() || '';
    if (!/"dir":"B2H,H4V,A9H,J1V,E5V"/.test(out.moveCall)) throw new Error('placement call wrong: ' + out.moveCall);
    return out;
  });
  /* The Games tab (2026-11-19): Live · History · Standings tabs. Live
     opens first when matches wait on you (badge = how many); History
     files ended matches as compact rows under day groups, filterable by
     game; Standings carries the room record. Arrow keys move between
     tabs; a history row opens its arena; Rematch re-creates the match. */
  await run('games-tab', { state: { bs: true, bsPlay: true, duel: true, game: true }, init: () => { try { localStorage.setItem('ac-games-tab', 'history'); } catch (e) {} } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 4000 });
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#view-games .gm-row', { timeout: 4000 });
    out.selected = await page.$eval('#view-games [role="tab"][aria-selected="true"]', e => e.textContent);
    if (!/^Live/.test(out.selected)) throw new Error('with matches waiting on you, Live should open first (even after History was last used): ' + out.selected);
    out.badge = await page.$eval('#view-games .gm-tab-badge', e => e.textContent);
    if (out.badge !== '3') throw new Error('the Live tab should badge the 3 matches waiting on you, got ' + out.badge);
    out.rows = await page.$$eval('#view-games .gm-row', els => els.length);
    out.live = await page.$$eval('#view-games .gm-live', els => els.length);
    if (out.rows !== 4 || out.live !== 4) throw new Error('Live should list the four live matches, got ' + out.rows + ' rows / ' + out.live + ' live');
    if (await page.$('#view-games .gm-hrow') !== null) throw new Error('past matches should not show on the Live tab');
    if (await page.$('#view-games .gm-head .btn.primary') !== null) throw new Error('the header should no longer carry a New game button (Start a match lives in Live)');
    out.start = await page.$eval('#view-games .gm-panel-live .gm-start-btn', e => e.textContent);
    if (out.start !== 'Start a match') throw new Error('the Live tab should carry Start a match, got ' + out.start);
    // the your-move chime: a speaker toggle that explains itself
    const chime = '#view-games .gm-chime-btn';
    out.chime = await page.$eval(chime, e => e.getAttribute('aria-label') + '|' + e.getAttribute('aria-pressed'));
    if (out.chime !== 'Your-move chime|true') throw new Error('the chime toggle should be labelled and on by default: ' + out.chime);
    await page.hover(chime);
    await page.waitForSelector('#view-games .gm-tip.on', { timeout: 2000 });
    out.tip = await page.$eval('#view-games .gm-tip', e => e.textContent);
    if (!/short sound plays when a match is waiting on you/.test(out.tip)) throw new Error('hovering the chime should explain it: ' + out.tip);
    await page.click(chime);
    out.afterTap = await page.$eval(chime, e => e.getAttribute('aria-pressed')) + '|' + await page.$eval('#view-games .gm-tip', e => e.textContent);
    if (out.afterTap !== 'false|Chime off') throw new Error('a tap should mute the chime and say so: ' + out.afterTap);
    await page.click(chime);
    await page.mouse.move(5, 5);
    if (await page.$('#newGameBtn') !== null) throw new Error('the sidebar should no longer carry a New game button');
    await shot(page, 'games-tab.png');
    await page.click('#view-games [role="tab"]:has-text("History")');
    await page.waitForSelector('#view-games .gm-hrow', { timeout: 4000 });
    out.hrows = await page.$$eval('#view-games .gm-hrow', els => els.map(e => e.textContent));
    out.days = await page.$$eval('#view-games .gm-day .gm-sec', els => els.map(e => e.textContent));
    if (out.hrows.length !== 3) throw new Error('History should list the three ended matches, got ' + out.hrows.length);
    if (JSON.stringify(out.days) !== '["Today","Yesterday","This week"]') throw new Error('History should file matches by the day they ended: ' + JSON.stringify(out.days));
    if (!/🏆/.test(out.hrows[0]) || !/Ada/.test(out.hrows[0]) || !/Battleship #4/.test(out.hrows[0]) || !/5–4/.test(out.hrows[0]) || !/vs Henry · 81 turns/.test(out.hrows[0])) throw new Error('a history row should read winner, game, score, field and length: ' + out.hrows[0]);
    if (!/Won/.test(out.hrows[2]) || !/Duel #21/.test(out.hrows[2]) || !/3–1/.test(out.hrows[2])) throw new Error('the viewer\'s own result should be marked: ' + out.hrows[2]);
    out.chips = await page.$$eval('#view-games .gm-chip', els => els.map(e => e.textContent));
    // catalog order (Duel, Frontlines, Light Cycles, Battleship), as in the picker
    if (JSON.stringify(out.chips) !== '["All3","Duel1","Battleship2"]') throw new Error('History should offer filters for the games present: ' + JSON.stringify(out.chips));
    await page.click('#view-games .gm-chip:has-text("Duel")');
    out.duelOnly = await page.$$eval('#view-games .gm-hrow', els => els.length);
    if (out.duelOnly !== 1) throw new Error('the Duel filter should leave one match, got ' + out.duelOnly);
    await page.click('#view-games .gm-chip:has-text("All")');
    await shot(page, 'games-tab-history.png');
    // keyboard: arrows move between tabs
    await page.focus('#view-games [role="tab"][aria-selected="true"]');
    await page.keyboard.press('ArrowRight');
    out.afterArrow = await page.$eval('#view-games [role="tab"][aria-selected="true"]', e => e.textContent);
    if (out.afterArrow !== 'Standings') throw new Error('ArrowRight from History should select Standings, got ' + out.afterArrow);
    out.rec = await page.$eval('#view-games .gm-rec', e => e.textContent);
    await shot(page, 'games-tab-standings.png');
    if (!/Battleship/.test(out.rec) || !/Ada/.test(out.rec) || !/2–0/.test(out.rec) || !/100%/.test(out.rec) || !/Duel/.test(out.rec)) throw new Error('Standings should render per-kind standings: ' + out.rec);
    if (!/🔥/.test(out.rec) || !/W2/.test(out.rec) || !/L2/.test(out.rec)) throw new Error('standings should carry the current streaks: ' + out.rec);
    if (!/Elo ladder/.test(out.rec) || !/1031\+15/.test(out.rec) || !/969−15/.test(out.rec)) throw new Error('a 2-player game shows its Elo ladder with the last change: ' + out.rec);
    await page.keyboard.press('ArrowLeft');
    await page.waitForSelector('#view-games .gm-hrow', { timeout: 4000 });
    await page.click('#view-games .gm-hrow:first-of-type .gm-hrow-open');
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host', { timeout: 6000 });
    out.arena = await page.$$eval('#viewer .bs-3d-host', els => els.length);
    out.arenaWinner = await page.$eval('#viewer .game-winner', e => e.textContent);
    if (out.arena !== 1) throw new Error('tapping a history row should open its arena (the 3D scene), got ' + out.arena);
    if (!/Ada/.test(out.arenaWinner)) throw new Error('the arena should carry the winner banner: ' + out.arenaWinner);
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    out.backOn = await page.$eval('#view-games [role="tab"][aria-selected="true"]', e => e.textContent);
    if (!/^History/.test(out.backOn)) throw new Error('coming back from an arena should keep the tab you chose, got ' + out.backOn);
    await page.click('#view-games .gm-hrow:first-of-type .gm-hrow-rematch');
    await page.waitForSelector('#viewer:not([hidden])', { timeout: 4000 });
    await page.waitForTimeout(300);
    out.rematchCall = calls.filter(c => c.includes('POST /api/rooms/demo/games ')).pop() || '';
    if (!/"game":"battleship"/.test(out.rematchCall) || !/"players":\["Ada","Henry"\]/.test(out.rematchCall)) throw new Error('row rematch should re-create the same match: ' + out.rematchCall);
    out.lobby = await page.$eval('#viewer', e => e.textContent);
    if (!/Lobby/.test(out.lobby)) throw new Error('the rematch should open in its lobby: ' + out.lobby.slice(0, 200));
    return out;
  });
  await run('games-tab-mobile-dark', { state: { bs: true, game: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 4000 });
    await page.click('#menu');
    await page.waitForTimeout(350);
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#view-games .gm-row', { timeout: 4000 });
    out.rows = await page.$$eval('#view-games .gm-row', els => els.length);
    if (out.rows !== 2) throw new Error('the mobile Live tab should list the two live matches, got ' + out.rows);
    // a long press on the chime explains it and does not toggle it
    const cb = await (await page.$('#view-games .gm-chime-btn')).boundingBox();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 }] });
    await page.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);
    out.hold = await page.$eval('#view-games .gm-chime-btn', e => e.getAttribute('aria-pressed')) + '|' + await page.$eval('#view-games .gm-tip', e => e.classList.contains('on') + ':' + e.textContent.slice(0, 15));
    if (out.hold !== 'true|true:Your-move chime') throw new Error('holding the chime should show what it does without toggling it: ' + out.hold);
    await shot(page, 'games-tab-mobile-chime-tip.png');
    out.tabH = await page.$eval('#view-games [role="tab"]', e => e.getBoundingClientRect().height);
    if (out.tabH < 44) throw new Error('tabs should be at least 44px tall on touch, got ' + out.tabH);
    await page.waitForTimeout(700);
    await shot(page, 'games-tab-mobile-dark.png');
    await page.tap('#view-games [role="tab"]:has-text("History")');
    await page.waitForSelector('#view-games .gm-hrow', { timeout: 4000 });
    out.hrows = await page.$$eval('#view-games .gm-hrow', els => els.length);
    if (out.hrows !== 2) throw new Error('mobile History should list two ended matches, got ' + out.hrows);
    out.overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (out.overflow > 0) throw new Error('the history should not scroll the page sideways: ' + out.overflow);
    await shot(page, 'games-tab-mobile-history.png');
    return out;
  });
  for (const [label, o] of [['markdown-light', {}], ['markdown-dark', { scheme: 'dark' }], ['markdown-mobile', { w: 390, h: 844 }]]) {
    await run(label, Object.assign({ state: { markdown: true }, init: () => { window.__alert = 0; window.alert = () => { window.__alert++; }; } }, o), async (page) => {
      await page.waitForTimeout(300);
      await page.evaluate(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight - 1600; });
      await shot(page, label + '.png');
      await page.evaluate(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight; });
      await shot(page, label + '-bottom.png');
      if (label !== 'markdown-light') return;
      return await page.evaluate(() => {
        const m7 = document.querySelector('.msg[data-id="7"] .text'), m8 = document.querySelector('.msg[data-id="8"] .text');
        return {
          h: m7.querySelector('.md-h2') && m7.querySelector('.md-h2').textContent,
          strong: m7.querySelector('strong').textContent, em: m7.querySelector('em').textContent, code: m7.querySelector('p code').textContent,
          ol: Array.from(m7.querySelectorAll(':scope > ol > li')).length, nested: Array.from(m7.querySelectorAll('ol li ul li')).map(x => x.textContent),
          del: m7.querySelector('del').textContent, table: Array.from(m7.querySelectorAll('td')).map(x => x.textContent + (x.style.textAlign ? '@' + x.style.textAlign : '')),
          quote: m7.querySelector('blockquote').textContent, pre: m7.querySelector('pre code').textContent,
          links: Array.from(m7.querySelectorAll('a')).map(a => a.textContent + '=>' + a.getAttribute('href')),
          xssImgs: document.querySelectorAll('.text img').length, xssText: m8.textContent, xssLinks: Array.from(m8.querySelectorAll('a')).length, xssEm: m8.querySelectorAll('em').length,
          alerts: window.__alert,
          human: Array.from(document.querySelectorAll('.msg')).map(r => r.dataset.id + (r.classList.contains('human') ? 'H' : '')).join(' '),
        };
      });
    });
  }
  await run('agent-gate', { state: { agentYou: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 });
    out.block = await page.$eval('#agentBlock', e => e.textContent);
    out.intro = await page.$eval('#agentIntro', e => e.textContent);
    if (!/\/api\/rooms\/demo\/mcp/.test(out.block)) throw new Error('setup block must name the MCP endpoint: ' + out.block.slice(0, 80));
    if (!/X-Invite-Token: tok_Probe/.test(out.block)) throw new Error('setup block must carry the invite header');
    if (!/Probe/.test(out.intro)) throw new Error('intro must name the agent: ' + out.intro);
    await shot(page, 'agent-gate.png');
    await page.click('#agentApp');
    await page.waitForSelector('#view-chat:not([hidden])', { timeout: 4000 });
    out.chatAfterEscape = true;
    await page.reload();
    await page.waitForTimeout(700);
    out.gateAfterReload = await page.$eval('#view-agent', e => !e.hidden);
    if (out.gateAfterReload) throw new Error('agent gate must not reappear after the escape on this device');
    return out;
  });

  // --- M2 shell scenarios (ported verbatim from tests/ui.test.js) ---
  for (const scheme of ['light', 'dark']) {
    await run('desktop-' + scheme, { scheme }, async (page) => {
      await shot(page, scheme + '-chat.png');
      for (const t of ['constitution', 'decisions', 'questions', 'stakes', 'memory', 'members']) { await page.click('.tab[data-tab="' + t + '"]'); await page.waitForTimeout(200); await shot(page, scheme + '-' + t + '.png'); }
      const counts = await page.$$eval('.tab .count', els => els.map(e => e.parentElement.dataset.tab + '=' + e.textContent + (e.classList.contains('alert') ? '!' : '')));
      // Sidebar counts are production-derived for this fixture (the
      // root suite only logs them; assert them here so a counts
      // divergence cannot pass silently — stakes is due within
      // SEVEN days in the current app, decisions count when an
      // active member has not signed).
      const wantCounts = ['chat=', 'games=', 'media=', 'constitution=', 'decisions=2!', 'questions=2', 'stakes=1!', 'memory=', 'members=3'];
      if (JSON.stringify(counts) !== JSON.stringify(wantCounts)) throw new Error('sidebar counts diverge from production: got ' + JSON.stringify(counts));
      return { counts, hash: await page.evaluate(() => location.hash) };
    });
  }
  await run('mobile-light', { w: 390, h: 844 }, async (page) => {
    await shot(page, 'mobile-chat.png');
    await page.click('#menu'); await page.waitForTimeout(350); await shot(page, 'mobile-drawer.png');
    await page.click('.tab[data-tab="decisions"]'); await page.waitForTimeout(350); await shot(page, 'mobile-decisions.png');
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    return { scrollWidth: sw };
  });
  await run('mobile-dark', { w: 390, h: 844, scheme: 'dark' }, async (page) => { await shot(page, 'mobile-dark-chat.png'); await page.click('#menu'); await page.waitForTimeout(350); await shot(page, 'mobile-dark-drawer.png'); });
  // Update banner: the page is stamped uitestbuild1, /api/build reports
  // uitestbuild2, so the banner shows; dismissal is per build and the
  // Refresh button reloads the page.
  await run('update-banner', { state: { behind: true } }, async (page) => {
    const out = {};
    out.meta = await page.$eval('meta[name="build"]', e => e.getAttribute('content'));
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    await shot(page, 'update-banner.png');
    await page.click('#updateDismiss');
    await page.waitForFunction(() => document.getElementById('updateStrip').hidden, null, { timeout: 4000 });
    await page.reload(); await page.waitForTimeout(900);
    out.afterDismissReload = await page.$eval('#updateStrip', e => e.hidden);
    await page.evaluate(() => localStorage.removeItem('ac:build-dismissed'));
    await page.reload();
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    await Promise.all([page.waitForNavigation({ timeout: 5000 }), page.click('#updateRefresh')]);
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    out.refreshReloaded = true;
    if (out.meta !== 'uitestbuild1') throw new Error('page build meta wrong: ' + out.meta);
    if (!out.afterDismissReload) throw new Error('dismissal did not persist across reload');
    return out;
  });
  await run('update-banner-mobile', { state: { behind: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    await shot(page, 'update-banner-mobile.png');
    return { ok: true };
  });
  await run('update-banner-current', {}, async (page) => {
    await page.waitForTimeout(900);
    const hidden = await page.$eval('#updateStrip', e => e.hidden);
    if (!hidden) throw new Error('banner must stay hidden when the build is current');
    return { hidden };
  });
  // Pull-to-refresh: a downward drag from the top bar. A short drag only
  // shows the hint; past the threshold, releasing reloads the page.
  await run('pull-refresh-mobile', { w: 390, h: 844, touch: true }, async (page) => {
    const out = {};
    const drag = (dy) => page.evaluate((d) => {
      const bar = document.querySelector('.topbar');
      const mk = (t, y) => new PointerEvent(t, { clientY: y, bubbles: true, pointerId: 7, isPrimary: true });
      bar.dispatchEvent(mk('pointerdown', 120));
      bar.dispatchEvent(mk('pointermove', 120 + d));
    }, dy);
    const release = () => page.evaluate(() => {
      document.querySelector('.topbar').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, isPrimary: true }));
    });
    await drag(30);
    out.shortHint = await page.$eval('#pullHintText', e => e.textContent);
    await release(); await page.waitForTimeout(350);
    out.shortHidden = await page.$eval('#pullHint', e => e.hidden);
    await drag(120);
    out.fullHint = await page.$eval('#pullHintText', e => e.textContent);
    await shot(page, 'pull-refresh-mobile.png');
    await Promise.all([page.waitForNavigation({ timeout: 5000 }), release()]);
    out.reloaded = true;
    if (out.shortHint !== 'Pull to refresh') throw new Error('short drag hint wrong: ' + out.shortHint);
    if (!out.shortHidden) throw new Error('hint must hide after a short drag');
    if (out.fullHint !== 'Release to refresh') throw new Error('full drag hint wrong: ' + out.fullHint);
    return out;
  });
  await run('push-bell', { init: () => { try { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); } catch (e) {} } }, async (page) => {
    // Soak defect S2 (2026-11-09): on the owner's phone (Chrome,
    // permission undecided) the staging app showed no bell at all.
    // Two causes stacked: staging served /sw.js as HTML, so
    // registration failed and serviceWorker.ready never resolved -
    // and the port only painted the bell at the end of that async
    // check, while production paints visibility from the support
    // rule. Here the harness 404s /sw.js the same way; with the
    // permission stubbed to "default" the bell must still appear.
    const out = {};
    out.perm = await page.evaluate(() => Notification.permission);
    if (out.perm !== 'default') throw new Error('permission stub did not take: ' + out.perm);
    await page.waitForTimeout(800);
    out.vis = await page.$$eval('.pushBtn', bs => bs.map(b => !b.hidden));
    if (!out.vis.some(Boolean)) throw new Error('push bell never became visible: ' + JSON.stringify(out));
    return out;
  });
  // New game (2026-11-19 redesign): a gallery of the games from the
  // catalog, then the chosen game's setup - How to play (folded, one tap
  // opens it), players (you are picked by default), options, Start. A duel
  // needs exactly 2 players, Light Cycles 2-4; Back returns to the
  // gallery and keeps the picks (trimmed to the next game's maximum);
  // starting posts the create call and closes the dialog.
  const ngOpen = async (page) => {
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#view-games .gm-start-btn', { timeout: 4000 });
    await page.click('#view-games .gm-start-btn');
    await page.waitForSelector('#newGameDlg[open]', { timeout: 4000 });
  };
  await run('new-game', {}, async (page, S, calls) => {
    const out = {};
    await ngOpen(page);
    out.gallery = await page.$$eval('#newGameDlg .ng-game', (bs) => bs.map((b) => b.getAttribute('data-game')));
    out.galleryFacts = await page.$$eval('#newGameDlg .ng-game .game-facts', (fs) => fs.map((f) => f.textContent));
    await page.click('#newGameDlg .ng-game[data-game="duel"]');
    out.howtoFolded = await page.$eval('#newGameDlg .ng-howto', (d) => !d.open);
    await page.click('#newGameDlg .ng-howto > summary');
    out.howtoOpensOnTap = await page.$eval('#newGameDlg .ng-howto', (d) => d.open && /Rock blunts scissors/.test(d.textContent));
    out.startDisabledAtOne = await page.$eval('#ngStart', e => e.disabled);
    await page.click('[data-player="Ada"]');
    out.startEnabledAtTwo = await page.$eval('#ngStart', e => !e.disabled);
    out.startLabel = await page.$eval('#ngStart', e => e.textContent);
    await page.click('#newGameDlg .ng-back');
    await page.click('#newGameDlg .ng-game[data-game="lightcycles"]');
    out.paceSegShown = await page.$('[data-opt="mode"]') !== null;
    out.asyncPressed = await page.$eval('[data-opt="mode"] button:nth-child(1)', e => e.getAttribute('aria-pressed') === 'true');
    out.tickHiddenOnAsync = await page.$('[data-opt="tick"]') === null;
    await page.click('[data-opt="mode"] button:nth-child(2)');
    out.tickSegShown = await page.$('[data-opt="tick"]') !== null;
    await page.click('[data-player="Henry"]');
    out.lcCount = await page.$eval('.ng-count', e => e.textContent.trim());
    await page.click('#newGameDlg .ng-back');
    await page.click('#newGameDlg .ng-game[data-game="battleship"]');
    out.bsVariantSeg = await page.$('[data-opt="variant"]') !== null;
    await page.click('#newGameDlg .ng-back');
    await page.click('#newGameDlg .ng-game[data-game="duel"]');
    out.howtoFoldedAgain = await page.$eval('#newGameDlg .ng-howto', (d) => !d.open);
    out.duelCount = await page.$eval('.ng-count', e => e.textContent.trim());
    await shot(page, 'new-game.png');
    await page.click('#ngStart');
    await page.waitForTimeout(600);
    out.dlgClosed = await page.$eval('#newGameDlg', e => !e.open);
    const cc = calls.filter(c => c.includes('POST /api/rooms/demo/games ')).pop() || '';
    out.createCall = cc;
    const body = JSON.parse(cc.slice(cc.indexOf('{')));
    if (out.gallery.join(',') !== 'duel,frontlines,coderace,trust,auction,liarsdice,twotruths,corpse,twenty,werewolf,lettergrid,trivia,sketch,fourinarow,lightcycles,battleship') throw new Error('gallery must list every catalog game: ' + out.gallery);
    if (!out.galleryFacts.every((f) => /players/.test(f))) throw new Error('every gallery card must carry its facts: ' + JSON.stringify(out.galleryFacts));
    if (!out.howtoFolded || !out.howtoFoldedAgain) throw new Error('How to play must start folded: ' + JSON.stringify(out));
    if (!out.howtoOpensOnTap) throw new Error('a tap on How to play opens the rules');
    if (!out.startDisabledAtOne) throw new Error('duel must not start with 1 player');
    if (!out.startEnabledAtTwo) throw new Error('duel must start with 2 players');
    if (out.startLabel !== 'Start Duel') throw new Error('Start names the game: ' + out.startLabel);
    if (!out.bsVariantSeg) throw new Error('Battleship must show the variant options');
    if (!out.paceSegShown) throw new Error('Light Cycles must show the pace options');
    if (!out.asyncPressed) throw new Error('Light Cycles must default to async pace');
    if (!out.tickHiddenOnAsync) throw new Error('the tick length belongs to live pace only');
    if (!out.tickSegShown) throw new Error('Light Cycles live pace must show the tick options');
    if (out.lcCount !== '3 of 2\u20134') throw new Error('LC count wrong: ' + out.lcCount);
    if (out.duelCount !== '2 of 2') throw new Error('going back to duel must trim to 2 players, got: ' + out.duelCount);
    if (!out.dlgClosed) throw new Error('dialog must close after a successful start');
    if (body.game !== 'duel' || body.best_of !== 5 || JSON.stringify(body.players) !== '["Anthony","Ada"]') throw new Error('create body wrong: ' + cc);
    return out;
  });
  // Battleship seats 2-6: a third pick turns the match into a
  // free-for-all (count and summary say so), skirmish trims back to
  // two, and the create call carries the captains and the variant.
  await run('new-game-ffa', {}, async (page, S, calls) => {
    const out = {};
    await ngOpen(page);
    await page.click('#newGameDlg .ng-game[data-game="battleship"]');
    await page.click('[data-player="Ada"]');
    out.twoCount = await page.$eval('.ng-count', e => e.textContent.trim());
    await page.click('[data-player="Henry"]');
    out.threeCount = await page.$eval('.ng-count', e => e.textContent.trim());
    out.hint = await page.$eval('.ng-note', e => e.textContent);
    out.startEnabled = await page.$eval('#ngStart', e => !e.disabled);
    await page.click('[data-opt="variant"] button:nth-child(3)');
    out.skirmishCount = await page.$eval('.ng-count', e => e.textContent.trim());
    await page.click('[data-opt="variant"] button:nth-child(2)');
    await page.click('[data-player="Henry"]');
    out.salvoHint = await page.$eval('.ng-note', e => e.textContent);
    await shot(page, 'new-game-ffa.png');
    await page.click('#ngStart');
    await page.waitForTimeout(600);
    const cc = calls.filter(c => c.includes('POST /api/rooms/demo/games ')).pop() || '';
    const body = JSON.parse(cc.slice(cc.indexOf('{')));
    if (out.twoCount !== '2 of 2\u20136') throw new Error('two-captain count wrong: ' + out.twoCount);
    if (out.threeCount !== '3 of 2\u20136') throw new Error('ffa count wrong: ' + out.threeCount);
    if (!/free-for-all/i.test(out.hint)) throw new Error('three captains should read as a free-for-all: ' + out.hint);
    if (!out.startEnabled) throw new Error('an ffa must be startable with 3 captains');
    if (out.skirmishCount !== '2 of 2') throw new Error('skirmish must trim to two captains: ' + out.skirmishCount);
    if (!/free-for-all salvo/i.test(out.salvoHint)) throw new Error('a 3-captain salvo summary: ' + out.salvoHint);
    if (body.game !== 'battleship' || body.variant !== 'salvo' || JSON.stringify(body.players) !== '["Anthony","Ada","Henry"]') throw new Error('ffa create body wrong: ' + cc);
    return out;
  });
  await run('new-game-mobile', { w: 390, h: 844, touch: true }, async (page) => {
    const out = {};
    await page.click('#menu'); await page.waitForTimeout(350);
    await page.click('.tab[data-tab="games"]'); await page.waitForTimeout(700);
    await page.click('#view-games .gm-start-btn');
    await page.waitForSelector('#newGameDlg[open]', { timeout: 4000 });
    await page.waitForTimeout(200);
    await shot(page, 'new-game-mobile.png');
    await page.click('#newGameDlg .ng-game[data-game="duel"]');
    await page.waitForTimeout(200);
    out.startDisabledAtOne = await page.$eval('#ngStart', e => e.disabled);
    // even with How to play opened, Start stays on screen (pinned to the bottom)
    await page.click('#newGameDlg .ng-howto > summary');
    await page.waitForTimeout(150);
    out.startOnScreen = await page.$eval('#ngStart', (b) => { const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
    await shot(page, 'new-game-mobile-setup.png');
    if (!out.startDisabledAtOne) throw new Error('duel must not start with 1 player');
    if (!out.startOnScreen) throw new Error('Start must stay on screen while How to play is open');
    return out;
  });
  // Frontlines (2026-11-19): the card shows the score and the last round
  // on a compact field; the arena shows the field and the planner. Lock
  // in stays off until the split adds up to 100; Even fills it; the
  // commit sends the split and the planner reads as locked.
  for (const [label, o] of [['frontlines-arena', {}], ['frontlines-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { fl: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .fl-card', { timeout: 6000 });
      out.cardHills = await page.$$eval('.game-card .fl-hill', (h) => h.length);
      out.cardCap = await page.$eval('.game-card .fl-card-cap', (e) => e.textContent);
      await page.click('.game-card');
      await page.waitForSelector('#viewer .fl-plan', { timeout: 6000 });
      out.fieldCap = await page.$eval('#viewer .fl-cap', (e) => e.textContent);
      out.flags = await page.$$eval('#viewer .fl-field .fl-flag', (f) => f.map((x) => x.textContent));
      out.lockOffAtZero = await page.$eval('#viewer .fl-go', (b) => b.disabled);
      out.banner = await page.$eval('#viewer .duel-statusline, #viewer .turn-banner', (e) => e.textContent).catch(() => '');
      await shot(page, label + '-plan.png');
      await page.click('#viewer .fl-acts button:nth-child(1)');
      out.left = await page.$eval('#viewer .fl-left', (e) => e.textContent);
      out.lockOnAt100 = await page.$eval('#viewer .fl-go', (b) => !b.disabled);
      // one hill nudged: Lock in goes off again (95 placed)
      await page.click('#viewer .fl-row:nth-of-type(2) .fl-step:first-of-type');
      out.leftAfterNudge = await page.$eval('#viewer .fl-left', (e) => e.textContent);
      await page.click('#viewer .fl-acts button:nth-child(1)');
      await page.click('#viewer .fl-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/12/moves')).pop() || '';
      out.lockedLabel = await page.$eval('#viewer .fl-go', (b) => b.textContent);
      await shot(page, label + '-locked.png');
      if (out.cardHills !== 5) throw new Error('the card shows the five hills: ' + out.cardHills);
      if (!/Round 2 level/.test(out.cardCap)) throw new Error('the card names the last round: ' + out.cardCap);
      if (!/Round 2 in numbers/.test(out.fieldCap)) throw new Error('the arena shows the last resolved round: ' + out.fieldCap);
      if (out.flags.join(',') !== 'level,Anthony,Ada,level,level') throw new Error('round 2 flags: ' + out.flags);
      if (!out.lockOffAtZero || !out.lockOnAt100) throw new Error('Lock in waits for exactly 100: ' + JSON.stringify(out));
      if (!/All 100 placed/.test(out.left) || !/5 left to place/.test(out.leftAfterNudge)) throw new Error('the troop counter: ' + JSON.stringify(out));
      if (!/"dir":"20,20,20,20,20"/.test(out.moveCall)) throw new Error('the commit sends the split: ' + out.moveCall);
      if (!/Locked in/.test(out.lockedLabel)) throw new Error('the planner reads locked after the commit: ' + out.lockedLabel);
      return out;
    });
  }
  // Code Race (2026-11-19): the card shows each racer's latest feedback;
  // the arena puts your lane first with your guesses, a rival's lane
  // shows feedback only (pegs hidden); the palette fills the slots, Guess
  // sends them in order, and the round's guess shows sealed in your lane.
  for (const [label, o] of [['coderace-arena', {}], ['coderace-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card', { timeout: 6000 });
      out.cardRows = await page.$$eval('.game-card .cr-card-row', (r) => r.map((x) => x.querySelector('.cr-card-name').textContent));
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer .cr-input', { timeout: 6000 });
      out.lanes = await page.$$eval('#viewer .cr-lane .cr-lane-name', (n) => n.map((x) => x.textContent));
      out.myPegs = await page.$$eval('#viewer .cr-lane.mine .cr-row:first-child .cr-peg', (p) => p.map((x) => x.textContent).join(''));
      out.rivalHidden = await page.$$eval('#viewer .cr-lane:not(.mine) .cr-peg', (p) => p.every((x) => x.classList.contains('hidden') && !x.textContent));
      out.rivalPips = await page.$$eval('#viewer .cr-board > .cr-lane:nth-child(2) .cr-row:nth-child(2) .cr-pip.hit', (p) => p.length);
      out.goOff = await page.$eval('#viewer .cr-go', (b) => b.disabled);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '-board.png');
      for (const k of ['R', 'G', 'B', 'Y']) await page.click('#viewer .cr-color[aria-label="Add ' + { R: 'red', G: 'green', B: 'blue', Y: 'yellow' }[k] + '"]');
      out.slots = await page.$$eval('#viewer .cr-slot .cr-peg', (p) => p.map((x) => x.textContent).join(''));
      // a tap on a slot takes that peg out
      await page.click('#viewer .cr-slot:nth-child(2)');
      out.afterClear = await page.$$eval('#viewer .cr-slot .cr-peg', (p) => p.map((x) => x.textContent).join(''));
      await page.click('#viewer .cr-color[aria-label="Add green"]');
      out.goOn = await page.$eval('#viewer .cr-go', (b) => !b.disabled);
      await page.click('#viewer .cr-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/14/moves')).pop() || '';
      out.sealed = await page.$$eval('#viewer .cr-lane.mine .cr-row.sealed .cr-peg', (p) => p.map((x) => x.textContent).join(''));
      await shot(page, label + '-guessed.png');
      if (out.cardRows.length !== 3) throw new Error('the card lists every racer: ' + out.cardRows);
      if (out.lanes[0] !== 'Anthony (you)') throw new Error('your lane comes first: ' + out.lanes);
      if (out.myPegs !== 'RGBY') throw new Error('your own guess shows in full: ' + out.myPegs);
      if (!out.rivalHidden) throw new Error('a rival\'s pegs stay hidden');
      if (out.rivalPips !== 2) throw new Error('a rival\'s feedback shows (Ada round 2: 2 right place): ' + out.rivalPips);
      if (!out.goOff || !out.goOn) throw new Error('Guess waits for every slot: ' + JSON.stringify(out));
      if (out.slots !== 'RGBY' || out.afterClear !== 'RBY') throw new Error('the palette fills slots and a tap clears one: ' + JSON.stringify(out));
      if (!/"dir":"R B Y G"/.test(out.moveCall)) throw new Error('the guess goes in order: ' + out.moveCall);
      if (out.sealed !== 'RBYG') throw new Error('the round\'s guess shows sealed in your lane: ' + out.sealed);
      if (!/Your guess · round 3 of 10/.test(out.banner)) throw new Error('the turn banner asks for a guess: ' + out.banner);
      return out;
    });
  }
  // A finished race: the code is shown, the lanes run in place order with
  // the winner's trophy, and every rival's guess is out in the open.
  for (const [label, o] of [['coderace-done', {}], ['coderace-done-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true, crDone: true } }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card .cr-secret', { timeout: 6000 });
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer .cr-secret', { timeout: 6000 });
      out.secret = await page.$$eval('#viewer .cr-secret .cr-peg', (p) => p.map((x) => x.textContent).join(''));
      out.lanes = await page.$$eval('#viewer .cr-lane .cr-lane-name', (n) => n.map((x) => x.textContent));
      out.trophy = await page.$eval('#viewer .cr-lane:first-child .cr-place', (e) => e.textContent);
      out.adaGuess = await page.$$eval('#viewer .cr-board > .cr-lane:first-child .cr-row:first-child .cr-peg', (p) => p.map((x) => x.textContent).join(''));
      out.input = !!(await page.$('#viewer .cr-input'));
      out.meta = await page.$eval('#viewer .lc-meta', (e) => e.textContent);
      await shot(page, label + '.png');
      if (out.secret !== 'RGBO') throw new Error('the code is shown once the race is over: ' + out.secret);
      if (out.lanes.join(',') !== 'Ada,Anthony (you),Henry' || out.trophy !== '🏆') throw new Error('lanes in place order, the winner first: ' + JSON.stringify(out));
      if (out.adaGuess !== 'RRBB') throw new Error('a rival\'s guesses are out in the open: ' + out.adaGuess);
      if (out.input) throw new Error('no guess input once the race is over');
      if (!/Cracked in round 3 · 4 rounds · 4 pegs · 6 colours/.test(out.meta)) throw new Error('the record line: ' + out.meta);
      return out;
    });
  }
  // Words: rivals' rows are bare coloured tiles; you type the word; a word
  // not in the list is refused with the server's reason; Enter sends.
  for (const [label, o] of [['coderace-words', {}], ['coderace-words-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true, crWords: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card', { timeout: 6000 });
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer .cr-word', { timeout: 6000 });
      out.myTiles = await page.$$eval('#viewer .cr-lane.mine .cr-row:first-child .cr-tile', (t) => t.map((x) => x.textContent + ':' + x.className.split(' ')[1]).join(','));
      out.rivalLetters = await page.$$eval('#viewer .cr-lane:not(.mine) .cr-tile', (t) => t.map((x) => x.textContent).join(''));
      await page.fill('#viewer .cr-word', 'xqzzt');
      await page.click('#viewer .cr-go');
      await page.waitForTimeout(400);
      out.refused = await page.$eval('#viewer .lc-note', (e) => e.textContent);
      await page.fill('#viewer .cr-word', 'crane');
      await page.press('#viewer .cr-word', 'Enter');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/14/moves')).pop() || '';
      out.sealed = await page.$$eval('#viewer .cr-lane.mine .cr-row.sealed .cr-tile', (t) => t.map((x) => x.textContent).join(''));
      await shot(page, label + '.png');
      if (out.myTiles !== 'C:n,R:n,A:g,N:n,E:y') throw new Error('your tiles carry letters and colours: ' + out.myTiles);
      if (out.rivalLetters !== '') throw new Error('rival tiles carry no letters: ' + out.rivalLetters);
      if (!/not in the word list/.test(out.refused)) throw new Error('a word not in the list is refused: ' + out.refused);
      if (!/"dir":"crane"/.test(out.moveCall)) throw new Error('Enter sends the word: ' + out.moveCall);
      if (out.sealed !== 'CRANE') throw new Error('the sealed guess shows in your lane: ' + out.sealed);
      return out;
    });
  }
  // Four in a Row (2026-11-19): the card shows the board; the arena puts
  // the drop buttons under the scene on your turn; a drop lands (the
  // scene counts it) and the turn passes; a finished match names the
  // winner and the result line counts the moves (the board is the scene:
  // the 2D grid was retired 2026-11-20).
  for (const [label, o] of [['fourinarow-arena', {}], ['fourinarow-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 6000 });
      out.cardDiscs = await page.$$eval('.game-card .c4-disc', (d) => d.length);
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer .c4-drop', { timeout: 6000 });
      out.drops = await page.$$eval('#viewer .c4-drop', (b) => b.filter((x) => !x.disabled).length);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.seats = await page.$eval('#viewer .c4-seats', (e) => e.textContent);
      await shot(page, label + '-turn.png');
      await page.click('#viewer .c4-drop:nth-child(4)');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/16/moves')).pop() || '';
      out.landed = await page.waitForFunction(() => { const l = document.querySelector('#viewer .c4-3d-host [role="img"]'); return l && /7 discs on the board/.test(l.getAttribute('aria-label')) ? 'yes' : null; }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => 'no');
      out.dropsAfter = await page.$$('#viewer .c4-drop').then((b) => b.length);
      out.bannerAfter = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '-dropped.png');
      if (out.cardDiscs !== 6) throw new Error('the card shows the board: ' + out.cardDiscs);
      if (out.drops !== 7) throw new Error('seven open columns on your turn: ' + out.drops);
      if (!/Your move · turn 7/.test(out.banner)) throw new Error('the banner asks for your move: ' + out.banner);
      if (!/Ada1 timeout/.test(out.seats)) throw new Error('the seats show timeouts: ' + out.seats);
      if (!/"dir":"4"/.test(out.moveCall)) throw new Error('a drop sends the column: ' + out.moveCall);
      if (out.landed !== 'yes') throw new Error('the dropped disc lands on the board (the scene counts 7)');
      if (out.dropsAfter !== 0 || !/Waiting on Ada/.test(out.bannerAfter)) throw new Error('the turn passes: ' + JSON.stringify(out));
      return out;
    });
  }
  for (const [label, o] of [['fourinarow-done', {}], ['fourinarow-done-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true, c4Done: true } }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 6000 });
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer .game-winner', { timeout: 6000 });
      out.scene = await page.waitForFunction(() => { const l = document.querySelector('#viewer .c4-3d-host [role="img"]'); return l && l.getAttribute('aria-label'); }, null, { timeout: 20000 }).then((h) => h.jsonValue());
      out.meta = await page.$eval('#viewer .lc-meta', (e) => e.textContent);
      out.winner = await page.$eval('#viewer .game-winner', (e) => e.textContent);
      out.drops = await page.$$('#viewer .c4-drop').then((b) => b.length);
      await shot(page, label + '.png');
      if (!/Ada won\. 12 discs on the board/.test(out.scene)) throw new Error('the scene names the winner: ' + out.scene);
      if (!/Four in a row · 12 moves/.test(out.meta)) throw new Error('the record line: ' + out.meta);
      if (!/Ada/.test(out.winner) || !/move 12/.test(out.winner)) throw new Error('the winner banner: ' + out.winner);
      if (out.drops !== 0) throw new Error('no drop buttons once it is over');
      return out;
    });
  }
  // Sketch & Guess (2026-11-20, 3D only): the artist sees the secret
  // prompt and a sketch pad; Send drawing refuses an empty page, then sends
  // the pad as a PNG data URL (the status line never echoes it); a
  // guesser's card shows the drawing; the arena puts the gallery first,
  // then the guess form, the scores and the last round (the Referee's calls
  // marked).
  await run('sketch-draw', { state: { sg: true, sgDraw: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .sg-card', { timeout: 6000 });
    await page.click('.game-card.kind-sketch');
    await page.waitForSelector('#viewer .sg-artist', { timeout: 20000 });
    out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
    out.prompt = await page.$eval('#viewer .sg-prompt-text', (e) => e.textContent);
    out.touch = await page.$eval('#viewer .sg-canvas', (c) => getComputedStyle(c).touchAction);
    await page.click('#viewer .sg-artist .sg-send');
    out.empty = await page.$eval('#viewer .lc-note', (e) => e.textContent);
    const box = await (await page.$('#viewer .sg-canvas')).boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.2, { steps: 6 });
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 6 });
    await page.mouse.up();
    await page.click('#viewer .sg-swatch[aria-label="Pen colour #ef4444"]');
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 4 });
    await page.mouse.up();
    out.ink = await page.$eval('#viewer .sg-canvas', (c) => { const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < x.length; i += 4) if (x[i] < 200 || x[i + 1] < 200) n++; return n; });
    await shot(page, 'sketch-draw.png');
    await page.click('#viewer .sg-artist .sg-send');
    out.sending = await page.$eval('#viewer .lc-note', (e) => e.textContent);
    await page.waitForTimeout(500);
    out.call = (calls.filter((c) => c.includes('/games/38/moves')).pop() || '').slice(0, 80);
    if (!/You're the artist · draw your prompt/.test(out.banner)) throw new Error('the banner: ' + out.banner);
    if (out.prompt !== 'a lighthouse in a storm') throw new Error('the artist sees the prompt: ' + out.prompt);
    if (out.touch !== 'none') throw new Error('strokes must not scroll the page: ' + out.touch);
    if (!/Draw something first/.test(out.empty)) throw new Error('an empty page is refused: ' + out.empty);
    if (out.ink < 200) throw new Error('the strokes land on the pad: ' + out.ink);
    if (/data:/.test(out.sending)) throw new Error('the status line must not echo the image: ' + out.sending.slice(0, 60));
    if (!/"dir":"data:image\/png;base64,/.test(out.call)) throw new Error('the pad goes out as a PNG data URL: ' + out.call);
    return { banner: out.banner, ink: out.ink, sending: out.sending };
  });
  await run('sketch-draw-mobile', { state: { sg: true, sgDraw: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .sg-card', { timeout: 6000 });
    await page.click('.game-card.kind-sketch');
    await page.waitForSelector('#viewer .sg-artist', { timeout: 20000 });
    await page.$eval('#viewer .sg-canvas', (e) => e.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    const box = await (await page.$('#viewer .sg-canvas')).boundingBox();
    out.width = Math.round(box.width);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    out.ink = await page.$eval('#viewer .sg-canvas', (c) => { const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < x.length; i += 4) if (x[i] < 200) n++; return n; });
    await shot(page, 'sketch-draw-mobile.png');
    if (out.width < 300) throw new Error('the pad fills the phone width: ' + out.width);
    if (out.ink < 20) throw new Error('a tap draws a dot: ' + out.ink);
    return out;
  });
  for (const [label, o] of [['sketch-guess', {}], ['sketch-guess-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { sg: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .sg-card', { timeout: 6000 });
      out.cardImg = !!(await page.$('.game-card .sg-card-img'));
      out.cardCap = await page.$eval('.game-card .sg-card-cap', (e) => e.textContent);
      await page.click('.game-card.kind-sketch');
      await page.waitForSelector('#viewer .sg-guess', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .sg-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|sg-form|sg-scores|sg-reveal/.test(c)));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.reveal = await page.$$eval('#viewer .sg-rv', (r) => r.map((x) => x.textContent));
      out.prompt = await page.$eval('#viewer .sg-rv-prompt', (e) => e.textContent);
      await page.fill('#viewer .sg-in', 'a lighthouse');
      await shot(page, label + '.png');
      await page.click('#viewer .sg-guess .sg-send');
      await page.waitForTimeout(500);
      out.call = calls.filter((c) => c.includes('/games/38/moves')).pop() || '';
      out.title = await page.$eval('#viewer .sg-guess .sg-form-title', (e) => e.textContent).catch(() => '');
      if (!out.cardImg || !/Guess Ada's drawing/.test(out.cardCap)) throw new Error('the card shows the drawing: ' + JSON.stringify(out));
      if (out.toggle) throw new Error('no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,sg-form,sg-scores,sg-reveal') throw new Error('the gallery, the guess, scores, the last round: ' + JSON.stringify(out.order));
      if (!/Guess Ada's drawing · round 2 of 3/.test(out.banner)) throw new Error('the banner: ' + out.banner);
      if (!/It was: a cat stuck in a tree/.test(out.prompt) || !/cat up a tree.*the Referee's call.*\+2/.test(out.reveal[0]) || !/a squirrel/.test(out.reveal[1]) || !/Henry.*the artist.*\+1/.test(out.reveal[2])) throw new Error('the last round: ' + JSON.stringify(out));
      if (!/"dir":"a lighthouse"/.test(out.call)) throw new Error('a guess goes out: ' + out.call);
      if (!/Your guess is in/.test(out.title)) throw new Error('the sealed guess shows: ' + out.title);
      return out;
    });
  }
  // Trivia (2026-11-20, 3D only, a rotating quizmaster): the card shows
  // the question and the balances; the arena puts the stage first, then
  // the question, your form, the scores and the last round's reveal. An
  // answer goes out with its wager (quick stakes set the slider); typing
  // keeps the field's focus.
  for (const [label, o] of [['trivia-answer', {}], ['trivia-answer-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tv: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tv-card', { timeout: 6000 });
      out.cardQ = await page.$eval('.game-card .tv-card-q', (e) => e.textContent);
      await page.click('.game-card.kind-trivia');
      await page.waitForSelector('#viewer .tv-answer', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .tv-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tv-q|tv-form|tv-scores|tv-reveal/.test(c)));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.reveal = await page.$$eval('#viewer .tv-rv', (r) => r.map((x) => x.textContent));
      await page.fill('#viewer .tv-in-a', 'Lisbon');
      await page.click('#viewer .tv-chip-btn:has-text("20")');
      out.stake = await page.$eval('#viewer .tv-stake', (e) => e.textContent);
      out.focusAfterType = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('tv-in-a'));
      await shot(page, label + '.png');
      await page.click('#viewer .tv-answer .tv-send');
      await page.waitForTimeout(500);
      out.call = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
      out.title = await page.$eval('#viewer .tv-answer .tv-form-title', (e) => e.textContent).catch(() => '');
      if (!/Which city did I grow up in\?.? - Ada asks/.test(out.cardQ)) throw new Error('the card shows the question: ' + out.cardQ);
      if (out.toggle) throw new Error('no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,tv-q,tv-form,tv-scores,tv-reveal') throw new Error('the stage, question, form, scores, reveal: ' + JSON.stringify(out.order));
      if (!/Your answer · round 2 of 6/.test(out.banner)) throw new Error('the banner: ' + out.banner);
      if (out.reveal.length !== 3 || !/Ada.*Red.*\+15/.test(out.reveal[0]) || !/Anthony.*blue.*−10/.test(out.reveal[1]) || !/Henry.*split the table.*\+10/.test(out.reveal[2])) throw new Error('the last round: ' + JSON.stringify(out.reveal));
      if (out.stake !== '20 of 25') throw new Error('a quick stake sets the wager: ' + out.stake);
      if (!/"dir":"\{\\"answer\\":\\"Lisbon\\",\\"wager\\":20\}"/.test(out.call)) throw new Error('the answer goes out with its wager: ' + out.call);
      if (!/Your answer is in/.test(out.title)) throw new Error('the sealed answer shows: ' + out.title);
      return out;
    });
  }
  await run('trivia-quizmaster', { state: { tv: true, tvAsk: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .tv-card', { timeout: 6000 });
    await page.click('.game-card.kind-trivia');
    await page.waitForSelector('#viewer .tv-ask', { timeout: 20000 });
    out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
    out.q = await page.$eval('#viewer .tv-q-text', (e) => e.textContent);
    await page.fill('#viewer .tv-in-q', 'What is my favourite fruit?');
    out.disabledBeforeAnswer = await page.$eval('#viewer .tv-ask .tv-send', (b) => b.disabled);
    await page.fill('#viewer .tv-in-a', 'Mango');
    await page.fill('#viewer .tv-in-acc', 'mangoes | a mango');
    await shot(page, 'trivia-quizmaster.png');
    await page.click('#viewer .tv-ask .tv-send');
    await page.waitForTimeout(500);
    out.call = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
    if (!/You're the quizmaster · ask a question/.test(out.banner)) throw new Error('the banner: ' + out.banner);
    if (!/You is writing|Anthony is writing a question/.test(out.q)) throw new Error('the question waits: ' + out.q);
    if (!out.disabledBeforeAnswer) throw new Error('Ask waits for the answer');
    if (!/question.*What is my favourite fruit\?.*answer.*Mango.*accept.*mangoes.*a mango/.test(out.call)) throw new Error('the question goes out with its answer and variants: ' + out.call);
    return out;
  });
  await run('trivia-judge', { state: { tv: true, tvJudge: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .tv-card', { timeout: 6000 });
    await page.click('.game-card.kind-trivia');
    await page.waitForSelector('#viewer .tv-judge', { timeout: 20000 });
    out.title = await page.$eval('#viewer .tv-judge .tv-form-title', (e) => e.textContent);
    out.rows = await page.$$eval('#viewer .tv-judge-row', (r) => r.map((x) => x.textContent));
    await page.click('#viewer .tv-accept[aria-label="Count Ada\'s answer as right"]');
    await page.waitForTimeout(400);
    out.accept = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
    out.counted = await page.$eval('#viewer .tv-judge-row', (e) => e.className);
    await page.click('#viewer .tv-judge .tv-send');
    await page.waitForTimeout(400);
    out.done = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
    if (!/the answer is Rex/.test(out.title)) throw new Error('the judge sees the answer: ' + out.title);
    if (out.rows.length !== 1 || !/Ada.*Rexy/.test(out.rows[0])) throw new Error('the answers to judge: ' + JSON.stringify(out.rows));
    if (!/"dir":"accept Ada"/.test(out.accept) || !/ok/.test(out.counted)) throw new Error('Count it accepts the answer: ' + JSON.stringify(out));
    if (!/"dir":"done"/.test(out.done)) throw new Error('Reveal ends the judging: ' + out.done);
    return out;
  });
  // Letter Grid (2026-11-20, 3D only): the card shows a small grid with
  // the claims; the arena puts the scene first, then the word panel, the
  // scores, your words and the last round's words. Typing traces the
  // path live (cells as chips, the score it would make); a word that
  // can't be traced, or one you've played, can't be sent; Send carries the
  // word with its cells.
  for (const [label, o] of [['lettergrid-arena', {}], ['lettergrid-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { lg: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .lg-card', { timeout: 6000 });
      out.mini = await page.$$eval('.game-card .lg-mini-cell', (c) => c.length);
      out.owned = await page.$$eval('.game-card .lg-mini-cell.owned', (c) => c.length);
      out.cardCap = await page.$eval('.game-card .lg-card-cap', (e) => e.textContent);
      await page.click('.game-card.kind-lettergrid');
      await page.waitForSelector('#viewer .lg-panel', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .lg-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|lg-panel|lg-scores|lg-yours|lg-reveal/.test(c)));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.reveal = await page.$$eval('#viewer .lg-rv', (r) => r.map((x) => x.textContent));
      await page.fill('#viewer .lg-word', 'zzzz');
      out.bad = await page.$eval('#viewer .lg-trace', (e) => e.textContent);
      out.badSend = await page.$eval('#viewer .lg-send', (b) => b.disabled);
      await page.fill('#viewer .lg-word', 'pour');
      out.played = await page.$eval('#viewer .lg-trace', (e) => e.textContent);
      await page.fill('#viewer .lg-word', 'stone');
      out.cells = await page.$$eval('#viewer .lg-cell', (c) => c.map((x) => x.textContent));
      out.preview = await page.$eval('#viewer .lg-preview', (e) => e.textContent);
      out.focus = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('lg-word'));
      await shot(page, label + '.png');
      await page.click('#viewer .lg-send');
      await page.waitForTimeout(500);
      out.call = calls.filter((c) => c.includes('/games/34/moves')).pop() || '';
      out.queued = await page.$eval('#viewer .lg-queued', (e) => e.textContent).catch(() => '');
      if (out.mini !== 25 || out.owned !== 12) throw new Error('the card shows the grid and its claims: ' + JSON.stringify(out));
      if (!/Round 1: CARE \(Ada, \+8\)/.test(out.cardCap)) throw new Error('the card names the round\'s best word: ' + out.cardCap);
      if (out.toggle) throw new Error('no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,lg-panel,lg-scores,lg-yours,lg-reveal') throw new Error('the scene, the panel, scores, your words, the last round: ' + JSON.stringify(out.order));
      if (!/Your word · round 2 of 8/.test(out.banner)) throw new Error('the banner: ' + out.banner);
      if (out.reveal.length !== 3 || !/CARE/.test(out.reveal.join('|'))) throw new Error('the last round\'s words: ' + JSON.stringify(out.reveal));
      if (!/ZZZZ can't be traced/.test(out.bad) || !out.badSend) throw new Error('an untraceable word cannot be sent: ' + JSON.stringify(out));
      if (!/You've played POUR already/.test(out.played)) throw new Error('your own words cannot repeat: ' + out.played);
      if (out.cells.join(',') !== 'S A1,T B1,O C1,N D1,E E1') throw new Error('the traced cells: ' + JSON.stringify(out.cells));
      if (!/\+5 · \+5 cells/.test(out.preview)) throw new Error('what it would score: ' + out.preview);
      if (!out.focus) throw new Error('typing keeps the field focused');
      if (!/"dir":"stone A1 B1 C1 D1 E1"/.test(out.call)) throw new Error('Send carries the word and its cells: ' + out.call);
      if (!/Your word is in: STONE/.test(out.queued)) throw new Error('the sealed word shows: ' + out.queued);
      return out;
    });
  }
  // Werewolf (2026-11-20, 3D only): the village first, then your role,
  // your move (a vote by day; a role's pick by night), the discussion
  // panel (the town square; the den for wolves), the timeline and the
  // villagers. Day: a villager talks and votes. Night: a wolf picks a
  // kill and whispers in the den.
  for (const [label, o] of [['werewolf-day', {}], ['werewolf-day-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ww: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ww-card', { timeout: 6000 });
      out.cardLine = await page.$eval('.game-card .ww-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-werewolf');
      await page.waitForSelector('#viewer .ww-action', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .ww-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|ww-role|ww-action|ww-talk|ww-events|ww-players/.test(c)));
      out.role = await page.$eval('#viewer .ww-role-name', (e) => e.textContent);
      out.targets = await page.$$eval('#viewer .ww-target', (els) => els.map((e) => e.textContent));
      out.talk = await page.$$eval('#viewer .ww-talk-sec', (els) => els.map((e) => e.querySelector('.ww-talk-title').textContent + ':' + e.querySelectorAll('.ww-line').length));
      out.events = await page.$eval('#viewer .ww-events', (e) => e.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .ww-talk-input', 'I agree - Henry.');
      await shot(page, label + '.png');
      await page.click('#viewer .ww-say');
      await page.waitForTimeout(400);
      out.sayCall = calls.filter((c) => c.includes('/games/30/moves')).pop() || '';
      await page.click('#viewer .ww-target[aria-label="Vote out Henry"]');
      await page.waitForTimeout(400);
      out.voteCall = calls.filter((c) => c.includes('/games/30/moves')).pop() || '';
      out.voted = await page.$eval('#viewer .ww-target.on', (e) => e.textContent);
      if (!/Day 1 · 4 alive · talking and voting/.test(out.cardLine)) throw new Error('the card says the day: ' + out.cardLine);
      if (out.toggle) throw new Error('wave 3 games have no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,ww-role,ww-action,ww-talk,ww-events,ww-players') throw new Error('the village, role, move, talk, timeline, villagers: ' + JSON.stringify(out.order));
      if (out.role !== 'You are the Villager') throw new Error('your role: ' + out.role);
      if (out.targets.length !== 4 || !/^Henry1$/.test(out.targets[1]) || !/Anthony \(you\)/.test(out.targets[2])) throw new Error('the vote lists the living with the public tallies: ' + JSON.stringify(out.targets));
      if (out.talk.join(',') !== 'The village square:1') throw new Error('a villager sees only the town square: ' + JSON.stringify(out.talk));
      if (!/Jax was killed in the night - villager/.test(out.events)) throw new Error('the timeline: ' + out.events);
      if (!/Day 1 · talk it out, then vote/.test(out.banner)) throw new Error('the banner: ' + out.banner);
      if (!/"dir":"say: I agree - Henry\."/.test(out.sayCall)) throw new Error('Say talks in the game: ' + out.sayCall);
      if (!/"dir":"vote Henry"/.test(out.voteCall) || !/Henry/.test(out.voted)) throw new Error('a tap votes: ' + JSON.stringify(out));
      return out;
    });
  }
  for (const [label, o] of [['werewolf-night-wolf', {}], ['werewolf-night-wolf-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ww: true, wwWolf: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ww-card', { timeout: 6000 });
      await page.click('.game-card.kind-werewolf');
      await page.waitForSelector('#viewer .ww-action', { timeout: 20000 });
      out.role = await page.$eval('#viewer .ww-role', (e) => e.textContent);
      out.targets = await page.$$eval('#viewer .ww-target', (els) => els.map((e) => e.textContent));
      out.talk = await page.$$eval('#viewer .ww-talk-sec', (els) => els.map((e) => e.querySelector('.ww-talk-title').textContent));
      out.sleeps = await page.$eval('#viewer .ww-talk-sec', (e) => e.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .ww-target[aria-label="Kill Ada"]');
      await page.waitForTimeout(400);
      out.killCall = calls.filter((c) => c.includes('/games/30/moves')).pop() || '';
      await page.fill('#viewer .ww-talk-sec.den .ww-talk-input', 'agreed');
      await page.click('#viewer .ww-talk-sec.den .ww-say');
      await page.waitForTimeout(400);
      out.denCall = calls.filter((c) => c.includes('/games/30/moves')).pop() || '';
      if (!/You are the Werewolf/.test(out.role) || !/Your pack: Ivy/.test(out.role)) throw new Error('a wolf sees the pack: ' + out.role);
      if (out.targets.length !== 2 || !/Ivy too/.test(out.targets[0])) throw new Error('the kill picks, with the pack\'s: ' + JSON.stringify(out.targets));
      if (out.talk.length !== 2 || !/only your pack/.test(out.talk[1])) throw new Error('a wolf also has the den: ' + JSON.stringify(out.talk));
      if (!/The village sleeps/.test(out.sleeps)) throw new Error('no town talk at night: ' + out.sleeps);
      if (!/Night 2 · your move: kill/.test(out.banner)) throw new Error('the banner asks for the kill: ' + out.banner);
      if (!/"dir":"kill Ada"/.test(out.killCall)) throw new Error('a tap picks the kill: ' + out.killCall);
      if (!/"dir":"den: agreed"/.test(out.denCall)) throw new Error('a whisper goes to the den: ' + out.denCall);
      return out;
    });
  }
  // Twenty Questions (2026-11-20, 3D only): the box first, then the
  // controls (ask or guess; or, as the answerer, answer with a note), the
  // budget, the public Q/A log, the scores and the last reveal.
  for (const [label, o] of [['twenty-ask', {}], ['twenty-ask-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tq: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tq-card', { timeout: 6000 });
      out.cardLine = await page.$eval('.game-card .tq-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-twenty');
      await page.waitForSelector('#viewer .tq-panel', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .tq-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tq-panel|tq-budget|tq-log|tq-scores|tq-reveal/.test(c)));
      out.pips = await page.$$eval('#viewer .tq-pip', (els) => els.filter((e) => e.classList.contains('yes')).length + '/' + els.filter((e) => e.classList.contains('no')).length + '/' + els.length);
      out.log = await page.$$eval('#viewer .tq-qa', (els) => els.map((e) => e.textContent));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .tq-panel .tq-input', 'Is it blue?');
      await shot(page, label + '.png');
      await page.click('#viewer .tq-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/28/moves')).pop() || '';
      out.after = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      if (!/Round 1 of 3 · Ada answers · 2 of 20 asked/.test(out.cardLine)) throw new Error('the card says who answers and how far: ' + out.cardLine);
      if (out.toggle) throw new Error('wave 3 games have no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,tq-panel,tq-budget,tq-log,tq-scores,tq-reveal') throw new Error('the box, your controls, the budget, the log, scores, reveal: ' + JSON.stringify(out.order));
      if (out.pips !== '1/1/20') throw new Error('the budget lights spent questions by answer: ' + out.pips);
      if (out.log.length !== 3 || !/^1HenryIs it alive\?NO/.test(out.log[0]) || !/YES · much/.test(out.log[1]) || !/unanswerable/.test(out.log[2])) throw new Error('the public log: ' + JSON.stringify(out.log));
      if (!/Ask Ada a question · 18 of 20 left/.test(out.banner)) throw new Error('the banner asks for a question: ' + out.banner);
      if (!/"dir":"Is it blue\?"/.test(out.moveCall)) throw new Error('Ask sends the question: ' + out.moveCall);
      if (!/Waiting on Ada's answer/.test(out.after)) throw new Error('then waits on the answer: ' + out.after);
      return out;
    });
  }
  for (const [label, o] of [['twenty-answer', {}], ['twenty-answer-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tq: true, tqAnswer: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tq-card', { timeout: 6000 });
      await page.click('.game-card.kind-twenty');
      await page.waitForSelector('#viewer .tq-panel .tq-q', { timeout: 20000 });
      out.secret = await page.$eval('#viewer .tq-secret', (e) => e.textContent);
      out.q = await page.$eval('#viewer .tq-q', (e) => e.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .tq-note', 'mostly glass');
      await shot(page, label + '.png');
      await page.click('#viewer .tq-yes');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/28/moves')).pop() || '';
      if (out.secret !== 'Your secret: a lighthouse') throw new Error('the answerer sees the secret: ' + out.secret);
      if (out.q !== 'Is it made of metal?' || !/Henry asks · answer/.test(out.banner)) throw new Error('the waiting question: ' + JSON.stringify(out));
      if (!/"dir":"yes - mostly glass"/.test(out.moveCall)) throw new Error('Yes sends the answer and the note: ' + out.moveCall);
      return out;
    });
  }
  // Exquisite Corpse (2026-11-20, 3D only): the desk first; on your turn
  // the fold (only the segment before yours) and your segment, the turn
  // strip, then - once revealed - the story with the favourite vote.
  for (const [label, o] of [['corpse-write', {}], ['corpse-write-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ec: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ec-card', { timeout: 6000 });
      out.cardLine = await page.$eval('.game-card .ec-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-corpse');
      await page.waitForSelector('#viewer .ec-writer', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .ec-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|ec-writer|ec-strip|ec-story|ec-writers/.test(c)));
      out.fold = await page.$eval('#viewer .ec-fold-text', (e) => e.textContent);
      out.strip = await page.$$eval('#viewer .ec-strip .ec-beat', (els) => els.map((e) => e.className.replace('ec-beat', '').trim() || '-').join(','));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .ec-input', 'One. Two. Three. Four.');
      out.over = await page.$eval('#viewer .ec-go', (b) => b.disabled + '|' + document.querySelector('#viewer .ec-count').textContent);
      await page.fill('#viewer .ec-input', 'By midnight the gulls had formed a committee. Their first motion was bread.');
      out.ok = await page.$eval('#viewer .ec-go', (b) => b.disabled);
      await shot(page, label + '.png');
      await page.click('#viewer .ec-go');
      await page.waitForTimeout(600);
      out.moveCall = calls.filter((c) => c.includes('/games/26/moves')).pop() || '';
      out.after = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.writerGone = !(await page.$('#viewer .ec-writer'));
      if (!/Turn 3 of 6 · Anthony is writing/.test(out.cardLine)) throw new Error('the card says whose turn: ' + out.cardLine);
      if (out.toggle) throw new Error('wave 3 games have no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,ec-writer,ec-strip,ec-writers') throw new Error('the desk, your turn, the strip, the writers: ' + JSON.stringify(out.order));
      if (out.fold !== 'The mayor declared it a holiday. Nobody knew why.') throw new Error('the fold shows only the segment before yours: ' + out.fold);
      if (out.strip !== 'wrote,wrote,now,-,-,-') throw new Error('the strip shows who wrote, not what: ' + out.strip);
      if (!/Your turn to write · turn 3 of 6/.test(out.banner)) throw new Error('the banner asks for a segment: ' + out.banner);
      if (!/^true\|4 sentences/.test(out.over) || out.ok !== false) throw new Error('1 to 3 sentences: ' + JSON.stringify(out));
      if (!/gulls had formed a committee\. Their first motion was bread\./.test(out.moveCall)) throw new Error('the segment goes as dir: ' + out.moveCall);
      if (!/Ada is writing/.test(out.after) || !out.writerGone) throw new Error('the turn passes on: ' + out.after);
      return out;
    });
  }
  for (const [label, o] of [['corpse-vote', {}], ['corpse-vote-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ec: true, ecVote: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ec-card', { timeout: 6000 });
      await page.click('.game-card.kind-corpse');
      await page.waitForSelector('#viewer .ec-story', { timeout: 20000 });
      out.seed = await page.$eval('#viewer .ec-seed', (e) => e.textContent);
      out.segs = await page.$$eval('#viewer .ec-seg', (els) => els.map((e) => e.querySelector('.ec-seg-by').textContent + ':' + !!e.querySelector('.ec-vote')));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .ec-seg:nth-of-type(3) .ec-vote');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/26/moves')).pop() || '';
      out.voted = await page.$eval('#viewer .ec-seg.voted .ec-seg-by', (e) => e.textContent);
      if (!/lighthouse keeper/.test(out.seed)) throw new Error('the seed opens the story: ' + out.seed);
      if (out.segs.join(',') !== 'Ada:true,Henry:true,Anthony:false') throw new Error('a favourite for any segment but your own: ' + JSON.stringify(out.segs));
      if (!/The story is revealed · pick a favourite/.test(out.banner)) throw new Error('the banner asks for a favourite: ' + out.banner);
      if (!/"dir":"2"/.test(out.moveCall) || out.voted !== 'Henry') throw new Error('the favourite vote: ' + JSON.stringify(out));
      return out;
    });
  }
  // Two Truths and a Lie (2026-11-19, 3D only - no 2D view or toggle):
  // the campfire first, then the statements to vote on (or the
  // storyteller's form), the scores and the last round's reveal.
  for (const [label, o] of [['twotruths-vote', {}], ['twotruths-vote-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tt: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tt-card-board', { timeout: 6000 });
      out.cardLine = await page.$eval('.game-card .tt-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-twotruths');
      await page.waitForSelector('#viewer:not([hidden]) .tt-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tt-statements|tt-writer|tt-scores|tt-reveal/.test(c)));
      out.label = await page.$eval('#viewer .tt-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.cards = await page.$$eval('#viewer .tt-statements .tt-card', (els) => els.map((e) => e.textContent));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.reveal = await page.$eval('#viewer .tt-reveal', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .tt-statements .tt-card:nth-of-type(2)');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/24/moves')).pop() || '';
      out.voted = await page.$eval('#viewer .tt-card.voted', (e) => e.textContent);
      out.after = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      if (!/Round 2 of 3 · Ada told - vote for the lie/.test(out.cardLine)) throw new Error('the card names the storyteller: ' + out.cardLine);
      if (out.toggle) throw new Error('wave 3 games have no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,tt-statements,tt-scores,tt-reveal') throw new Error('the campfire, then the statements, scores and the reveal: ' + JSON.stringify(out.order));
      if (!/Two Truths and a Lie, 3D view: Ada's statements are up; 1 voted\./.test(out.label)) throw new Error('the scene reads the round: ' + out.label);
      if (out.cards.length !== 3 || !/^1I once lost a duel to a dog/.test(out.cards[0])) throw new Error('the three statements: ' + JSON.stringify(out.cards));
      if (!/Spot the lie · Ada's statements/.test(out.banner)) throw new Error('the banner asks for a vote: ' + out.banner);
      if (!/LIEI have been to the moon/.test(out.reveal) || !/Ada \+2 · Henry \+1/.test(out.reveal)) throw new Error('the last round reveals the lie and points: ' + out.reveal);
      if (!/"dir":"2"/.test(out.moveCall) || !/your vote: the lie/.test(out.voted)) throw new Error('a tap votes: ' + JSON.stringify(out));
      if (!/Your vote is in/.test(out.after)) throw new Error('the vote reads in: ' + out.after);
      return out;
    });
  }
  for (const [label, o] of [['twotruths-write', {}], ['twotruths-write-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tt: true, ttWrite: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tt-card-board', { timeout: 6000 });
      await page.click('.game-card.kind-twotruths');
      await page.waitForSelector('#viewer .tt-writer', { timeout: 20000 });
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.go0 = await page.$eval('#viewer .tt-go', (b) => b.disabled);
      const tas = await page.$$('#viewer .tt-input');
      await tas[0].fill('I have a cat named Pixel');
      await tas[1].fill('I learned to swim at forty');
      await tas[2].fill('I once sang on live radio');
      await page.click('#viewer .tt-writer-row:nth-child(3) .tt-lie-pick');
      out.kept = await page.$$eval('#viewer .tt-input', (els) => els.map((e) => e.value).join('|'));
      out.go1 = await page.$eval('#viewer .tt-go', (b) => b.disabled);
      await shot(page, label + '.png');
      await page.click('#viewer .tt-go');
      await page.waitForTimeout(600);
      out.moveCall = calls.filter((c) => c.includes('/games/24/moves')).pop() || '';
      out.mine = await page.$eval('#viewer .tt-statements', (e) => e.textContent);
      if (!/Your turn to tell · round 3 of 3/.test(out.banner)) throw new Error('the banner asks the storyteller: ' + out.banner);
      if (out.go0 !== true || out.go1 !== false) throw new Error('send waits for three statements and a lie: ' + JSON.stringify(out));
      if (out.kept !== 'I have a cat named Pixel|I learned to swim at forty|I once sang on live radio') throw new Error('marking the lie keeps the text: ' + out.kept);
      if (!/lie[\\"]*:3/.test(out.moveCall) || !/I once sang on live radio/.test(out.moveCall)) throw new Error('the statements go as one structured move: ' + out.moveCall);
      if (!/your lie/.test(out.mine)) throw new Error('the storyteller sees their lie marked: ' + out.mine);
      return out;
    });
  }
  // Liar's Dice (2026-11-19): the card shows the standing bid and the
  // table; the arena puts the bid first, then your cup, the bid builder
  // (count, face, Bid or Liar!), the table and the last round's opened
  // cups. Desktop raises; the phone calls liar.
  for (const [label, o] of [['liarsdice-arena', {}], ['liarsdice-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark', liar: true }]]) {
    await run(label, Object.assign({ state: { ld: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ld-card', { timeout: 6000 });
      out.cardBid = await page.$eval('.game-card .ld-now-bid', (e) => e.textContent);
      await page.click('.game-card.kind-liarsdice');
      await page.waitForSelector('#viewer .ld-bidder', { timeout: 6000 });
      out.now = await page.$eval('#viewer .ld-now', (e) => e.textContent);
      out.cup = await page.$$eval('#viewer .ld-cup .ld-die', (els) => els.map((d) => d.getAttribute('aria-label') + (d.classList.contains('wild') ? 'w' : '')).join(','));
      out.go0 = await page.$eval('#viewer .ld-go', (b) => b.textContent);
      out.odds = await page.$eval('#viewer .ld-odds', (e) => e.textContent);
      out.reveal = await page.$eval('#viewer .ld-reveal', (e) => e.textContent);
      out.hits = await page.$$eval('#viewer .ld-reveal .ld-die.hit', (els) => els.length);
      out.turnSeat = await page.$eval('#viewer .ld-seat.turn .ld-name', (e) => e.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '-bid.png');
      if (o.liar) {
        await page.click('#viewer .ld-liar');
        await page.waitForTimeout(500);
        out.moveCall = calls.filter((c) => c.includes('/games/22/moves')).pop() || '';
        await page.waitForSelector('#viewer .ld-reveal .ld-die.hit', { timeout: 4000 });
        out.after = await page.$eval('#viewer .ld-reveal .ld-verdict', (e) => e.textContent);
        await shot(page, label + '-called.png');
        if (!/"dir":"liar"/.test(out.moveCall)) throw new Error('Liar! sends liar: ' + out.moveCall);
        if (!/the bid stands/.test(out.after) || !/Anthony loses a die \(4 left\)/.test(out.after)) throw new Error('the call opens the cups: ' + out.after);
      } else {
        await page.click('#viewer .ld-face[aria-label="twos"]');
        out.go1 = await page.$eval('#viewer .ld-go', (b) => b.textContent);
        await page.click('#viewer .ld-bid-row .fl-step[aria-label="One fewer die"]');
        out.blocked = await page.$eval('#viewer .ld-go', (b) => b.disabled + '|' + (document.querySelector('#viewer .ld-why') || {}).textContent);
        await page.click('#viewer .ld-face[aria-label="fives"]');
        out.go2 = await page.$eval('#viewer .ld-go', (b) => b.textContent + '|' + b.disabled);
        await page.click('#viewer .ld-go');
        await page.waitForTimeout(500);
        out.moveCall = calls.filter((c) => c.includes('/games/22/moves')).pop() || '';
        out.afterBanner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
        out.builderGone = !(await page.$('#viewer .ld-bidder'));
        if (out.go1 !== 'Bid 4 twos') throw new Error('a face pick keeps the count: ' + out.go1);
        if (!/^true\|Beat 3 fours/.test(out.blocked)) throw new Error('a bid that does not beat the last is blocked: ' + out.blocked);
        if (out.go2 !== 'Bid 3 fives|false' || !/"dir":"3x5"/.test(out.moveCall)) throw new Error('the same count of a higher face is a raise: ' + JSON.stringify(out));
        if (!/Waiting on Henry/.test(out.afterBanner) || !out.builderGone) throw new Error('the turn passes on: ' + out.afterBanner);
      }
      if (!/3 ×by Ada/.test(out.cardBid)) throw new Error('the card shows the standing bid: ' + out.cardBid);
      if (!/Standing bid · round 2/.test(out.now) || !/among all 14 dice - ones count as fours/.test(out.now)) throw new Error('the standing bid: ' + out.now);
      if (out.cup !== '1w,3,4,4,6') throw new Error('your cup, ones marked wild: ' + out.cup);
      if (out.go0 !== 'Bid 4 fours') throw new Error('the builder starts on the classic raise: ' + out.go0);
      if (!/You hold 3 · about 6 expected among all 14/.test(out.odds)) throw new Error('the odds count wild ones: ' + out.odds);
      if (!/Ada called liar on Henry's 7 sixes/.test(out.reveal) || !/the bid was a lie/.test(out.reveal) || !/Henry loses a die \(4 left\)/.test(out.reveal) || out.hits !== 6) throw new Error('the last round opens every cup: ' + out.reveal + ' hits ' + out.hits);
      if (out.turnSeat !== 'Anthony (you)') throw new Error('the table marks whose turn: ' + out.turnSeat);
      if (!/Raise or call liar · round 2/.test(out.banner)) throw new Error('the banner asks for a bid: ' + out.banner);
      return out;
    });
  }
  // The auction (2026-11-19): the card shows the lot and the bidders; the
  // arena puts the lot first, then your sealed bid (steps, quick amounts),
  // the bidders, and the last lot's opened bids.
  for (const [label, o] of [['auction-arena', {}], ['auction-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { au: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .au-card', { timeout: 6000 });
      out.cardLot = await page.$eval('.game-card .au-lot-name', (e) => e.textContent);
      await page.click('.game-card.kind-auction');
      await page.waitForSelector('#viewer .au-bid', { timeout: 6000 });
      out.lot = await page.$eval('#viewer .au-lot', (e) => e.textContent);
      out.result = await page.$eval('#viewer .au-result', (e) => e.textContent);
      out.go0 = await page.$eval('#viewer .au-go', (b) => b.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '-bid.png');
      await page.click('#viewer .au-acts button:has-text("25")');
      await page.click('#viewer .au-bid-row .fl-step[aria-label="5 more"]');
      out.go = await page.$eval('#viewer .au-go', (b) => b.textContent);
      await page.click('#viewer .au-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/20/moves')).pop() || '';
      out.after = await page.$eval('#viewer .au-go', (b) => b.textContent + '|' + b.disabled);
      await shot(page, label + '-sealed.png');
      if (!/unusual wisdom/.test(out.cardLot)) throw new Error('the card shows the lot: ' + out.cardLot);
      if (!/Lot 3 of 6/.test(out.lot)) throw new Error('the lot under the hammer: ' + out.lot);
      if (!/Lot 2: “The last slice of pizza, still warm”Anthony · 20/.test(out.result) || !/pass/.test(out.result)) throw new Error('the last lot\'s opened bids: ' + out.result);
      if (out.go0 !== 'Pass') throw new Error('a zero bid reads as Pass: ' + out.go0);
      if (out.go !== 'Bid 30' || !/"dir":"30"/.test(out.moveCall)) throw new Error('quick amounts and steps make the bid: ' + JSON.stringify(out));
      if (out.after !== 'Bid in ✓|true') throw new Error('the bid reads sealed: ' + out.after);
      if (!/Your bid · lot 3 of 6/.test(out.banner)) throw new Error('the banner asks for a bid: ' + out.banner);
      return out;
    });
  }
  // Trust (2026-11-19): the card shows the scores; the arena puts the
  // scoreboard first, then a Cooperate / Defect pair per rival (Lock in
  // waits for both), then the last round's who-trusted-whom grid.
  for (const [label, o] of [['trust-arena', {}], ['trust-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tr: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tr-card', { timeout: 6000 });
      out.cardOrder = await page.$$eval('.game-card .tr-name', (n) => n.map((x) => x.textContent));
      await page.click('.game-card.kind-trust');
      await page.waitForSelector('#viewer .tr-plan', { timeout: 6000 });
      out.scores = await page.$$eval('#viewer .tr-scores .tr-score', (n) => n.map((x) => x.textContent).join(','));
      out.grid = await page.$$eval('#viewer .tr-grid tr', (rows) => rows.slice(1).map((r) => [...r.querySelectorAll('td.tr-cell')].map((c) => c.textContent).join('')).join('|'));
      out.goOff = await page.$eval('#viewer .tr-go', (b) => b.disabled);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '-plan.png');
      await page.click('#viewer .tr-choice:nth-of-type(2) .tr-pick.c');
      out.halfOff = await page.$eval('#viewer .tr-go', (b) => b.disabled);
      await page.click('#viewer .tr-choice:nth-of-type(3) .tr-pick.d');
      out.goOn = await page.$eval('#viewer .tr-go', (b) => !b.disabled);
      await page.click('#viewer .tr-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/18/moves')).pop() || '';
      out.locked = await page.$eval('#viewer .tr-go', (b) => b.textContent);
      await shot(page, label + '-locked.png');
      if (out.cardOrder.join(',') !== 'Ada,Anthony (you),Henry') throw new Error('the card ranks by score: ' + out.cardOrder);
      if (out.scores !== '14,12,9') throw new Error('the scoreboard ranks by score: ' + out.scores);
      if (out.grid !== '✗✗|✓✗|✓✓') throw new Error('the round 2 grid (rows choose, columns receive): ' + out.grid);
      if (!out.goOff || !out.halfOff || !out.goOn) throw new Error('Lock in waits for a choice per rival: ' + JSON.stringify(out));
      if (!/"dir":"Ada:C, Henry:D"/.test(out.moveCall)) throw new Error('the choices go per rival: ' + out.moveCall);
      if (!/Locked in/.test(out.locked)) throw new Error('the planner reads locked: ' + out.locked);
      if (!/Your choices · round 3/.test(out.banner)) throw new Error('the turn banner asks for choices: ' + out.banner);
      return out;
    });
  }
  // Trust in 3D (the default): the table loads first, then the scores,
  // the choices and the grid; a lock-in still sends per-rival choices.
  for (const [label, o] of [['trust-3d', {}], ['trust-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tr: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tr-card', { timeout: 6000 });
      await page.click('.game-card.kind-trust');
      await page.waitForSelector('#viewer:not([hidden]) .tr-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .tr-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tr-scores|tr-plan|tr-grid-wrap/.test(c)));
      await shot(page, label + '.png');
      await page.click('#viewer .tr-acts button:has-text("Trust everyone")');
      await page.click('#viewer .tr-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/18/moves')).pop() || '';
      if (!/Trust arena, 3D view: Ada 14, chosen; Henry 9, thinking; Anthony \(you\) 12, thinking\. On the table: round 2\./.test(out.label)) throw new Error('the scene reads the table: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,tr-scores,tr-plan,tr-grid-wrap') throw new Error('the table, then scores, choices and the grid: ' + JSON.stringify(out.order));
      if (!/"dir":"Ada:C, Henry:C"/.test(out.moveCall)) throw new Error('Trust everyone sends C to each rival: ' + out.moveCall);
      return out;
    });
  }
  // Liar's Dice in 3D (the default): the table loads first, then the
  // standing bid, your cup, the bid builder, the table and the last round;
  // Liar! still sends the call.
  for (const [label, o] of [['liarsdice-3d', {}], ['liarsdice-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ld: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ld-card', { timeout: 6000 });
      await page.click('.game-card.kind-liarsdice');
      await page.waitForSelector('#viewer:not([hidden]) .ld-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .ld-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|ld-now|ld-cup|ld-bidder|ld-table|ld-reveal/.test(c)));
      await shot(page, label + '.png');
      await page.click('#viewer .ld-liar');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/22/moves')).pop() || '';
      if (!/Liar's Dice table, 3D view: the standing bid is 3 fours by Ada\. Ada 5 dice; Anthony \(you\) 5 dice, to bid; Henry 4 dice\./.test(out.label)) throw new Error('the scene reads the table: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,ld-now,ld-cup,ld-bidder,ld-table,ld-reveal') throw new Error('the table, then the bid, your cup, the builder, the seats and the last round: ' + JSON.stringify(out.order));
      if (!/"dir":"liar"/.test(out.moveCall)) throw new Error('Liar! sends the call: ' + out.moveCall);
      return out;
    });
  }
  // The auction in 3D (the default): the hall loads first, then the lot,
  // your bid and the bidders; a bid still sends the number.
  for (const [label, o] of [['auction-3d', {}], ['auction-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { au: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .au-card', { timeout: 6000 });
      await page.click('.game-card.kind-auction');
      await page.waitForSelector('#viewer:not([hidden]) .au-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .au-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|au-lot|au-bid|au-players|au-result/.test(c)));
      await shot(page, label + '.png');
      await page.click('#viewer .au-acts button:has-text("Half")');
      await page.click('#viewer .au-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/20/moves')).pop() || '';
      if (!/Auction arena, 3D view: the lot is A rubber duck of unusual wisdom\. Ada 65 left, 1 won, bid in; Anthony \(you\) 80 left, 1 won, thinking; Henry 100 left, 0 won, thinking\./.test(out.label)) throw new Error('the scene reads the hall: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,au-lot,au-bid,au-players,au-result') throw new Error('the hall, then the lot, your bid, the bidders and the last lot: ' + JSON.stringify(out.order));
      if (!/"dir":"40"/.test(out.moveCall)) throw new Error('Half bids half the budget left: ' + out.moveCall);
      return out;
    });
  }
  // Four in a Row in 3D (the default): the board scene loads first, the
  // seats and the 1-7 drop buttons follow it (no 2D grid), a drop still
  // sends the column, and there is no 2D view to switch to.
  for (const [label, o] of [['fourinarow-3d', {}], ['fourinarow-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 6000 });
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer:not([hidden]) .c4-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .c4-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|c4-seats|c4-under/.test(c)));
      out.grid = !!(await page.$('#viewer .c4-grid'));
      await shot(page, label + '.png');
      await page.click('#viewer .c4-drop:nth-child(2)');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/16/moves')).pop() || '';
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      if (!/Four in a Row arena, 3D view: Anthony \(you\) plays solid discs; Ada plays ringed discs\. Anthony to move, turn 7\. 6 discs on the board\./.test(out.label)) throw new Error('the scene names the seats and the turn: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,c4-seats,c4-under') throw new Error('the scene, then the seats, then the drop buttons: ' + JSON.stringify(out.order));
      if (out.grid) throw new Error('no 2D grid under the 3D board');
      if (!/"dir":"2"/.test(out.moveCall)) throw new Error('a drop button still sends the column: ' + out.moveCall);
      if (out.toggle) throw new Error('the 2D views are retired: no toggle');
      return out;
    });
  }
  // Code Race in 3D (the default): the vault loads above the guess input,
  // its label reads the race from the viewer's seat, a guess still goes
  // out, and there is no 2D view to switch to.
  for (const [label, o] of [['coderace-3d', {}], ['coderace-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card', { timeout: 6000 });
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer:not([hidden]) .cr-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .cr-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|cr-input|cr-board/.test(c)));
      await shot(page, label + '.png');
      for (const k of ['red', 'green', 'blue', 'yellow']) await page.click('#viewer .cr-color[aria-label="Add ' + k + '"]');
      await page.click('#viewer .cr-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/14/moves')).pop() || '';
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      if (!/Code Race arena, 3D view: Ada, guessed; Anthony \(you\), thinking; Henry, thinking\. On the pillars: round 2\./.test(out.label)) throw new Error('the scene reads the race from the viewer\'s seat: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,cr-input,cr-board') throw new Error('the vault, then the input, then the lanes: ' + JSON.stringify(out.order));
      if (!/"dir":"R G B Y"/.test(out.moveCall)) throw new Error('the 3D view still sends the guess: ' + out.moveCall);
      if (out.toggle) throw new Error('the 2D views are retired: no toggle');
      return out;
    });
  }
  // Frontlines in 3D (the default): the scene loads above the score and
  // the planner, the round's numbers follow the planner, a lock-in still
  // sends the split, and there is no 2D view to switch to.
  for (const [label, o] of [['frontlines-3d', {}], ['frontlines-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { fl: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .fl-card', { timeout: 6000 });
      await page.click('.game-card');
      await page.waitForSelector('#viewer:not([hidden]) .fl-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .fl-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval('#viewer .lc-arena > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /fl-3d-host|lc-board-big|fl-score|fl-plan|fl-cap/.test(c) || c === 'lc-board-big'));
      out.fieldCap = await page.$eval('#viewer .fl-cap', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .fl-acts button:nth-child(1)');
      await page.click('#viewer .fl-go');
      await page.waitForTimeout(500);
      out.moveCall = calls.filter((c) => c.includes('/games/12/moves')).pop() || '';
      if (!/Frontlines arena, 3D view: Anthony \(you\) 0, planning versus Ada 1, committed\. On the field: round 2\./.test(out.label)) throw new Error('the scene names both sides from the viewer\'s seat: ' + out.label);
      if (out.toggle) throw new Error('the 2D views are retired: no toggle');
      const iScene = out.order.indexOf('lc-board-big');
      const iPlan = out.order.indexOf('fl-plan');
      const iCap = out.order.indexOf('fl-cap');
      if (!(iScene >= 0 && iScene < iPlan && iPlan < iCap)) throw new Error('scene, then the planner, then the numbers: ' + JSON.stringify(out.order));
      if (!/Round 2 in numbers/.test(out.fieldCap)) throw new Error('the numbers follow the planner in 3D: ' + out.fieldCap);
      if (!/"dir":"20,20,20,20,20"/.test(out.moveCall)) throw new Error('the 3D view still commits the split: ' + out.moveCall);
      return out;
    });
  }
  // The Guide tab lists every game; Start in a game's entry opens that
  // game's setup directly. The ? in an arena's header opens How to play
  // for that game, and Escape closes the sheet but not the arena.
  await run('games-guide-and-help', { state: { game: true } }, async (page) => {
    const out = {};
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#gm-tab-guide', { timeout: 4000 });
    await page.click('#gm-tab-guide');
    out.guide = await page.$$eval('.gm-guide', (ds) => ds.map((d) => d.getAttribute('data-game')));
    await page.click('.gm-guide[data-game="battleship"] > summary');
    out.rulesShown = await page.$eval('.gm-guide[data-game="battleship"] .howto', (h) => /Sink every enemy ship/.test(h.textContent));
    await page.click('.gm-guide[data-game="battleship"] .btn');
    await page.waitForSelector('#newGameDlg[open]', { timeout: 3000 });
    out.setupFromGuide = await page.$eval('#newGameDlg [data-setup]', (e) => e.getAttribute('data-setup'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.click('#gm-tab-live');
    await page.click('.gm-row');
    await page.waitForSelector('#viewerHelp', { timeout: 6000 });
    await page.click('#viewerHelp');
    await page.waitForSelector('#gameHelpDlg[open]', { timeout: 3000 });
    out.helpTitle = await page.$eval('#ghTitle', (e) => e.textContent);
    await shot(page, 'arena-help.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    out.helpClosed = await page.$eval('#gameHelpDlg', (d) => !d.open);
    out.arenaStillOpen = await page.$eval('#viewer', (v) => !v.hidden);
    if (out.guide.join(',') !== 'duel,frontlines,coderace,trust,auction,liarsdice,twotruths,corpse,twenty,werewolf,lettergrid,trivia,sketch,fourinarow,lightcycles,battleship') throw new Error('guide must list every game: ' + out.guide);
    if (!out.rulesShown) throw new Error('an open guide entry shows the rules');
    if (out.setupFromGuide !== 'battleship') throw new Error('Start in the guide opens that game\'s setup: ' + out.setupFromGuide);
    if (!/How to play Light Cycles/.test(out.helpTitle)) throw new Error('the ? opens this game\'s rules: ' + out.helpTitle);
    if (!out.helpClosed || !out.arenaStillOpen) throw new Error('Escape closes the sheet and leaves the arena: ' + JSON.stringify(out));
    return out;
  });
  await run('denied', { state: { deny: 401 } }, async (page) => { await shot(page, 'denied.png'); return { disabled: await page.$$eval('.tab', e => e.every(x => x.disabled)) }; });
  await run('nonmember', { state: { noYou: true }, hash: '#members' }, async (page) => { return { formShown: await page.$eval('#invForm', f => !f.hidden) }; });
  await run('agent-gate-dark', { state: { agentYou: true }, scheme: 'dark' }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 }); await shot(page, 'agent-gate-dark.png'); return { ok: true }; });
  await run('agent-gate-mobile', { state: { agentYou: true }, w: 390, h: 844, touch: true }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 }); await page.waitForTimeout(200); await shot(page, 'agent-gate-mobile.png'); return { ok: true }; });
  await run('agent-gate-mobile-dark', { state: { agentYou: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 }); await page.waitForTimeout(200); await shot(page, 'agent-gate-mobile-dark.png'); return { ok: true }; });
  await run('forced-dark-light', { args: ['--blink-settings=forceDarkModeEnabled=true'], init: () => { try { localStorage.setItem('chat-theme', 'light'); } catch (e) {} } }, async (page) => { await shot(page, 'forcedark-light.png'); });

  await run('artifacts', { state: { artifacts: true } }, async (page) => {
    const out = {};
    const fr = await page.waitForSelector('.art-card iframe.art-frame', { timeout: 4000 });
    out.frameSandbox = await fr.getAttribute('sandbox');
    out.frameSrc = await fr.getAttribute('src');
    out.cardName = await page.$eval('.art-card .art-name', e => e.textContent);
    await page.waitForSelector('.doc-card .doc-body .md-h', { timeout: 4000 });
    out.docHead = await page.$eval('.doc-card .doc-body .md-h', e => e.textContent);
    out.docName = await page.$eval('.doc-card .art-name', e => e.textContent);
    out.docBody = await page.$eval('.doc-card .doc-body', e => e.textContent);
    if (out.frameSandbox !== 'allow-scripts') throw new Error('iframe sandbox must be exactly allow-scripts, got: ' + out.frameSandbox);
    if (!/Probe doc/.test(out.docHead)) throw new Error('doc heading not rendered: ' + out.docHead);
    if (!/Rendered/.test(out.docBody)) throw new Error('doc body not rendered');
    // Cards are previews only: no Open / Expand / Download links on them.
    out.cardLinks = await page.$$eval('.art-card a, .art-card button, .doc-card a, .doc-card button', els => els.length);
    if (out.cardLinks !== 0) throw new Error('cards must carry no links or buttons, found ' + out.cardLinks);
    await shot(page, 'artifacts-cards.png');
    // Tapping the page card opens the full-screen viewer; browser back closes it.
    await page.click('.art-card');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-frame', { timeout: 4000 });
    out.viewerTitle = await page.$eval('#viewerTitle', e => e.textContent);
    await shot(page, 'artifacts-viewer-page.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    // Tapping the doc card opens the viewer with the full document; the chevron closes it.
    await page.click('.doc-card');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-doc .md-h', { timeout: 4000 });
    out.viewerDoc = await page.$eval('#viewer .viewer-doc', e => e.textContent);
    out.viewerDl = await page.$eval('#viewerDl', e => !e.hidden);
    await shot(page, 'artifacts-viewer-doc.png');
    await page.click('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    if (!/Rendered/.test(out.viewerDoc)) throw new Error('viewer doc not rendered');
    if (!out.viewerDl) throw new Error('viewer must offer Download for a document');
    // Images get the same treatment: inline, no wrapping link; tap opens the viewer.
    out.imgWrapped = await page.$eval('.msg-img', e => e.parentElement.tagName);
    await page.click('.msg-img');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-img', { timeout: 4000 });
    await page.waitForTimeout(200);
    await shot(page, 'artifacts-viewer-image.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    if (out.imgWrapped === 'A') throw new Error('image must not be wrapped in a new-tab link');
    return out;
  });
  await run('artifacts-mobile', { state: { artifacts: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.art-card iframe.art-frame', { timeout: 4000 });
    await shot(page, 'artifacts-mobile-cards.png');
    await page.tap('.art-card');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-frame', { timeout: 4000 });
    await page.waitForTimeout(300);
    await shot(page, 'artifacts-mobile-viewer.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    await page.tap('.msg-img');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-img', { timeout: 4000 });
    await page.waitForTimeout(200);
    await shot(page, 'artifacts-mobile-image.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return { ok: true };
  });

  await run('game-card', { state: { game: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .lc-svg', { timeout: 4000 });
    out.trailCells = await page.$$eval('.game-card .lc-svg rect', els => els.length);
    out.drawLines = await page.$$eval('.game-card .lc-draw', els => els.length);
    if (out.drawLines < 2) throw new Error('each living rider should carry a draw-in segment, got ' + out.drawLines);
    out.cardMeta = await page.$eval('.game-card .art-size', e => e.textContent);
    if (out.trailCells < 10) throw new Error('board should render trails and heads, got ' + out.trailCells + ' rects');
    if (!/Tick 3/.test(out.cardMeta)) throw new Error('card meta wrong: ' + out.cardMeta);
    await shot(page, 'game-card.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lc-pad', { timeout: 4000 });
    out.viewerTitle = await page.$eval('#viewerTitle', e => e.textContent);
    out.padBtns = await page.$$eval('#viewer .lc-btn', els => els.map(b => b.getAttribute('aria-label') + ':' + (b.disabled ? 'off' : 'on')));
    if (!/Light Cycles #1/.test(out.viewerTitle)) throw new Error('viewer title wrong: ' + out.viewerTitle);
    if (!out.padBtns.includes('Steer up:off')) throw new Error('reverse (up, heading down) must be disabled: ' + JSON.stringify(out.padBtns));
    if (!out.padBtns.includes('Steer left:on')) throw new Error('left must be playable: ' + JSON.stringify(out.padBtns));
    await shot(page, 'game-arena.png');
    await page.click('#viewer .lc-btn[aria-label="Steer left"]');
    await page.waitForFunction(() => document.querySelector('#viewer .lc-note').textContent.includes('Queued: left'), null, { timeout: 4000 });
    out.moveCall = calls.filter(c => c.includes('/games/1/moves')).pop() || '';
    if (!/"dir":"left"/.test(out.moveCall)) throw new Error('move call wrong: ' + out.moveCall);
    await shot(page, 'game-arena-queued.png');
    await page.click('#viewer .arena-tabs .arena-tab:nth-child(2)');
    await page.waitForSelector('#viewer .hist-row', { timeout: 4000 });
    out.histRows = await page.$$eval('#viewer .hist-row', els => els.length);
    out.histText = await page.$eval('#viewer .hist-list', e => e.textContent);
    if (out.histRows !== 3) throw new Error('cycles history should render the creation note plus one row per tick, got ' + out.histRows);
    if (!/Tick 1/.test(out.histText) || !/clock/.test(out.histText)) throw new Error('cycles history should show moves with clock-default tags: ' + out.histText.slice(0, 200));
    await shot(page, 'game-arena-history.png');
    await page.click('#viewer .arena-tabs .arena-tab:nth-child(1)');
    await page.waitForSelector('#viewer .lc-pad', { timeout: 4000 });
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return out;
  });
  await run('game-card-mobile', { state: { game: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.game-card .lc-svg', { timeout: 4000 });
    await shot(page, 'game-mobile-card.png');
    await page.tap('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lc-pad', { timeout: 4000 });
    await page.waitForTimeout(300);
    await shot(page, 'game-mobile-arena.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return { ok: true };
  });
  /* Light Cycles 3D (2026-11-13): the arena opens in 3D by default with a
     tag over every cycle ("You" for the viewer), Zones toggles the floor
     tint, and Chase rides behind the viewer's cycle until Reset view. */
  await run('lc-3d-arena', { state: { game: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .lc-svg', { timeout: 4000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lc-3d-host canvas', { timeout: 20000 });
    await page.waitForSelector('#viewer .lc-tag.me', { timeout: 20000 });
    out.tags = await page.$$eval('#viewer .lc-tag', els => els.map(e => e.textContent));
    if (!out.tags.some(t => /^You/.test(t))) throw new Error('the viewer\'s cycle should carry a You tag: ' + JSON.stringify(out.tags));
    await page.click('#viewer .arena3d-toggle:has-text("Zones")');
    out.zones = await page.$eval('#viewer .arena3d-toggle:has-text("Zones")', e => e.getAttribute('aria-pressed'));
    if (out.zones !== 'true') throw new Error('Zones should toggle on, got ' + out.zones);
    await page.click('#viewer .arena3d-toggle:has-text("Chase")');
    out.chase = await page.$eval('#viewer .arena3d-toggle[aria-pressed="true"]:has-text("Chase")', e => e.textContent);
    if (out.chase !== 'Chase: You') throw new Error('Chase should ride behind the viewer first, got ' + out.chase);
    await page.click('#viewer .arena3d-reset:has-text("Reset view")');
    out.after = await page.$eval('#viewer .arena3d-toggle:has-text("Chase")', e => e.getAttribute('aria-pressed') + ' ' + e.textContent);
    if (out.after !== 'false Chase') throw new Error('Reset view should end the chase, got ' + out.after);
    out.note = await page.$eval('#viewer .lc-note', e => e.textContent);
    if (!/tap a marker on the board/.test(out.note)) throw new Error('the 3D note should mention steering on the board: ' + out.note);
    await shot(page, 'lc-3d-arena.png');
    return out;
  });
  /* Light Cycles 3D replay (2026-11-14): a finished match offers Replay
     race; it plays the race from the start line with a tick counter and
     End, and hands back the button when it's over. */
  await run('lc-3d-replay', { state: { game: true } }, async (page, S) => {
    const out = {};
    const g = S.game;
    g.status = 'finished';
    g.winner = 'Ada';
    g.players.forEach((p) => { if (p.name !== 'Ada') { p.alive = false; g.log.push({ tick: g.tick, text: p.name + ' is out at tick ' + g.tick + ' - the trail holds.' }); } });
    g.you.alive = false;
    const card = S.msgs.find((m) => m.id === 9);
    card.game.status = 'finished';
    card.game.winner = 'Ada';
    await page.reload();
    await page.waitForSelector('.game-card', { timeout: 4000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lc-3d-host canvas', { timeout: 20000 });
    await page.waitForSelector('#viewer .lc-replay-btn', { timeout: 30000 });
    await page.click('#viewer .lc-replay-btn');
    await page.waitForSelector('#viewer .lc-replay', { timeout: 4000 });
    out.banner = await page.$eval('#viewer .lc-replay', (e) => e.textContent);
    if (!/Replay/.test(out.banner) || !/of 3/.test(out.banner)) throw new Error('the replay banner should count ticks of 3: ' + out.banner);
    if (await page.$('#viewer .lc-replay-btn')) throw new Error('the Replay button should give way to the banner while it plays');
    await page.click('#viewer .lc-replay button');
    await page.waitForSelector('#viewer .lc-replay-btn', { timeout: 20000 });
    out.after = await page.$$eval('#viewer .lc-replay', (els) => els.length);
    if (out.after !== 0) throw new Error('End should close the replay banner');
    await shot(page, 'lc-3d-replay.png');
    return out;
  });
  // Duel UX: the card carries identity-colored pips and score numerals, the
  // last round's face-off with its verdict, a YOUR THROW pill and the round
  // clock bar; the viewer is a face-off arena with big throw tiles (beats
  // microcopy), a plain-words status line, the last-round verdict banner and
  // a round-chip strip. A tile tap queues the throw through the API.
  await run('duel-card', { state: { duel: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 4000 });
    out.pill = await page.$eval('.game-card .duel-pill', e => e.textContent);
    out.pipColor = await page.$eval('.game-card .duel-row .duel-pips', e => getComputedStyle(e).color);
    out.faceoff = await page.$eval('.game-card .duel-faceoff-line', e => e.textContent);
    out.clockbar = await page.$$eval('.game-card .duel-clockbar', els => els.length);
    if (!/YOUR THROW/.test(out.pill)) throw new Error('card pill wrong: ' + out.pill);
    if (out.pipColor !== 'rgb(34, 211, 238)') throw new Error('Ada pips should be her cyan, got ' + out.pipColor);
    if (!/CLASH/.test(out.faceoff)) throw new Error('card face-off should name the clash: ' + out.faceoff);
    if (out.clockbar !== 1) throw new Error('card should carry one round clock bar, got ' + out.clockbar);
    await shot(page, 'duel-card.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 4000 });
    out.tiles = await page.$$eval('#viewer .duel-tile .t-beats', els => els.map(e => e.textContent));
    out.status = await page.$eval('#viewer .duel-statusline', e => e.textContent);
    out.verdict = await page.$eval('#viewer .duel-verdict', e => e.textContent);
    if (JSON.stringify(out.tiles) !== JSON.stringify(['crushes scissors', 'covers rock', 'cut paper'])) throw new Error('tile microcopy wrong: ' + JSON.stringify(out.tiles));
    if (!/your throw decides the round/.test(out.status)) throw new Error('status line wrong: ' + out.status);
    if (!/CLASH/.test(out.verdict)) throw new Error('verdict banner should name the clash: ' + out.verdict);
    await shot(page, 'duel-arena.png');
    await page.click('#viewer .duel-tile:nth-child(3)');
    await page.waitForFunction(() => document.querySelector('#viewer .duel-tile.queued'), null, { timeout: 4000 });
    out.moveCall = calls.filter(c => c.includes('/games/2/moves')).pop() || '';
    if (!/"dir":"scissors"/.test(out.moveCall)) throw new Error('move call wrong: ' + out.moveCall);
    await shot(page, 'duel-arena-queued.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return out;
  });
  // The lobby: a duel card waits on the viewer's accept, with the
  // buttons right on the card; accepting starts the match in place
  // (no arena trip), and the arena then offers throws as usual.
  await run('duel-lobby', { state: { duelLobby: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 4000 });
    out.cardMeta = await page.$eval('.game-card .art-size', e => e.textContent);
    if (!/Lobby/.test(out.cardMeta) || !/waiting on Anthony/.test(out.cardMeta)) throw new Error('lobby card meta wrong: ' + out.cardMeta);
    await page.waitForSelector('.game-card .game-lobby-actions .duel-btn', { timeout: 4000 });
    await shot(page, 'duel-lobby-card.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lobby-panel .duel-btn', { timeout: 4000 });
    out.arenaLine = await page.$eval('#viewer .lobby-panel .duel-statusline', e => e.textContent);
    if (!/Accept to take your seat/.test(out.arenaLine)) throw new Error('arena lobby line wrong: ' + out.arenaLine);
    await shot(page, 'duel-lobby-arena-panel.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    await page.click('.game-card .game-lobby-actions .duel-btn:first-child');
    await page.waitForFunction(() => document.querySelector('.game-card .art-size').textContent.includes('Round 1'), null, { timeout: 4000 });
    out.acceptCall = calls.filter(c => c.includes('/games/3/accept')).pop() || '';
    if (!out.acceptCall) throw new Error('accept call missing: ' + JSON.stringify(calls.slice(-4)));
    out.viewerHidden = await page.$eval('#viewer', e => e.hidden);
    if (!out.viewerHidden) throw new Error('accept on the card must not open the arena');
    await shot(page, 'duel-lobby-accepted.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 4000 });
    await shot(page, 'duel-lobby-arena.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return out;
  });
  await run('duel-lobby-mobile', { state: { duelLobby: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.game-card .game-lobby-actions .duel-btn', { timeout: 4000 });
    await page.waitForTimeout(200);
    await shot(page, 'duel-lobby-mobile-card.png');
    return { ok: true };
  });
  await run('duel-finished', { state: { duelDone: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 4000 });
    out.cardMeta = await page.$eval('.game-card .art-size', e => e.textContent);
    if (out.cardMeta !== 'Final · 3–2 · 7 rounds') throw new Error('finished card meta should be the standard record line: ' + out.cardMeta);
    out.cardWinner = await page.$eval('.game-card .game-winner', e => e.textContent);
    if (!/🏆/.test(out.cardWinner) || !/Anthony/.test(out.cardWinner) || !/3–2/.test(out.cardWinner)) throw new Error('finished card should carry the winner banner: ' + out.cardWinner);
    out.cardRematch = await page.$$eval('.game-card button', els => els.map(b => b.textContent).filter(t => /Rematch/.test(t)).length);
    if (out.cardRematch !== 1) throw new Error('finished card should offer one Rematch, got ' + out.cardRematch);
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-verdict', { timeout: 4000 });
    out.verdict = await page.$eval('#viewer .duel-verdict', e => e.textContent);
    out.arenaWinner = await page.$eval('#viewer .game-winner', e => e.textContent);
    if (!/Anthony/.test(out.arenaWinner) || !/3–2/.test(out.arenaWinner)) throw new Error('finished arena should carry the winner banner: ' + out.arenaWinner);
    out.tend = await page.$eval('#viewer .duel-tend', e => e.textContent);
    if (!/rock \d+%/.test(out.tend) || !/paper \d+%/.test(out.tend)) throw new Error('finished duel arena should carry tendency lines: ' + out.tend);
    out.chips = await page.$$eval('#viewer .duel-chip', els => els.length);
    out.rematch = await page.$$eval('#viewer button', els => els.map(b => b.textContent).filter(t => /Rematch/.test(t)).length);
    if (out.chips !== 0) throw new Error('the rounds strip should be gone from the game tab, got ' + out.chips);
    if (out.rematch !== 1) throw new Error('finished duel should offer one Rematch, got ' + out.rematch);
    await shot(page, 'duel-finished.png');
    await page.click('#viewer .arena-tabs .arena-tab:nth-child(2)');
    await page.waitForSelector('#viewer .hist-row', { timeout: 4000 });
    out.histRows = await page.$$eval('#viewer .hist-row', els => els.length);
    out.histText = await page.$eval('#viewer .hist-list', e => e.textContent);
    if (out.histRows !== 7) throw new Error('history should render one row per round, got ' + out.histRows);
    if (!/takes it/.test(out.histText) || !/Tie/.test(out.histText)) throw new Error('history rows should carry outcome pills: ' + out.histText.slice(0, 200));
    await shot(page, 'duel-finished-history.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return out;
  });
  await run('duel-mobile', { state: { duel: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.game-card .duel-board', { timeout: 4000 });
    await shot(page, 'duel-mobile-card.png');
    await page.tap('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 4000 });
    await page.waitForTimeout(300);
    await shot(page, 'duel-mobile-arena.png');
    await page.tap('#viewer .arena-tabs .arena-tab:nth-child(2)');
    await page.waitForSelector('#viewer .hist-row', { timeout: 4000 });
    const rows = await page.$$eval('#viewer .hist-row', els => els.length);
    if (rows !== 3) throw new Error('mobile history should render one row per round, got ' + rows);
    await page.waitForTimeout(200);
    await shot(page, 'duel-mobile-history.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return { ok: true };
  });

  // --- M3 message-core scenarios (ported verbatim from tests/ui.test.js) ---
  await run('unread', {}, async (page, S) => {
    await page.click('.tab[data-tab="stakes"]'); await page.waitForTimeout(200);
    await page.evaluate(() => {});
    return null;
  });
  await run('voice', { state: { payloadKind: true }, init: () => {
      window.__said = []; window.__recs = [];
      class FakeSR { constructor() { window.__recs.push(this); } start() { this.on = true; } stop() { this.on = false; setTimeout(() => this.onend && this.onend(), 10); } abort() { this.stop(); } }
      window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = undefined;
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      const synth = { speak(u) { window.__said.push(u.text); this.cur = u; }, cancel() { window.__said.push('<cancel>'); } };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    } }, async (page) => {
    const out = {};
    out.micVisible = await page.$eval('#mic', b => !b.hidden);
    out.sendLabel = await page.$eval('#send', b => b.getAttribute('aria-label') + '|' + !!b.querySelector('svg') + '|' + b.textContent.trim());
    out.speakButtons = await page.$$eval('.speak', b => b.length);
    await page.fill('#text', 'Hi');
    await page.click('#mic'); await page.waitForTimeout(50);
    out.micOn = await page.$eval('#mic', b => b.className + '|' + b.getAttribute('aria-pressed'));
    await shot(page, 'voice-recording.png');
    await page.evaluate(() => { const r = window.__recs[0]; const res = (t, f) => { const a = [{ transcript: t }]; a.isFinal = f; return a; };
      r.onresult({ resultIndex: 0, results: [res('there team', true), res(' this is int', false)] }); });
    out.afterInterim = await page.$eval('#text', t => t.value);
    await page.evaluate(() => { const r = window.__recs[0]; const res = (t, f) => { const a = [{ transcript: t }]; a.isFinal = f; return a; };
      r.onresult({ resultIndex: 1, results: [res('there team', true), res(' this is dictated.', true)] }); });
    out.afterFinal = await page.$eval('#text', t => t.value);
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    out.posted = await page.$eval('#msgs .msg:last-child .text', e => e.textContent);
    out.micAfterSend = await page.$eval('#mic', b => b.className);
    out.textAfterSend = await page.$eval('#text', t => t.value);
    await page.hover('#msgs .msg[data-id="3"]');
    await page.click('#msgs .msg[data-id="3"] .speak'); await page.waitForTimeout(50);
    out.speakOn = await page.$eval('#msgs .msg[data-id="3"] .speak', b => b.className + '|' + b.getAttribute('aria-label'));
    await shot(page, 'voice-speaking.png');
    await page.click('#msgs .msg[data-id="3"] .speak');
    out.speakOff = await page.$eval('#msgs .msg[data-id="3"] .speak', b => b.className);
    out.said = await page.evaluate(() => window.__said);
    out.tags = await page.$$eval('#msgs .msg-head', hs => hs.map(h => Array.from(h.querySelectorAll('.tag')).map(t => t.textContent).join('+') + ':' + h.querySelector('.who').textContent));
    return out;
  });
  await run('dictation-patterns', { init: () => {
      window.__recs = [];
      class FakeSR { constructor() { window.__recs.push(this); } start() {} stop() { setTimeout(() => this.onend && this.onend(), 10); } abort() { this.stop(); } }
      window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = undefined;
    } }, async (page) => {
    const feed = (list) => page.evaluate((list) => {
      const r = window.__recs[window.__recs.length - 1];
      for (const ev of list) { const results = ev.r.map(([t, f]) => { const a = [{ transcript: t }]; a.isFinal = f; return a; }); r.onresult({ resultIndex: ev.i, results }); }
      return document.getElementById('text').value;
    }, list);
    const out = {};
    // Desktop Chrome: separate segments, interim updates, leading spaces
    await page.fill('#text', ''); await page.click('#mic');
    out.desktop = await feed([
      { i: 0, r: [['hello', false]] }, { i: 0, r: [['hello there', false]] }, { i: 0, r: [['hello there', true]] },
      { i: 1, r: [['hello there', true], [' how are', false]] }, { i: 1, r: [['hello there', true], [' how are you', true]] },
    ]);
    await page.click('#mic'); await page.waitForTimeout(50);
    // Appends after existing text
    await page.fill('#text', 'Note:'); await page.click('#mic');
    out.append = await feed([{ i: 0, r: [['buy milk', true]] }, { i: 1, r: [['buy milk', true], ['and eggs', true]] }]);
    return out;
  });
  for (const [label, ua] of [['android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'], ['iphone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1']]) {
    await run('phrase-mode-' + label, { ua, w: 390, h: 844, init: () => {
        window.__recs = [];
        class FakeSR { constructor() { window.__recs.push(this); } start() {} stop() { setTimeout(() => this.onend && this.onend(), 10); } abort() { this.stop(); } }
        window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = undefined;
      } }, async (page) => {
      const say = (pairs, end) => page.evaluate(([pairs, end]) => {
        const r = window.__recs[window.__recs.length - 1];
        const results = pairs.map(([t, f]) => { const a = [{ transcript: t }]; a.isFinal = f; return a; });
        if (results.length) r.onresult({ resultIndex: 0, results });
        if (end) r.onend();
        return { text: document.getElementById('text').value, sessions: window.__recs.length, continuous: r.continuous, mic: document.getElementById('mic').className };
      }, [pairs, end]);
      const out = {};
      await page.click('#mic');
      out.s1 = await say([['hello', false]], false);
      out.s1b = await say([['hello there', true]], true);
      out.s2 = await say([['how are you', true]], true);
      out.s3 = await say([['yes', true]], true);
      out.s4 = await say([['yes', true]], true);
      out.silent = [await say([], true), await say([], true), await say([], true)].map(x => x.mic + '/' + x.sessions);
      await page.fill('#text', ''); await page.click('#mic');
      await say([['send this', true]], false);
      await page.click('#send'); await page.waitForTimeout(300);
      out.afterSend = await page.evaluate(() => ({ text: document.getElementById('text').value, mic: document.getElementById('mic').className, sessions: window.__recs.length }));
      return out;
    });
  }
  for (const [label, o] of [['markdown-light', {}], ['markdown-dark', { scheme: 'dark' }], ['markdown-mobile', { w: 390, h: 844 }]]) {
    await run(label, Object.assign({ state: { markdown: true }, init: () => { window.__alert = 0; window.alert = () => { window.__alert++; }; } }, o), async (page) => {
      await page.waitForTimeout(300);
      await page.evaluate(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight - 1600; });
      await shot(page, label + '.png');
      await page.evaluate(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight; });
      await shot(page, label + '-bottom.png');
      if (label !== 'markdown-light') return;
      return await page.evaluate(() => {
        const m7 = document.querySelector('.msg[data-id="7"] .text'), m8 = document.querySelector('.msg[data-id="8"] .text');
        return {
          h: m7.querySelector('.md-h2') && m7.querySelector('.md-h2').textContent,
          strong: m7.querySelector('strong').textContent, em: m7.querySelector('em').textContent, code: m7.querySelector('p code').textContent,
          ol: Array.from(m7.querySelectorAll(':scope > ol > li')).length, nested: Array.from(m7.querySelectorAll('ol li ul li')).map(x => x.textContent),
          del: m7.querySelector('del').textContent, table: Array.from(m7.querySelectorAll('td')).map(x => x.textContent + (x.style.textAlign ? '@' + x.style.textAlign : '')),
          quote: m7.querySelector('blockquote').textContent, pre: m7.querySelector('pre code').textContent,
          links: Array.from(m7.querySelectorAll('a')).map(a => a.textContent + '=>' + a.getAttribute('href')),
          xssImgs: document.querySelectorAll('.text img').length, xssText: m8.textContent, xssLinks: Array.from(m8.querySelectorAll('a')).length, xssEm: m8.querySelectorAll('em').length,
          alerts: window.__alert,
          human: Array.from(document.querySelectorAll('.msg')).map(r => r.dataset.id + (r.classList.contains('human') ? 'H' : '')).join(' '),
        };
      });
    });
  }
  await run('markdown-speech', { state: { markdown: true }, init: () => {
      window.__said = []; window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      Object.defineProperty(window, 'speechSynthesis', { value: { speak(u) { window.__said.push(u.text); }, cancel() {} }, configurable: true });
    } }, async (page) => {
    await page.evaluate(() => { const b = document.querySelector('.msg[data-id="7"] .speak'); b.click(); });
    return { said: await page.evaluate(() => window.__said.join(' ')) };
  });
  await run('noname', { state: { noYou: true }, w: 1280, h: 860 }, async (page, S) => {
    await page.evaluate(() => { localStorage.removeItem('chat-name'); }); await page.reload(); await page.waitForTimeout(500);
    const before = await page.evaluate(() => ({ input: !document.getElementById('name').hidden, line: !document.getElementById('asLine').hidden }));
    await page.screenshot({ path: OUT + 'noname.png' });
    await page.fill('#text', 'hi'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    const err = await page.$eval('#err', e => e.hidden ? '' : e.textContent);
    await page.fill('#name', 'Guest Writer'); await page.press('#name', 'Enter'); await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ input: !document.getElementById('name').hidden, line: document.getElementById('asLine').textContent.trim() }));
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    const posted = S.msgs[S.msgs.length - 1];
    await page.click('#asChange'); await page.waitForTimeout(100);
    const changing = await page.evaluate(() => !document.getElementById('name').hidden);
    await page.screenshot({ path: OUT + 'named.png' });
    await page.click('.tab[data-tab="questions"]'); await page.waitForTimeout(200);
    await page.fill('#qInput', 'one'); await page.click('#qForm button[type=submit]'); await page.waitForTimeout(400);
    const addEnabled = await page.$eval('#qForm button[type=submit]', b => !b.disabled);
    const qCount = await page.$eval('#c-questions', e => e.textContent);
    return { before, err, after, posted: posted.from + ': ' + posted.text, changing, addEnabled, qCount };
  });
  await run('dictation-patterns', { init: () => {
      window.__recs = [];
      class FakeSR { constructor() { window.__recs.push(this); } start() {} stop() { setTimeout(() => this.onend && this.onend(), 10); } abort() { this.stop(); } }
      window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = undefined;
    } }, async (page) => {
    const feed = (list) => page.evaluate((list) => {
      const r = window.__recs[window.__recs.length - 1];
      for (const ev of list) { const results = ev.r.map(([t, f]) => { const a = [{ transcript: t }]; a.isFinal = f; return a; }); r.onresult({ resultIndex: ev.i, results }); }
      return document.getElementById('text').value;
    }, list);
    const out = {};
    await page.fill('#text', ''); await page.click('#mic');
    out.desktop = await feed([
      { i: 0, r: [['hello', false]] }, { i: 0, r: [['hello there', false]] }, { i: 0, r: [['hello there', true]] },
      { i: 1, r: [['hello there', true], [' how are', false]] }, { i: 1, r: [['hello there', true], [' how are you', true]] },
    ]);
    await page.click('#mic'); await page.waitForTimeout(50);
    await page.fill('#text', 'Note:'); await page.click('#mic');
    out.append = await feed([{ i: 0, r: [['buy milk', true]] }, { i: 1, r: [['buy milk', true], ['and eggs', true]] }]);
    return out;
  });
  for (const [label, ua] of [['android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'], ['iphone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1']]) {
    await run('phrase-mode-' + label, { ua, w: 390, h: 844, init: () => {
        window.__recs = [];
        class FakeSR { constructor() { window.__recs.push(this); } start() {} stop() { setTimeout(() => this.onend && this.onend(), 10); } abort() { this.stop(); } }
        window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = undefined;
      } }, async (page) => {
      const say = (pairs, end) => page.evaluate(([pairs, end]) => {
        const r = window.__recs[window.__recs.length - 1];
        const results = pairs.map(([t, f]) => { const a = [{ transcript: t }]; a.isFinal = f; return a; });
        if (results.length) r.onresult({ resultIndex: 0, results });
        if (end) r.onend();
        return { text: document.getElementById('text').value, sessions: window.__recs.length, continuous: r.continuous, mic: document.getElementById('mic').className };
      }, [pairs, end]);
      const out = {};
      await page.click('#mic');
      out.s1 = await say([['hello', false]], false);
      out.s1b = await say([['hello there', true]], true);
      out.s2 = await say([['how are you', true]], true);
      out.s3 = await say([['yes', true]], true);
      out.s4 = await say([['yes', true]], true);
      out.silent = [await say([], true), await say([], true), await say([], true)].map(x => x.mic + '/' + x.sessions);
      await page.fill('#text', ''); await page.click('#mic');
      await say([['send this', true]], false);
      await page.click('#send'); await page.waitForTimeout(300);
      out.afterSend = await page.evaluate(() => ({ text: document.getElementById('text').value, mic: document.getElementById('mic').className, sessions: window.__recs.length }));
      return out;
    });
  }
  await run('markdown-speech', { state: { markdown: true }, init: () => {
      window.__said = []; window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      Object.defineProperty(window, 'speechSynthesis', { value: { speak(u) { window.__said.push(u.text); }, cancel() {} }, configurable: true });
    } }, async (page) => {
    await page.evaluate(() => { const b = document.querySelector('.msg[data-id="7"] .speak'); b.click(); });
    return { said: await page.evaluate(() => window.__said.join(' ')) };
  });
  await run('no-speech-api', { init: () => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; } }, async (page) => ({ micHidden: await page.$eval('#mic', b => b.hidden) }));

  // --- M4 board / members / reactions scenarios (ported from
  // tests/ui.test.js; fixture paths point at the original fixtures) ---
  await run('actions', {}, async (page, S, calls) => {
    const out = {};
    await page.fill('#text', 'Hello from the test'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    out.lastMsg = await page.$eval('#msgs .msg:last-child .text', e => e.textContent);
    await page.click('.tab[data-tab="questions"]'); await page.waitForTimeout(200);
    // Board parity guards: Delete is a borderless quiet button in the
    // current app, and relative times never pluralize ("5 hr ago").
    const qMeta = await page.$eval('#qList', e => e.textContent);
    if (qMeta.includes('hrs ago')) throw new Error('rel() pluralized hours: ' + qMeta.slice(0, 200));
    if (!qMeta.includes('5 hr ago')) throw new Error('question meta missing "5 hr ago": ' + qMeta.slice(0, 200));
    const delCls = await page.$eval('#qList .btn.danger', b => b.className);
    if (!delCls.includes('quiet')) throw new Error('board Delete is not the quiet variant: ' + delCls);
    await page.fill('#qInput', 'New question from UI'); await page.click('#qForm button[type=submit]'); await page.waitForTimeout(400);
    out.qAfterAdd = await page.$$eval('#qList .card-title', e => e.map(x => x.textContent));
    await page.click('#qList .card:first-child button:has-text("Claim")'); await page.waitForTimeout(300);
    await page.click('#qList .card:first-child button:has-text("Resolve")'); await page.waitForTimeout(200);
    await shot(page, 'action-resolve-form.png');
    // Edit forms: fields are .field columns and the control spans the
    // card (a bare <label> left the textarea at intrinsic width,
    // floating over its label).
    const rfShape = await page.$eval('#qList form.edit', f => { const ta = f.querySelector('textarea'); const lab = ta.closest('label'); return { field: !!lab && lab.classList.contains('field'), ratio: ta.getBoundingClientRect().width / f.getBoundingClientRect().width, cancel: Array.from(f.querySelectorAll('button')).map(b => b.textContent + ':' + b.className).join('|') }; });
    if (!rfShape.field || rfShape.ratio < 0.8) throw new Error('resolve edit-form layout diverges: ' + JSON.stringify(rfShape));
    if (!rfShape.cancel.includes('Cancel:btn sm')) throw new Error('edit-form Cancel is not plain btn sm: ' + rfShape.cancel);
    await page.fill('#qList .card:first-child textarea', 'Henry will book it.'); await page.click('#qList .card:first-child button:has-text("Mark resolved")'); await page.waitForTimeout(400);
    await page.click('[data-qf="resolved"]'); await page.waitForTimeout(200);
    out.resolved = await page.$$eval('#qList .card-title', e => e.map(x => x.textContent));
    await page.click('.tab[data-tab="decisions"]'); await page.waitForTimeout(200);
    await page.click('#dcList .card:last-child button:has-text("Sign")'); await page.waitForTimeout(400);
    out.signers1 = S.dc[0].signers;
    await page.click('.tab[data-tab="constitution"]'); await page.waitForTimeout(200);
    await page.click('#conBody button:has-text("Edit")'); await page.waitForTimeout(200);
    await shot(page, 'action-const-edit.png');
    const ceShape = await page.$eval('#conBody form.edit', f => { const ta = f.querySelector('textarea'); const lab = ta.closest('label'); return { field: !!lab && lab.classList.contains('field'), ratio: ta.getBoundingClientRect().width / f.getBoundingClientRect().width }; });
    if (!ceShape.field || ceShape.ratio < 0.8) throw new Error('constitution edit-form layout diverges: ' + JSON.stringify(ceShape));
    await page.fill('#conBody textarea', 'Purpose v3'); await page.click('#conBody button:has-text("Save as version 3")'); await page.waitForTimeout(400);
    out.conVersion = S.con.version;
    await page.click('.tab[data-tab="stakes"]'); await page.waitForTimeout(200);
    await page.fill('#sTitle', 'Buy gift'); await page.fill('#sDate', ymd(3)); await page.click('#sForm button[type=submit]'); await page.waitForTimeout(400);
    out.stakes = await page.$$eval('#sList .card-title', e => e.map(x => x.textContent));
    await page.click('.tab[data-tab="memory"]'); await page.waitForTimeout(200);
    await page.fill('#dInput', 'Test digest'); await page.click('#dForm button[type=submit]'); await page.waitForTimeout(400);
    out.digests = S.dg.length;
    page.once('dialog', d => d.accept());
    await page.click('.tab[data-tab="decisions"]'); await page.waitForTimeout(200);
    await page.click('#dcList .card:first-child button:has-text("Delete")'); await page.waitForTimeout(400);
    out.decisionsAfterDelete = S.dc.length;
    await page.click('[data-theme-set="dark"]'); await page.waitForTimeout(100);
    await page.reload(); await page.waitForTimeout(500);
    out.themeAfterReload = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    out.tabAfterReload = await page.evaluate(() => document.querySelector('.tab[aria-current="page"]').dataset.tab);
    out.writes = calls.filter(c => !c.startsWith('GET')).map(c => c.split(' ').slice(0, 2).join(' '));
    return out;
  });
  await run('invites', {}, async (page, S, calls) => {
    await shot(page, 'kinds-chat.png');
    const tags = await page.$$eval('#msgs .msg-head', hs => hs.map(h => Array.from(h.querySelectorAll('.tag')).map(t => t.textContent).join('+') + ':' + h.querySelector('.who').textContent));
    await page.click('.tab[data-tab="members"]'); await page.waitForTimeout(200);
    const formShown = await page.$eval('#invForm', f => !f.hidden);
    const instrCount = await page.$$eval('button', bs => bs.filter(b => b.textContent === 'Copy w/ Instructions').length);
    await shot(page, 'members-desktop.png');
    await page.fill('#invName', 'Matheo'); await page.click('[data-kind="human"]'); await page.click('#invForm button[type=submit]'); await page.waitForTimeout(400);
    await shot(page, 'invite-human.png');
    const humanFields = await page.$$eval('#invResult input', i => i.map(x => x.value));
    const humanBtns = await page.$$eval('#invResult button', b => b.map(x => x.textContent));
    await page.fill('#invName', 'Scout'); await page.click('[data-kind="agent"]'); await page.click('#invForm button[type=submit]'); await page.waitForTimeout(400);
    await shot(page, 'invite-agent.png');
    const agentFields = await page.$$eval('#invResult input', i => i.map(x => x.value));
    const agentBtns = await page.$$eval('#invResult button', b => b.map(x => x.textContent));
    await page.fill('#invName', 'Ada'); await page.click('#invForm button[type=submit]'); await page.waitForTimeout(400);
    const dupToast = await page.$eval('#toast', t => t.hidden ? '' : t.textContent);
    const posts = calls.filter(c => c.startsWith('POST') && c.includes('/invites')).map(c => c.split(' ').slice(2).join(' '));
    return { tags, formShown, instrCount, humanFields, agentFields, humanBtns, agentBtns, dupToast, posts };
  });
  await run('invite-card-mobile-dark', { scheme: 'dark', w: 390, h: 844, hash: '#members' }, async (page) => {
    await page.fill('#invName', 'Scout'); await page.click('[data-kind="agent"]'); await page.click('#invForm button[type=submit]'); await page.waitForTimeout(400);
    await shot(page, 'invite-agent-mobile-dark.png');
    return { btns: await page.$$eval('#invResult button', b => b.map(x => x.textContent)) };
  });
  await run('invites-dark-mobile', { scheme: 'dark', w: 390, h: 844, hash: '#members' }, async (page) => { await shot(page, 'members-mobile-dark.png'); });
  /* A reload paints avatars at once (2026-11-19): the roster is remembered
     per room on the device, so the chat shows each picture before
     /members answers (here held back 3 s) instead of initials. */
  await run('avatars-instant-reload', {}, async (page) => {
    await page.waitForSelector('#msgs .msg .gutter .avatar.img img', { timeout: 4000 });
    const first = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.filter(a => a.querySelector('img')).length);
    await page.route(/\/api\/rooms\/[^/]+\/members(\?|$)/, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.fallback(); });
    await page.reload();
    await page.waitForSelector('#msgs .msg', { timeout: 4000 });
    await page.waitForTimeout(300);
    const early = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.filter(a => a.querySelector('img')).length);
    if (!first || early !== first) throw new Error('after a reload, avatars should show before /members answers: ' + early + ' of ' + first);
    return { first, early };
  });
  await run('avatars', {}, async (page, S, calls) => {
    const out = {};
    out.chatAvatars = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.map(a => a.className + (a.querySelector('img') ? ':img' : a.querySelector('svg') ? ':svg' : ':' + a.textContent)));
    await shot(page, 'avatars-chat.png');
    await page.click('.tab[data-tab="members"]'); await page.waitForTimeout(200);
    out.before = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Add a photo")')]);
    await fc.setFiles(FIXTURES + 'photo.png'); await page.waitForTimeout(800);
    out.upload = calls.filter(c => c.startsWith('PUT') && c.includes('/avatar'));
    out.after = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    out.myAvatarImg = await page.$eval('#mList .card.member .avatar img', i => i.complete && i.naturalWidth + 'x' + i.naturalHeight).catch(() => 'none');
    out.uploadedSize = S.av.anthony ? S.av.anthony.buf.length : 0;
    await shot(page, 'avatars-members.png');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Change photo")')]);
    await fc2.setFiles(FIXTURES + 'henry.gif'); await page.waitForTimeout(600);
    out.gifUpload = calls.filter(c => c.startsWith('PUT') && c.includes('/avatar')).slice(-1)[0];
    const [fc3] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Change photo")')]);
    await fc3.setFiles(FIXTURES + 'notimage.png'); await page.waitForTimeout(600);
    out.badToast = await page.$eval('#toast', t => t.textContent);
    await page.click('#mList .photo-actions button:has-text("Remove photo")'); await page.waitForTimeout(500);
    out.afterRemove = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    await page.click('.tab[data-tab="chat"]'); await page.waitForTimeout(200);
    return out;
  });
  await run('avatars-dark-mobile', { scheme: 'dark', w: 390, h: 844 }, async (page) => { await shot(page, 'avatars-mobile-dark.png'); });
  for (const [label, o] of [['avatar-dialog', {}], ['avatar-dialog-dark-mobile', { scheme: 'dark', w: 390, h: 844 }]]) {
    await run(label, o, async (page) => {
      const out = {};
      await page.click('#msgs .msg[data-id="1"] .avatar'); await page.waitForTimeout(400);
      out.henry = await page.evaluate(() => ({ open: document.getElementById('avDlg').open, name: document.getElementById('avName').textContent, kind: document.getElementById('avKind').textContent, img: (document.querySelector('#avBig img') || {}).naturalWidth, size: document.querySelector('#avBig .avatar').getBoundingClientRect().width }));
      // Name and kind pill sit on one .title-row line in the current
      // app; stacked block divs are a divergence.
      const avRow = await page.evaluate(() => { const n = document.getElementById('avName'), k = document.getElementById('avKind'); return !!(n && k && n.parentElement && n.parentElement.classList.contains('title-row') && k.parentElement === n.parentElement); });
      if (!avRow) throw new Error('avatar dialog name/kind are not on one title-row');
      await shot(page, label + '-gif.png');
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      out.closedByEsc = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.click('#msgs .msg[data-id="4"] .avatar'); await page.waitForTimeout(200);
      out.claude = await page.evaluate(() => ({ name: document.getElementById('avName').textContent, kind: document.getElementById('avKind').textContent, svg: !!document.querySelector('#avBig svg') }));
      // The in-room bot is retired (2026-11-12) and "claude" is an ordinary
      // name: a non-member sender by that name gets no Bot pill and no bot glyph.
      if (out.claude.kind !== '' || out.claude.svg) throw new Error('claude should render as an ordinary sender, got ' + JSON.stringify(out.claude));
      await shot(page, label + '-claude.png');
      await page.mouse.click(5, 5); await page.waitForTimeout(150);
      out.closedByBackdrop = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.click('#msgs .msg[data-id="3"] .avatar'); await page.waitForTimeout(200);
      out.ada = await page.evaluate(() => ({ text: document.querySelector('#avBig .avatar').textContent, kind: document.getElementById('avKind').textContent }));
      await shot(page, label + '-initials.png');
      await page.click('#avClose'); await page.waitForTimeout(150);
      out.closedByButton = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.focus('#msgs .msg[data-id="5"] .avatar'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
      out.keyboard = await page.evaluate(() => document.getElementById('avDlg').open && document.getElementById('avName').textContent);
      return out;
    });
  }
  await run('reactions', {}, async (page, S, calls) => {
    const out = {};
    const chips = (id) => page.$$eval('.msg[data-id="' + id + '"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    out.initial = await chips(3);
    const box = await page.$eval('.msg[data-id="1"] .text', e => { const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; });
    await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up(); await page.waitForTimeout(100);
    out.barOpen = await page.$$eval('.rx-bar button.rx', b => b.map(x => x.textContent).join(''));
    // The quick bar is production-shaped: six reactions ending in
    // Angry, a plain-plus "More reactions" button, and a text-only
    // Copy (an icon Copy once wrapped the mobile bar to two rows).
    const barShape = await page.$$eval('.rx-bar button', bs => bs.map(b => ({ t: b.title || '', txt: b.textContent, cls: b.className, svg: !!b.querySelector('svg') })));
    if (!barShape.some(b => b.t === 'Angry')) throw new Error('reaction bar lacks the Angry quick reaction: ' + JSON.stringify(barShape));
    if (!barShape.some(b => b.cls.includes('rx-plus') && b.t === 'More reactions')) throw new Error('reaction bar plus button diverges: ' + JSON.stringify(barShape));
    const copyBtn = barShape.find(b => b.txt === 'Copy');
    if (!copyBtn || copyBtn.svg) throw new Error('reaction bar Copy must be text-only: ' + JSON.stringify(barShape));
    await shot(page, 'reactions-bar.png');
    await page.click('.rx-bar button[title="Love"]'); await page.waitForTimeout(300);
    out.afterLove = await chips(1); out.barClosed = !(await page.$('.rx-bar'));
    await page.click('.msg[data-id="1"] .text'); await page.waitForTimeout(600);
    out.quickClickNoBar = !(await page.$('.rx-bar'));
    await page.hover('.msg[data-id="1"]'); await page.click('.msg[data-id="1"] .react-btn'); await page.waitForTimeout(150);
    await page.click('.rx-bar button[title="Haha"]'); await page.waitForTimeout(300);
    out.afterHaha = await chips(1);
    await page.click('.msg[data-id="1"] .rx-chip.mine'); await page.waitForTimeout(300);
    out.afterRemove = await chips(1);
    await page.click('.msg[data-id="3"] .rx-chip:not(.mine)'); await page.waitForTimeout(300);
    out.msg3 = await chips(3);
    out.titles = await page.$$eval('.msg[data-id="3"] .rx-chip', cs => cs.map(c => c.title));
    await page.click('.msg[data-id="3"] .react-btn', { force: true }); await page.waitForTimeout(100);
    await page.keyboard.press('Escape'); out.escCloses = !(await page.$('.rx-bar'));
    out.posts = calls.filter(c => c.includes('/reactions')).map(c => c.replace('POST /api/rooms/demo/messages/', ''));
    await page.hover('.msg[data-id="3"]'); await shot(page, 'reactions-chips.png');
    return out;
  });
  /* The quick reaction bar fits a 360px phone whole, Copy and + included
     (2026-11-19 sweep: at ~365px wide they were clipped). */
  await run('reactions-bar-narrow', { w: 360, h: 760, touch: true }, async (page) => {
    const box = await page.$eval('.msg[data-id="1"] .text', e => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; });
    await page.waitForTimeout(150);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    await page.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);
    const fit = await page.evaluate(() => {
      const bar = document.querySelector('.rx-bar');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      const kids = Array.from(bar.querySelectorAll('button')).map(b => b.getBoundingClientRect());
      return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, kidsInside: kids.every(k => k.left >= r.left - 1 && k.right <= r.right + 1 && k.right <= innerWidth) };
    });
    if (!fit) throw new Error('the reaction bar did not open on a long press');
    if (fit.left < 0 || fit.right > fit.vw || !fit.kidsInside) throw new Error('reaction bar clipped on a 360px phone: ' + JSON.stringify(fit));
    await shot(page, 'reactions-bar-narrow.png');
    return fit;
  });
  /* Holding a reaction chip opens who reacted right above that chip,
     its pointer on it (2026-11-19: it used to sit over the message
     above, 40px in from the row's edge), with the chip outlined;
     Escape closes it and clears the outline. Desktop and phone. */
  for (const [label, o] of [['reactions-who-anchored', {}], ['reactions-who-anchored-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, o, async (page) => {
      await page.waitForSelector('.rx-chip', { timeout: 4000 });
      const chips = await page.$$('.rx-chip');
      const chip = chips[chips.length - 1];
      const cb = await chip.boundingBox();
      const x = cb.x + cb.width / 2, y = cb.y + cb.height / 2;
      if (o.touch) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(650);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(650);
        await page.mouse.up();
      }
      await page.waitForSelector('.rx-who[data-side]', { timeout: 3000 });
      await page.waitForTimeout(250);
      const wb = await (await page.$('.rx-who')).boundingBox();
      const out = { side: await page.$eval('.rx-who', e => e.dataset.side), gap: Math.round(cb.y - (wb.y + wb.height)), offCentre: Math.round(Math.abs(wb.x + wb.width / 2 - x)) };
      out.held = await chip.evaluate(e => e.classList.contains('rx-held'));
      if (out.side !== 'above' || out.gap < 4 || out.gap > 16) throw new Error('who reacted should sit just above the held chip: ' + JSON.stringify(out));
      if (out.offCentre > 2) throw new Error('who reacted should be centred on the held chip: ' + JSON.stringify(out));
      if (!out.held) throw new Error('the held chip should be outlined while its popover is open');
      await shot(page, label + '.png');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.rx-who') && !document.querySelector('.rx-chip.rx-held'), null, { timeout: 2000 });
      return out;
    });
  }
  await run('reactions-hold-noclick', {}, async (page, S, calls) => {
    // Regression (owner soak, 2026-11-09): "hold brings up the bar,
    // but I have to click twice for the selection to take." A real
    // touch long-press release often produces NO click event, so the
    // swallow flag set when the bar opens must not outlive the
    // gesture: production clears it 120ms after pointerup and exempts
    // clicks inside the popover. A port missing both guards eats the
    // first deliberate tap. Synthetic pointer events model the
    // no-click release exactly (no native click follows them).
    const out = {};
    const chips = (id) => page.$$eval('.msg[data-id="' + id + '"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    const holdOpen = async (id) => {
      await page.$eval('.msg[data-id="' + id + '"] .text', (el) => {
        const r = el.getBoundingClientRect();
        const init = { bubbles: true, clientX: r.left + 20, clientY: r.top + 8, button: 0, pointerId: 9, isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerdown', init));
      });
      await page.waitForTimeout(700);
      await page.$eval('.msg[data-id="' + id + '"] .text', (el) => {
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, isPrimary: true }));
      });
    };
    // Phase 1: slow tap after a no-click release (flag-expiry path).
    await holdOpen(1);
    out.bar1 = !!(await page.$('.rx-bar'));
    await page.waitForTimeout(300);
    await page.click('.rx-bar button[title="Love"]'); await page.waitForTimeout(300);
    out.afterLove = await chips(1);
    if (JSON.stringify(out.afterLove) !== JSON.stringify(['\u2764\uFE0F1*'])) throw new Error('first tap after a no-click hold-release was eaten: ' + JSON.stringify(out));
    // Phase 2: immediate tap after a no-click release (in-popover
    // exemption path - the tap lands before any expiry could run).
    await holdOpen(3);
    out.bar2 = !!(await page.$('.rx-bar'));
    await page.click('.rx-bar button[title="Wow"]'); await page.waitForTimeout(300);
    out.afterWow = await chips(3);
    if (!out.afterWow.some(c => c === '\u{1F62E}1*')) throw new Error('immediate tap after a no-click hold-release was eaten: ' + JSON.stringify(out));
    out.posts = calls.filter(c => c.includes('/reactions')).map(c => c.replace('POST /api/rooms/demo/messages/', ''));
    return out;
  });
  await run('reactions-picker', {}, async (page, S, calls) => {
    const out = {};
    await page.hover('.msg[data-id="1"]'); await page.click('.msg[data-id="1"] .react-btn'); await page.waitForTimeout(150);
    await page.click('.rx-bar .rx-plus'); await page.waitForTimeout(500);
    out.sections = await page.$$eval('.rx-picker .rx-sec', s => s.map(x => x.textContent));
    out.cells = await page.$$eval('.rx-picker .rx-cell', c => c.length);
    await shot(page, 'reactions-picker.png');
    await page.fill('.rx-picker .rx-search', 'unicorn'); await page.waitForTimeout(150);
    out.search = await page.$$eval('.rx-picker .rx-cell', c => c.map(x => x.textContent).join(''));
    await page.click('.rx-picker .rx-cell'); await page.waitForTimeout(300);
    out.chips1 = await page.$$eval('.msg[data-id="1"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    out.pickerClosed = !(await page.$('.rx-picker'));
    out.post = calls.filter(c => c.includes('/reactions')).slice(-1)[0];
    await page.hover('.msg[data-id="1"]'); await page.click('.msg[data-id="1"] .react-btn'); await page.waitForTimeout(150);
    out.barMine = await page.$$eval('.rx-bar button.rx.on', b => b.map(x => x.textContent));
    await page.click('.rx-bar .rx-plus'); await page.waitForTimeout(300);
    out.recent = await page.$eval('.rx-picker .rx-sec', s => s.textContent + ':' + s.nextElementSibling.textContent);
    // The picker highlights your current reaction's cell (.on), like
    // the current app — the unicorn just picked on this message.
    const pickerOn = await page.$$eval('.rx-picker .rx-cell.on', cs => cs.map(c => c.textContent));
    // Production marks the mine emoji wherever it renders (Recent
    // row AND its home category), so: at least one, all the unicorn.
    if (!pickerOn.length || pickerOn.some(e => e !== '\u{1F984}')) throw new Error('picker mine-highlight diverges: ' + JSON.stringify(pickerOn));
    await page.click('.rx-picker .rx-tab[title="Food & Drink"]'); await page.waitForTimeout(150);
    out.tabScrolled = await page.$eval('.rx-picker .rx-grid', g => g.scrollTop > 100);
    await page.keyboard.press('Escape'); out.escClosed = !(await page.$('.rx-picker'));
    out.speakPill = await page.$eval('.msg[data-id="1"] .speak', b => { const s = getComputedStyle(b); return s.borderRadius + ' ' + s.opacity; });
    out.chips3 = await page.$$eval('.msg[data-id="3"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    await page.mouse.move(5, 300); await shot(page, 'reactions-after.png');
    return out;
  });
  await run('reactions-picker-mobile', { w: 390, h: 844, scheme: 'dark', touch: true }, async (page) => {
    const r = await page.$eval('.msg[data-id="3"] .text', e => { const b = e.getBoundingClientRect(); return { x: b.left + 30, y: b.top + 10 }; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }); await page.waitForTimeout(600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(150);
    await shot(page, 'reactions-bar-mobile-dark.png');
    await page.tap('.rx-bar .rx-plus'); await page.waitForTimeout(500);
    await shot(page, 'reactions-picker-mobile-dark.png');
    return { inView: await page.$eval('.rx-picker', p => { const b = p.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; }) };
  });
  await run('reactions-touch', { w: 390, h: 844, scheme: 'dark', touch: true }, async (page) => {
    const out = {};
    const r = await page.$eval('.msg[data-id="3"] .text', e => { const b = e.getBoundingClientRect(); return { x: b.left + 30, y: b.top + 10 }; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
    await page.waitForTimeout(650);
    out.barOpen = !!(await page.$('.rx-bar'));
    await shot(page, 'reactions-touch-dark.png');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(200);
    out.stillOpenAfterRelease = !!(await page.$('.rx-bar'));
    out.barInView = await page.$eval('.rx-bar', b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; });
    await page.tap('.rx-bar button[title="Wow"]'); await page.waitForTimeout(300);
    out.chips = await page.$$eval('.msg[data-id="3"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y + 60 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x, y: r.y + 10 }] });
    await page.waitForTimeout(650);
    out.dragNoBar = !(await page.$('.rx-bar'));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return out;
  });

  // The media shelf: the attachments listing as a filterable grid,
  // the full-screen viewer, and the jump back to the message.
  await run('media-shelf', { state: { artifacts: true, shelf: true }, hash: '#invite=tok_Anthony' }, async (page) => {
    await page.click('.tab[data-tab="media"]');
    await page.waitForSelector('.media-tile', { timeout: 5000 });
    const out = {};
    out.tiles = await page.$$eval('.media-tile', ts => ts.length);
    out.allCount = await page.$eval('.media-bar .seg button[aria-pressed="true"] .media-n', e => e.textContent).catch(() => null);
    await shot(page, 'media-grid.png');
    await page.click('.media-bar .seg button:nth-child(2)');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 1);
    out.photosOnly = await page.$$eval('.media-tile', ts => ts.length);
    await page.click('.media-bar .seg button:nth-child(1)');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 5);
    await page.selectOption('.media-from', 'Anthony');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 1);
    out.senderKinds = await page.$$eval('.media-tile .media-kind', ts => ts.map(t => t.textContent));
    await page.selectOption('.media-from', '');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 5);
    out.tileRef = await page.$eval('.media-tile .media-ref', e => e.textContent);
    await page.click('.media-tile:has(img)');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-img', { timeout: 5000 });
    out.viewerOpen = true;
    out.capRef = await page.$eval('.media-cap-ref code', e => e.textContent);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('.media-cap-ref .btn');
    await page.waitForFunction(() => document.querySelector('.media-cap-ref .btn').textContent === 'Copied', null, { timeout: 3000 });
    out.clipboard = await page.evaluate(() => navigator.clipboard.readText());
    await shot(page, 'media-viewer.png');
    await page.click('.media-cap .media-jump');
    await page.waitForFunction(() => document.querySelector('#viewer').hidden, null, { timeout: 5000 });
    out.backInChat = await page.$eval('#view-chat', e => !e.hidden);
    await page.waitForFunction(() => { const el = document.querySelector('.msg[data-id="8"]'); return !!el && el.classList.contains('flash'); }, null, { timeout: 5000 });
    out.flashed = true;
    return out;
  });
  await run('media-shelf-mobile', { state: { artifacts: true, shelf: true }, hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page) => {
    await page.tap('#menu');
    await page.waitForTimeout(300);
    await page.tap('.tab[data-tab="media"]');
    await page.waitForSelector('.media-tile', { timeout: 5000 });
    await page.waitForTimeout(700); // let the drawer finish closing before the shot
    const tiles = await page.$$eval('.media-tile', ts => ts.length);
    const overflow = await page.evaluate(() => {
      const seg = document.querySelector('.media-bar .seg');
      return {
        doc: document.documentElement.scrollWidth - window.innerWidth,
        bar: seg ? seg.getBoundingClientRect().right - window.innerWidth : 0,
      };
    });
    if (overflow.doc > 0 || overflow.bar > 0) throw new Error('media bar overflows the viewport: ' + JSON.stringify(overflow));
    await shot(page, 'media-grid-mobile.png');
    return { tiles, overflow };
  });

  // The home page runs on its own fake (like the original suite's
  // runHome): "/" serves the app, /api/build is always ahead, and
  // any room's messages answer you: "Tester" for identity checks.
  async function runHome() {
    const name = 'home-page';
    const b = await chromium.launch({});
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.route('https://chat.victorio.cloud/**', async (route) => {
      const u = new URL(route.request().url());
      const pth = u.pathname;
      const J = (o, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (pth === '/' || pth === '/index.html' || pth.startsWith('/r/')) return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
      if (pth === '/api/build') return J({ build: 'uitestbuild2' });
      if (pth.endsWith('/messages')) return J({ messages: [], you: 'Tester' });
      if (pth.endsWith('/members')) return J({ room: 'demo', invite_only: true, members: [] });
      if (pth.startsWith('/assets/')) { try { const b2 = require('fs').readFileSync(DIST + pth); return route.fulfill({ status: 200, contentType: pth.endsWith('.css') ? 'text/css' : 'text/javascript', body: b2 }); } catch (e) { return route.fulfill({ status: 404, body: 'nf' }); } }
      return route.fulfill({ status: 404, body: 'nf' });
    });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('chat-invite:demo-room', 'tok_demo');
        localStorage.setItem('chat-invite:second-room', 'tok_second');
      } catch (e) {}
    });
    const out = {};
    try {
      await page.goto('https://chat.victorio.cloud/');
      await page.waitForTimeout(900);
      out.rows = await page.$$eval('.roomrow', (rs) => rs.length);
      const brandDisplay = await page.$eval('.brand-block', (e) => getComputedStyle(e).display);
      if (brandDisplay !== 'flex') throw new Error('home brand-block is not flex (display=' + brandDisplay + ')');
      out.forgetInsideLink = await page.$eval('body', () => !!document.querySelector('.roomrow a .forget'));
      out.forgetIsSibling = await page.$eval('body', () => !!document.querySelector('.roomrow > .forget'));
      out.asYou = await page.$$eval('.roomrow .who', (ws) => ws.map((w) => w.textContent));
      await page.click('.tab[data-view="create"]');
      await page.waitForTimeout(200);
      await page.fill('#cRoom', 'My Room');
      out.preview = await page.$eval('#cRoomUrl', (e) => e.textContent);
      await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 4000 });
      out.updateBanner = true;
      await page.screenshot({ path: OUT + 'home-update-banner.png' });
      await page.evaluate(() => {
        const bar = document.querySelector('.topbar');
        const mk = (t, y) => new PointerEvent(t, { clientY: y, bubbles: true, pointerId: 7, isPrimary: true });
        bar.dispatchEvent(mk('pointerdown', 40));
        bar.dispatchEvent(mk('pointermove', 170));
      });
      out.pullHint = await page.$eval('#pullHintText', (e) => e.textContent);
      await page.screenshot({ path: OUT + 'home-pull.png' });
      await Promise.all([
        page.waitForNavigation({ timeout: 5000 }),
        page.evaluate(() => document.querySelector('.topbar').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, isPrimary: true }))),
      ]);
      out.pullReloaded = true;
    } catch (e) {
      FAILURES++;
      console.log('FAIL ' + name + ': harness error: ' + e.message);
    }
    await b.close();
    const fatal = errs.filter((e) => !e.startsWith('console:'));
    if (fatal.length) {
      FAILURES++;
      console.log('FAIL ' + name + ': ' + JSON.stringify(fatal));
    }
    if (out.rows !== 2 || out.forgetInsideLink || !out.forgetIsSibling || (out.preview || '').indexOf('/r/my-room') < 0 || !out.updateBanner || out.pullHint !== 'Release to refresh' || !out.pullReloaded) {
      FAILURES++;
      console.log('FAIL ' + name + ': assertions: ' + JSON.stringify(out));
    } else {
      console.log('PASS ' + name + ' ' + JSON.stringify(out));
    }
    if (errs.length) console.log(name + ' ERRORS: ' + JSON.stringify(errs));
  }
  await runHome();
  console.log(FAILURES ? 'PARITY SUITE: ' + FAILURES + ' failing scenario(s)' : 'PARITY SUITE: all ported scenarios pass');
  process.exit(FAILURES ? 1 : 0);
})();
