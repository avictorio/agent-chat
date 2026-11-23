// UI scenarios: the Games tab, New game, the guide, the chat cards, the Duel and Light Cycles.
// Run alone: node -r ./tests/system-chromium.js tests/ui/games.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { settle, clockNow, done, ngOpen, run, shot } = require('./harness');

(async () => {
  await run('duel-card', { state: { duel: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 10000 });
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
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 10000 });
    out.tiles = await page.$$eval('#viewer .duel-tile .t-beats', els => els.map(e => e.textContent));
    out.status = await page.$eval('#viewer .duel-statusline', e => e.textContent);
    out.verdict = await page.$eval('#viewer .duel-verdict', e => e.textContent);
    if (JSON.stringify(out.tiles) !== JSON.stringify(['crushes scissors', 'covers rock', 'cut paper'])) throw new Error('tile microcopy wrong: ' + JSON.stringify(out.tiles));
    if (!/your throw decides the round/.test(out.status)) throw new Error('status line wrong: ' + out.status);
    if (!/CLASH/.test(out.verdict)) throw new Error('verdict banner should name the clash: ' + out.verdict);
    // the arrival ends with its name card: under load the stage can still
    // be dark when the iris has gone, so let the card clear first
    await page.waitForFunction(() => !document.querySelector('#viewer .impact-title'), null, { timeout: 15000 }).catch(() => {});
    await shot(page, 'duel-arena.png');
    await page.click('#viewer .duel-tile:nth-child(3)');
    await page.waitForFunction(() => document.querySelector('#viewer .duel-tile.queued'), null, { timeout: 10000 });
    out.moveCall = calls.filter(c => c.includes('/games/2/moves')).pop() || '';
    if (!/"dir":"scissors"/.test(out.moveCall)) throw new Error('move call wrong: ' + out.moveCall);
    await shot(page, 'duel-arena-queued.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    return out;
  });
  /* The Games tab: Live · History · Standings tabs. Live opens first when
     matches wait on you (badge = how many); History files ended matches as
     compact rows under day groups, filterable by game; Standings carries
     the room record. Arrow keys move between tabs; a history row opens its
     arena; Rematch re-creates the match. */
  await run('games-tab', { state: { bs: true, bsPlay: true, duel: true, game: true }, init: () => { try { localStorage.setItem('ac-games-tab', 'history'); } catch {} } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 10000 });
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#view-games .gm-row', { timeout: 10000 });
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
    await page.waitForSelector('#view-games .gm-tip.on', { timeout: 10000 });
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
    await page.waitForSelector('#view-games .gm-hrow', { timeout: 10000 });
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
    await page.waitForSelector('#view-games .gm-hrow', { timeout: 10000 });
    await page.click('#view-games .gm-hrow:first-of-type .gm-hrow-open');
    await page.waitForSelector('#viewer:not([hidden]) .bs-3d-host', { timeout: 10000 });
    out.arena = await page.$$eval('#viewer .bs-3d-host', els => els.length);
    out.arenaWinner = await page.$eval('#viewer .game-winner', e => e.textContent);
    if (out.arena !== 1) throw new Error('tapping a history row should open its arena (the 3D scene), got ' + out.arena);
    if (!/Ada/.test(out.arenaWinner)) throw new Error('the arena should carry the winner banner: ' + out.arenaWinner);
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    out.backOn = await page.$eval('#view-games [role="tab"][aria-selected="true"]', e => e.textContent);
    if (!/^History/.test(out.backOn)) throw new Error('coming back from an arena should keep the tab you chose, got ' + out.backOn);
    await page.click('#view-games .gm-hrow:first-of-type .gm-hrow-rematch');
    await page.waitForSelector('#viewer:not([hidden])', { timeout: 10000 });
    await settle(page);
    out.rematchCall = calls.filter(c => c.includes('POST /api/rooms/demo/games ')).pop() || '';
    if (!/"game":"battleship"/.test(out.rematchCall) || !/"players":\["Ada","Henry"\]/.test(out.rematchCall)) throw new Error('row rematch should re-create the same match: ' + out.rematchCall);
    out.lobby = await page.$eval('#viewer', e => e.textContent);
    if (!/Lobby/.test(out.lobby)) throw new Error('the rematch should open in its lobby: ' + out.lobby.slice(0, 200));
    return out;
  });
  await run('games-tab-mobile-dark', { state: { bs: true, game: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card', { timeout: 10000 });
    await page.click('#menu');
    await settle(page);
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#view-games .gm-row', { timeout: 10000 });
    out.rows = await page.$$eval('#view-games .gm-row', els => els.length);
    if (out.rows !== 2) throw new Error('the mobile Live tab should list the two live matches, got ' + out.rows);
    // a long press on the chime explains it and does not toggle it
    const cb = await (await page.$('#view-games .gm-chime-btn')).boundingBox();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 }] });
    // keep the finger down until the hold registers (the tip opens), then
    // lift: a fixed hold raced the app's 450 ms timer, which runs late
    // when the 3D scenes load the machine, so the lift could come first
    // and count as a tap
    await page.waitForFunction(() => document.querySelector('#view-games .gm-tip.on'), null, { timeout: 5000 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    out.hold = await page.$eval('#view-games .gm-chime-btn', e => e.getAttribute('aria-pressed')) + '|' + await page.$eval('#view-games .gm-tip', e => e.classList.contains('on') + ':' + e.textContent.slice(0, 15));
    if (out.hold !== 'true|true:Your-move chime') throw new Error('holding the chime should show what it does without toggling it: ' + out.hold);
    await settle(page);
    await shot(page, 'games-tab-mobile-chime-tip.png');
    out.tabH = await page.$eval('#view-games [role="tab"]', e => e.getBoundingClientRect().height);
    if (out.tabH < 44) throw new Error('tabs should be at least 44px tall on touch, got ' + out.tabH);
    await page.waitForTimeout(700);
    await shot(page, 'games-tab-mobile-dark.png');
    await page.tap('#view-games [role="tab"]:has-text("History")');
    await page.waitForSelector('#view-games .gm-hrow', { timeout: 10000 });
    out.hrows = await page.$$eval('#view-games .gm-hrow', els => els.length);
    if (out.hrows !== 2) throw new Error('mobile History should list two ended matches, got ' + out.hrows);
    out.overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (out.overflow > 0) throw new Error('the history should not scroll the page sideways: ' + out.overflow);
    await shot(page, 'games-tab-mobile-history.png');
    return out;
  });
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
    await settle(page);
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
    await settle(page);
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
    await page.click('#menu'); await settle(page);
    await page.click('.tab[data-tab="games"]'); await settle(page);
    await page.click('#view-games .gm-start-btn');
    await page.waitForSelector('#newGameDlg[open]', { timeout: 10000 });
    await page.waitForTimeout(200);
    await shot(page, 'new-game-mobile.png');
    await page.click('#newGameDlg .ng-game[data-game="duel"]');
    await settle(page);
    out.startDisabledAtOne = await page.$eval('#ngStart', e => e.disabled);
    // even with How to play opened, Start stays on screen (pinned to the bottom)
    await page.click('#newGameDlg .ng-howto > summary');
    await settle(page);
    out.startOnScreen = await page.$eval('#ngStart', (b) => { const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
    await shot(page, 'new-game-mobile-setup.png');
    if (!out.startDisabledAtOne) throw new Error('duel must not start with 1 player');
    if (!out.startOnScreen) throw new Error('Start must stay on screen while How to play is open');
    return out;
  });
  // The Guide tab lists every game; Start in a game's entry opens that
  // game's setup directly. The ? in an arena's header opens How to play
  // for that game, and Escape closes the sheet but not the arena.
  await run('games-guide-and-help', { state: { game: true } }, async (page) => {
    const out = {};
    await page.click('.tab[data-tab="games"]');
    await page.waitForSelector('#gm-tab-guide', { timeout: 10000 });
    await page.click('#gm-tab-guide');
    out.guide = await page.$$eval('.gm-guide', (ds) => ds.map((d) => d.getAttribute('data-game')));
    await page.click('.gm-guide[data-game="battleship"] > summary');
    out.rulesShown = await page.$eval('.gm-guide[data-game="battleship"] .howto', (h) => /Sink every enemy ship/.test(h.textContent));
    await page.click('.gm-guide[data-game="battleship"] .btn');
    await page.waitForSelector('#newGameDlg[open]', { timeout: 10000 });
    out.setupFromGuide = await page.$eval('#newGameDlg [data-setup]', (e) => e.getAttribute('data-setup'));
    await page.keyboard.press('Escape');
    await settle(page);
    await page.click('#gm-tab-live');
    await page.click('.gm-row');
    await page.waitForSelector('#viewerHelp', { timeout: 10000 });
    await page.click('#viewerHelp');
    await page.waitForSelector('#gameHelpDlg[open]', { timeout: 10000 });
    out.helpTitle = await page.$eval('#ghTitle', (e) => e.textContent);
    await shot(page, 'arena-help.png');
    await page.keyboard.press('Escape');
    await settle(page);
    out.helpClosed = await page.$eval('#gameHelpDlg', (d) => !d.open);
    out.arenaStillOpen = await page.$eval('#viewer', (v) => !v.hidden);
    if (out.guide.join(',') !== 'duel,frontlines,coderace,trust,auction,liarsdice,twotruths,corpse,twenty,werewolf,lettergrid,trivia,sketch,fourinarow,lightcycles,battleship') throw new Error('guide must list every game: ' + out.guide);
    if (!out.rulesShown) throw new Error('an open guide entry shows the rules');
    if (out.setupFromGuide !== 'battleship') throw new Error('Start in the guide opens that game\'s setup: ' + out.setupFromGuide);
    if (!/How to play Light Cycles/.test(out.helpTitle)) throw new Error('the ? opens this game\'s rules: ' + out.helpTitle);
    if (!out.helpClosed || !out.arenaStillOpen) throw new Error('Escape closes the sheet and leaves the arena: ' + JSON.stringify(out));
    return out;
  });
  await run('game-card', { state: { game: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .lc-svg', { timeout: 10000 });
    out.trailCells = await page.$$eval('.game-card .lc-svg rect', els => els.length);
    out.drawLines = await page.$$eval('.game-card .lc-draw', els => els.length);
    if (out.drawLines < 2) throw new Error('each living rider should carry a draw-in segment, got ' + out.drawLines);
    out.cardMeta = await page.$eval('.game-card .art-size', e => e.textContent);
    if (out.trailCells < 10) throw new Error('board should render trails and heads, got ' + out.trailCells + ' rects');
    if (!/Tick 3/.test(out.cardMeta)) throw new Error('card meta wrong: ' + out.cardMeta);
    await shot(page, 'game-card.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lc-pad', { timeout: 10000 });
    out.viewerTitle = await page.$eval('#viewerTitle', e => e.textContent);
    out.padBtns = await page.$$eval('#viewer .lc-btn', els => els.map(b => b.getAttribute('aria-label') + ':' + (b.disabled ? 'off' : 'on')));
    if (!/Light Cycles #1/.test(out.viewerTitle)) throw new Error('viewer title wrong: ' + out.viewerTitle);
    if (!out.padBtns.includes('Steer up:off')) throw new Error('reverse (up, heading down) must be disabled: ' + JSON.stringify(out.padBtns));
    if (!out.padBtns.includes('Steer left:on')) throw new Error('left must be playable: ' + JSON.stringify(out.padBtns));
    await shot(page, 'game-arena.png');
    await page.click('#viewer .lc-btn[aria-label="Steer left"]');
    await page.waitForFunction(() => document.querySelector('#viewer .lc-note').textContent.includes('Queued: left'), null, { timeout: 10000 });
    out.moveCall = calls.filter(c => c.includes('/games/1/moves')).pop() || '';
    if (!/"dir":"left"/.test(out.moveCall)) throw new Error('move call wrong: ' + out.moveCall);
    // the app asks for the whole move_log (agents get the last ticks only):
    // the replay, the catch-up and History rebuild every tick from it
    out.fetchCall = calls.filter(c => /^GET \/api\/rooms\/demo\/games\/1[?]/.test(c)).pop() || '';
    if (!/[?]log=full$/.test(out.fetchCall) || !/\/games\/1\/moves[?]log=full /.test(out.moveCall)) throw new Error('the game fetch and the move should ask for log=full: ' + out.fetchCall + ' | ' + out.moveCall);
    await shot(page, 'game-arena-queued.png');
    await page.click('#viewer .arena-tabs .arena-tab:nth-child(2)');
    await page.waitForSelector('#viewer .hist-row', { timeout: 10000 });
    out.histRows = await page.$$eval('#viewer .hist-row', els => els.length);
    out.histText = await page.$eval('#viewer .hist-list', e => e.textContent);
    if (out.histRows !== 3) throw new Error('cycles history should render the creation note plus one row per tick, got ' + out.histRows);
    if (!/Tick 1/.test(out.histText) || !/clock/.test(out.histText)) throw new Error('cycles history should show moves with clock-default tags: ' + out.histText.slice(0, 200));
    await shot(page, 'game-arena-history.png');
    await page.click('#viewer .arena-tabs .arena-tab:nth-child(1)');
    await page.waitForSelector('#viewer .lc-pad', { timeout: 10000 });
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    return out;
  });
  await run('game-card-mobile', { state: { game: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.game-card .lc-svg', { timeout: 10000 });
    await shot(page, 'game-mobile-card.png');
    await page.tap('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lc-pad', { timeout: 10000 });
    await page.waitForTimeout(300);
    await shot(page, 'game-mobile-arena.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    return { ok: true };
  });
  /* Light Cycles 3D: the arena opens with a tag over every cycle ("You" for
     the viewer), Zones toggles the floor tint, and Chase rides behind the
     viewer's cycle until Reset view. */
  await run('lc-3d-arena', { state: { game: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .lc-svg', { timeout: 10000 });
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
  /* Light Cycles 3D replay: a finished match offers Replay race; it plays
     the race from the start line with a tick counter and End, and hands
     back the button when it's over. */
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
    await page.waitForSelector('.game-card', { timeout: 10000 });
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lc-3d-host canvas', { timeout: 20000 });
    await page.waitForSelector('#viewer .lc-replay-btn', { timeout: 30000 });
    await page.click('#viewer .lc-replay-btn');
    // generous: three 3D files rendering at once (run.js) can starve this page
    await page.waitForSelector('#viewer .lc-replay', { timeout: 10000 });
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
  // The lobby: a duel card waits on the viewer's accept, with the
  // buttons right on the card; accepting starts the match in place
  // (no arena trip), and the arena then offers throws as usual.
  await run('duel-lobby', { state: { duelLobby: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 10000 });
    out.cardMeta = await page.$eval('.game-card .art-size', e => e.textContent);
    if (!/Lobby/.test(out.cardMeta) || !/waiting on Anthony/.test(out.cardMeta)) throw new Error('lobby card meta wrong: ' + out.cardMeta);
    await page.waitForSelector('.game-card .game-lobby-actions .duel-btn', { timeout: 10000 });
    await shot(page, 'duel-lobby-card.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .lobby-panel .duel-btn', { timeout: 10000 });
    out.arenaLine = await page.$eval('#viewer .lobby-panel .duel-statusline', e => e.textContent);
    if (!/Accept to take your seat/.test(out.arenaLine)) throw new Error('arena lobby line wrong: ' + out.arenaLine);
    await shot(page, 'duel-lobby-arena-panel.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    await page.click('.game-card .game-lobby-actions .duel-btn:first-child');
    await page.waitForFunction(() => document.querySelector('.game-card .art-size').textContent.includes('Round 1'), null, { timeout: 10000 });
    out.acceptCall = calls.filter(c => c.includes('/games/3/accept')).pop() || '';
    if (!out.acceptCall) throw new Error('accept call missing: ' + JSON.stringify(calls.slice(-4)));
    out.viewerHidden = await page.$eval('#viewer', e => e.hidden);
    if (!out.viewerHidden) throw new Error('accept on the card must not open the arena');
    await shot(page, 'duel-lobby-accepted.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 10000 });
    await shot(page, 'duel-lobby-arena.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    return out;
  });
  await run('duel-lobby-mobile', { state: { duelLobby: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.game-card .game-lobby-actions .duel-btn', { timeout: 10000 });
    await page.waitForTimeout(200);
    await shot(page, 'duel-lobby-mobile-card.png');
    return { ok: true };
  });
  await run('duel-finished', { state: { duelDone: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 10000 });
    out.cardMeta = await page.$eval('.game-card .art-size', e => e.textContent);
    if (out.cardMeta !== 'Final · 3–2 · 7 rounds') throw new Error('finished card meta should be the standard record line: ' + out.cardMeta);
    out.cardWinner = await page.$eval('.game-card .game-winner', e => e.textContent);
    if (!/🏆/.test(out.cardWinner) || !/Anthony/.test(out.cardWinner) || !/3–2/.test(out.cardWinner)) throw new Error('finished card should carry the winner banner: ' + out.cardWinner);
    out.cardRematch = await page.$$eval('.game-card button', els => els.map(b => b.textContent).filter(t => /Rematch/.test(t)).length);
    if (out.cardRematch !== 1) throw new Error('finished card should offer one Rematch, got ' + out.cardRematch);
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-verdict', { timeout: 10000 });
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
    await page.waitForSelector('#viewer .hist-row', { timeout: 10000 });
    out.histRows = await page.$$eval('#viewer .hist-row', els => els.length);
    out.histText = await page.$eval('#viewer .hist-list', e => e.textContent);
    if (out.histRows !== 7) throw new Error('history should render one row per round, got ' + out.histRows);
    if (!/takes it/.test(out.histText) || !/Tie/.test(out.histText)) throw new Error('history rows should carry outcome pills: ' + out.histText.slice(0, 200));
    await shot(page, 'duel-finished-history.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    return out;
  });
  await run('duel-mobile', { state: { duel: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.game-card .duel-board', { timeout: 10000 });
    await shot(page, 'duel-mobile-card.png');
    await page.tap('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 10000 });
    await page.waitForTimeout(300);
    await shot(page, 'duel-mobile-arena.png');
    await page.tap('#viewer .arena-tabs .arena-tab:nth-child(2)');
    await page.waitForSelector('#viewer .hist-row', { timeout: 10000 });
    const rows = await page.$$eval('#viewer .hist-row', els => els.length);
    if (rows !== 3) throw new Error('mobile history should render one row per round, got ' + rows);
    await page.waitForTimeout(200);
    await shot(page, 'duel-mobile-history.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    return { ok: true };
  });

  // A spectator's Duel card when the match finishes: the frame that ends
  // it carries no rounds, so the store fetches the full state once and
  // the card's face-off shows the finishing throws, not the round before.
  for (const [label, o] of [['duel-spectator-finish', {}], ['duel-spectator-finish-mobile', { w: 390, h: 844, touch: true }]]) {
    await run(label, Object.assign({ state: { duel: true } }, o), async (page, S, calls) => {
      // the duel is Ada against Henry; the signed-in Anthony watches
      const swap = (x) => JSON.parse(JSON.stringify(x).replace(/Anthony/g, 'Henry'));
      S.duel = swap(S.duel);
      S.duel.you = { playing: false };
      const msg = S.msgs.find((m) => m.id === 10);
      msg.game = swap(msg.game);
      msg.text = msg.text.replace(/Anthony/g, 'Henry');
      let release;
      const gate = new Promise((r) => (release = r));
      let streams = 0;
      await page.route('**/stream*', async (route) => {
        streams++;
        if (streams > 1) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 600000\n\n' });
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: await gate });
      });
      await page.reload();
      await settle(page);
      await page.waitForSelector('.game-card .duel-faceoff-line', { timeout: 10000 });
      const before = await page.$eval('.game-card .duel-faceoff-line', (e) => e.textContent);
      // the server finishes it: round 4, Ada's paper over Henry's rock
      const at = clockNow();
      S.duel.rounds.push({ n: 4, throws: { Ada: 'paper', Henry: 'rock' }, winner: 'Ada', at, throws_at: { Ada: at, Henry: at } });
      Object.assign(S.duel, { status: 'finished', winner: 'Ada', round: 4, score: { Ada: 3, Henry: 0 }, deadline: null });
      S.duel.players.forEach((p) => { p.wins = S.duel.score[p.name]; p.thrown = false; });
      // the frame is the public summary: no rounds, log, h2h or you
      const pub = JSON.parse(JSON.stringify(S.duel));
      for (const k of ['rounds', 'log', 'you', 'awaiting', 'awaiting_accept', 'h2h', 'how_to_play']) delete pub[k];
      release('retry: 600000\n\nevent: game\ndata: ' + JSON.stringify({ type: 'game', room: 'demo', from: 'Ada', kind: 'agent', targets: [], game: pub }) + '\n\n');
      // well inside the 20 s card poll, which skips finished matches anyway
      await page.waitForFunction(() => /🪨/.test((document.querySelector('.game-card .duel-faceoff-line') || {}).textContent || ''), null, { timeout: 8000 })
        .catch(() => { throw new Error('the card must show the finishing throws (paper over rock); still: ' + before); });
      const out = { before, after: await page.$eval('.game-card .duel-faceoff-line', (e) => e.textContent) };
      out.gets = calls.filter((c) => /GET \/api\/rooms\/demo\/games\/2(\?|$)/.test(c)).length;
      await page.waitForTimeout(300);
      await shot(page, label + '.png');
      return out;
    });
  }

  // Werewolf is won by a side (winner null, the seats in winners): History
  // names the side with your Won/Lost, and Standings counts its streaks.
  for (const [label, o] of [['games-history-team', {}], ['games-history-team-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ww: true }, init: () => { try { localStorage.setItem('ac-games-tab', 'history'); } catch { /* storage off */ } } }, o), async (page, S) => {
      const t = clockNow();
      const mk = (id, ago, side) => Object.assign({}, S.ww, { id, status: 'finished', phase: null, side, winner: null, draw: false,
        winners: side === 'village' ? ['Ada', 'Henry', 'Anthony', 'Jax'] : ['Ivy'], places: ['Ada', 'Henry', 'Anthony', 'Jax', 'Ivy'], deadline: null, created: t - ago - 3600e3, ended: t - ago,
        players: S.ww.players.map((p) => Object.assign({}, p, { role: p.name === 'Ivy' ? 'werewolf' : 'villager' })) });
      const games = [mk(42, 60e3, 'village'), mk(41, 3600e3, 'village'), mk(40, 7200e3, 'wolves')];
      await page.route(/\/api\/rooms\/demo\/games(\?.*)?$/, (r) => r.request().method() === 'GET'
        ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ room: 'demo', games, record: { werewolf: [{ name: 'Ada', hex: '#22d3ee', w: 2, l: 1 }, { name: 'Anthony', hex: '#f472b6', w: 2, l: 1 }, { name: 'Ivy', hex: '#4ade80', w: 1, l: 2 }] } }) })
        : r.fallback());
      if (o.w) {
        await page.click('#menu');
        await settle(page);
      }
      await page.click('.tab[data-tab="games"]');
      await page.click('#view-games [role="tab"]:has-text("History")');
      await page.waitForSelector('#view-games .gm-hrow', { timeout: 10000 });
      await settle(page);
      const rows = await page.$$eval('#view-games .gm-hrow-open', (els) => els.map((e) => ({ who: e.querySelector('.gm-hrow-who').textContent, label: e.getAttribute('aria-label'), chip: (e.querySelector('.gm-hrow-me') || {}).textContent || null })));
      await shot(page, label + '.png');
      await page.click('#view-games [role="tab"]:has-text("Standings")');
      await settle(page);
      const streaks = await page.$$eval('#view-games .gm-rec-streak', (els) => els.map((e) => e.textContent.trim()));
      await shot(page, label + '-standings.png');
      if (rows.length !== 3) throw new Error('three finished matches: ' + JSON.stringify(rows));
      if (!/The village wins/.test(rows[0].who) || !/The wolves win/.test(rows[2].who)) throw new Error('History names the winning side: ' + JSON.stringify(rows));
      if (rows[0].chip !== 'Won' || rows[2].chip !== 'Lost') throw new Error('your own result, from winners: ' + JSON.stringify(rows));
      if (!/The village wins, against Ivy\./.test(rows[0].label)) throw new Error('the field splits by side: ' + rows[0].label);
      if (!streaks.some((x) => /W2/.test(x)) || !streaks.some((x) => /L2/.test(x))) throw new Error('two village wins in a row are a streak: ' + JSON.stringify(streaks));
      return { rows, streaks };
    });
  }

  done('games');
})();
