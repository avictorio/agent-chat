// UI scenarios: each game's arena: its controls, its moves and its finished state, desktop and phone.
// Run alone: node -r ./tests/system-chromium.js tests/ui/arenas.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { ARENA_KIDS, settle, done, noGl, now, run, shot } = require('./harness');

(async () => {
  // Frontlines: the card shows the score and the last round on a compact
  // field; without WebGL the arena shows the field (with WebGL its numbers
  // are in the scene, see frontlines-3d) and the planner. Lock in stays off
  // until the split adds up to 100; Even fills it; the commit sends the split
  // and the planner reads as locked.
  for (const [label, o] of [['frontlines-arena', {}], ['frontlines-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { fl: true }, init: noGl }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .fl-card', { timeout: 10000 });
      out.cardHills = await page.$$eval('.game-card .fl-hill', (h) => h.length);
      out.cardCap = await page.$eval('.game-card .fl-card-cap', (e) => e.textContent);
      await page.click('.game-card');
      await page.waitForSelector('#viewer .fl-plan', { timeout: 10000 });
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
      // the planner is React (ctx.panel): a repaint keeps the half-made split
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .fl-plan', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .fl-left', (e) => e.textContent) + '|' + (await page.$$eval('#viewer .fl-num', (n) => n.map((x) => x.value).join(',')));
      await page.click('#viewer .fl-acts button:nth-child(1)');
      await page.click('#viewer .fl-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/12/moves')).pop() || '';
      out.lockedLabel = await page.$eval('#viewer .fl-go', (b) => b.textContent);
      await shot(page, label + '-locked.png');
      if (out.cardHills !== 5) throw new Error('the card shows the five hills: ' + out.cardHills);
      if (!/Round 2 level/.test(out.cardCap)) throw new Error('the card names the last round: ' + out.cardCap);
      if (!/Round 2 in numbers/.test(out.fieldCap)) throw new Error('the arena shows the last resolved round: ' + out.fieldCap);
      if (out.flags.join(',') !== 'level,Anthony,Ada,level,level') throw new Error('round 2 flags: ' + out.flags);
      if (!out.lockOffAtZero || !out.lockOnAt100) throw new Error('Lock in waits for exactly 100: ' + JSON.stringify(out));
      if (!/All 100 placed/.test(out.left) || !/5 left to place/.test(out.leftAfterNudge)) throw new Error('the troop counter: ' + JSON.stringify(out));
      if (out.kept !== '5 left to place|15,20,20,20,20') throw new Error('a repaint keeps the split: ' + out.kept);
      if (!/"dir":"20,20,20,20,20"/.test(out.moveCall)) throw new Error('the commit sends the split: ' + out.moveCall);
      if (!/Locked in/.test(out.lockedLabel)) throw new Error('the planner reads locked after the commit: ' + out.lockedLabel);
      return out;
    });
  }
  // Code Race: the card shows each racer's latest feedback; without WebGL
  // (with it the lanes are the vault's ledgers, see coderace-3d) the arena
  // puts your lane first with your guesses, a rival's lane shows feedback
  // only (pegs hidden); the palette fills the slots, Guess sends them in
  // order, and the round's guess shows sealed in your lane.
  for (const [label, o] of [['coderace-arena', {}], ['coderace-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true }, init: noGl }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card', { timeout: 10000 });
      out.cardRows = await page.$$eval('.game-card .cr-card-row', (r) => r.map((x) => x.querySelector('.cr-card-name').textContent));
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer .cr-input', { timeout: 10000 });
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
      // the input is React (ctx.panel): a repaint keeps the half-made guess
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .cr-input', { timeout: 10000 });
      out.kept = (await page.$$eval('#viewer .cr-slot .cr-peg', (p) => p.map((x) => x.textContent).join(''))) + '|' + (await page.$eval('#viewer .cr-go', (b) => b.disabled));
      await page.click('#viewer .cr-color[aria-label="Add green"]');
      out.goOn = await page.$eval('#viewer .cr-go', (b) => !b.disabled);
      await page.click('#viewer .cr-go');
      await settle(page);
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
      if (out.kept !== 'RBY|true') throw new Error('a repaint keeps the half-made guess: ' + out.kept);
      if (!/"dir":"R B Y G"/.test(out.moveCall)) throw new Error('the guess goes in order: ' + out.moveCall);
      if (out.sealed !== 'RBYG') throw new Error('the round\'s guess shows sealed in your lane: ' + out.sealed);
      if (!/Your guess · round 3 of 10/.test(out.banner)) throw new Error('the turn banner asks for a guess: ' + out.banner);
      return out;
    });
  }
  // A finished race: the code is shown, the lanes (the no-WebGL view) run
  // in place order with the winner's trophy, and every rival's guess is
  // out in the open.
  for (const [label, o] of [['coderace-done', {}], ['coderace-done-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true, crDone: true }, init: noGl }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card .cr-secret', { timeout: 10000 });
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer .cr-secret', { timeout: 10000 });
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
  // Words (the no-WebGL lanes): rivals' rows are bare coloured tiles; you
  // type the word; a word not in the list is refused with the server's
  // reason; Enter sends.
  for (const [label, o] of [['coderace-words', {}], ['coderace-words-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { cr: true, crWords: true }, init: noGl }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .cr-card', { timeout: 10000 });
      await page.click('.game-card.kind-coderace');
      await page.waitForSelector('#viewer .cr-word', { timeout: 10000 });
      out.myTiles = await page.$$eval('#viewer .cr-lane.mine .cr-row:first-child .cr-tile', (t) => t.map((x) => x.textContent + ':' + x.className.split(' ')[1]).join(','));
      out.rivalLetters = await page.$$eval('#viewer .cr-lane:not(.mine) .cr-tile', (t) => t.map((x) => x.textContent).join(''));
      await page.fill('#viewer .cr-word', 'xqzzt');
      await page.click('#viewer .cr-go');
      await settle(page);
      out.refused = await page.$eval('#viewer .lc-note', (e) => e.textContent);
      await page.fill('#viewer .cr-word', 'crane');
      // the input is React (ctx.panel): a repaint keeps the word being typed
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .cr-word', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .cr-word', (i) => i.value + '|' + document.querySelector('#viewer .cr-go').disabled);
      await page.press('#viewer .cr-word', 'Enter');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/14/moves')).pop() || '';
      out.sealed = await page.$$eval('#viewer .cr-lane.mine .cr-row.sealed .cr-tile', (t) => t.map((x) => x.textContent).join(''));
      await shot(page, label + '.png');
      if (out.myTiles !== 'C:n,R:n,A:g,N:n,E:y') throw new Error('your tiles carry letters and colours: ' + out.myTiles);
      if (out.rivalLetters !== '') throw new Error('rival tiles carry no letters: ' + out.rivalLetters);
      if (!/not in the word list/.test(out.refused)) throw new Error('a word not in the list is refused: ' + out.refused);
      if (out.kept !== 'CRANE|false') throw new Error('a repaint keeps the word being typed: ' + out.kept);
      if (!/"dir":"crane"/.test(out.moveCall)) throw new Error('Enter sends the word: ' + out.moveCall);
      if (out.sealed !== 'CRANE') throw new Error('the sealed guess shows in your lane: ' + out.sealed);
      return out;
    });
  }
  // Four in a Row: the card shows the board; the arena puts the drop buttons
  // under the scene on your turn; a drop lands (the scene counts it) and the
  // turn passes; a finished match names the winner and the result line counts
  // the moves (the board is the scene).
  for (const [label, o] of [['fourinarow-arena', {}], ['fourinarow-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 10000 });
      out.cardDiscs = await page.$$eval('.game-card .c4-disc', (d) => d.length);
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer .c4-drop', { timeout: 10000 });
      out.drops = await page.$$eval('#viewer .c4-drop', (b) => b.filter((x) => !x.disabled).length);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.seats = await page.$eval('#viewer .c4-seats', (e) => e.textContent);
      await shot(page, label + '-turn.png');
      await page.click('#viewer .c4-drop:nth-child(4)');
      await settle(page);
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
  // A match that ends on the clock after its last drop: the replay of that
  // drop says the match was lost on timeouts, not "four in a row" - the drop
  // decided nothing.
  for (const [label, o] of [['fourinarow-forfeit', {}], ['fourinarow-forfeit-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    // the viewer last saw move 5, so opening the arena replays move 6
    await run(label, Object.assign({ state: { c4: true, c4Forfeit: true }, init: () => { try { localStorage.setItem('ac-c4-seen:/r/demo:16', '5'); } catch {} } }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 10000 });
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer .c4-3d-host canvas', { timeout: 20000 });
      // the first card is the arena's welcome; wait for the outcome's
      out.title = await page.waitForFunction(() => { const t = Array.from(document.querySelectorAll('#viewer .impact-title')).map((e) => e.textContent).find((x) => /DEFEAT|VICTORY|WINS|DRAW/.test(x)); return t || false; }, null, { timeout: 20000 }).then((h) => h.jsonValue());
      out.said = await page.waitForFunction(() => { const s = Array.from(document.querySelectorAll('#viewer .sr-only[aria-live]')).map((e) => e.textContent).join(' '); return /drops in column/.test(s) && s; }, null, { timeout: 20000 }).then((h) => h.jsonValue());
      out.meta = await page.$eval('#viewer .lc-meta', (e) => e.textContent);
      out.winner = await page.$eval('#viewer .game-winner', (e) => e.textContent);
      await shot(page, label + '.png');
      if (!/by forfeit/.test(out.winner) || /move 6/.test(out.winner)) throw new Error('the winner banner should say how it was won: ' + out.winner);
      if (!/DEFEAT/.test(out.title) || !/You timed out three times/.test(out.title)) throw new Error('the last drop should title the forfeit: ' + out.title);
      if (/Four in a row/i.test(out.title)) throw new Error('no four was made: ' + out.title);
      if (!/Anthony timed out a third time - Ada wins by forfeit/.test(out.said)) throw new Error('the spoken line should name the forfeit: ' + out.said);
      if (!/Won by forfeit/.test(out.meta)) throw new Error('the record line: ' + out.meta);
      // the History tab: no "four in a row" on the last move either
      await page.click('#viewer .arena-tab:nth-child(2)');
      await page.waitForSelector('#viewer .hist-list .hist-row', { timeout: 10000 });
      out.pills = await page.$$eval('#viewer .hist-list .hist-pill', (els) => els.map((e) => e.textContent));
      if (out.pills.some((t) => /four in a row/i.test(t))) throw new Error('the history should not say four in a row: ' + JSON.stringify(out.pills));
      return out;
    });
  }
  for (const [label, o] of [['fourinarow-done', {}], ['fourinarow-done-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { c4: true, c4Done: true } }, o), async (page) => {
      const out = {};
      await page.waitForSelector('.game-card .c4-grid', { timeout: 10000 });
      await page.click('.game-card.kind-fourinarow');
      await page.waitForSelector('#viewer .game-winner', { timeout: 10000 });
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
  // Sketch & Guess: the artist sees the secret prompt and a sketch pad; Send
  // drawing refuses an empty page, then sends the pad as a PNG data URL (the
  // status line never echoes it); a guesser's card shows the drawing; the
  // arena puts the gallery first, then the guess form, the scores and the
  // last round (the Referee's calls marked).
  await run('sketch-draw', { state: { sg: true, sgDraw: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .sg-card', { timeout: 10000 });
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
    // the pad is React (ctx.panel) drawing gameView's strokes: a repaint
    // keeps the drawing, the pen colour and the eraser
    await page.click('#viewer .sg-tool:has-text("Eraser")');
    await page.click('#viewer .arena-tabs button:nth-child(2)');
    await page.click('#viewer .arena-tabs button:nth-child(1)');
    await page.waitForSelector('#viewer .sg-artist', { timeout: 10000 });
    out.kept = await page.$eval('#viewer .sg-artist', (f) => { const c = f.querySelector('.sg-canvas'); const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < x.length; i += 4) if (x[i] < 200 || x[i + 1] < 200) n++; return n + '|' + f.querySelector('.sg-swatch.on').getAttribute('aria-label') + '|' + f.querySelector('.sg-tool.on').textContent; });
    await page.click('#viewer .sg-tool:has-text("Eraser")');
    out.kept += '|' + (await page.$$eval('#viewer .sg-tool.on', (n) => n.length));
    await page.mouse.move(box.x + 10, box.y + 10);
    await shot(page, 'sketch-draw.png');
    await page.click('#viewer .sg-artist .sg-send');
    out.sending = await page.$eval('#viewer .lc-note', (e) => e.textContent);
    await settle(page);
    out.call = (calls.filter((c) => c.includes('/games/38/moves')).pop() || '').slice(0, 80);
    if (!/You're the artist · draw your prompt/.test(out.banner)) throw new Error('the banner: ' + out.banner);
    if (out.prompt !== 'a lighthouse in a storm') throw new Error('the artist sees the prompt: ' + out.prompt);
    if (out.touch !== 'none') throw new Error('strokes must not scroll the page: ' + out.touch);
    if (!/Draw something first/.test(out.empty)) throw new Error('an empty page is refused: ' + out.empty);
    if (out.ink < 200) throw new Error('the strokes land on the pad: ' + out.ink);
    if (out.kept !== out.ink + '|Pen colour #ef4444|Eraser|0') throw new Error('a repaint keeps the drawing and the pen (and the eraser goes off again): ' + out.kept + ' (ink ' + out.ink + ')');
    if (/data:/.test(out.sending)) throw new Error('the status line must not echo the image: ' + out.sending.slice(0, 60));
    if (!/"dir":"data:image\/png;base64,/.test(out.call)) throw new Error('the pad goes out as a PNG data URL: ' + out.call);
    return { banner: out.banner, ink: out.ink, kept: out.kept, sending: out.sending };
  });
  await run('sketch-draw-mobile', { state: { sg: true, sgDraw: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => {
    const out = {};
    await page.waitForSelector('.game-card .sg-card', { timeout: 10000 });
    await page.click('.game-card.kind-sketch');
    await page.waitForSelector('#viewer .sg-artist', { timeout: 20000 });
    await page.$eval('#viewer .sg-canvas', (e) => e.scrollIntoView({ block: 'center' }));
    await settle(page);
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
      await page.waitForSelector('.game-card .sg-card', { timeout: 10000 });
      out.cardImg = !!(await page.$('.game-card .sg-card-img'));
      out.cardCap = await page.$eval('.game-card .sg-card-cap', (e) => e.textContent);
      await page.click('.game-card.kind-sketch');
      await page.waitForSelector('#viewer .sg-guess', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .sg-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|sg-form|sg-scores|sg-reveal/.test(c)));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.reveal = await page.$$eval('#viewer .sg-rv', (r) => r.map((x) => x.textContent));
      out.prompt = await page.$eval('#viewer .sg-rv-prompt', (e) => e.textContent);
      await page.fill('#viewer .sg-in', 'a lighthouse');
      // the guess is React (ctx.panel): a repaint keeps the draft
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .sg-guess', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .sg-guess', (f) => f.querySelector('.sg-in').value + '|' + f.querySelector('.sg-send').disabled);
      await page.focus('#viewer .sg-in');
      await page.keyboard.type(' at sea');
      out.typed = await page.$eval('#viewer .sg-in', (i) => i.value + '|' + (document.activeElement === i));
      await page.fill('#viewer .sg-in', 'a lighthouse');
      await shot(page, label + '.png');
      await page.click('#viewer .sg-guess .sg-send');
      await settle(page);
      out.call = calls.filter((c) => c.includes('/games/38/moves')).pop() || '';
      out.title = await page.$eval('#viewer .sg-guess .sg-form-title', (e) => e.textContent).catch(() => '');
      if (!out.cardImg || !/Guess Ada's drawing/.test(out.cardCap)) throw new Error('the card shows the drawing: ' + JSON.stringify(out));
      if (out.toggle) throw new Error('no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,sg-form,sg-scores,sg-reveal') throw new Error('the gallery, the guess, scores, the last round: ' + JSON.stringify(out.order));
      if (!/Guess Ada's drawing · round 2 of 3/.test(out.banner)) throw new Error('the banner: ' + out.banner);
      if (!/It was: a cat stuck in a tree/.test(out.prompt) || !/cat up a tree.*the Referee's call.*\+2/.test(out.reveal[0]) || !/a squirrel/.test(out.reveal[1]) || !/Henry.*the artist.*\+1/.test(out.reveal[2])) throw new Error('the last round: ' + JSON.stringify(out));
      if (out.kept !== 'a lighthouse|false') throw new Error('a repaint keeps the draft: ' + out.kept);
      if (out.typed !== 'a lighthouse at sea|true') throw new Error('typing keeps the field: ' + out.typed);
      if (!/"dir":"a lighthouse"/.test(out.call)) throw new Error('a guess goes out: ' + out.call);
      if (!/Your guess is in/.test(out.title)) throw new Error('the sealed guess shows: ' + out.title);
      return out;
    });
  }
  // Trivia (a rotating quizmaster): the card shows the question and the
  // balances; the arena puts the stage first, then the question, your form,
  // the scores and the last round's reveal. An answer goes out with its wager
  // (quick stakes set the slider); typing keeps the field's focus.
  for (const [label, o] of [['trivia-answer', {}], ['trivia-answer-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tv: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tv-card', { timeout: 10000 });
      out.cardQ = await page.$eval('.game-card .tv-card-q', (e) => e.textContent);
      await page.click('.game-card.kind-trivia');
      await page.waitForSelector('#viewer .tv-answer', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .tv-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tv-q|tv-form|tv-scores|tv-reveal/.test(c)));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.reveal = await page.$$eval('#viewer .tv-rv', (r) => r.map((x) => x.textContent));
      await page.fill('#viewer .tv-in-a', 'Lisbon');
      await page.click('#viewer .tv-chip-btn:has-text("20")');
      out.stake = await page.$eval('#viewer .tv-stake', (e) => e.textContent);
      out.focusAfterType = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('tv-in-a'));
      // the form is React (ctx.panel): a repaint keeps the answer and the stake
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .tv-answer', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .tv-answer', (f) => f.querySelector('.tv-in-a').value + '|' + f.querySelector('.tv-range').value + '|' + f.querySelector('.tv-stake').textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .tv-answer .tv-send');
      await settle(page);
      out.call = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
      out.title = await page.$eval('#viewer .tv-answer .tv-form-title', (e) => e.textContent).catch(() => '');
      if (!/Which city did I grow up in\?.? - Ada asks/.test(out.cardQ)) throw new Error('the card shows the question: ' + out.cardQ);
      if (out.toggle) throw new Error('no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,tv-q,tv-form,tv-scores,tv-reveal') throw new Error('the stage, question, form, scores, reveal: ' + JSON.stringify(out.order));
      if (!/Your answer · round 2 of 6/.test(out.banner)) throw new Error('the banner: ' + out.banner);
      if (out.reveal.length !== 3 || !/Ada.*Red.*\+15/.test(out.reveal[0]) || !/Anthony.*blue.*−10/.test(out.reveal[1]) || !/Henry.*split the table.*\+10/.test(out.reveal[2])) throw new Error('the last round: ' + JSON.stringify(out.reveal));
      if (out.stake !== '20 of 25') throw new Error('a quick stake sets the wager: ' + out.stake);
      if (out.kept !== 'Lisbon|20|20 of 25') throw new Error('a repaint keeps the answer and the stake: ' + out.kept);
      if (!/"dir":"\{\\"answer\\":\\"Lisbon\\",\\"wager\\":20\}"/.test(out.call)) throw new Error('the answer goes out with its wager: ' + out.call);
      if (!/Your answer is in/.test(out.title)) throw new Error('the sealed answer shows: ' + out.title);
      return out;
    });
  }
  await run('trivia-quizmaster', { state: { tv: true, tvAsk: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .tv-card', { timeout: 10000 });
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
    await settle(page);
    out.call = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
    if (!/You're the quizmaster · ask a question/.test(out.banner)) throw new Error('the banner: ' + out.banner);
    if (!/You is writing|Anthony is writing a question/.test(out.q)) throw new Error('the question waits: ' + out.q);
    if (!out.disabledBeforeAnswer) throw new Error('Ask waits for the answer');
    if (!/question.*What is my favourite fruit\?.*answer.*Mango.*accept.*mangoes.*a mango/.test(out.call)) throw new Error('the question goes out with its answer and variants: ' + out.call);
    return out;
  });
  await run('trivia-judge', { state: { tv: true, tvJudge: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .tv-card', { timeout: 10000 });
    await page.click('.game-card.kind-trivia');
    await page.waitForSelector('#viewer .tv-judge', { timeout: 20000 });
    out.title = await page.$eval('#viewer .tv-judge .tv-form-title', (e) => e.textContent);
    out.rows = await page.$$eval('#viewer .tv-judge-row', (r) => r.map((x) => x.textContent));
    await page.click('#viewer .tv-accept[aria-label="Count Ada\'s answer as right"]');
    await settle(page);
    out.accept = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
    out.counted = await page.$eval('#viewer .tv-judge-row', (e) => e.className);
    await page.click('#viewer .tv-judge .tv-send');
    await settle(page);
    out.done = calls.filter((c) => c.includes('/games/36/moves')).pop() || '';
    if (!/the answer is Rex/.test(out.title)) throw new Error('the judge sees the answer: ' + out.title);
    if (out.rows.length !== 1 || !/Ada.*Rexy/.test(out.rows[0])) throw new Error('the answers to judge: ' + JSON.stringify(out.rows));
    if (!/"dir":"accept Ada"/.test(out.accept) || !/ok/.test(out.counted)) throw new Error('Count it accepts the answer: ' + JSON.stringify(out));
    if (!/"dir":"done"/.test(out.done)) throw new Error('Reveal ends the judging: ' + out.done);
    return out;
  });
  // Letter Grid: the card shows a small grid with the claims; the arena puts
  // the scene first, then the word panel, the scores, your words and the last
  // round's words. Typing traces the path live (cells as chips, the score it
  // would make); a word that can't be traced, or one you've played, can't be
  // sent; Send carries the word with its cells.
  for (const [label, o] of [['lettergrid-arena', {}], ['lettergrid-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { lg: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .lg-card', { timeout: 10000 });
      out.mini = await page.$$eval('.game-card .lg-mini-cell', (c) => c.length);
      out.owned = await page.$$eval('.game-card .lg-mini-cell.owned', (c) => c.length);
      out.cardCap = await page.$eval('.game-card .lg-card-cap', (e) => e.textContent);
      await page.click('.game-card.kind-lettergrid');
      await page.waitForSelector('#viewer .lg-panel', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .lg-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|lg-panel|lg-scores|lg-yours|lg-reveal/.test(c)));
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
      // the panel is React (ctx.panel; the draft stays on the view, which
      // the scene shares): a repaint keeps the word, its trace and Send
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .lg-panel', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .lg-panel', (p) => p.querySelector('.lg-word').value + '|' + [...p.querySelectorAll('.lg-cell')].map((c) => c.textContent).join(',') + '|' + p.querySelector('.lg-send').disabled);
      await page.click('#viewer .lg-send');
      await settle(page);
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
      if (out.kept !== 'STONE|S A1,T B1,O C1,N D1,E E1|false') throw new Error('a repaint keeps the word: ' + out.kept);
      if (!/"dir":"stone A1 B1 C1 D1 E1"/.test(out.call)) throw new Error('Send carries the word and its cells: ' + out.call);
      if (!/Your word is in: STONE/.test(out.queued)) throw new Error('the sealed word shows: ' + out.queued);
      return out;
    });
  }
  // Werewolf: the village first, then your role, your move (a vote by day; a
  // role's pick by night), the discussion panel (the town square; the den for
  // wolves), the timeline and the villagers. Day: a villager talks and votes.
  // Night: a wolf picks a kill and whispers in the den.
  for (const [label, o] of [['werewolf-day', {}], ['werewolf-day-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ww: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ww-card', { timeout: 10000 });
      out.cardLine = await page.$eval('.game-card .ww-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-werewolf');
      await page.waitForSelector('#viewer .ww-action', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .ww-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|ww-role|ww-action|ww-talk|ww-events|ww-players/.test(c)));
      out.role = await page.$eval('#viewer .ww-role-name', (e) => e.textContent);
      out.targets = await page.$$eval('#viewer .ww-target', (els) => els.map((e) => e.textContent));
      out.talk = await page.$$eval('#viewer .ww-talk-sec', (els) => els.map((e) => e.querySelector('.ww-talk-title').textContent + ':' + e.querySelectorAll('.ww-line').length));
      out.events = await page.$eval('#viewer .ww-events', (e) => e.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .ww-talk-input', 'I agree - Henry.');
      // the talk panel is React (ctx.panel): a repaint keeps what you typed
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .ww-talk-input', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .ww-talk-input', (i) => i.value);
      await shot(page, label + '.png');
      await page.click('#viewer .ww-say');
      await settle(page);
      out.sayCall = calls.filter((c) => c.includes('/games/30/moves')).pop() || '';
      await page.click('#viewer .ww-target[aria-label="Vote out Henry"]');
      await settle(page);
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
      if (out.kept !== 'I agree - Henry.') throw new Error('a repaint keeps the line being typed: ' + out.kept);
      if (!/"dir":"say: I agree - Henry\."/.test(out.sayCall)) throw new Error('Say talks in the game: ' + out.sayCall);
      if (!/"dir":"vote Henry"/.test(out.voteCall) || !/Henry/.test(out.voted)) throw new Error('a tap votes: ' + JSON.stringify(out));
      return out;
    });
  }
  for (const [label, o] of [['werewolf-night-wolf', {}], ['werewolf-night-wolf-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ww: true, wwWolf: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ww-card', { timeout: 10000 });
      await page.click('.game-card.kind-werewolf');
      await page.waitForSelector('#viewer .ww-action', { timeout: 20000 });
      out.role = await page.$eval('#viewer .ww-role', (e) => e.textContent);
      out.targets = await page.$$eval('#viewer .ww-target', (els) => els.map((e) => e.textContent));
      out.talk = await page.$$eval('#viewer .ww-talk-sec', (els) => els.map((e) => e.querySelector('.ww-talk-title').textContent));
      out.sleeps = await page.$eval('#viewer .ww-talk-sec', (e) => e.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .ww-target[aria-label="Kill Ada"]');
      await settle(page);
      out.killCall = calls.filter((c) => c.includes('/games/30/moves')).pop() || '';
      await page.fill('#viewer .ww-talk-sec.den .ww-talk-input', 'agreed');
      await page.click('#viewer .ww-talk-sec.den .ww-say');
      await settle(page);
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
  // Werewolf's town square past the server's window: the talk comes as the
  // newest lines only, so a new line leaves the count the same. The poll
  // must still repaint the square with it.
  for (const [label, o] of [['werewolf-talk-full', {}], ['werewolf-talk-full-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ww: true } }, o), async (page, S) => {
      const line = (n) => ({ n, by: n % 2 ? 'Ada' : 'Henry', text: 'line ' + n, ch: 'town', phase: 'day', day: 1, at: now - 40e3 + n * 100 });
      S.ww.talk = Array.from({ length: 120 }, (_, i) => line(i + 1));
      await page.waitForSelector('.game-card.kind-werewolf', { timeout: 10000 });
      await page.click('.game-card.kind-werewolf');
      await page.waitForSelector('#viewer .ww-talk', { timeout: 20000 });
      const last = () => page.$$eval('#viewer .ww-talk-sec:not(.den) .ww-line-text', (e) => (e.length ? e[e.length - 1].textContent : ''));
      const out = { start: await last() };
      // line 121 arrives and the oldest drops off: still 120 lines
      S.ww.talk = S.ww.talk.slice(1).concat([line(121)]);
      await page.waitForFunction(() => { const e = document.querySelectorAll('#viewer .ww-talk-sec:not(.den) .ww-line-text'); return e.length && e[e.length - 1].textContent === 'line 121'; }, null, { timeout: 15000 })
        .catch(async () => { throw new Error('the 8 s poll must show line 121 in a full square; still ' + (await last())); });
      out.after = await last();
      if (out.start !== 'line 120') throw new Error('the square starts at line 120: ' + out.start);
      await page.$eval('#viewer .ww-talk', (e) => e.scrollIntoView({ block: 'center' }));
      await shot(page, label + '.png');
      return out;
    });
  }
  // Twenty Questions: the box first, then the controls (ask or guess; or, as
  // the answerer, answer with a note), the budget, the public Q/A log, the
  // scores and the last reveal.
  for (const [label, o] of [['twenty-ask', {}], ['twenty-ask-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tq: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tq-card', { timeout: 10000 });
      out.cardLine = await page.$eval('.game-card .tq-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-twenty');
      await page.waitForSelector('#viewer .tq-panel', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .tq-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tq-panel|tq-budget|tq-log|tq-scores|tq-reveal/.test(c)));
      out.pips = await page.$$eval('#viewer .tq-pip', (els) => els.filter((e) => e.classList.contains('yes')).length + '/' + els.filter((e) => e.classList.contains('no')).length + '/' + els.length);
      out.log = await page.$$eval('#viewer .tq-qa', (els) => els.map((e) => e.textContent));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .tq-panel .tq-input', 'Is it blue?');
      await shot(page, label + '.png');
      // the question box is React (ctx.panel): a repaint keeps the half-made draft
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .tq-panel .tq-input', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .tq-panel .tq-input', (i) => i.value + '|' + document.querySelector('#viewer .tq-go').disabled);
      // a question that starts with "guess" is still a question: Ask (on
      // desktop) and Enter (on the phone) send it as "ask: ..."
      await page.fill('#viewer .tq-panel .tq-input', 'Guessing by size, is it bigger than a car?');
      if (o.w) await page.press('#viewer .tq-panel .tq-input', 'Enter');
      else await page.click('#viewer .tq-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/28/moves')).pop() || '';
      out.lastQa = await page.$$eval('#viewer .tq-qa', (els) => { const e = els[els.length - 1]; return e.className + '|' + e.textContent; });
      out.after = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      if (!/Round 1 of 3 · Ada answers · 2 of 20 asked/.test(out.cardLine)) throw new Error('the card says who answers and how far: ' + out.cardLine);
      if (out.toggle) throw new Error('wave 3 games have no 2D/3D toggle');
      if (out.order.join(',') !== 'lc-board-big,tq-panel,tq-budget,tq-log,tq-scores,tq-reveal') throw new Error('the box, your controls, the budget, the log, scores, reveal: ' + JSON.stringify(out.order));
      if (out.pips !== '1/1/20') throw new Error('the budget lights spent questions by answer: ' + out.pips);
      if (out.log.length !== 3 || !/^1HenryIs it alive\?NO/.test(out.log[0]) || !/YES · much/.test(out.log[1]) || !/unanswerable/.test(out.log[2])) throw new Error('the public log: ' + JSON.stringify(out.log));
      if (!/Ask Ada a question · 18 of 20 left/.test(out.banner)) throw new Error('the banner asks for a question: ' + out.banner);
      if (out.kept !== 'Is it blue?|false') throw new Error('a repaint keeps the draft: ' + out.kept);
      if (!/"dir":"ask: Guessing by size, is it bigger than a car\?"/.test(out.moveCall)) throw new Error('Ask and Enter send the question as ask:, never as a guess: ' + out.moveCall);
      if (/guess/.test(out.lastQa.split('|')[0]) || !/Guessing by size/.test(out.lastQa)) throw new Error('the question is logged as a question: ' + out.lastQa);
      if (!/Waiting on Ada's answer/.test(out.after)) throw new Error('then waits on the answer: ' + out.after);
      return out;
    });
  }
  for (const [label, o] of [['twenty-answer', {}], ['twenty-answer-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tq: true, tqAnswer: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tq-card', { timeout: 10000 });
      await page.click('.game-card.kind-twenty');
      await page.waitForSelector('#viewer .tq-panel .tq-q', { timeout: 20000 });
      out.secret = await page.$eval('#viewer .tq-secret', (e) => e.textContent);
      out.q = await page.$eval('#viewer .tq-q', (e) => e.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .tq-note', 'mostly glass');
      await shot(page, label + '.png');
      await page.click('#viewer .tq-yes');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/28/moves')).pop() || '';
      if (out.secret !== 'Your secret: a lighthouse') throw new Error('the answerer sees the secret: ' + out.secret);
      if (out.q !== 'Is it made of metal?' || !/Henry asks · answer/.test(out.banner)) throw new Error('the waiting question: ' + JSON.stringify(out));
      if (!/"dir":"yes - mostly glass"/.test(out.moveCall)) throw new Error('Yes sends the answer and the note: ' + out.moveCall);
      return out;
    });
  }
  // Exquisite Corpse: the desk first; on your turn the fold (only the segment
  // before yours) and your segment, the turn strip, then - once revealed -
  // the story with the favourite vote.
  for (const [label, o] of [['corpse-write', {}], ['corpse-write-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ec: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ec-card', { timeout: 10000 });
      out.cardLine = await page.$eval('.game-card .ec-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-corpse');
      await page.waitForSelector('#viewer .ec-writer', { timeout: 20000 });
      await page.waitForSelector('#viewer:not([hidden]) .ec-3d-host canvas', { timeout: 20000 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|ec-writer|ec-strip|ec-story|ec-writers/.test(c)));
      out.fold = await page.$eval('#viewer .ec-fold-text', (e) => e.textContent);
      out.strip = await page.$$eval('#viewer .ec-strip .ec-beat', (els) => els.map((e) => e.className.replace('ec-beat', '').trim() || '-').join(','));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await page.fill('#viewer .ec-input', 'One. Two. Three. Four.');
      out.over = await page.$eval('#viewer .ec-go', (b) => b.disabled + '|' + document.querySelector('#viewer .ec-count').textContent);
      await page.fill('#viewer .ec-input', 'By midnight the gulls had formed a committee. Their first motion was bread.');
      out.ok = await page.$eval('#viewer .ec-go', (b) => b.disabled);
      await shot(page, label + '.png');
      // the writer is React (ctx.panel): a repaint keeps the half-made draft
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .ec-writer', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .ec-input', (t) => t.value + '|' + document.querySelector('#viewer .ec-count').textContent + '|' + document.querySelector('#viewer .ec-go').disabled);
      await page.click('#viewer .ec-go');
      await settle(page);
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
      if (out.kept !== 'By midnight the gulls had formed a committee. Their first motion was bread.|2 sentences · 75/400|false') throw new Error('a repaint keeps the draft: ' + out.kept);
      if (!/gulls had formed a committee\. Their first motion was bread\./.test(out.moveCall)) throw new Error('the segment goes as dir: ' + out.moveCall);
      if (!/Ada is writing/.test(out.after) || !out.writerGone) throw new Error('the turn passes on: ' + out.after);
      return out;
    });
  }
  for (const [label, o] of [['corpse-vote', {}], ['corpse-vote-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { ec: true, ecVote: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ec-card', { timeout: 10000 });
      await page.click('.game-card.kind-corpse');
      await page.waitForSelector('#viewer .ec-story', { timeout: 20000 });
      out.seed = await page.$eval('#viewer .ec-seed', (e) => e.textContent);
      out.segs = await page.$$eval('#viewer .ec-seg', (els) => els.map((e) => e.querySelector('.ec-seg-by').textContent + ':' + !!e.querySelector('.ec-vote')));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .ec-seg:nth-of-type(3) .ec-vote');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/26/moves')).pop() || '';
      out.voted = await page.$eval('#viewer .ec-seg.voted .ec-seg-by', (e) => e.textContent);
      if (!/lighthouse keeper/.test(out.seed)) throw new Error('the seed opens the story: ' + out.seed);
      if (out.segs.join(',') !== 'Ada:true,Henry:true,Anthony:false') throw new Error('a favourite for any segment but your own: ' + JSON.stringify(out.segs));
      if (!/The story is revealed · pick a favourite/.test(out.banner)) throw new Error('the banner asks for a favourite: ' + out.banner);
      if (!/"dir":"2"/.test(out.moveCall) || out.voted !== 'Henry') throw new Error('the favourite vote: ' + JSON.stringify(out));
      return out;
    });
  }
  // Two Truths and a Lie: the campfire first, then the statements to vote on
  // (or the storyteller's form), the scores and the last round's reveal.
  for (const [label, o] of [['twotruths-vote', {}], ['twotruths-vote-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tt: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tt-card-board', { timeout: 10000 });
      out.cardLine = await page.$eval('.game-card .tt-card-line', (e) => e.textContent);
      await page.click('.game-card.kind-twotruths');
      await page.waitForSelector('#viewer:not([hidden]) .tt-3d-host canvas', { timeout: 20000 });
      await page.waitForFunction(() => { const s = document.querySelector('#viewer .arena3d-status'); return s && s.hidden; }, null, { timeout: 60000, polling: 100 });
      out.toggle = !!(await page.$('#viewer .lc-view-btn'));
      out.order = await page.$$eval(ARENA_KIDS, (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => /lc-board-big|tt-statements|tt-writer|tt-scores|tt-reveal/.test(c)));
      out.label = await page.$eval('#viewer .tt-3d-host [role="img"]', (c) => c.getAttribute('aria-label'));
      out.cards = await page.$$eval('#viewer .tt-statements .tt-card', (els) => els.map((e) => e.textContent));
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      out.reveal = await page.$eval('#viewer .tt-reveal', (e) => e.textContent);
      await shot(page, label + '.png');
      await page.click('#viewer .tt-statements .tt-card:nth-of-type(2)');
      await settle(page);
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
      await page.waitForSelector('.game-card .tt-card-board', { timeout: 10000 });
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
      // the form is React (ctx.panel): a repaint keeps the half-made draft
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .tt-writer', { timeout: 10000 });
      out.repainted = await page.$$eval('#viewer .tt-writer-row', (rows) => rows.map((r) => r.querySelector('.tt-input').value + (r.classList.contains('lie') ? ' (lie)' : '')).join('|') + '|' + document.querySelector('#viewer .tt-go').disabled);
      await page.click('#viewer .tt-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/24/moves')).pop() || '';
      out.mine = await page.$eval('#viewer .tt-statements', (e) => e.textContent);
      if (!/Your turn to tell · round 3 of 3/.test(out.banner)) throw new Error('the banner asks the storyteller: ' + out.banner);
      if (out.go0 !== true || out.go1 !== false) throw new Error('send waits for three statements and a lie: ' + JSON.stringify(out));
      if (out.kept !== 'I have a cat named Pixel|I learned to swim at forty|I once sang on live radio') throw new Error('marking the lie keeps the text: ' + out.kept);
      if (out.repainted !== 'I have a cat named Pixel|I learned to swim at forty|I once sang on live radio (lie)|false') throw new Error('a repaint keeps the draft: ' + out.repainted);
      if (!/lie[\\"]*:3/.test(out.moveCall) || !/I once sang on live radio/.test(out.moveCall)) throw new Error('the statements go as one structured move: ' + out.moveCall);
      if (!/your lie/.test(out.mine)) throw new Error('the storyteller sees their lie marked: ' + out.mine);
      return out;
    });
  }
  // Liar's Dice: the card shows the standing bid and the table; without WebGL
  // the arena puts the bid first, then your cup, the bid builder (count,
  // face, Bid or Liar!), the table and the last round's opened cups (with
  // WebGL the cup and the seats are in the scene, see liarsdice-3d). Desktop
  // raises; the phone calls liar.
  for (const [label, o] of [['liarsdice-arena', {}], ['liarsdice-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark', liar: true }]]) {
    await run(label, Object.assign({ state: { ld: true }, init: noGl }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .ld-card', { timeout: 10000 });
      out.cardBid = await page.$eval('.game-card .ld-now-bid', (e) => e.textContent);
      await page.click('.game-card.kind-liarsdice');
      await page.waitForSelector('#viewer .ld-bidder', { timeout: 10000 });
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
        await settle(page);
        out.moveCall = calls.filter((c) => c.includes('/games/22/moves')).pop() || '';
        await page.waitForSelector('#viewer .ld-reveal .ld-die.hit', { timeout: 10000 });
        out.after = await page.$eval('#viewer .ld-reveal .ld-verdict', (e) => e.textContent);
        await shot(page, label + '-called.png');
        if (!/"dir":"liar"/.test(out.moveCall)) throw new Error('Liar! sends liar: ' + out.moveCall);
        if (!/the bid stands/.test(out.after) || !/Anthony loses a die \(4 left\)/.test(out.after)) throw new Error('the call opens the cups: ' + out.after);
      } else {
        await page.click('#viewer .ld-face[aria-label="twos"]');
        out.go1 = await page.$eval('#viewer .ld-go', (b) => b.textContent);
        // the bid builder is React (ctx.panel): a repaint keeps the draft
        await page.click('#viewer .arena-tabs button:nth-child(2)');
        await page.click('#viewer .arena-tabs button:nth-child(1)');
        await page.waitForSelector('#viewer .ld-bidder', { timeout: 10000 });
        out.kept = await page.$eval('#viewer .ld-go', (b) => b.textContent);
        await page.click('#viewer .ld-bid-row .fl-step[aria-label="One fewer die"]');
        out.blocked = await page.$eval('#viewer .ld-go', (b) => b.disabled + '|' + (document.querySelector('#viewer .ld-why') || {}).textContent);
        await page.click('#viewer .ld-face[aria-label="fives"]');
        out.go2 = await page.$eval('#viewer .ld-go', (b) => b.textContent + '|' + b.disabled);
        await page.click('#viewer .ld-go');
        await settle(page);
        out.moveCall = calls.filter((c) => c.includes('/games/22/moves')).pop() || '';
        out.afterBanner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
        out.builderGone = !(await page.$('#viewer .ld-bidder'));
        if (out.go1 !== 'Bid 4 twos') throw new Error('a face pick keeps the count: ' + out.go1);
        if (out.kept !== 'Bid 4 twos') throw new Error('a repaint keeps the draft: ' + out.kept);
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
  // The auction: the card shows the lot and the bidders; the arena puts the
  // lot first, then your sealed bid (steps, quick amounts), the bidders, and
  // the last lot's opened bids.
  for (const [label, o] of [['auction-arena', {}], ['auction-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { au: true } }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .au-card', { timeout: 10000 });
      out.cardLot = await page.$eval('.game-card .au-lot-name', (e) => e.textContent);
      await page.click('.game-card.kind-auction');
      await page.waitForSelector('#viewer .au-bid', { timeout: 10000 });
      out.lot = await page.$eval('#viewer .au-lot', (e) => e.textContent);
      out.result = await page.$eval('#viewer .au-result', (e) => e.textContent);
      out.go0 = await page.$eval('#viewer .au-go', (b) => b.textContent);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '-bid.png');
      // a typed amount counts on change (here the blur), held to the budget
      await page.fill('#viewer .au-num', '150');
      await page.$eval('#viewer .au-num', (i) => i.blur());
      out.typed = await page.$eval('#viewer .au-go', (b) => b.textContent + '|' + document.querySelector('#viewer .au-num').value);
      await page.click('#viewer .au-acts button:has-text("25")');
      await page.click('#viewer .au-bid-row .fl-step[aria-label="5 more"]');
      out.go = await page.$eval('#viewer .au-go', (b) => b.textContent);
      // the bid is React (ctx.panel): a repaint keeps the half-made draft
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .au-bid', { timeout: 10000 });
      out.kept = await page.$eval('#viewer .au-go', (b) => b.textContent + '|' + document.querySelector('#viewer .au-num').value);
      await page.click('#viewer .au-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/20/moves')).pop() || '';
      out.after = await page.$eval('#viewer .au-go', (b) => b.textContent + '|' + b.disabled);
      await shot(page, label + '-sealed.png');
      if (!/unusual wisdom/.test(out.cardLot)) throw new Error('the card shows the lot: ' + out.cardLot);
      if (!/Lot 3 of 6/.test(out.lot)) throw new Error('the lot under the hammer: ' + out.lot);
      if (!/Lot 2: “The last slice of pizza, still warm”Anthony · 20/.test(out.result) || !/pass/.test(out.result)) throw new Error('the last lot\'s opened bids: ' + out.result);
      if (out.go0 !== 'Pass') throw new Error('a zero bid reads as Pass: ' + out.go0);
      if (out.typed !== 'Bid 80|80') throw new Error('a typed bid is held to the budget: ' + out.typed);
      if (out.go !== 'Bid 30' || !/"dir":"30"/.test(out.moveCall)) throw new Error('quick amounts and steps make the bid: ' + JSON.stringify(out));
      if (out.kept !== 'Bid 30|30') throw new Error('a repaint keeps the draft: ' + out.kept);
      if (out.after !== 'Bid in ✓|true') throw new Error('the bid reads sealed: ' + out.after);
      if (!/Your bid · lot 3 of 6/.test(out.banner)) throw new Error('the banner asks for a bid: ' + out.banner);
      return out;
    });
  }
  // Trust: the card shows the scores; the arena puts the scoreboard first,
  // then a Cooperate / Defect pair per rival (Lock in waits for both), then -
  // without WebGL - the last round's who-trusted-whom grid (with WebGL the
  // table's threads are the grid, see trust-3d).
  for (const [label, o] of [['trust-arena', {}], ['trust-arena-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { tr: true }, init: noGl }, o), async (page, S, calls) => {
      const out = {};
      await page.waitForSelector('.game-card .tr-card', { timeout: 10000 });
      out.cardOrder = await page.$$eval('.game-card .tr-name', (n) => n.map((x) => x.textContent));
      await page.click('.game-card.kind-trust');
      await page.waitForSelector('#viewer .tr-plan', { timeout: 10000 });
      out.scores = await page.$$eval('#viewer .tr-scores .tr-score', (n) => n.map((x) => x.textContent).join(','));
      out.grid = await page.$$eval('#viewer .tr-grid tr', (rows) => rows.slice(1).map((r) => [...r.querySelectorAll('td.tr-cell')].map((c) => c.textContent).join('')).join('|'));
      out.goOff = await page.$eval('#viewer .tr-go', (b) => b.disabled);
      out.banner = await page.$eval('#viewer .turn-banner .duel-statusline', (e) => e.textContent);
      await shot(page, label + '-plan.png');
      await page.click('#viewer .tr-choice:nth-of-type(2) .tr-pick.c');
      out.halfOff = await page.$eval('#viewer .tr-go', (b) => b.disabled);
      // the planner is React (ctx.panel): a repaint keeps the half-made draft
      await page.click('#viewer .arena-tabs button:nth-child(2)');
      await page.click('#viewer .arena-tabs button:nth-child(1)');
      await page.waitForSelector('#viewer .tr-plan', { timeout: 10000 });
      out.kept = await page.$$eval('#viewer .tr-pick.on', (n) => n.map((x) => x.closest('.tr-choice').querySelector('.tr-choice-name').textContent + ':' + x.textContent).join(','));
      await page.click('#viewer .tr-choice:nth-of-type(3) .tr-pick.d');
      out.goOn = await page.$eval('#viewer .tr-go', (b) => !b.disabled);
      await page.click('#viewer .tr-go');
      await settle(page);
      out.moveCall = calls.filter((c) => c.includes('/games/18/moves')).pop() || '';
      out.locked = await page.$eval('#viewer .tr-go', (b) => b.textContent);
      await shot(page, label + '-locked.png');
      if (out.cardOrder.join(',') !== 'Ada,Anthony (you),Henry') throw new Error('the card ranks by score: ' + out.cardOrder);
      if (out.scores !== '14,12,9') throw new Error('the scoreboard ranks by score: ' + out.scores);
      if (out.grid !== '✗✗|✓✗|✓✓') throw new Error('the round 2 grid (rows choose, columns receive): ' + out.grid);
      if (!out.goOff || !out.halfOff || !out.goOn) throw new Error('Lock in waits for a choice per rival: ' + JSON.stringify(out));
      if (out.kept !== 'Ada:🤝 Cooperate') throw new Error('a repaint keeps the draft: ' + out.kept);
      if (!/"dir":"Ada:C, Henry:D"/.test(out.moveCall)) throw new Error('the choices go per rival: ' + out.moveCall);
      if (!/Locked in/.test(out.locked)) throw new Error('the planner reads locked: ' + out.locked);
      if (!/Your choices · round 3/.test(out.banner)) throw new Error('the turn banner asks for choices: ' + out.banner);
      return out;
    });
  }
  done('arenas');
})();
