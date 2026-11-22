// A markup snapshot of every game's chat card and arena, for refactors
// that must not change the DOM: for each fixture state, with and without
// WebGL, at desktop and phone width, it records the card board and the
// arena's Game and History tabs as a normalised tree (attributes sorted;
// the turn banner, clock bars and 3D scene left out, since they move with
// the clock). Writes one JSON file;
// compare two runs with `node tests/ui/panelsnap.js diff a.json b.json`
// (it compares the snapshots both files have). ONLY_GAMES=tr,au snapshots
// just the states of those fixtures (the first key of each state).
// A state with several cards snapshots the one CARD names for it (else
// the first in the feed); VARIANTS are states the harness has no option
// for, made by changing the fixture fresh() built.
// STYLES=1 adds a hash of each element's full computed style, for CSS
// moves that must not change how anything looks (the games.css split).
// Not part of the suite: run it before and after a change.
const { chromium, fresh, setup, installClock, settle, noGl, now } = require('./harness');
const fs = require('fs');

const STATES = [['game'], ['duel'], ['duelLobby'], ['duel', 'duelDone'], ['bs'], ['bs', 'bsSetup'], ['bs', 'bsPlay'], ['bs', 'bsFfa'], ['fl'], ['fl', 'flValued'], ['cr'], ['cr', 'crWords'], ['cr', 'crDone'], ['c4'], ['c4', 'c4Done'], ['c4', 'c4Done', 'c4Forfeit'], ['tr'], ['au'], ['ld'], ['tt'], ['tt', 'ttWrite'], ['ec'], ['ec', 'ecVote'], ['tq'], ['tq', 'tqAnswer'], ['ww'], ['ww', 'wwWolf'], ['lg'], ['tv'], ['tv', 'tvAsk'], ['tv', 'tvJudge'], ['sg'], ['sg', 'sgDraw'],
  ['game', 'lcLobby'], ['game', 'lcQueued'], ['game', 'lcOut'], ['game', 'lcWatch'], ['game', 'lcDone'],
  ['sg', 'sgWatch'], ['sg', 'sgArtist'], ['sg', 'sgQueued'], ['sg', 'sgRoast'], ['sg', 'sgDone'],
  ['bs', 'bsWatchSetup'], ['bs', 'bsPlay', 'bsSonar'], ['bs', 'bsPlay', 'bsDone'], ['bs', 'bsFfa', 'bsFfaWatch'], ['bs', 'bsFfa', 'bsFfaOut']];
