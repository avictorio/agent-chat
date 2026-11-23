// UI scenarios: the 3D arenas of the rounds games (Trust, Liar's Dice, Auction, Four in a Row, Code Race, Frontlines).
// Run alone: node -r ./tests/system-chromium.js tests/ui/arenas-3d.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { ARENA_KIDS, settle, done, run, shot } = require('./harness');

(async () => {
  // Trust in 3D: the table loads first, then the scores and the choices - the
  // grid is the table's threads, with the colour key in the frame's caption
  // and each seat's round points on its plate; a lock-in still sends
  // per-rival choices.
  for (const [label, o] of [['trust-3d', {}], ['trust-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tr: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tr-card', { timeout: 10000 });
      await page.click('.game-card.kind-trust');
      await page.waitForSelector('#viewer:not([hidden]) .tr-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .tr-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tr-scores|tr-plan|tr-grid-wrap/.test(c)));
      out.caption = await page.$eval('#viewer .tr-caption', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .tr-acts button:has-text("Trust everyone")');
      await page.click('#viewer .tr-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/18/moves')).pop() || '';
      if (!/Trust arena, 3D view: Ada 14, chosen; Henry 9, thinking; Anthony \(you\) 12, thinking\. On the table: round 2\./.test(out.label)) throw new Error('the scene reads the table: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,tr-scores,tr-plan') throw new Error('the table, then scores and choices: ' + JSON.stringify(out.order));
      if (out.caption !== 'Round 2: teal = cooperated · red = defected') throw new Error('the frame keys the threads: ' + out.caption);
      if (!/"dir":"Ada:C, Henry:C"/.test(out.moveCall)) throw new Error('Trust everyone sends C to each rival: ' + out.moveCall);
      return out;
    });
  }
  // The largest Trust table, 8 seats: each seat its own colour (from the
  // seventh on a create used to answer 500, six colours for eight seats),
  // and the choices list all seven rivals.
  for (const [label, o] of [['trust-eight', {}], ['trust-eight-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tr: true, tr8: true } }, o), async (page) => {
      const out = {};
      await page.click('.game-card.kind-trust');
      await page.waitForSelector('#viewer:not([hidden]) .tr-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.rivals = await page.$$eval('#viewer .tr-choice-name', (els) => els.map((e) => e.textContent.trim() + ' ' + getComputedStyle(e).color));
      await shot(page, label + '.png');
      await page.$eval('#viewer .tr-plan', (e) => e.scrollIntoView());
      await shot(page, label + '-plan.png');
      if (out.rivals.length !== 7) throw new Error('a choice for each of the seven rivals: ' + JSON.stringify(out.rivals));
      if (new Set(out.rivals.map((r) => r.split(' ').slice(1).join(' '))).size !== 7) throw new Error('each rival in its own colour: ' + JSON.stringify(out.rivals));
      return out;
    });
  }
  // Liar's Dice in 3D: the table loads first, then the standing bid, your
  // cup, the bid builder, the table and the last round; Liar! still sends the
  // call.
  for (const [label, o] of [['liarsdice-3d', {}], ['liarsdice-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ld: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ld-card', { timeout: 10000 });
      await page.click('.game-card.kind-liarsdice');
      await page.waitForSelector('#viewer:not([hidden]) .ld-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .ld-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|ld-now|ld-cup|ld-bidder|ld-table|ld-reveal/.test(c)));
      out.caption = await page.$eval('#viewer .ld-caption', (e) => e.textContent).catch(() => null);
      await shot(page, label + '.png');
      await page.click('#viewer .ld-liar');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/22/moves')).pop() || '';
      if (!/Liar's Dice table, 3D view: your cup holds 1, 3, 4, 4, 6 \(your ones are wild\); the standing bid is 3 fours by Ada\. Ada 5 dice; Anthony \(you\) 5 dice, to bid; Henry 4 dice\./.test(out.label)) throw new Error('the scene reads your cup and the table: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,ld-now,ld-bidder,ld-reveal') throw new Error('the table (your cup and the seats in it), then the bid, the builder and the last round: ' + JSON.stringify(out.order));
      if (out.caption !== 'Your ones are wild - they count toward any face.') throw new Error('the wild ones note is the frame\'s caption: ' + out.caption);
      if (!/"dir":"liar"/.test(out.moveCall)) throw new Error('Liar! sends the call: ' + out.moveCall);
      return out;
    });
  }
  // Liar's Dice after a round a timeout closed: the server opens no cup and
  // sends each seat's dice count (held) instead. The replay of that round
  // shows every seat with its dice - read from the cups alone, every seat
  // came out "0 dice, out" - and the last-round panel says no cup was
  // opened.
  const ldUnseen = () => { try { localStorage.setItem('ac-ld-seen:/r/demo:22', '0'); } catch { /* no storage: the scenario fails on its own */ } };
  for (const [label, o] of [['liarsdice-3d-timeout', {}], ['liarsdice-3d-timeout-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ld: true, ldTimeout: true }, init: ldUnseen }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .ld-card', { timeout: 10000 });
      await page.click('.game-card.kind-liarsdice');
      await page.waitForSelector('#viewer:not([hidden]) .ld-3d-host canvas', { timeout: 20000 });
      // read while the replay plays (the catch-up note is up): once it lands
      // the label shows the live counts
      out.label = await (await page.waitForFunction(() => { const c = document.querySelector('#viewer .duel-catchup'); const l = document.querySelector('#viewer .ld-3d-host [role="img"]'); return c && l ? l.getAttribute('aria-label') : null; }, null, { timeout: 60000, polling: 50 })).jsonValue();
      out.reveal = await page.$eval('#viewer .ld-reveal', (e) => e.textContent);
      await shot(page, label + '.png');
      if (!/Ada 5 dice; Anthony \(you\) 5 dice[^;]*; Henry [45] dice\./.test(out.label)) throw new Error('the replayed round shows each seat\'s dice count: ' + out.label);
      if (/, out/.test(out.label)) throw new Error('no seat is out in that round: ' + out.label);
      if (!/turn ran out/.test(out.reveal) || !/No cup was opened - only a call of liar opens them\./.test(out.reveal)) throw new Error('the last round says no cup was opened: ' + out.reveal);
      return out;
    });
  }
  // The auction in 3D: the hall loads first, then the lot, your bid and the
  // bidders; a bid still sends the number.
  for (const [label, o] of [['auction-3d', {}], ['auction-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { au: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .au-card', { timeout: 10000 });
      await page.click('.game-card.kind-auction');
      await page.waitForSelector('#viewer:not([hidden]) .au-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .au-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|au-lot|au-bid|au-players|au-result/.test(c)));
      await shot(page, label + '.png');
      await page.click('#viewer .au-acts button:has-text("Half")');
      await page.click('#viewer .au-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/20/moves')).pop() || '';
      if (!/Auction arena, 3D view: the lot is A rubber duck of unusual wisdom\. Ada 65 left, 1 won, bid in; Anthony \(you\) 80 left, 1 won, thinking; Henry 100 left, 0 won, thinking\./.test(out.label)) throw new Error('the scene reads the hall: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,au-lot,au-bid,au-players,au-result') throw new Error('the hall, then the lot, your bid, the bidders and the last lot: ' + JSON.stringify(out.order));
      if (!/"dir":"40"/.test(out.moveCall)) throw new Error('Half bids half the budget left: ' + out.moveCall);
      return out;
    });
  }
  // Four in a Row in 3D: the board scene loads first, the seats and the 1-7
  // drop buttons follow it (no 2D grid), a drop still sends the column, and
  // there is no 2D view to switch to.
  for (const [label, o] of [['fourinarow-3d', {}], ['fourinarow-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 10000 });
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer:not([hidden]) .c4-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .c4-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|c4-seats|c4-under/.test(c)));
      out.grid = !!(await page.$('#viewer .c4-grid'));
      await shot(page, label + '.png');
      await page.click('#viewer .c4-drop:nth-child(2)');
      await settle(page);
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
  // Code Race in 3D: the vault loads above the guess input, its label reads
  // the race from the viewer's seat and every racer's rounds (yours with your
  // guesses, a rival's feedback only); your guesses with their feedback are a
  // board in the frame - the lanes are the no-WebGL view; a guess still goes
  // out; no 2D view to switch to.
  for (const [label, o] of [['coderace-3d', {}], ['coderace-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card', { timeout: 10000 });
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer:not([hidden]) .cr-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .cr-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|cr-input|cr-board/.test(c)));
      out.ledger = await page.$$eval('#viewer .cr-ledger .cr-lrow', (rows) => rows.map((r) => r.querySelector('.cr-ln').textContent + ':' + [...r.querySelectorAll('.cr-lpeg')].map((p) => p.textContent).join('') + ':' + r.querySelectorAll('.cr-lpip.hit').length + '/' + r.querySelectorAll('.cr-lpip.near').length));
      await shot(page, label + '.png');
      for (const k of ['red', 'green', 'blue', 'yellow']) await page.click('#viewer .cr-color[aria-label="Add ' + k + '"]');
      await page.click('#viewer .cr-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/14/moves')).pop() || '';
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      if (!/Code Race arena, 3D view: Ada, guessed; Anthony \(you\), thinking; Henry, thinking\. On the pillars: round 2\./.test(out.label)) throw new Error('the scene reads the race from the viewer\'s seat: ' + out.label);
      if (!/Your rounds: 1 R G B Y - \d right place, \d right colour/.test(out.label) || !/Ada's rounds: 1 - \d right place/.test(out.label)) throw new Error('the ledgers read your guesses and a rival\'s feedback only: ' + out.label);
      if (out.order.join(',') !== 'lc-board-big,cr-input') throw new Error('the vault (your guesses in its frame), then the input: ' + JSON.stringify(out.order));
      if (out.ledger.join(',') !== 'R1:RGBY:1/2,R2:RRGO:2/0') throw new Error('the frame lists your guesses with their feedback: ' + JSON.stringify(out.ledger));
      if (!/"dir":"R G B Y"/.test(out.moveCall)) throw new Error('the 3D view still sends the guess: ' + out.moveCall);
      if (out.toggle) throw new Error('the 2D views are retired: no toggle');
      return out;
    });
  }
  // Frontlines in 3D: the scene loads above the score and the planner; the
  // round's numbers are in the scene (on the hills, and the result in the
  // frame's caption - no flat field under it); a lock-in still sends the
  // split; there is no 2D view to switch to.
  for (const [label, o] of [['frontlines-3d', {}], ['frontlines-3d-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { fl: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .fl-card', { timeout: 10000 });
      await page.click('.game-card');
      await page.waitForSelector('#viewer:not([hidden]) .fl-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.label = await page.$eval('#viewer .fl-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /fl-3d-host|lc-board-big|fl-score|fl-plan|fl-cap/.test(c) || c === 'lc-board-big'));
      out.caption = await page.$eval('#viewer .fl-caption', (e) => e.textContent);
      out.field = await page.$$eval('#viewer .fl-field, #viewer .fl-cap', (f) => f.length);
      await shot(page, label + '.png');
      await page.click('#viewer .fl-acts button:nth-child(1)');
      await page.click('#viewer .fl-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/12/moves')).pop() || '';
      if (!/Frontlines arena, 3D view: Anthony \(you\) 0, planning versus Ada 1, committed\. On the field: round 2\./.test(out.label)) throw new Error('the scene names both sides from the viewer\'s seat: ' + out.label);
      if (out.toggle) throw new Error('the 2D views are retired: no toggle');
      const iScene = out.order.indexOf('lc-board-big');
      const iPlan = out.order.indexOf('fl-plan');
      if (!(iScene >= 0 && iScene < iPlan)) throw new Error('scene, then the planner: ' + JSON.stringify(out.order));
      if (out.caption !== 'Round 2: Anthony 1 hill · Ada 1 hill — level') throw new Error('the frame\'s caption gives the round in numbers: ' + out.caption);
      if (out.field !== 0) throw new Error('no flat field under the scene: ' + out.field);
      if (!/"dir":"20,20,20,20,20"/.test(out.moveCall)) throw new Error('the 3D view still commits the split: ' + out.moveCall);
      return out;
    });
  }
  /* A lost WebGL context (a phone backgrounding the tab) left a blank
     box with no word; under reduced motion a restored one stayed blank,
     since nothing asked for a frame. Now the box says it paused, a
     restore draws the scene again, and a context that never comes back
     offers Restore, which builds the scene on a fresh canvas. */
  const loseCtx = (page, back) => page.$eval('#viewer .c4-3d-host canvas', (c, back) => {
    const x = (window.__lc = window.__lc || c.getContext('webgl2').getExtension('WEBGL_lose_context'));
    if (back) x.restoreContext(); else x.loseContext();
  }, back);
  const statusIs = (page, re) => page.waitForFunction((re) => { const s = document.querySelector('#viewer .c4-3d-host .arena3d-status'); return s && (re ? !s.hidden && new RegExp(re).test(s.textContent) : s.hidden); }, re, { timeout: 20000, polling: 100 });
  // counts the scene's WebGL draw calls: a restored context that nothing
  // asks to draw makes none, and shows a cleared canvas
  const countDraws = () => {
    const P = WebGL2RenderingContext.prototype;
    window.__draws = 0;
    for (const k of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = P[k];
      P[k] = function (...a) { window.__draws++; return f.apply(this, a); };
    }
  };
  const draws = (page) => page.evaluate(() => window.__draws);
  // a few frames: a draw asked for lands within them
  const frames = (page) => page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n > 10 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  for (const [label, o] of [['arena-context-lost', {}], ['arena-context-lost-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true }, reducedMotion: 'reduce', init: countDraws }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 10000 });
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer:not([hidden]) .c4-3d-host canvas', { timeout: 20000 });
      await statusIs(page, null);
      await loseCtx(page, false);
      await statusIs(page, 'paused');
      await shot(page, label + '-paused.png');
      const d0 = await draws(page);
      await loseCtx(page, true);
      await statusIs(page, null);
      await frames(page);
      out.restored = (await draws(page)) - d0;
      if (out.restored < 1) throw new Error('a restored context draws the scene again, even under reduced motion: ' + JSON.stringify(out));
      // never given back: Restore builds the scene anew
      await loseCtx(page, false);
      await statusIs(page, 'was lost');
      await shot(page, label + '-lost.png');
      const old = await page.$('#viewer .c4-3d-host canvas');
      await page.click('#viewer .c4-3d-host .arena3d-status button');
      await page.waitForFunction((o) => { const c = document.querySelector('#viewer .c4-3d-host canvas'); return c && c !== o; }, old, { timeout: 20000 });
      const d1 = await draws(page);
      await statusIs(page, null);
      await frames(page);
      out.rebuilt = (await draws(page)) - d1;
      if (out.rebuilt < 1) throw new Error('Restore draws the scene on a fresh canvas: ' + JSON.stringify(out));
      return out;
    });
  }
  /* A context lost while the scene was still loading (after the first
     frame's compile, before it reported ready): the ready report hid the
     status layer, so the later "was lost" note and Restore went into a
     hidden layer and the box stayed blank. The test browser cannot lose
     the context at that exact moment, so the host hears the scene's loss
     event as soon as it is made, before the scene reports ready. */
  const loseOnMount = () => {
    new MutationObserver((_, mo) => {
      const h = document.querySelector('#viewer .c4-3d-host');
      if (!h) return;
      mo.disconnect();
      h.dispatchEvent(new CustomEvent('arena3d-context', { detail: { lost: true } }));
    }).observe(document, { childList: true, subtree: true });
  };
  await run('arena-context-lost-loading', { state: { c4: true }, reducedMotion: 'reduce', init: loseOnMount }, async (page) => {
    await page.waitForSelector('.game-card .c4-grid', { timeout: 10000 });
    await page.click('.game-card.kind-fourinarow');
    await page.waitForSelector('#viewer:not([hidden]) .c4-3d-host canvas', { timeout: 20000 });
    await statusIs(page, 'was lost');
    const out = await page.$eval('#viewer .c4-3d-host .arena3d-status', (s) => ({ text: s.textContent, button: !!(s.querySelector('button') || {}).offsetParent }));
    if (!out.button) throw new Error('a context lost while loading must still offer Restore: ' + JSON.stringify(out));
    const old = await page.$('#viewer .c4-3d-host canvas');
    await page.click('#viewer .c4-3d-host .arena3d-status button');
    await page.waitForFunction((o) => { const c = document.querySelector('#viewer .c4-3d-host canvas'); return c && c !== o; }, old, { timeout: 20000 });
    await statusIs(page, null);
    return out;
  });
  done('arenas-3d');
})();
