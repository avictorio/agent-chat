// Parity harness for the React rewrite (web/PARITY.md, M1).
// The fake-API core below (fresh/roomState/setup) and the ported scenarios
// are copied VERBATIM from tests/ui.test.js — same fixtures, same
// assertions — with only the page-serving branches changed: this suite
// serves the built app (app/dist) instead of src/chat.html, and /api/build
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
      ...(opts.duelLobby ? [{ id: 11, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'Duel match #3 - Ada (cyan) vs Anthony (orange). Rock-paper-scissors, first to 3. Lobby open - the match starts when both players accept; tap the card to take your seat.', game: { id: 3, type: 'duel', status: 'lobby', round: 1, target: 3, winner: null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: 0, thrown: false, accepted: true }, { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: 0, thrown: false, accepted: false }] } }] : []),
      ...(opts.bs ? [{ id: 12, ts: now - 25e3, from: 'Henry', kind: 'agent', text: 'Battleship match #5 - Ada (cyan) vs Henry (orange). Hidden fleets, one shot per turn. Tap the card for the arena.', game: { id: 5, type: 'battleship', status: 'running', phase: 'play', turn: 80, turn_of: 'Henry', winner: null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 40, hits: 16, sunk: 4, afloat: 1 }, { name: 'Henry', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 39, hits: 15, sunk: 4, afloat: 1 }] } }] : []),
      ...(opts.bsPlay ? [{ id: 13, ts: now - 20e3, from: 'Ada', kind: 'agent', text: 'Battleship match #6 - Anthony (orange) vs Ada (cyan). Hidden fleets, one shot per turn. Tap the card for the arena.', game: { id: 6, type: 'battleship', status: 'running', phase: 'play', turn: 13, turn_of: 'Anthony', winner: null, players: [{ name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: true, shots: 6, hits: 2, sunk: 0, afloat: 5 }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 6, hits: 1, sunk: 0, afloat: 5 }] } }] : []),
      ...(opts.bsSetup ? [{ id: 14, ts: now - 15e3, from: 'Ada', kind: 'agent', text: 'Battleship match #8 - Anthony (orange) vs Ada (cyan). Hidden fleets, one shot per turn. Tap the card for the arena.', game: { id: 8, type: 'battleship', status: 'running', phase: 'setup', turn: 0, turn_of: null, winner: null, players: [{ name: 'Anthony', color: 'orange', hex: '#fb923c', accepted: true, placed: false, shots: 0, hits: 0, sunk: 0, afloat: 5 }, { name: 'Ada', color: 'cyan', hex: '#22d3ee', accepted: true, placed: true, shots: 0, hits: 0, sunk: 0, afloat: 5 }] } }] : []),
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
    mb: { invite_only: true, members: [
      { name: 'Anthony', kind: 'human', status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 5 * 60e3, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Anthony' },
      { name: 'Henry', kind: 'agent', avatar: 'https://chat.victorio.cloud/api/rooms/demo/avatars/Henry?v=1', invited_by: null, status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 2 * H, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Henry', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Henry".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Ada', kind: 'agent', status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 40 * 60e3, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Ada', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Ada".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Hank', kind: 'agent', invited_by: 'Henry', status: 'unused', invited: now - 2 * D, joined: null, last_seen: null, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Hank', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Hank".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Old bot', kind: 'agent', status: 'revoked', invited: now - 5 * D, joined: now - 4 * D, last_seen: now - 4 * D, revoked: now - 3 * D },
    ] },
    nid: 100,
    av: { henry: { buf: require('fs').readFileSync(__dirname + '/../../tests/fixtures/henry.gif'), type: 'image/gif' } },
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
    const findGame = (id) => [S.duel, S.game, S.duelLobby, S.bs, S.bsPlay, S.bsSetup].find(g => g && g.id == id) || null;
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
    if (p.endsWith('/games') && m === 'GET') { const list = [S.bs, S.bsPlay, S.duel, S.game].filter(Boolean); if (S.bs) { list.push(Object.assign({}, S.bs, { id: 3, status: 'finished', winner: 'Ada', turn: 62, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) })); list.push(Object.assign({}, S.bs, { id: 4, status: 'finished', winner: 'Ada', turn: 81, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) })); } return J({ room: 'demo', games: list, record: { battleship: [{ name: 'Ada', hex: '#22d3ee', w: 2, l: 0 }, { name: 'Henry', hex: '#fb923c', w: 0, l: 2 }], duel: [{ name: 'Anthony', hex: '#fb923c', w: 1, l: 0 }, { name: 'Ada', hex: '#22d3ee', w: 0, l: 1 }] } }); }
    if (p.endsWith('/games') && m === 'POST') { const cols = [['cyan', '#22d3ee'], ['orange', '#fb923c'], ['pink', '#f472b6'], ['lime', '#a3e635']]; if (body.game === 'battleship') { const players = (body.players || []).map((n, i) => ({ name: n, color: cols[i][0], hex: cols[i][1], accepted: false, placed: false, shots: 0, hits: 0, sunk: 0, afloat: 5 })); const g = { id: 7, type: 'battleship', status: 'lobby', created_by: 'Anthony', card_msg: null, phase: null, turn: 0, turn_of: null, turn_seconds: body.tick_seconds || 3600, deadline: null, lobby_deadline: Date.now() + 3600e3, winner: null, declined_by: null, players, boards: [], last_move: null, log: [], awaiting: [], awaiting_accept: players.map(p => p.name), you: { playing: false } }; S.bs = g; return J({ room: 'demo', game: g }, 201); } const isDuel = body.game === 'duel'; const players = (body.players || []).map((n, i) => isDuel ? { name: n, color: cols[i][0], hex: cols[i][1], wins: 0, thrown: false, accepted: n === 'Anthony' } : { name: n, color: cols[i][0], hex: cols[i][1], dir: ['right', 'left', 'down', 'up'][i], alive: true, x: 5 + i * 3, y: 5, moved: false, accepted: n === 'Anthony' }); const waiting = (body.players || []).filter(n => n !== 'Anthony'); const g = isDuel ? { id: 7, type: 'duel', status: 'lobby', created_by: 'Anthony', card_msg: null, round: 1, target: Math.floor((body.best_of || 5) / 2) + 1, best_of: body.best_of || 5, round_seconds: body.tick_seconds || 60, deadline: null, lobby_deadline: Date.now() + 3600e3, winner: null, score: {}, players, rounds: [], awaiting: [], awaiting_accept: waiting, you: { playing: true, queued: null, accepted: true } } : { id: 7, type: 'lightcycles', status: 'lobby', created_by: 'Anthony', card_msg: null, w: 30, h: 22, tick: 0, tick_seconds: body.tick_seconds || 120, deadline: null, lobby_deadline: Date.now() + 3600e3, winner: null, players, trails: [], log: [], awaiting: [], awaiting_accept: waiting, you: { playing: true, queued: null, accepted: true } }; if (isDuel) S.duel = g; else S.game = g; return J({ room: 'demo', game: g }, 201); }
    if ((mm = p.match(/games\/(\d+)\/(accept|decline)$/)) && m === 'POST') { const gm = findGame(mm[1]); if (!gm) return J({ error: 'No game' }, 404); if (mm[2] === 'decline') { gm.status = 'cancelled'; gm.declined_by = 'Anthony'; return J({ room: 'demo', game: gm }); } gm.players.forEach(x => { x.accepted = true; }); if (gm.you) gm.you.accepted = true; gm.awaiting_accept = []; gm.status = 'running'; gm.deadline = Date.now() + (gm.round_seconds || gm.tick_seconds || 60) * 1000; return J({ room: 'demo', game: gm }); }
    if ((mm = p.match(/games\/(\d+)\/moves$/)) && m === 'POST') { const gm = findGame(mm[1]); if (!gm) return J({ error: 'No game' }, 404); gm.you.queued = body.dir; const pl = gm.players.find(x => x.name === 'Anthony'); if (pl) { pl.moved = true; pl.thrown = true; } if (gm.awaiting) gm.awaiting = gm.awaiting.filter(n => n !== 'Anthony'); return J({ room: 'demo', game: gm, resolved: false }); }
    if ((mm = p.match(/games\/(\d+)$/))) { const gm = mm[1] === '4' && S.bs ? Object.assign({}, S.bs, { id: 4, status: 'finished', winner: 'Ada', turn: 81, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) }) : findGame(mm[1]); if (!gm) return J({ error: 'No game with that id' }, 404); return J({ room: 'demo', game: gm }); }
    if (p.endsWith('/members')) return J(S.mb);
    return route.fulfill({ status: 404, body: 'nf' });
  });
}
let FAILURES = 0;
(async () => {
  const shot = (page, f) => page.screenshot({ path: OUT + f });
  async function run(name, o, fn) {
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
    await page.waitForSelector('#viewer:not([hidden]) .bs-grid', { timeout: 4000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    out.banner = await page.$eval('#viewer .bs-verdict', e => e.textContent);
    out.ring = await page.$$eval('#viewer .bs-cell.bs-last', els => els.length);
    out.note = await page.$eval('#viewer .lc-note', e => e.textContent);
    out.axes = await page.$$eval('#viewer .bs-axis-x span', els => els.length);
    out.segH = await page.$$eval('#viewer .bs-cell.seg-h', els => els.length);
    out.segV = await page.$$eval('#viewer .bs-cell.seg-v', els => els.length);
    if (out.grids !== 2) throw new Error('spectator arena should show two boards, got ' + out.grids);
    if (out.axes !== 20) throw new Error('two boards should carry 20 column labels, got ' + out.axes);
    if (!(out.segH > 0 && out.segV > 0)) throw new Error('sunk hulls should render as hull segments, got seg-h ' + out.segH + ' seg-v ' + out.segV);
    if (!/Ada fires A7 · HIT/.test(out.banner)) throw new Error('arena banner wrong: ' + out.banner);
    if (out.ring !== 1) throw new Error('exactly one last-shot ring expected, got ' + out.ring);
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
    await page.waitForSelector('#viewer:not([hidden]) .bs-grid', { timeout: 4000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    if (out.grids !== 2) throw new Error('mobile spectator arena should show two boards, got ' + out.grids);
    await shot(page, 'bs-spectator-mobile-dark.png');
    return out;
  });
  await run('battleship-player', { state: { bsPlay: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 4000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .bs-grid', { timeout: 4000 });
    out.ships = await page.$$eval('#viewer .bs-cell.ship', els => els.length);
    out.banner = await page.$eval('#viewer .bs-verdict', e => e.textContent);
    out.ring = await page.$$eval('#viewer .bs-cell.bs-last', els => els.length);
    out.segStart = await page.$$eval('#viewer .bs-cell.seg-start', els => els.length);
    out.strips = await page.$$eval('#viewer .bs-side .bs-strip', els => els.length);
    if (out.ships !== 16) throw new Error('own fleet should render 16 un-hit ship cells, got ' + out.ships);
    if (out.segStart !== 5) throw new Error('own fleet should render five hull bows, got ' + out.segStart);
    if (out.strips !== 2) throw new Error('arena should show two fleet strips, got ' + out.strips);
    if (!/Ada fires H5 · HIT/.test(out.banner)) throw new Error('player banner wrong: ' + out.banner);
    if (out.ring !== 1) throw new Error('exactly one last-shot ring expected, got ' + out.ring);
    out.warn = await page.$eval('#viewer .bs-warn', e => e.textContent);
    if (!/Anthony has missed 2 turns in a row/.test(out.warn) || !/forfeits/.test(out.warn)) throw new Error('two missed turns should carry the forfeit warning: ' + out.warn);
    await shot(page, 'bs-player-arena.png');
    await page.click('#viewer button.bs-cell[aria-label="Fire at C7"]');
    await page.waitForTimeout(400);
    out.moveCall = calls.filter(c => c.includes('/games/6/moves')).pop() || '';
    if (!/"dir":"C7"/.test(out.moveCall)) throw new Error('fire call wrong: ' + out.moveCall);
    return out;
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
  await run('games-tab', { state: { bs: true, bsPlay: true, duel: true, game: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 4000 });
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#view-games .gm-row', { timeout: 4000 });
    out.rows = await page.$$eval('#view-games .gm-row', els => els.length);
    out.live = await page.$$eval('#view-games .gm-live', els => els.length);
    out.finished = await page.$eval('#view-games .gm-row:last-of-type .gm-state', e => e.textContent);
    out.rowWinner = await page.$eval('#view-games .gm-row:last-of-type .game-winner', e => e.textContent);
    if (out.rows !== 6) throw new Error('games tab should list six matches, got ' + out.rows);
    if (out.live !== 4) throw new Error('four matches should be live, got ' + out.live);
    if (out.finished !== 'Final · 5–4 ships · 16–15 hits · 81 turns') throw new Error('finished row should carry the standard record line: ' + out.finished);
    if (!/🏆/.test(out.rowWinner) || !/Ada/.test(out.rowWinner) || !/5–4/.test(out.rowWinner)) throw new Error('finished row should carry the standard winner banner: ' + out.rowWinner);
    if (await page.$('#view-games .gm-head .btn.primary') === null) throw new Error('the Games tab should carry the New game button');
    if (await page.$('#newGameBtn') !== null) throw new Error('the sidebar should no longer carry a New game button');
    out.rec = await page.$eval('#view-games .gm-rec', e => e.textContent);
    if (!/Battleship/.test(out.rec) || !/Ada/.test(out.rec) || !/2–0/.test(out.rec) || !/100%/.test(out.rec) || !/Duel/.test(out.rec)) throw new Error('the room record should render per-kind standings: ' + out.rec);
    if (!/🔥/.test(out.rec) || !/W2/.test(out.rec) || !/L2/.test(out.rec)) throw new Error('standings should carry the current streaks: ' + out.rec);
    await shot(page, 'games-tab.png');
    await page.click('#view-games .gm-row:last-of-type');
    await page.waitForSelector('#viewer:not([hidden]) .bs-grid', { timeout: 4000 });
    out.arena = await page.$$eval('#viewer .bs-grid', els => els.length);
    out.arenaWinner = await page.$eval('#viewer .game-winner', e => e.textContent);
    if (out.arena !== 2) throw new Error('tapping a row should open its arena, got ' + out.arena);
    if (!/Ada/.test(out.arenaWinner)) throw new Error('the arena should carry the winner banner: ' + out.arenaWinner);
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    await page.click('#view-games .gm-row:last-of-type .gm-rematch');
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
    if (out.rows !== 4) throw new Error('mobile games tab should list four matches, got ' + out.rows);
    await page.waitForTimeout(700);
    await shot(page, 'games-tab-mobile-dark.png');
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
      const wantCounts = ['chat=', 'games=', 'constitution=', 'decisions=2!', 'questions=2', 'stakes=1!', 'memory=', 'members=3'];
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
  // New game dialog (post-cutover feature, 2026-11-09): the Games
  // tab's button opens it; a duel needs exactly 2 players (you are
  // picked by default), Light Cycles 2-4; starting posts the create
  // call with the picked players and closes the dialog.
  await run('new-game', {}, async (page, S, calls) => {
    const out = {};
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('.gm-head .btn.primary', { timeout: 4000 });
    await page.click('.gm-head .btn.primary');
    await page.waitForSelector('#newGameDlg[open]', { timeout: 4000 });
    out.startDisabledAtOne = await page.$eval('#ngStart', e => e.disabled);
    await page.click('[data-player="Ada"]');
    out.startEnabledAtTwo = await page.$eval('#ngStart', e => !e.disabled);
    await page.click('#newGameDlg [aria-label="Game type"] button:nth-child(2)');
    out.paceSegShown = await page.$('[aria-label="Pace"]') !== null;
    out.asyncPressed = await page.$eval('[aria-label="Pace"] button:nth-child(1)', e => e.getAttribute('aria-pressed') === 'true');
    await page.click('[aria-label="Pace"] button:nth-child(2)');
    out.tickSegShown = await page.$('[aria-label="Tick length"]') !== null;
    await page.click('[data-player="Henry"]');
    out.lcCount = await page.$eval('.ng-count', e => e.textContent.trim());
    await page.click('#newGameDlg [aria-label="Game type"] button:nth-child(3)');
    out.bsVariantSeg = await page.$('[aria-label="Battleship variant"]') !== null;
    await page.click('#newGameDlg [aria-label="Game type"] button:nth-child(1)');
    out.duelCount = await page.$eval('.ng-count', e => e.textContent.trim());
    await shot(page, 'new-game.png');
    await page.click('#ngStart');
    await page.waitForTimeout(600);
    out.dlgClosed = await page.$eval('#newGameDlg', e => !e.open);
    const cc = calls.filter(c => c.includes('POST /api/rooms/demo/games ')).pop() || '';
    out.createCall = cc;
    const body = JSON.parse(cc.slice(cc.indexOf('{')));
    if (!out.startDisabledAtOne) throw new Error('duel must not start with 1 player');
    if (!out.startEnabledAtTwo) throw new Error('duel must start with 2 players');
    if (!out.bsVariantSeg) throw new Error('Battleship must show the variant options');
    if (!out.paceSegShown) throw new Error('Light Cycles must show the pace options');
    if (!out.asyncPressed) throw new Error('Light Cycles must default to async pace');
    if (!out.tickSegShown) throw new Error('Light Cycles live pace must show the tick options');
    if (out.lcCount !== '3 of 2\u20134') throw new Error('LC count wrong: ' + out.lcCount);
    if (out.duelCount !== '2 of 2') throw new Error('switching back to duel must trim to 2 players, got: ' + out.duelCount);
    if (!out.dlgClosed) throw new Error('dialog must close after a successful start');
    if (body.game !== 'duel' || body.best_of !== 5 || JSON.stringify(body.players) !== '["Anthony","Ada"]') throw new Error('create body wrong: ' + cc);
    return out;
  });
  await run('new-game-mobile', { w: 390, h: 844, touch: true }, async (page) => {
    const out = {};
    await page.click('#menu'); await page.waitForTimeout(350);
    await page.click('.tab[data-tab="games"]'); await page.waitForTimeout(700);
    await page.click('.gm-head .btn.primary');
    await page.waitForSelector('#newGameDlg[open]', { timeout: 4000 });
    await page.waitForTimeout(200);
    await shot(page, 'new-game-mobile.png');
    out.startDisabledAtOne = await page.$eval('#ngStart', e => e.disabled);
    if (!out.startDisabledAtOne) throw new Error('duel must not start with 1 player');
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