// The card a state snapshots when the feed has more than one (its label).
const CARD = { bsPlay: 'Battleship #6', bsSetup: 'Battleship #8', bsFfa: 'Battleship #9' };
const VARIANTS = {
  // Light Cycles: a lobby, a queued move, the viewer out (the record
  // keeper named mid-match), a spectator, a finished match
  lcLobby: (S) => Object.assign(S.game, { status: 'lobby', tick: 0, deadline: null, lobby_deadline: now + 1800e3, players: S.game.players.map((p, i) => Object.assign({}, p, { accepted: i !== 1, moved: false })), you: { playing: true, accepted: true, alive: true, queued: null, legal_moves: [] } }),
  lcQueued: (S) => { S.game.you.queued = 'left'; S.game.players[2].moved = true; },
  lcOut: (S) => { S.game.you = { playing: true, alive: false, queued: null, legal_moves: [] }; S.game.players[2].alive = false; S.game.record_keeper = 'Anthony'; },
  lcWatch: (S) => { S.game.you = { playing: false }; },
  lcDone: (S) => Object.assign(S.game, { status: 'finished', winner: 'Ada', deadline: null, record_keeper: 'Henry', players: S.game.players.map((p) => Object.assign({}, p, { alive: p.name === 'Ada' })), you: { playing: true, alive: false, queued: null, legal_moves: [] } }),
  // Sketch & Guess: a spectator, the artist while the others guess, a
  // sealed guess, a round with a missed guess, a roast and no Referee, a
  // finished match whose last round was forfeit
  sgWatch: (S) => { S.sg.you = { playing: false }; },
  sgArtist: (S) => { S.sg.artist = 'Anthony'; S.sg.you = { playing: true, accepted: true, artist: true, prompt: 'a lighthouse in a storm', legal_moves: [] }; },
  sgQueued: (S) => { S.sg.you.queued = 'a lighthouse'; S.sg.players[2].committed = true; },
  sgRoast: (S) => { const r = S.sg.rounds[0]; r.guesses = { Ada: Object.assign({}, r.guesses.Ada, { how: 'match' }) }; r.missed = ['Anthony']; r.roast = 'Henry drew a cat. Nobody is sure.'; r.judge = 'match'; r.judge_note = 'timeout'; },
  sgDone: (S) => { Object.assign(S.sg, { status: 'finished', phase: null, winner: 'Ada', deadline: null, image: null }); S.sg.rounds.push({ n: 2, artist: 'Ada', prompt: 'a paper boat', image: null, guesses: {}, right: [], missed: [], points: {}, judge: null, judge_note: null, roast: null, forfeit: true, at: now - 30e3 }); S.sg.you = { playing: true, accepted: true, artist: false, legal_moves: [] }; },
  // Battleship: spectating the placement; the viewer's shot just sank a
  // 2-ship (a ringed cell, the banner's border), a sonar ping and both
  // captains warned; a finished match seen by its loser; a spectator of
  // the free-for-all as Hank's last ship sinks; the viewer out of the
  // free-for-all as Henry sinks a ship of Ada's
  bsWatchSetup: (S) => { Object.assign(S.bs, { phase: 'setup', turn: 0, turn_of: null, last_move: null, log: [] }); S.bs.players.forEach((p, i) => Object.assign(p, { placed: i === 0, shots: 0, hits: 0, sunk: 0, afloat: 5 })); S.bs.boards.forEach((b) => { b.incoming = {}; b.sunk_ships = []; }); },
  bsSonar: (S) => { const g = S.bsPlay; Object.assign(g, { turn: 13, turn_of: 'Ada', misses: { Anthony: 1, Ada: 2 }, sonar: { for: 'Ada', label: 'C3', turn: 13 }, last_move: { by: 'Anthony', cell: 'C6', result: 'hit', sunk: 2, turn: 12 } }); g.you.your_turn = false; g.you.sunk_ships = [{ size: 2, cells: ['C5', 'C6'] }]; g.boards[1].sunk_ships = [{ size: 2, cells: ['C5', 'C6'] }]; g.players[1].afloat = 4; g.players[0].sunk = 1; },
  bsDone: (S) => { const g = S.bsPlay; Object.assign(g, { status: 'finished', winner: 'Ada', deadline: null, turn_of: null, last_move: { by: 'Ada', cell: 'H7', result: 'hit', sunk: 4, turn: 40 } }); g.you.your_turn = false; g.you.fleet.forEach((s) => { s.hits = s.cells.slice(); s.sunk = true; }); g.players[0].afloat = 0; g.players[1].sunk = 5; },
  bsFfaWatch: (S) => { const g = S.bsFfa; g.you = { playing: false }; g.last_move = { by: 'Anthony', target: 'Hank', cell: 'J2', result: 'hit', sunk: 2, turn: 30 }; },
  bsFfaOut: (S) => { const g = S.bsFfa; Object.assign(g, { turn_of: 'Ada', misses: { Henry: 2, Ada: 1 }, sonar: { for: 'Ada', target: 'Henry', label: 'B4', turn: 31 }, last_move: { by: 'Henry', target: 'Ada', cell: 'C6', result: 'hit', sunk: 2, turn: 30 } }); g.players[0].eliminated = true; g.players[0].afloat = 0; g.you.eliminated = true; g.you.your_turn = false; g.you.fleet.forEach((s) => { s.hits = s.cells.slice(); s.sunk = true; }); g.you.targets[0].sunk_ships = [{ size: 2, cells: ['C5', 'C6'] }]; g.you.targets[0].shots.C6 = 'hit'; },
};
const MODES = [
  { key: 'gl-desk', gl: true, w: 1280, h: 860 },
  { key: 'nogl-desk', gl: false, w: 1280, h: 860 },
  { key: 'nogl-phone', gl: false, w: 390, h: 844, touch: true },
];

function serialise(styles) {
  const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  };
  const css = (n) => {
    if (!styles) return '';
    // computed values (computedStyleMap), not getComputedStyle's resolved
    // ones: those resolve margins and sizes against the layout of the
    // moment, which varies run to run; the cascade's result does not
    let all = '';
    for (const [prop, vals] of n.computedStyleMap()) all += prop + ':' + vals.map(String).join(',') + ';';
    return ' css=' + (styles === 'full' ? JSON.stringify(all) : hash(all));
  };
  const SKIP = '.turn-banner, .duel-clockwrap, .lc-3d-host, .arena3d-frame, canvas, .gm-due, .turn-left';
  const walk = (n) => {
    if (n.nodeType === 3) return n.textContent.trim() ? JSON.stringify(n.textContent) : '';
    if (n.nodeType !== 1) return '';
    if (n.matches(SKIP)) return '<' + n.tagName.toLowerCase() + ' skipped/>';
    // a React panel's host is display: contents and stands for nothing
    if (n.classList.contains('panel-host')) return [...n.childNodes].map(walk).filter(Boolean).join('');
    const attrs = [...n.attributes].map((a) => a.name + '=' + JSON.stringify(a.value)).sort().join(' ');
    const props = [];
    if (n.tagName === 'BUTTON' || n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') {
      if (n.disabled) props.push('[disabled]');
      if ('value' in n && n.value) props.push('[value=' + JSON.stringify(n.value) + ']');
      if (n.checked) props.push('[checked]');
    }
    const kids = [...n.childNodes].map(walk).filter(Boolean).join('');
    return '<' + n.tagName.toLowerCase() + (attrs ? ' ' + attrs : '') + props.join('') + css(n) + '>' + kids + '</' + n.tagName.toLowerCase() + '>';
  };
  return walk;
}

