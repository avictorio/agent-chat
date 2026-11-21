// The UI suite's shared harness: the fake API (fresh state, setup), the
// scenario runner (run) and the helpers the feature files use. Each
// <feature>.test.js runs its own scenarios; run.js runs the files in
// parallel. See the comment below for how a scenario is served.
// The web app's UI suite. It began as the parity harness for the React
// rewrite (web/PARITY.md, M1), ported from the pre-React suite (root
// tests/ui.test.js, removed with the old pages on 2026-11-19; its fixtures
// stay in the root tests/fixtures/). It serves the built app (app/dist)
// through a fake API, and /api/build answers 'uitestbuild1' when current
// (the served page is stamped the same). Exits non-zero when a scenario
// fails; ONLY=name1,name2 runs just those.
const { chromium } = require('playwright');
const path = require('path');
// web/tests: the fixtures, the fake data's files and the screenshots are
// found from here.
const TESTS = path.join(__dirname, '..');
// The suite's clock (REFACTOR.md 5.3): the fake data and every page start at
// one fixed instant, a Friday mid-afternoon, UTC on both sides, so two runs
// of a build give the same times, dates and day separators in their
// screenshots (live second countdowns still move with the run).
// CLOCK=shift (the default) moves only the page's Date: it starts at NOW
// and runs at real speed, while timers, frames and performance.now stay
// real, so holds, timers, upload rates and the 3D scenes behave as in real
// use. CLOCK=install uses Playwright's page.clock instead (it fakes timers
// and performance too, which the Light Cycles replay does not survive);
// CLOCK=fixed freezes Date (it breaks anything that measures time with it);
// CLOCK=real is the machine's clock.
process.env.TZ = 'UTC';
const CLOCK = process.env.CLOCK || 'shift';
const NOW = Date.UTC(2026, 10, 20, 15, 4, 0);
const clockNow = () => (CLOCK === 'real' ? Date.now() : NOW);
async function useClock(page) {
  if (CLOCK === 'fixed') await page.clock.setFixedTime(NOW);
  else if (CLOCK === 'install') await page.clock.install({ time: NOW });
  else if (CLOCK === 'shift') {
    await page.addInitScript((now) => {
      const Real = Date;
      const off = now - Real.now();
      class ShiftedDate extends Real {
        constructor(...a) {
          if (a.length) super(...a);
          else super(Real.now() + off);
        }
        static now() {
          return Real.now() + off;
        }
      }
      globalThis.Date = ShiftedDate;
    }, NOW);
  }
}
const fs = require('fs');
const DIST = TESTS + '/../app/dist';
const HTML = fs.readFileSync(DIST + '/index.html', 'utf8').replace('content="next-dev"', 'content="uitestbuild1"');
// Console errors a scenario fails on: everything except "Failed to load
// resource" with an HTTP status, which only comes from a request the stub
// answered on purpose (an unknown request is caught separately, as
// S.unhandled). A scenario that expects another one passes allowConsole
// (a RegExp).
const RESOURCE_STATUS = /^console: Failed to load resource: the server responded with a status of \d+/;
const badConsole = (errs, allow) => errs.filter((e) => e.startsWith('console:') && !RESOURCE_STATUS.test(e) && !(allow && allow.test(e)));
// The app icon the install strip shows (the live Worker serves /icons/*):
// a 1x1 PNG is enough for the stubs.
const ICON_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const FIXTURES = require('path').join(TESTS, '..', '..', 'tests', 'fixtures') + '/';
const OUT = TESTS + '/shots/';
fs.mkdirSync(OUT, { recursive: true });
const now = clockNow(), H = 3600e3, D = 86400e3;
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
      ...(opts.broken ? [{ id: 71, ts: now - 30e3, from: 'Ada', kind: 'agent', text: 'This one arrives with malformed reactions.', reactions: { '\u{1F44D}': 'Ada' } }] : []),
      ...(opts.files ? [{ id: 60, ts: now - 50e3, from: 'Ada', kind: 'agent', text: 'The full dataset, as promised.', file: { type: 'application/zip', bytes: 734003200, name: 'lima-survey-2026.zip', url: '/api/rooms/demo/messages/60/file?exp=1&sig=x' } }, { id: 61, ts: now - 45e3, from: 'Henry', kind: 'agent', text: 'Raw drone shot.', image: { type: 'image/png', bytes: 48000000, url: '/api/rooms/demo/messages/61/image?exp=1&sig=x' } }] : []),
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
      if (opts.c4Forfeit) {
        // over on the clock after move 6: Anthony's third timeout, no four made
        Object.assign(g, { status: 'finished', turn_of: null, winner: 'Ada', forfeit: 'Anthony', deadline: null, awaiting: [] });
        g.players[0].timeouts = 3;
        g.you = { playing: true, accepted: true, piece: 'X', your_turn: false, timeouts: 3, legal_moves: [] };
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
    av: { henry: { buf: require('fs').readFileSync(TESTS + '/../../tests/fixtures/henry.gif'), type: 'image/gif' } },
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
      S.av.anthony = { buf, type }; me.avatar = 'https://chat.victorio.cloud/api/rooms/demo/avatars/Anthony?v=' + clockNow(); return J({ ok: 1 });
    }
    if (p === '/emoji.json') return route.fulfill({ status: 200, contentType: 'application/json', body: require('fs').readFileSync(TESTS + '/../../tests/fixtures/emoji-compact.json') });
    if (p.startsWith('/assets/')) { try { const body = require('fs').readFileSync(DIST + p); return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body }); } catch (e) { return route.fulfill({ status: 404, body: 'nf' }); } }
    if (p.startsWith('/r/') || p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (p === '/api/build') return J({ build: S.behind ? 'uitestbuild2' : 'uitestbuild1' });
    if (p.startsWith('/api/') && S.deny) return J({ error: S.deny === 403 ? "This invite link has been revoked. Ask the room owner for a new one." : "This room is invite-only. Open your invite link to join." }, S.deny);
    if (p.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 600000\n\nevent: state\ndata: ' + JSON.stringify({ type: 'state', room: 'demo', room_state: roomState(S) }) + '\n\n' });
    if (/\/messages\/\d+\/html$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Probe</title><p>artifact body</p>' });
    if (/\/messages\/\d+\/doc$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Probe doc\n\nRendered **body** here.' });
    if (/\/messages\/\d+\/image$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: require('fs').readFileSync(TESTS + '/../../tests/fixtures/photo.png') });
    // Video and audio bodies: the media shelf's tiles fetch them; no fixture
    // needed, an empty body of the right type is enough for the UI.
    if ((am = p.match(/\/messages\/\d+\/(video|audio)$/))) return route.fulfill({ status: 200, contentType: am[1] === 'video' ? 'video/mp4' : 'audio/mp4', body: Buffer.alloc(0) });
    if ((am = p.match(/\/messages\/(\d+)\/reactions$/))) {
      const msg = S.msgs.find(x => x.id == am[1]); if (!msg) return J({ error: 'No message' }, 404);
      const r = msg.reactions || {}; Object.keys(r).forEach(k => { r[k] = r[k].filter(x => x.toLowerCase() !== body.from.toLowerCase()); if (!r[k].length) delete r[k]; });
      if (body.reaction) (r[body.reaction] = r[body.reaction] || []).push(body.from);
      msg.reactions = r; return J({ room: 'demo', id: msg.id, reactions: r });
    }
    if ((am = p.match(/\/messages\/(\d+)\/(image|audio|video|file)\/(start|part|sign|status|finish|abort)$/))) {
      const id = +am[1], kind = am[2], step = am[3], key = id + ':' + kind;
      S.ups = S.ups || {};
      if (step === 'start') { const ps = 65536; S.ups[key] = { size: body.size, name: body.name, type: body.type, ps, parts: Math.max(1, Math.ceil(body.size / ps)), got: new Set() }; return J({ room: 'demo', id, kind, part_size: ps, parts: S.ups[key].parts, resumed: false, received: [], direct: !!(S.direct && body.direct), expires_at: new Date(clockNow() + 7 * D).toISOString() }); }
      const u0 = S.ups[key];
      if (step === 'status') return J({ room: 'demo', id, kind, uploading: !!u0 && !u0.done, complete: !!(u0 && u0.done), received: u0 ? [...u0.got] : [] });
      if (step === 'abort') { delete S.ups[key]; return J({ room: 'demo', id, kind, aborted: true }); }
      if (step === 'sign') { S.signs = (S.signs || 0) + 1; const urls = {}; for (const n of body.parts || []) urls[n] = 'https://acct.r2.cloudflarestorage.com/victorio-chat-media/demo/' + id + '/' + kind + '?partNumber=' + n + '&uploadId=up1&X-Amz-Signature=sig' + S.signs; return J({ room: 'demo', id, kind, method: 'PUT', urls, expires_at: new Date(clockNow() + 3600e3).toISOString() }); }
      if (!u0) return J({ error: 'No upload in progress for that message' }, 409);
      if (step === 'part') {
        const n = +u.searchParams.get('n');
        if (S.partDelay) await new Promise((r) => setTimeout(r, S.partDelay));
        if (S.failOnce === n && !S.failedOnce) { S.failedOnce = true; return J({ error: 'Part did not reach storage' }, 502); }
        const len = (req.postDataBuffer() || []).length; const want = n < u0.parts ? u0.ps : u0.size - (u0.parts - 1) * u0.ps;
        if (len !== want) return J({ error: 'wrong length', expected_bytes: want }, 400);
        u0.got.add(n); return J({ room: 'demo', id, kind, part: n });
      }
      if (u0.got.size < u0.parts) return J({ error: 'parts missing', missing: [] }, 409);
      u0.done = true;
      const ref = { type: kind === 'file' ? (u0.type || 'application/octet-stream') : kind + '/x', bytes: u0.size, url: '/api/rooms/demo/messages/' + id + '/' + kind + '?exp=1&sig=x' };
      if (kind === 'file') ref.name = u0.name;
      const dr = (S.drafts || []).find((x) => x.id === id); if (dr) dr[kind] = ref;
      return J({ room: 'demo', id, kind, [kind]: ref, published: false });
    }
    if (p.endsWith('/upload/resume')) return J({ room: 'demo', found: false, id: null, received: [] });
    if ((am = p.match(/\/messages\/(\d+)\/publish$/))) { const dr = (S.drafts || []).find((x) => x.id === +am[1]); if (!dr) return J({ error: 'No message with that id' }, 404); S.drafts = S.drafts.filter((x) => x !== dr); if (body.text) dr.text = body.text; S.msgs.push(dr); return J(Object.assign({ room: 'demo' }, dr, { room_state: roomState(S) })); }
    if ((am = p.match(/\/messages\/(\d+)$/)) && m === 'DELETE') { S.drafts = (S.drafts || []).filter((x) => x.id !== +am[1]); S.msgs = S.msgs.filter((x) => x.id !== +am[1]); return J({ room: 'demo', deleted: +am[1] }); }
    if (p.endsWith('/messages') && m === 'POST' && body.draft) { const x = { id: ++S.nid, ts: clockNow(), from: body.from, text: body.text }; (S.drafts = S.drafts || []).push(x); return J(Object.assign({ draft: true }, x, { room_state: roomState(S) }), 201); }
    if (p.endsWith('/messages') && m === 'POST') { const x = { id: ++S.nid, ts: clockNow(), from: body.from, text: body.text }; S.msgs.push(x); return J(Object.assign({}, x, { room_state: roomState(S) }), 201); }
    if (p.endsWith('/messages')) return J(S.agentYou
      ? { room: 'demo', messages: S.msgs, last_id: S.msgs[S.msgs.length - 1].id, you: 'Probe', you_kind: 'agent', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Probe".\nConnect over MCP (Model Context Protocol), the room\'s agent surface:\n  Endpoint: POST https://chat.victorio.cloud/api/rooms/demo/mcp\n  Header: X-Invite-Token: tok_Probe\nSend initialize, then tools/list for the room\'s tools (messages, reactions, the board, games, voice, fetch, uploads). Call whoami and get_room_state first.', room_state: roomState(S) }
      : { room: 'demo', messages: S.msgs, last_id: S.msgs[S.msgs.length - 1].id, you: S.noYou ? undefined : 'Anthony', you_kind: 'human', room_state: roomState(S) });
    if (p.endsWith('/constitution') && m === 'PUT') { S.hist.push(S.con); S.con = { version: S.con.version + 1, ts: clockNow(), editor: body.from, text: body.text }; return J({ constitution: S.con }, 201); }
    if (p.endsWith('/constitution')) return J({ constitution: S.con, history: S.hist.concat([S.con]) });
    let mm;
    if (p.endsWith('/decisions') && m === 'POST') { S.dc.push({ id: ++S.nid, ts: clockNow(), added_by: body.from, title: body.title, note: body.note || null, signers: [] }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/decisions')) return J({ decisions: S.dc });
    if ((mm = p.match(/decisions\/(\d+)$/))) { const d = S.dc.find(x => x.id == mm[1]); if (m === 'DELETE') { S.dc = S.dc.filter(x => x !== d); return J({ ok: 1 }); } if (body.action === 'sign') d.signers.push(body.from); if (body.action === 'unsign') d.signers = d.signers.filter(s => s !== body.from); if (body.action === 'edit') { d.title = body.title; d.note = body.note; } return J({ decision: d }); }
    if (p.endsWith('/questions') && m === 'POST') { S.q.push({ id: ++S.nid, ts: clockNow(), added_by: body.from, text: body.text, status: 'open', claimed_by: null }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/questions')) return J({ questions: S.q, resolved: S.qr });
    if ((mm = p.match(/questions\/(\d+)$/))) { let q = S.q.concat(S.qr).find(x => x.id == mm[1]); if (m === 'DELETE') { S.q = S.q.filter(x => x !== q); S.qr = S.qr.filter(x => x !== q); return J({ ok: 1 }); }
      if (body.action === 'claim') { q.status = 'claimed'; q.claimed_by = body.from; } if (body.action === 'unclaim') { q.status = 'open'; q.claimed_by = null; }
      if (body.action === 'resolve') { q.status = 'resolved'; q.resolved_by = body.from; q.resolution = body.note; S.q = S.q.filter(x => x !== q); S.qr.unshift(q); }
      if (body.action === 'edit') q.text = body.text; return J({ question: q }); }
    if (p.endsWith('/stakes') && m === 'POST') { S.sk.push({ id: ++S.nid, ts: clockNow(), added_by: body.from, title: body.title, date: body.date || null, note: body.note || null }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/stakes')) return J({ stakes: S.sk, done: S.skd });
    if ((mm = p.match(/stakes\/(\d+)$/))) { const s = S.sk.concat(S.skd).find(x => x.id == mm[1]); if (body.action === 'done') { s.done = clockNow(); s.done_by = body.from; S.sk = S.sk.filter(x => x !== s); S.skd.unshift(s); } return J({ stake: s }); }
    if (p.endsWith('/digests') && m === 'POST') { S.dg.unshift({ id: ++S.nid, ts: clockNow(), day: ymd(0), author: body.from, text: body.text }); return J({ ok: 1 }, 201); }
    if (p.includes('/digests')) return J({ digests: S.dg });
    if (p.endsWith('/invites') && m === 'POST') { if (S.mb.members.some(x => x.name.toLowerCase() === body.name.toLowerCase() && x.status !== 'revoked')) return J({ error: body.name + ' already has an active invite.' }, 409); S.mb.members.push({ name: body.name, kind: body.kind, invited_by: 'Anthony', status: 'unused', invited: clockNow() }); const inv = { room: 'demo', name: body.name, kind: body.kind, token: 'tok_' + body.name, link: 'https://chat.victorio.cloud/r/demo#invite=tok_' + body.name, created: clockNow() }; if (body.kind !== 'human') inv.agent_onboarding = 'You are invited to the Agent Chat room "demo" as the agent "' + body.name + '".\nInvite link: ' + inv.link + '\nThen implement the wake recipe and post a short hello.'; return J(inv, 201); }
    if (p.endsWith('/games') && m === 'GET') { const list = [S.bs, S.bsPlay, S.duel, S.game].filter(Boolean); const mid = new Date(clockNow()); mid.setHours(0, 0, 0, 0); if (S.duel) list.push(Object.assign({}, S.duel, { id: 21, status: 'finished', winner: 'Anthony', round: 5, score: { Anthony: 3, Ada: 1 }, created: mid.getTime() - 50 * 3600e3, ended: mid.getTime() - 48 * 3600e3 + 600e3 })); if (S.bs) { list.push(Object.assign({}, S.bs, { id: 3, status: 'finished', winner: 'Ada', turn: 62, created: mid.getTime() - 8 * 3600e3, ended: mid.getTime() - 3 * 3600e3, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) })); list.push(Object.assign({}, S.bs, { id: 4, status: 'finished', winner: 'Ada', turn: 81, created: clockNow() - 3 * 3600e3, ended: clockNow() - 60e3, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) })); } return J({ room: 'demo', games: list, record: { battleship: [{ name: 'Ada', hex: '#22d3ee', w: 2, l: 0 }, { name: 'Henry', hex: '#fb923c', w: 0, l: 2 }], duel: [{ name: 'Anthony', hex: '#fb923c', w: 1, l: 0 }, { name: 'Ada', hex: '#22d3ee', w: 0, l: 1 }] }, ladder: { battleship: [{ name: 'Ada', hex: '#22d3ee', rating: 1031, w: 2, l: 0, d: 0, last: 15 }, { name: 'Henry', hex: '#fb923c', rating: 969, w: 0, l: 2, d: 0, last: -15 }] } }); }
    if (p.endsWith('/games') && m === 'POST') { const cols = [['cyan', '#22d3ee'], ['orange', '#fb923c'], ['pink', '#f472b6'], ['lime', '#a3e635']]; if (body.game === 'battleship') { const players = (body.players || []).map((n, i) => ({ name: n, color: cols[i][0], hex: cols[i][1], accepted: false, placed: false, shots: 0, hits: 0, sunk: 0, afloat: 5 })); const g = { id: 7, type: 'battleship', status: 'lobby', created_by: 'Anthony', card_msg: null, phase: null, turn: 0, turn_of: null, turn_seconds: body.tick_seconds || 3600, deadline: null, lobby_deadline: clockNow() + 3600e3, winner: null, declined_by: null, players, boards: [], last_move: null, log: [], awaiting: [], awaiting_accept: players.map(p => p.name), you: { playing: false } }; S.bs = g; return J({ room: 'demo', game: g }, 201); } const isDuel = body.game === 'duel'; const players = (body.players || []).map((n, i) => isDuel ? { name: n, color: cols[i][0], hex: cols[i][1], wins: 0, thrown: false, accepted: n === 'Anthony' } : { name: n, color: cols[i][0], hex: cols[i][1], dir: ['right', 'left', 'down', 'up'][i], alive: true, x: 5 + i * 3, y: 5, moved: false, accepted: n === 'Anthony' }); const waiting = (body.players || []).filter(n => n !== 'Anthony'); const g = isDuel ? { id: 7, type: 'duel', status: 'lobby', created_by: 'Anthony', card_msg: null, round: 1, target: Math.floor((body.best_of || 5) / 2) + 1, best_of: body.best_of || 5, round_seconds: body.tick_seconds || 60, deadline: null, lobby_deadline: clockNow() + 3600e3, winner: null, score: {}, players, rounds: [], awaiting: [], awaiting_accept: waiting, you: { playing: true, queued: null, accepted: true } } : { id: 7, type: 'lightcycles', status: 'lobby', created_by: 'Anthony', card_msg: null, w: 30, h: 22, tick: 0, tick_seconds: body.tick_seconds || 120, deadline: null, lobby_deadline: clockNow() + 3600e3, winner: null, players, trails: [], log: [], awaiting: [], awaiting_accept: waiting, you: { playing: true, queued: null, accepted: true } }; if (isDuel) S.duel = g; else S.game = g; return J({ room: 'demo', game: g }, 201); }
    if ((mm = p.match(/games\/(\d+)\/(accept|decline)$/)) && m === 'POST') { const gm = findGame(mm[1]); if (!gm) return J({ error: 'No game' }, 404); if (mm[2] === 'decline') { gm.status = 'cancelled'; gm.declined_by = 'Anthony'; return J({ room: 'demo', game: gm }); } gm.players.forEach(x => { x.accepted = true; }); if (gm.you) gm.you.accepted = true; gm.awaiting_accept = []; gm.status = 'running'; gm.deadline = clockNow() + (gm.round_seconds || gm.tick_seconds || 60) * 1000; return J({ room: 'demo', game: gm }); }
    if ((mm = p.match(/games\/(\d+)\/moves$/)) && m === 'POST') { const gm = findGame(mm[1]); if (!gm) return J({ error: 'No game' }, 404); if (gm.type === 'sketch') { const raw = String(body.dir || '').trim(); if (/^data:image\/png;base64,/.test(raw)) { gm.phase = 'guess'; gm.image = { url: raw, type: 'image/png' }; } else if (raw) { gm.you = Object.assign({}, gm.you, { queued: raw }); gm.players.find((p) => p.name === 'Anthony').committed = true; } else return J({ error: 'bad move' }, 400); return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'trivia') { const raw = String(body.dir || '').trim(); let o = null; try { o = raw[0] === '{' ? JSON.parse(raw) : null; } catch (e) { o = null; } if (o && o.question) { gm.phase = 'answer'; gm.question = o.question; gm.you = Object.assign({}, gm.you, { answer: o.answer, accept: o.accept || [] }); } else if (o && o.answer) { gm.you = Object.assign({}, gm.you, { queued: { answer: o.answer, wager: o.wager || 0 } }); gm.players.find((p) => p.name === 'Anthony').committed = true; } else if (/^accept /.test(raw)) { gm.you = Object.assign({}, gm.you, { to_judge: gm.you.to_judge.map((x) => Object.assign({}, x, { accepted: x.accepted || raw.slice(7) === x.name })) }); } else if (raw !== 'done') return J({ error: 'bad move' }, 400); return J({ room: 'demo', game: gm, resolved: raw === 'done' }); } if (gm.type === 'lettergrid') { const raw = String(body.dir || '').trim().toLowerCase(); const m = raw.match(/^([a-z]+)((?:\s+[a-z]\d)*)$/); if (!m || m[1] === 'qqqq') return J({ error: '"' + (m ? m[1].toUpperCase() : raw) + '" is not in the dictionary - try another' }, 400); const path = m[2].trim() ? m[2].trim().split(/\s+/).map((c) => [Number(c.slice(1)) - 1, c.charCodeAt(0) - 97]) : null; gm.you = Object.assign({}, gm.you, { queued: { word: m[1], path } }); gm.players.find((p) => p.name === 'Anthony').committed = true; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'werewolf') { const raw = String(body.dir || '').trim(); const t = raw.match(/^(say|den):\s*(.+)$/i); if (t) { const line = { n: 9, by: 'Anthony', text: t[2], ch: t[1].toLowerCase() === 'den' || gm.phase === 'night' ? 'den' : 'town', phase: gm.phase, day: gm.night, at: clockNow() }; if (line.ch === 'den') gm.den = (gm.den || []).concat([line]); else gm.talk = gm.talk.concat([line]); return J({ room: 'demo', game: gm, resolved: false }); } const m = raw.match(/^(kill|vote)\s+(\w+)$/i); if (!m) return J({ error: 'Name a player' }, 400); if (gm.phase === 'night') gm.you = Object.assign({}, gm.you, { act: m[2] }); else { gm.you = Object.assign({}, gm.you, { vote: m[2] }); gm.votes = Object.assign({}, gm.votes, { Anthony: m[2] }); gm.players.find((p) => p.name === 'Anthony').voted = true; } return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'twenty') { const raw = String(body.dir || '').trim(); if (gm.you.answerer) { const m = raw.match(/^(yes|no)\b/i); if (!m) return J({ error: 'Answer yes or no' }, 400); const p = gm.qa.find((x) => gm.pending && x.n === gm.pending.n); p.a = m[1].toLowerCase(); p.note = raw.replace(/^(yes|no)\s*-?\s*/i, '') || null; gm.asked += 1; gm.remaining -= 1; gm.phase = 'ask'; gm.pending = null; return J({ room: 'demo', game: gm, resolved: false }); } if (!raw) return J({ error: 'Ask a question' }, 400); const e = { n: gm.qa.length + 1, by: 'Anthony', kind: /^guess/i.test(raw) ? 'guess' : 'q', q: raw.replace(/^guess:\s*/i, ''), a: null, note: null, flagged: false }; gm.qa.push(e); gm.pending = e; gm.phase = 'answer'; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'corpse') { const raw = String(body.dir || '').trim(); if (gm.phase === 'write') { if (!raw) return J({ error: 'Send your segment' }, 400); gm.segments += 1; gm.beats.push({ turn: gm.turn, by: 'Anthony', wrote: true }); gm.turn += 1; gm.turn_of = 'Ada'; gm.players.find((p) => p.name === 'Anthony').segments = 1; gm.you = Object.assign({}, gm.you, { writer: false, tail: undefined, segments: [3] }); return J({ room: 'demo', game: gm, resolved: true }); } const v = Number(raw); if (!(v === 1 || v === 2)) return J({ error: 'You cannot vote for your own segment' }, 400); gm.you = Object.assign({}, gm.you, { vote: v }); gm.players.find((p) => p.name === 'Anthony').committed = true; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'twotruths') { const raw = String(body.dir || ''); if (gm.phase === 'write') { let o = null; try { o = JSON.parse(raw); } catch (e) {} if (!o || !Array.isArray(o.statements) || o.statements.length !== 3) return J({ error: 'Send exactly three statements' }, 400); gm.phase = 'vote'; gm.statements = o.statements; gm.players.forEach((p) => (p.committed = false)); gm.you = Object.assign({}, gm.you, { statements: o.statements, lie: o.lie }); return J({ room: 'demo', game: gm, resolved: false }); } const v = Number(raw); if (!(v >= 1 && v <= 3)) return J({ error: 'dir is 1, 2 or 3' }, 400); gm.you = Object.assign({}, gm.you, { vote: v }); gm.players.find((p) => p.name === 'Anthony').committed = true; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'liarsdice') { const raw = String(body.dir || '').trim().toLowerCase(); if (raw === 'liar') { gm.rounds.push({ n: gm.round, at: clockNow(), cups: { Ada: [2, 4, 4, 5, 6], Anthony: [1, 3, 4, 4, 6], Henry: [3, 4, 5, 6] }, bids: gm.bids.slice(), reason: 'call', call: { by: 'Anthony', bid: gm.bid }, face: gm.bid.face, count: 6, stands: true, loser: 'Anthony', out: false, dice_left: 4 }); gm.players[1].dice = 4; gm.dice_total = 13; gm.round += 1; gm.bid = null; gm.bids = []; gm.turn += 1; gm.you = Object.assign({}, gm.you, { dice: [2, 2, 5, 6], your_turn: true, legal_moves: ['1x2', '1x3', '1x4', '1x5', '1x6'] }); return J({ room: 'demo', game: gm, resolved: true }); } const m = raw.match(/^(\d+)x([1-6])$/); if (!m) return J({ error: 'dir is a bid like 3x4, or liar', legal_moves: gm.you.legal_moves }, 400); gm.bid = { by: 'Anthony', qty: +m[1], face: +m[2], at: clockNow() }; gm.bids.push(gm.bid); gm.turn += 1; gm.turn_of = 'Henry'; gm.awaiting = ['Henry']; gm.you = Object.assign({}, gm.you, { your_turn: false, legal_moves: [] }); return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'auction') { const raw = String(body.dir || '').trim(); const v = raw === 'pass' ? 0 : Number(raw); if (!(v >= 0 && v <= gm.you.budget)) return J({ error: 'you have ' + gm.you.budget + ' left' }, 400); gm.you.queued = v; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = ['Henry']; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'trust') { const q = {}; for (const t of String(body.dir || '').split(',')) { const m = t.trim().match(/^(\w+):([CD])$/); if (m) q[m[1]] = m[2]; } if (Object.keys(q).length !== 2) return J({ error: 'one choice per rival' }, 400); gm.you.queued = q; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = ['Henry']; return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'fourinarow') { const c = Number(body.dir); if (!(c >= 1 && c <= 7)) return J({ error: 'dir is a column, 1 to 7 from the left', legal_moves: gm.you.legal_moves }, 400); const cells = gm.board.map((x) => x.split('')); let k = 5; while (k >= 0 && cells[k][c - 1] !== '.') k -= 1; if (k < 0) return J({ error: 'Column ' + c + ' is full', legal_moves: gm.you.legal_moves }, 400); cells[k][c - 1] = 'X'; gm.board = cells.map((x) => x.join('')); gm.last_move = { n: gm.moves.length + 1, by: 'Anthony', col: c, row: 6 - k }; gm.moves.push(gm.last_move); gm.turn += 1; gm.turn_of = 'Ada'; gm.awaiting = ['Ada']; gm.you = Object.assign({}, gm.you, { your_turn: false, legal_moves: [] }); return J({ room: 'demo', game: gm, resolved: true }); } if (gm.type === 'coderace') { const raw = String(body.dir || ''); const v = gm.mode === 'words' ? raw.toLowerCase().replace(/[^a-z]/g, '') : raw.toUpperCase().replace(/[^A-Z]/g, ''); if (v.length !== gm.length) return J({ error: 'a guess is ' + gm.length + ' long' }, 400); if (gm.mode === 'words' && v === 'xqzzt') return J({ error: '"xqzzt" is not in the word list - try another 5-letter word' }, 400); gm.you.queued = v; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = gm.awaiting.filter(n => n !== 'Anthony'); return J({ room: 'demo', game: gm, resolved: false }); } if (gm.type === 'frontlines') { const split = String(body.dir).split(',').map(Number); if (split.length !== 5 || split.reduce((a, b) => a + b, 0) !== 100) return J({ error: 'the five numbers must add up to exactly 100' }, 400); gm.you.queued = split; const me = gm.players.find(x => x.name === 'Anthony'); if (me) me.committed = true; gm.awaiting = []; return J({ room: 'demo', game: gm, resolved: false }); } gm.you.queued = body.dir; const pl = gm.players.find(x => x.name === 'Anthony'); if (pl) { pl.moved = true; pl.thrown = true; } if (gm.awaiting) gm.awaiting = gm.awaiting.filter(n => n !== 'Anthony'); return J({ room: 'demo', game: gm, resolved: false }); }
    if ((mm = p.match(/games\/(\d+)$/))) { const gm = mm[1] === '4' && S.bs ? Object.assign({}, S.bs, { id: 4, status: 'finished', winner: 'Ada', turn: 81, players: S.bs.players.map((p, i) => i === 0 ? Object.assign({}, p, { sunk: 5 }) : Object.assign({}, p, { sunk: 4, afloat: 0 })) }) : findGame(mm[1]); if (!gm) return J({ error: 'No game with that id' }, 404); return J({ room: 'demo', game: gm }); }
    if (p.endsWith('/attachments')) {
      const all = S.shelf || [];
      const kinds = (u.searchParams.get('kind') || '').split(',').filter(Boolean);
      const fromF = (u.searchParams.get('from') || '').toLowerCase();
      const lim = parseInt(u.searchParams.get('limit') || '60', 10);
      const counts = { all: 0, image: 0, video: 0, audio: 0, speak: 0, html: 0, doc: 0, file: 0 };
      for (const a of all) { if (!fromF || a.from.toLowerCase() === fromF) { counts[a.kind]++; counts.all++; } }
      let list = all.filter(a => (!kinds.length || kinds.includes(a.kind)) && (!fromF || a.from.toLowerCase() === fromF));
      const before = u.searchParams.get('before');
      if (before) { const i = list.findIndex(a => (a.id + ':' + a.kind) === before); list = i >= 0 ? list.slice(i + 1) : []; }
      const pageItems = list.slice(0, lim);
      const next = list.length > lim && pageItems.length ? pageItems[pageItems.length - 1].id + ':' + pageItems[pageItems.length - 1].kind : null;
      return J({ room: 'demo', attachments: pageItems, counts, next_cursor: next });
    }
    if (p.endsWith('/members')) return J(S.mb);
    if (p.startsWith('/icons/')) return route.fulfill({ status: 200, contentType: 'image/png', body: ICON_PNG });
    // Anything else is a request the stub doesn't know: record it, so a
    // scenario can tell a missing route (or a broken path) from a real 404.
    (S.unhandled = S.unhandled || []).push(m + ' ' + p);
    return route.fulfill({ status: 404, body: 'nf' });
  });
}
// Waits until the page has settled after an action: no request in flight
// (the event stream aside) for a quiet window, two frames painted, and no
// finite CSS animation or transition still running (bar widths aside: the
// turn clock and progress bars re-run a width transition every tick). A
// wait on state, not a fixed sleep: quick on a quiet machine, patient on a
// busy one. Sleeps that time a gesture (a long press, a hold) stay
// waitForTimeout, and so do the few that give a 3D scene time to draw
// before a screenshot (settle cannot see WebGL frames). SETTLE_DEBUG=1
// logs the slow ones.
function trackNetwork(page) {
  const net = { inflight: 0, last: Date.now(), open: new Set() };
  const skip = (r) => /\/stream(\?|$)/.test(r.url());
  page.on('request', (r) => { if (!skip(r)) { net.inflight++; net.last = Date.now(); net.open.add(r); } });
  const end = (r) => { if (!skip(r)) { net.inflight = Math.max(0, net.inflight - 1); net.last = Date.now(); net.open.delete(r); } };
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  page.__net = net;
}
async function settle(page, quiet = 120, max = 6000) {
  const net = page.__net;
  const t0 = Date.now();
  while (net && (net.inflight > 0 || Date.now() - net.last < quiet) && Date.now() - t0 < max) await new Promise((r) => setTimeout(r, 20));
  if (process.env.SETTLE_DEBUG && net && Date.now() - t0 >= max) console.error('settle cap: ' + [...net.open].map((r) => r.method() + ' ' + r.url().replace(/^https:\/\/chat\.victorio\.cloud/, '')).join(', '));
  const t1 = Date.now();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  const t2 = Date.now();
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !isFinite(a.effect.getComputedTiming().endTime) || a.transitionProperty === 'width'), null, { timeout: Math.max(500, max - (Date.now() - t0)) })
    .catch(() => {});
  if (process.env.SETTLE_DEBUG && Date.now() - t0 > 800) {
    const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => (a.animationName || a.transitionProperty || a.constructor.name) + ':' + Math.round(a.effect.getComputedTiming().endTime))).catch(() => []);
    console.error('settle slow: net ' + (t1 - t0) + ' frames ' + (t2 - t1) + ' anim ' + (Date.now() - t2) + ' ' + anims.join(','));
  }
}
let FAILURES = 0;
const shot = (page, f) => page.screenshot({ path: OUT + f });
async function run(name, o, fn) {
  // ONLY=name1,name2 runs just those scenarios (a quick re-check)
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
  const b = await chromium.launch({ args: o.args || [] });
  const ctx = await b.newContext({ colorScheme: o.scheme || 'light', viewport: { width: o.w || 1280, height: o.h || 860 }, userAgent: o.ua, hasTouch: !!o.touch, isMobile: !!o.touch, timezoneId: 'UTC', locale: 'en-US' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const S = fresh(o.state); const calls = [];
  await useClock(page);
  trackNetwork(page);
  await setup(page, S, calls);
  if (o.init) await page.addInitScript(o.init);
  try {
    await page.goto('https://chat.victorio.cloud/r/demo' + (o.hash || ''));
    await settle(page);
    const r = await fn(page, S, calls);
    const fatal = errs.filter(e => !e.startsWith('console:'));
    if (fatal.length) throw new Error('uncaught page errors: ' + JSON.stringify(fatal));
    // A request the stub doesn't know means a missing route or a broken
    // path; a console error means something logged a failure. Both fail.
    const stray = S.unhandled || [];
    if (stray.length) throw new Error('requests the stub does not handle: ' + JSON.stringify(stray));
    const cons = badConsole(errs, o.allowConsole);
    if (cons.length) throw new Error('console errors: ' + JSON.stringify(cons));
    console.log('PASS ' + name + (r ? ' ' + JSON.stringify(r) : ''));
  } catch (e) {
    FAILURES++;
    console.log('FAIL ' + name + ': ' + (e && e.message ? String(e.message).split('\n')[0] : String(e)));
  } finally {
    await b.close();
  }
}
/* No WebGL (2026-11-20, the 2D views are retired): the arena box
   shrinks to one note and the game plays on with the controls under
   it - Battleship's two-captain view gives their waters as a plain
   aiming grid (the scene was the only way to fire), Four in a Row
   keeps its drop buttons. No Reload button: a reload won't help. */
const noGl = () => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : g.call(this, t, ...a); }; };
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
// The media shelf: the attachments listing as a filterable grid,
// the full-screen viewer, and the jump back to the message.
// Uploads (2026-11-20): any file through the paperclip goes up in
// resumable parts under a draft, with byte progress, a retry on a failed
// part, and the message posting only once the upload is done.
const must = (c, msg) => { if (!c) throw new Error(msg); };
// A scenario with its own harness (the home page) counts its failure here.
function failed() {
  FAILURES++;
}
// The end of a feature file: its summary line, and the exit code the
// runner (run.js) reads.
function done(file) {
  console.log(FAILURES ? 'UI FILE ' + file + ': ' + FAILURES + ' failing scenario(s)' : 'UI FILE ' + file + ': all scenarios pass');
  process.exit(FAILURES ? 1 : 0);
}

module.exports = { settle, trackNetwork, CLOCK, NOW, clockNow, useClock, D, DIST, FIXTURES, H, HTML, ICON_PNG, OUT, RESOURCE_STATUS, TESTS, badConsole, chromium, done, failed, fresh, fs, must, ngOpen, noGl, now, path, roomState, run, setup, shot, ymd };
