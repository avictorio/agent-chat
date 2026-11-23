// UI scenarios: Battleship (the 3D arena, placement, free-for-all, phone aim) and the no-WebGL fallbacks.
// Run alone: node -r ./tests/system-chromium.js tests/ui/battleship.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { settle, done, noGl, run, shot } = require('./harness');

(async () => {
  await run('battleship-spectator', { state: { bs: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    out.minis = await page.$$eval('.game-card .bs-mini-svg', els => els.length);
    out.lastline = await page.$eval('.game-card .bs-lastline', e => e.textContent);
    out.cardStrips = await page.$$eval('.game-card .bs-strip', els => els.length);
    if (out.minis !== 2) throw new Error('card should show two mini boards, got ' + out.minis);
    if (!/Ada fires A7/.test(out.lastline)) throw new Error('card last-shot line wrong: ' + out.lastline);
    if (out.cardStrips !== 2) throw new Error('card should show two fleet strips, got ' + out.cardStrips);
    await shot(page, 'bs-card.png');
    await page.click('.game-card');
    // two captains: the 3D scene is the only arena view
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host', { timeout: 10000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    out.banner = await page.$eval('#viewer .bs-verdict', e => e.textContent);
    out.note = await page.$eval('#viewer .lc-note', e => e.textContent);
    if (out.grids !== 0) throw new Error('two captains spectate on the 3D scene, no 2D boards; got ' + out.grids);
    if (!/Ada fires A7 · HIT/.test(out.banner)) throw new Error('arena banner wrong: ' + out.banner);
    if (!/un-hit ships stay hidden/.test(out.note)) throw new Error('spectator note wrong: ' + out.note);
    await shot(page, 'bs-spectator-arena.png');
    if (await page.$('#viewer .lc-log') !== null) throw new Error('the plain-text record should be gone from the game tab');
    await page.click('#viewer .arena-tabs .arena-tab:nth-child(2)');
    await page.waitForSelector('#viewer .hist-row', { timeout: 10000 });
    out.histRows = await page.$$eval('#viewer .hist-row', els => els.length);
    out.histText = await page.$eval('#viewer .hist-list', e => e.textContent);
    out.histIdx = await page.$$eval('#viewer .hist-row .hist-idx', els => els.map((e) => e.textContent));
    out.histTab = await page.$eval('#viewer .arena-tabs .arena-tab:nth-child(2)', e => e.textContent);
    // every shot comes from the record (79), the log's tail adds its
    // note (the sonar ping): the turns before the log's 24 lines are there
    if (out.histRows !== 80 || out.histIdx[0] !== 'Turn 1' || out.histIdx[79] !== 'Turn 79') throw new Error('history should render all 79 shots from the record plus the log\'s note, got ' + out.histRows + ' rows from ' + out.histIdx[0] + ' to ' + out.histIdx[out.histIdx.length - 1]);
    if (!/· 80$/.test(out.histTab)) throw new Error('the History tab should count its rows: ' + out.histTab);
    if (!/I9/.test(out.histText) || !/Hit/.test(out.histText) || !/Sunk · 5/.test(out.histText) || !/Sonar ping for Ada/.test(out.histText)) throw new Error('history rows should carry cell badges, outcome pills and the log\'s notes: ' + out.histText.slice(0, 300));
    await shot(page, 'bs-spectator-history.png');
    return out;
  });
  await run('battleship-spectator-mobile-dark', { state: { bs: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await shot(page, 'bs-card-mobile-dark.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host canvas', { timeout: 20000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    if (out.grids !== 0) throw new Error('mobile spectator: the 3D scene only, got ' + out.grids + ' 2D boards');
    await shot(page, 'bs-spectator-mobile-dark.png');
    return out;
  });
  await run('battleship-player', { state: { bsPlay: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.click('.game-card');
    // the scene, then both fleet strips under it; firing is the scene's
    // (battleship-3d-keyboard, battleship-3d-phone-aim-fire, no-webgl-battleship)
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host', { timeout: 10000 });
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
  // Free-for-all: a four-captain match is one scene - your waters plus one
  // ocean per rival, the eliminated captain a grey wreck chart - with every
  // captain's fleet strip under it and no flat boards. The keyboard aims at
  // the first live rival; an arrow past the right edge crosses to the next
  // one, and the shot names its target.
  await run('battleship-ffa', { state: { bsFfa: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
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
    await settle(page);
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
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.tap('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    await settle(page);
    const showing = () => page.$eval('#viewer .arena3d-cycle-name', (e) => e.textContent + (e.classList.contains('wreck') ? '~' : ''));
    out.showing = await showing();
    if (out.showing !== 'Ada2/4') throw new Error('Ada\'s ocean up on your turn, 2 of 4: ' + out.showing);
    out.tools = await page.evaluate(() => { const a = document.querySelector('#viewer .arena3d-cycle').getBoundingClientRect(); const b = document.querySelector('#viewer .arena3d-tools').getBoundingClientRect(); return { cycleRight: Math.round(a.right), toolsLeft: Math.round(b.left) }; });
    if (out.tools.cycleRight > out.tools.toolsLeft) throw new Error('the cycler must clear the frame\'s tools: ' + JSON.stringify(out.tools));
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    if (out.grids !== 0) throw new Error('no 2D boards on the phone either, got ' + out.grids);
    await shot(page, 'bs-ffa-mobile-dark.png');
    await page.tap('#viewer .arena3d-cycle button[aria-label="Next ocean"]');
    await settle(page);
    out.after = await showing();
    await page.tap('#viewer .arena3d-cycle button[aria-label="Next ocean"]');
    await settle(page);
    out.wreck = await showing();
    await page.tap('#viewer .arena3d-cycle button[aria-label="Previous ocean"]');
    await settle(page);
    if (out.after !== 'Henry3/4' || out.wreck !== 'Hank4/4~') throw new Error('Next steps to Henry, then the struck-through wreck: ' + out.after + ' / ' + out.wreck);
    const box = await (await page.$('#viewer .lc-3d-host canvas')).boundingBox();
    const before = calls.length;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.55);
    await settle(page);
    if (calls.slice(before).some((c) => /\/moves/.test(c))) throw new Error('a tap must aim, not fire');
    out.fireText = await page.$eval('#viewer .arena3d-fire', (e) => e.textContent).catch(() => null);
    if (!out.fireText || !/^Fire at Henry's [A-J]\d+$/.test(out.fireText)) throw new Error('the Fire button names Henry\'s cell, got ' + out.fireText);
    await shot(page, 'bs-ffa-mobile-aimed.png');
    await page.tap('#viewer .arena3d-fire');
    await settle(page);
    const moves = calls.slice(before).filter((c) => /\/games\/9\/moves/.test(c));
    const cell = out.fireText.slice('Fire at Henry\'s '.length);
    if (moves.length !== 1 || moves[0].indexOf('"Henry:' + cell + '"') < 0) throw new Error('Fire should send one move at Henry:' + cell + ': ' + JSON.stringify(moves));
    return out;
  });
  await run('battleship-3d-default', { state: { bsPlay: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.click('.game-card');
    /* 20s, not the usual 4-8s: the canvas waits on the lazy three.js
       chunk loading plus software-GL init, which runs long on a
       loaded box - an 8s wait flakes while the scene itself renders
       fine. */
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
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.click('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && !s.hidden && /didn't load/.test(s.textContent) && s.querySelector('button'); }, null, { timeout: 20000 });
    // the failed scene was the only way to fire: the view is built again
    // with their waters as the aiming grid
    await page.waitForSelector('#viewer .bs-aim .bs-grid', { timeout: 10000 });
    return { status: await page.$eval('#viewer .arena3d-status', e => e.textContent), aim: await page.$$eval('#viewer .bs-aim .bs-cell', (c) => c.length) };
  });
  /* A browser with WebGL 1 only: three.js needs WebGL 2, so the device
     counts as having no WebGL - the note and the aiming grid at once. */
  const gl1Only = () => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return t === 'webgl2' ? null : g.call(this, t, ...a); }; };
  await run('webgl1-only-battleship', { state: { bsPlay: true }, init: gl1Only }, async (page, S, calls) => {
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer .bs-3d-host.no-3d .arena3d-status', { timeout: 10000 });
    const out = { gl1: await page.evaluate(() => !!document.createElement('canvas').getContext('webgl')), aim: await page.$$eval('#viewer .bs-aim .bs-cell', (c) => c.length), canvas: await page.$$eval('#viewer canvas', (c) => c.length) };
    if (out.aim !== 100) throw new Error('their waters as the aiming grid: ' + out.aim);
    if (out.canvas) throw new Error('no scene is attempted on WebGL 1');
    await page.click('#viewer .bs-aim .bs-cell:not(.miss):not(.hit):not(.sunk)');
    await settle(page);
    if (!calls.some((c) => /\/games\/6\/moves/.test(c))) throw new Error('a tap on the aiming grid fires');
    return out;
  });
  /* Liar's Dice whose scene chunk failed on a device with WebGL: the
     cup and the table come back, so the bidder sees their own dice. */
  for (const [label, o] of [['liarsdice-3d-load-failure', {}], ['liarsdice-3d-load-failure-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
  await run(label, Object.assign({ state: { ld: true } }, o), async (page) => {
    await page.route(/\/assets\/LiarsArena3D-.*\.js$/, (route) => route.fulfill({ status: 404, body: 'nf' }));
    await page.waitForSelector('.game-card.kind-liarsdice', { timeout: 10000 });
    await page.click('.game-card.kind-liarsdice');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && !s.hidden && /didn't load/.test(s.textContent); }, null, { timeout: 20000 });
    await page.waitForSelector('#viewer .ld-cup .ld-die', { timeout: 10000 });
    const out = { dice: await page.$$eval('#viewer .ld-cup .ld-die', (d) => d.length), table: await page.$$eval('#viewer .ld-table', (t) => t.length), bidder: await page.$$eval('#viewer .ld-bidder', (b) => b.length) };
    await settle(page);
    await shot(page, label + '.png');
    if (!out.dice || !out.table || !out.bidder) throw new Error('the cup, the table and the bidder after the scene failed: ' + JSON.stringify(out));
    return out;
  });
  }
  for (const [label, o] of [['no-webgl-battleship', {}], ['no-webgl-battleship-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { bsPlay: true }, init: noGl }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
      await page.click('.game-card');
      await page.waitForSelector('#viewer .bs-3d-host.no-3d .arena3d-status', { timeout: 10000 });
      out.status = await page.$eval('#viewer .arena3d-status', (e) => e.textContent);
      out.reload = !!(await page.$('#viewer .arena3d-status button'));
      out.hostH = await page.$eval('#viewer .bs-3d-host', (e) => e.getBoundingClientRect().height);
      out.grids = await page.$$eval('#viewer .bs-aim .bs-grid', (g) => g.length);
      await shot(page, label + '.png');
      const cell = await page.$('#viewer .bs-aim .bs-cell:not(.miss):not(.hit):not(.sunk)');
      if (cell) await cell.click();
      await settle(page);
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
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer .bs-3d-host.no-3d .arena3d-status', { timeout: 10000 });
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
    await settle(page);
    out.moveCall = calls.filter(c => c.includes('/games/9/moves')).pop() || '';
    if (!/"dir":"Ada:C7"/.test(out.moveCall)) throw new Error('ffa fire call should name its target, got: ' + out.moveCall);
    return out;
  });
  await run('no-webgl-battleship-setup', { state: { bsSetup: true }, init: noGl }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 10000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) button.bs-cell[aria-label="Place at A8"]', { timeout: 10000 });
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
    // the fleet being placed is the view's (the scene shares it), and the
    // panels draw it: a repaint keeps the hulls laid and the next one's lie
    await page.click('#viewer .arena-tabs button:nth-child(2)');
    await page.click('#viewer .arena-tabs button:nth-child(1)');
    await page.waitForSelector('#viewer button.bs-cell[aria-label="Place at A9"]', { timeout: 10000 });
    out.kept = (await count()) + '|' + (await page.$$eval('#viewer .duel-statusline', (els) => els.map((e) => e.textContent).find((t) => /Next hull|Fleet complete/.test(t)) || ''));
    if (out.kept !== '9|Next hull: your 3-ship, lying vertical from the cell you tap.') throw new Error('a repaint keeps the fleet being placed: ' + out.kept);
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
    await shot(page, 'no-webgl-bs-setup-placed.png');
    await page.click('#viewer .duel-pad .duel-btn:nth-child(4)');
    await settle(page);
    out.moveCall = calls.filter(c => c.includes('/games/8/moves')).pop() || '';
    if (!/"dir":"B2H,H4V,A9H,J1V,E5V"/.test(out.moveCall)) throw new Error('placement call wrong: ' + out.moveCall);
    return out;
  });
  // A spectator has no aiming grid: without WebGL the two captains'
  // boards follow the note (with WebGL they are not built at all).
  for (const [label, o] of [['no-webgl-battleship-spectator', {}], ['no-webgl-battleship-spectator-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { bs: true }, init: noGl }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
      await page.click('.game-card');
      await page.waitForSelector('#viewer .bs-3d-host.no-3d .arena3d-status', { timeout: 10000 });
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
    await page.waitForSelector('.game-card.kind-fourinarow', { timeout: 10000 });
    await page.click('.game-card.kind-fourinarow');
    await page.waitForSelector('#viewer .no-3d .arena3d-status', { timeout: 10000 });
    out.status = await page.$eval('#viewer .arena3d-status', (e) => e.textContent);
    out.drops = await page.$$eval('#viewer .c4-under button', (b) => b.length);
    out.cells = await page.$$eval('#viewer .c4-flat .c4-grid .c4-cell', (c) => c.length);
    out.discs = await page.$$eval('#viewer .c4-flat .c4-grid .c4-disc', (c) => c.length);
    if (!/3D isn't available on this device/.test(out.status)) throw new Error('the note: ' + out.status);
    if (out.drops < 7) throw new Error('the drop buttons stay: ' + out.drops);
    // the board itself: without it the drops aim at nothing
    if (out.cells !== 42 || !out.discs) throw new Error('the flat board, 7 by 6 with the discs down: ' + JSON.stringify(out));
    return out;
  });
  /* A refused move on your own turn: the view puts its note line on the
     page only when it has text, and on your turn it has none, so the
     referee's refusal shows as a toast instead of vanishing. */
  const REFUSED = 'The referee refused that move: the clock just ran out';
  for (const [label, o, state, gid, open, act] of [
    ['move-refused-toast', {}, { c4: true }, 16, '.game-card.kind-fourinarow', '#viewer .c4-drop:nth-child(4)'],
    ['move-refused-toast-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }, { c4: true }, 16, '.game-card.kind-fourinarow', '#viewer .c4-drop:nth-child(4)'],
    ['move-refused-toast-werewolf', {}, { ww: true }, 30, '.game-card.kind-werewolf', '#viewer .ww-target[aria-label="Vote out Henry"]'],
  ]) {
    await run(label, Object.assign({ state, init: noGl, allowConsole: [/409/] }, o), async (page) => {
      let posts = 0;
      await page.route('https://chat.victorio.cloud/**/games/' + gid + '/moves*', (r) => (r.request().method() === 'POST' ? (posts++, r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: REFUSED }) })) : r.fallback()));
      await page.click(open);
      await page.waitForSelector(act, { timeout: 15000 });
      await page.click(act);
      await page.waitForFunction((t) => { const e = document.querySelector('#toast'); return !!e && !e.hidden && e.textContent.includes(t); }, REFUSED, { timeout: 10000 }).catch(() => {});
      // on top: the viewer covers the page, and a toast under it was never seen
      const out = { posts, toast: await page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent)).catch(() => ''), onTop: await page.$eval('#toast', (e) => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === e; }).catch(() => false) };
      await shot(page, label + '.png');
      if (posts !== 1 || !out.toast.includes(REFUSED) || !out.onTop) throw new Error('the refusal shows as a toast, over the arena: ' + JSON.stringify(out));
      return out;
    });
  }
  for (const [label, o] of [['no-webgl-fourinarow-shot', {}], ['no-webgl-fourinarow-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true }, init: noGl }, o), async (page) => {
      await page.waitForSelector('.game-card.kind-fourinarow', { timeout: 10000 });
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer .c4-flat .c4-grid', { timeout: 10000 });
      await settle(page);
      await shot(page, label + '.png');
    });
  }
  /* Sketch & Guess without WebGL: the guesser sees the drawing over the
     guess box (the scene was the only place it showed). */
  for (const [label, o] of [['no-webgl-sketch-guess', {}], ['no-webgl-sketch-guess-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { sg: true }, init: noGl }, o), async (page, S) => {
      await page.waitForSelector('.game-card.kind-sketch', { timeout: 10000 });
      await page.click('.game-card.kind-sketch');
      await page.waitForSelector('#viewer .no-3d .arena3d-status', { timeout: 10000 });
      await settle(page);
      const out = await page.evaluate((url) => {
        const img = [...document.querySelectorAll('#viewer img')].find((i) => i.getAttribute('src') === url && /round 2/.test(i.alt));
        const f = document.querySelector('#viewer .sg-in');
        return { img: img ? img.alt : '', w: img ? Math.round(img.getBoundingClientRect().width) : 0, guess: !!f, above: !!(img && f && img.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) };
      }, S.sg.image.url);
      await shot(page, label + '.png');
      if (!out.img || out.w < 200) throw new Error('the drawing being guessed is shown, large: ' + JSON.stringify(out));
      if (!out.guess || !out.above) throw new Error('the drawing sits above the guess box: ' + JSON.stringify(out));
      return out;
    });
  }
  /* Letter Grid without WebGL: the grid as tiles; a tap traces the word
     as in the scene, and Send sends the word with its cells. */
  for (const [label, o] of [['no-webgl-lettergrid', {}], ['no-webgl-lettergrid-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { lg: true }, init: noGl }, o), async (page, S, calls) => {
      await page.waitForSelector('.game-card.kind-lettergrid', { timeout: 10000 });
      await page.click('.game-card.kind-lettergrid');
      await page.waitForSelector('#viewer .lg-mini.big button.lg-mini-cell', { timeout: 10000 });
      const out = { tiles: await page.$$eval('#viewer .lg-mini.big button.lg-mini-cell', (t) => t.length) };
      if (out.tiles !== 25) throw new Error('the 5 by 5 grid as tiles: ' + out.tiles);
      for (const at of ['B1', 'C1', 'D1']) await page.click('#viewer .lg-mini.big button[aria-label$=" at ' + at + '"], #viewer .lg-mini.big button[aria-label*=" at ' + at + ',"]');
      out.word = await page.$eval('#viewer .lg-word', (f) => f.value);
      out.lit = await page.$$eval('#viewer .lg-mini.big .lg-mini-cell.on', (t) => t.length);
      await shot(page, label + '.png');
      if (out.word !== 'TON' || out.lit !== 3) throw new Error('three taps trace TON and light its path: ' + JSON.stringify(out));
      await page.click('#viewer .lg-send');
      await settle(page);
      out.move = calls.filter((c) => /\/games\/34\/moves/.test(c)).pop() || '';
      if (!/"dir":"ton B1 C1 D1"/.test(out.move)) throw new Error('the word goes out with its cells: ' + out.move);
      return out;
    });
  }
  /* Keyboard play in the 3D arena: the frame takes focus, arrow keys
     aim from the centre cell (E5), Enter fires through the same move
     call a tap makes, and the live region speaks each step. */
  await run('battleship-3d-keyboard', { state: { bsPlay: true } }, async (page, S, calls) => {
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer .arena3d-frame[tabindex="0"]', { timeout: 20000 });
    await page.focus('#viewer .arena3d-frame');
    await page.keyboard.press('ArrowRight');
    const aimed = await page.$eval('#viewer .arena3d-frame .sr-only', e => e.textContent);
    if (!/^F5, /.test(aimed)) throw new Error('ArrowRight from E5 should aim at F5, said: ' + aimed);
    const before = calls.length;
    await page.keyboard.press('Enter');
    await settle(page);
    const moves = calls.slice(before).filter((c) => /\/games\/6\/moves/.test(c));
    if (!moves.length || !/"F5"/.test(moves[0])) throw new Error('Enter should fire at F5, calls: ' + JSON.stringify(moves));
    return { aimed, fired: moves[0] };
  });
  /* Phone (touch, 390 px): the 3D arena shows one ocean - the enemy's
     on your turn - and a tap only aims; the Fire button fires. */
  await run('battleship-3d-phone-aim-fire', { state: { bsPlay: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page, S, calls) => {
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.tap('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    await settle(page);
    const swap = await page.$$eval('#viewer .arena3d-swap button', (bs) => bs.map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')));
    if (swap.length !== 2 || !/\*$/.test(swap[1] || '')) throw new Error('the enemy ocean should be the one shown on your turn: ' + JSON.stringify(swap));
    const box = await (await page.$('#viewer .lc-3d-host canvas')).boundingBox();
    const before = calls.length;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.55);
    await settle(page);
    if (calls.slice(before).some((c) => /\/moves/.test(c))) throw new Error('a tap must aim, not fire');
    const fireText = await page.$eval('#viewer .arena3d-fire', (e) => e.textContent).catch(() => null);
    if (!fireText || !/^Fire at [A-J]\d+$/.test(fireText)) throw new Error('a tap should offer a Fire button, got ' + fireText);
    await page.tap('#viewer .arena3d-fire');
    await settle(page);
    const moves = calls.slice(before).filter((c) => /\/games\/6\/moves/.test(c));
    const cell = fireText.slice(8);
    if (moves.length !== 1 || moves[0].indexOf('"' + cell + '"') < 0) throw new Error('Fire should send one move at ' + cell + ': ' + JSON.stringify(moves));
    await shot(page, 'bs-3d-phone-aimed.png');
    return { swap, fired: moves[0] };
  });
  // Touch screens: the page owns touch until Move is on (two-finger camera
  // gestures are unreliable - a drifting first finger hands the gesture to
  // the browser, which scrolls or, on iOS, zooms the page).
  await run('arena-3d-phone-move-mode', { state: { bsPlay: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => {
    await page.waitForSelector('.game-card .bs-minis', { timeout: 10000 });
    await page.tap('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    const ta = () => page.$eval('#viewer .lc-3d-host canvas', (e) => getComputedStyle(e).touchAction);
    const btn = () => page.$eval('#viewer .arena3d-move', (e) => e.getAttribute('aria-pressed') + ' ' + e.textContent.trim());
    const before = { btn: await btn(), ta: await ta() };
    if (!/^false .*Move$/.test(before.btn) || before.ta !== 'pan-y') throw new Error('Move should start off with the page owning touch: ' + JSON.stringify(before));
    await page.tap('#viewer .arena3d-move');
    await settle(page);
    const on = { btn: await btn(), ta: await ta() };
    if (!/^true .*Done$/.test(on.btn) || on.ta !== 'none') throw new Error('Move should hand touch to the scene: ' + JSON.stringify(on));
    await page.tap('#viewer .arena3d-move');
    await settle(page);
    const off = { btn: await btn(), ta: await ta() };
    if (!/^false/.test(off.btn) || off.ta !== 'pan-y') throw new Error('Done should hand touch back to the page: ' + JSON.stringify(off));
    return { before, on, off };
  });
  /* Fleet placement in 3D: your ocean in the scene, the next hull a
     hologram, no grid. The keyboard moves the bow (from E5), R rotates,
     Enter lays the hull, Backspace takes it back; a hull that runs off the
     board is refused with the reason. The page keeps the status line and
     the buttons. */
  await run('battleship-setup', { state: { bsSetup: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 10000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer .arena3d-frame[tabindex="0"]', { timeout: 20000 });
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    out.grids = await page.$$eval('#viewer .bs-grid', els => els.length);
    out.label = await page.$eval('#viewer .arena3d-frame', e => e.getAttribute('aria-label'));
    if (out.grids !== 0) throw new Error('no placement grid with WebGL, got ' + out.grids);
    if (!/place your fleet/.test(out.label) || !/R rotates/.test(out.label)) throw new Error('the frame explains placement: ' + out.label);
    const say = () => page.$eval('#viewer .arena3d-frame .sr-only', e => e.textContent);
    // the placement line (the turn banner carries a statusline too)
    const status = () => page.$$eval('#viewer .duel-statusline', els => (els.map((e) => e.textContent).find((t) => /Next hull|Fleet complete/.test(t)) || ''));
    const press = async (k, n = 1) => { for (let i = 0; i < n; i++) await page.keyboard.press(k); };
    let cur = null;
    const go = async (label) => {
      const c = label.charCodeAt(0) - 65, r = parseInt(label.slice(1), 10) - 1;
      if (!cur) { await press('ArrowRight'); await press('ArrowLeft'); cur = { c: 4, r: 4 }; }
      await press(c > cur.c ? 'ArrowRight' : 'ArrowLeft', Math.abs(c - cur.c));
      await press(r > cur.r ? 'ArrowDown' : 'ArrowUp', Math.abs(r - cur.r));
      cur = { c, r };
    };
    await page.focus('#viewer .arena3d-frame');
    await press('r');
    await settle(page);
    out.rotated = await status();
    if (!/5-ship, lying vertical/.test(out.rotated)) throw new Error('R turns the next hull vertical: ' + out.rotated);
    await go('A8');
    out.offSay = await say();
    if (!/^A8: your 5-ship, vertical, runs off the board/.test(out.offSay)) throw new Error('aiming off the board says why: ' + out.offSay);
    await press('Enter');
    await settle(page);
    out.note = await page.$eval('#viewer .lc-note', e => e.textContent);
    if (!/runs off the board/.test(out.note)) throw new Error('off-board placement should be refused: ' + out.note);
    out.steps = [];
    for (const [cell, turn] of [['B2', true], ['H4', true], ['A9', true], ['J1', true], ['E5', false]]) {
      if (turn) { await press('r'); await settle(page); }
      await go(cell);
      await press('Enter');
      await settle(page);
      out.steps.push((await status()).replace(/\s+/g, ' ').slice(0, 40) + ' | ' + (await say()));  // the line and what the scene said
    }
    out.focusKept = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#viewer .arena3d-frame'));
    if (!out.focusKept) throw new Error('the scene keeps focus across repaints');
    if (!/Fleet complete/.test(out.steps[4])) throw new Error('the full fleet should be down, steps ' + JSON.stringify(out.steps));
    await page.waitForTimeout(600);
    await shot(page, 'bs-setup-placed.png');
    await press('Backspace');
    await settle(page);
    out.undone = await status();
    if (!/2-ship/.test(out.undone)) throw new Error('Backspace takes the last hull back: ' + out.undone);
    await go('E5');
    await press('Enter');
    await settle(page);
    await page.click('#viewer .duel-pad .duel-btn:nth-child(4)');
    await settle(page);
    out.moveCall = calls.filter(c => c.includes('/games/8/moves')).pop() || '';
    if (!/"dir":"B2H,H4V,A9H,J1V,E5V"/.test(out.moveCall)) throw new Error('placement call wrong: ' + out.moveCall);
    return out;
  });
  /* Phone: a tap aims the bow (the hologram shows where the hull lies),
     the Place button lays it. */
  await run('battleship-setup-mobile', { state: { bsSetup: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 10000 });
    await page.tap('.game-card');
    await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 30000 });
    await settle(page);
    out.tip = await page.$eval('#viewer .arena3d-tip', (e) => e.textContent).catch(() => null);
    if (out.tip !== 'Tap a cell for the bow') throw new Error('the tip asks for a bow cell: ' + out.tip);
    const box = await (await page.$('#viewer .lc-3d-host canvas')).boundingBox();
    await page.touchscreen.tap(box.x + box.width * 0.35, box.y + box.height * 0.5);
    await settle(page);
    out.place = await page.$eval('#viewer .arena3d-place', (e) => e.textContent).catch(() => null);
    if (!out.place || !/^Place 5-ship at [A-J]\d+$/.test(out.place)) throw new Error('a tap offers a Place button, got ' + out.place);
    await shot(page, 'bs-setup-mobile-aimed.png');
    await page.tap('#viewer .arena3d-place');
    await settle(page);
    out.status = await page.$$eval('#viewer .duel-statusline', els => (els.map((e) => e.textContent).find((t) => /Next hull|Fleet complete/.test(t)) || ''));
    if (!/4-ship/.test(out.status)) throw new Error('after the 5-ship the 4-ship is next: ' + out.status);
    if (calls.some((c) => /\/games\/8\/moves/.test(c))) throw new Error('placing a hull sends nothing until the fleet goes out');
    return out;
  });
  done('battleship');
})();
