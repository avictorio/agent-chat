// A markup snapshot of every game's chat card and arena, for refactors
// that must not change the DOM (the 2D panels' move to React): for each
// fixture state, with and without WebGL, at desktop and phone width, it
// records the card board and the arena's Game and History tabs as a
// normalised tree (attributes sorted; the turn banner, clock bars and 3D
// scene left out, since they move with the clock). Writes one JSON file;
// compare two runs with `node tests/ui/panelsnap.js diff a.json b.json`.
// Not part of the suite: run it before and after a change.
const { chromium, fresh, setup, useClock, settle, noGl } = require('./harness');
const fs = require('fs');

const STATES = [['game'], ['duel'], ['duelLobby'], ['duel', 'duelDone'], ['bs'], ['bs', 'bsSetup'], ['bs', 'bsPlay'], ['bs', 'bsFfa'], ['fl'], ['fl', 'flValued'], ['cr'], ['cr', 'crWords'], ['cr', 'crDone'], ['c4'], ['c4', 'c4Done'], ['c4', 'c4Done', 'c4Forfeit'], ['tr'], ['au'], ['ld'], ['tt'], ['tt', 'ttWrite'], ['ec'], ['ec', 'ecVote'], ['tq'], ['tq', 'tqAnswer'], ['ww'], ['ww', 'wwWolf'], ['lg'], ['tv'], ['tv', 'tvAsk'], ['tv', 'tvJudge'], ['sg'], ['sg', 'sgDraw']];
const MODES = [
  { key: 'gl-desk', gl: true, w: 1280, h: 860 },
  { key: 'nogl-desk', gl: false, w: 1280, h: 860 },
  { key: 'nogl-phone', gl: false, w: 390, h: 844, touch: true },
];

function serialise() {
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
    return '<' + n.tagName.toLowerCase() + (attrs ? ' ' + attrs : '') + props.join('') + '>' + kids + '</' + n.tagName.toLowerCase() + '>';
  };
  return walk;
}

async function snapOne(browser, state, mode) {
  const ctx = await browser.newContext({ viewport: { width: mode.w, height: mode.h }, hasTouch: !!mode.touch, isMobile: !!mode.touch, timezoneId: 'UTC', locale: 'en-US', colorScheme: 'dark' });
  const page = await ctx.newPage();
  const out = {};
  try {
    const S = fresh(Object.fromEntries(state.map((k) => [k, true])));
    await useClock(page);
    await setup(page, S, []);
    if (!mode.gl) await page.addInitScript(noGl);
    await page.goto('https://chat.victorio.cloud/r/demo');
    await settle(page);
    const card = await page.waitForSelector('.game-card .game-board > *:not(.md-p)', { timeout: 10000 }).catch(() => null);
    const snap = (sel) => page.evaluate(([sel, fn]) => { const walk = new Function('return ' + fn)()(); const el = document.querySelector(sel); return el ? walk(el) : null; }, [sel, serialise.toString()]);
    if (card) {
      await settle(page);
      out.card = await snap('.game-card');
      await page.click('.game-card');
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
  for (const s of STATES) for (const m of MODES) jobs.push([s, m]);
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
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    for (const part of ['card', 'arena', 'history', 'error']) {
      const x = (A[k] || {})[part];
      const y = (B[k] || {})[part];
      if (x === y) continue;
      n++;
      let i = 0;
      while (x && y && x[i] === y[i]) i++;
      console.log('DIFF ' + k + ' ' + part + ' at ' + i + ':\n  - ' + String(x).slice(Math.max(0, i - 120), i + 200) + '\n  + ' + String(y).slice(Math.max(0, i - 120), i + 200));
    }
  }
  console.log(n ? 'panelsnap diff: ' + n + ' difference(s)' : 'panelsnap diff: identical');
  process.exit(n ? 1 : 0);
}

if (process.argv[2] === 'diff') diff(process.argv[3], process.argv[4]);
else main();