async function snapOne(browser, state, mode) {
  const ctx = await browser.newContext({ viewport: { width: mode.w, height: mode.h }, hasTouch: !!mode.touch, isMobile: !!mode.touch, timezoneId: 'UTC', locale: 'en-US', colorScheme: 'dark' });
  const page = await ctx.newPage();
  const out = {};
  try {
    const S = fresh(Object.fromEntries(state.map((k) => [k, true])));
    state.forEach((k) => VARIANTS[k] && VARIANTS[k](S));
    const pick = state.filter((k) => CARD[k]).pop();
    const cardSel = pick ? '.game-card[aria-label="Open ' + CARD[pick] + '"]' : '.game-card';
    await installClock(page);
    await setup(page, S, []);
    if (!mode.gl) await page.addInitScript(noGl);
    await page.goto('https://chat.victorio.cloud/r/demo');
    await settle(page);
    const card = await page.waitForSelector(cardSel + ' .game-board > *:not(.md-p)', { timeout: 10000 }).catch(() => null);
    // computed styles mid-animation differ run to run: in STYLES mode
    // finish every finite animation and park infinite ones at their start
    const still = () => process.env.STYLES ? page.evaluate(() => document.getAnimations().forEach((an) => { try { if (isFinite(an.effect.getComputedTiming().endTime)) an.finish(); else { an.pause(); an.currentTime = 0; } } catch {} })) : null;
    const snap = async (sel) => { await still(); return snap0(sel); };
    const snap0 = (sel) => page.evaluate(([sel, fn, styles]) => { const walk = new Function('return ' + fn)()(styles); const el = document.querySelector(sel); return el ? walk(el) : null; }, [sel, serialise.toString(), process.env.STYLES === 'full' ? 'full' : !!process.env.STYLES]);
    if (card) {
      await settle(page);
      out.card = await snap(cardSel);
      await page.click(cardSel);
      await page.waitForFunction(() => { const a = document.querySelector('#viewer .lc-arena'); return a && !/Loading the arena/.test(a.textContent); }, null, { timeout: 10000 });
      await settle(page);
      await page.waitForTimeout(400);
      out.arena = await snap('#viewer .lc-arena');
      const hist = await page.$('#viewer .arena-tabs [data-tab="history"], #viewer .arena-tabs button:nth-child(2)');
      if (hist) {
        await hist.click();
        await settle(page);
        out.history = await snap('#viewer .lc-arena');
      }
    } else out.card = 'NO CARD';
  } catch (e) {
    out.error = String(e.message || e).split('\n')[0];
  } finally {
    await ctx.close();
  }
  return out;
}

async function main() {
  const file = process.argv[2] || 'panelsnap.json';
  const jobs = [];
  const only = process.env.ONLY_GAMES ? process.env.ONLY_GAMES.split(',') : null;
  for (const s of STATES) if (!only || only.includes(s[0])) for (const m of MODES) jobs.push([s, m]);
  const result = {};
  const N = Math.max(1, +process.env.JOBS || 6);
  let next = 0;
  const worker = async () => {
    const browser = await chromium.launch();
    while (next < jobs.length) {
      const [s, m] = jobs[next++];
      result[s.join('+') + '/' + m.key] = await snapOne(browser, s, m);
    }
    await browser.close();
  };
  await Promise.all(Array.from({ length: N }, worker));
  const sorted = Object.fromEntries(Object.keys(result).sort().map((k) => [k, result[k]]));
  fs.writeFileSync(file, JSON.stringify(sorted, null, 1));
  const errs = Object.entries(sorted).filter(([, v]) => v.error || v.card === 'NO CARD');
  console.log('panelsnap: ' + Object.keys(sorted).length + ' snapshots to ' + file + (errs.length ? '; problems: ' + errs.map(([k, v]) => k + ' ' + (v.error || v.card)).join('; ') : ''));
}

function diff(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8'));
  const B = JSON.parse(fs.readFileSync(b, 'utf8'));
  let n = 0;
  const both = Object.keys(A).filter((k) => k in B);
  console.log('panelsnap diff: comparing ' + both.length + ' snapshot(s) both files have');
  for (const k of both) {
    for (const part of ['card', 'arena', 'history', 'error']) {
      const x = (A[k] || {})[part];
      const y = (B[k] || {})[part];
      if (x === y) continue;
      n++;
      let i = 0;
      if (x && y) while (i < x.length && x[i] === y[i]) i++;
      console.log('DIFF ' + k + ' ' + part + ' at ' + i + ':\n  - ' + String(x).slice(Math.max(0, i - 120), i + 200) + '\n  + ' + String(y).slice(Math.max(0, i - 120), i + 200));
    }
  }
  console.log(n ? 'panelsnap diff: ' + n + ' difference(s)' : 'panelsnap diff: identical');
  process.exit(n ? 1 : 0);
}

if (process.argv[2] === 'diff') diff(process.argv[3], process.argv[4]);
else main();
