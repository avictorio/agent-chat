// UI scenarios: the chat: markdown, voice and dictation, message actions, artifacts and reactions.
// Run alone: node -r ./tests/system-chromium.js tests/ui/chat.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { settle, done, must, run, shot, ymd, TESTS } = require('./harness');

(async () => {
  for (const [label, o] of [['markdown-light', {}], ['markdown-dark', { scheme: 'dark' }], ['markdown-mobile', { w: 390, h: 844 }]]) {
    await run(label, Object.assign({ state: { markdown: true }, init: () => { window.__alert = 0; window.alert = () => { window.__alert++; }; } }, o), async (page) => {
      await settle(page);
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
  // Text that used to freeze or crash every open page of the room: 2,000
  // nested quotes (the renderer called itself once per level), a heading
  // followed by 7,990 spaces (a cubic expression), a list 400 deep.
  await run('markdown-hostile', { state: { hostileMarkdown: true } }, async (page) => {
    await settle(page);
    const t0 = Date.now();
    const out = await page.evaluate(() => {
      const t = (id) => document.querySelector('.msg[data-id="' + id + '"] .text');
      const nest = (root, tag) => { let d = 0, n = root.querySelector(tag); while (n) { d++; n = n.querySelector(tag); } return d; };
      const m = t(34);
      return {
        quoteDepth: nest(t(31), 'blockquote'), quoteTail: t(31).textContent.slice(-8),
        headingChars: t(32).querySelector('.md-h') ? t(32).querySelector('.md-h').textContent.length : -1,
        listDepth: nest(t(33), 'ul'), listTail: t(33).textContent.slice(-10),
        // an ordinary message beside them still renders as before
        quotes: nest(m, 'blockquote'), head: m.querySelector('.md-h').textContent, cells: Array.from(m.querySelectorAll('th, td')).map(x => x.textContent + (x.style.textAlign ? '@' + x.style.textAlign : '')).join(' '),
        pre: m.querySelector('pre code').textContent, rule: m.querySelectorAll('hr').length, link: m.querySelector('a').getAttribute('href'),
      };
    });
    out.answeredMs = Date.now() - t0;
    // past the nesting limit the rest is shown as it was written, markers and all
    const want = { quoteDepth: 13, quoteTail: '>>> deep', headingChars: 7992, listDepth: 13, listTail: '- item 399', quotes: 2, head: 'Still a heading', cells: 'a b@center 1 2@center', pre: 'code', rule: 1, link: 'https://example.com/x' };
    for (const k of Object.keys(want)) if (out[k] !== want[k]) throw new Error(k + ' should be ' + JSON.stringify(want[k]) + ', got ' + JSON.stringify(out[k]));
    if (out.answeredMs > 3000) throw new Error('the page took ' + out.answeredMs + ' ms to answer');
    await shot(page, 'markdown-hostile.png');
    return out;
  });
  // (the browser reports each script it refused in the preview: that message is the point)
  await run('artifacts', { state: { artifacts: true, artScript: true }, allowConsole: /Blocked script execution in .*\/messages\/8\/html/ }, async (page, S) => {
    const out = {};
    const fr = await page.waitForSelector('.art-card iframe.art-frame', { timeout: 10000 });
    out.frameSandbox = await fr.getAttribute('sandbox');
    out.frameSrc = await fr.getAttribute('src');
    out.cardName = await page.$eval('.art-card .art-name', e => e.textContent);
    await page.waitForSelector('.doc-card .doc-body .md-h', { timeout: 10000 });
    out.docHead = await page.$eval('.doc-card .doc-body .md-h', e => e.textContent);
    out.docName = await page.$eval('.doc-card .art-name', e => e.textContent);
    out.docBody = await page.$eval('.doc-card .doc-body', e => e.textContent);
    // The feed's preview is a picture of the page: scripts off (an empty sandbox), no focus (inert).
    out.frameInert = await fr.evaluate(e => e.inert === true);
    if (out.frameSandbox !== '' || !out.frameInert) throw new Error('the preview iframe must have an empty sandbox and be inert, got sandbox=' + JSON.stringify(out.frameSandbox) + ' inert=' + out.frameInert);
    await page.waitForTimeout(400);
    out.ranInPreview = S.artRan || 0;
    if (out.ranInPreview !== 0) throw new Error('the posted page\'s script ran in the feed preview (' + out.ranInPreview + ' request(s))');
    if (!/Probe doc/.test(out.docHead)) throw new Error('doc heading not rendered: ' + out.docHead);
    if (!/Rendered/.test(out.docBody)) throw new Error('doc body not rendered');
    // Cards are previews only: no Open / Expand / Download links on them.
    out.cardLinks = await page.$$eval('.art-card a, .art-card button, .doc-card a, .doc-card button', els => els.length);
    if (out.cardLinks !== 0) throw new Error('cards must carry no links or buttons, found ' + out.cardLinks);
    await shot(page, 'artifacts-cards.png');
    // Tapping the page card opens the full-screen viewer; browser back closes it.
    await page.click('.art-card');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-frame', { timeout: 10000 });
    out.viewerTitle = await page.$eval('#viewerTitle', e => e.textContent);
    // ...and in the viewer, which the reader opened, the page's script does run (so the check above can fail).
    out.viewerSandbox = await page.$eval('#viewer .viewer-frame', e => e.getAttribute('sandbox'));
    for (let k = 0; k < 50 && !(S.artRan > 0); k++) await page.waitForTimeout(100);
    out.ranInViewer = S.artRan || 0;
    if (out.viewerSandbox !== 'allow-scripts' || out.ranInViewer < 1) throw new Error('the opened page must run its script: sandbox=' + out.viewerSandbox + ' ran=' + out.ranInViewer);
    await shot(page, 'artifacts-viewer-page.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    // Tapping the doc card opens the viewer with the full document; the chevron closes it.
    await page.click('.doc-card');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-doc .md-h', { timeout: 10000 });
    out.viewerDoc = await page.$eval('#viewer .viewer-doc', e => e.textContent);
    out.viewerDl = await page.$eval('#viewerDl', e => !e.hidden);
    await shot(page, 'artifacts-viewer-doc.png');
    await page.click('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    if (!/Rendered/.test(out.viewerDoc)) throw new Error('viewer doc not rendered');
    if (!out.viewerDl) throw new Error('viewer must offer Download for a document');
    // Images get the same treatment: inline, no wrapping link; tap opens the viewer.
    out.imgWrapped = await page.$eval('.msg-img', e => e.parentElement.tagName);
    await page.click('.msg-img');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-img', { timeout: 10000 });
    await settle(page);
    await shot(page, 'artifacts-viewer-image.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    if (out.imgWrapped === 'A') throw new Error('image must not be wrapped in a new-tab link');
    return out;
  });
  await run('artifacts-mobile', { state: { artifacts: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('.art-card iframe.art-frame', { timeout: 10000 });
    await shot(page, 'artifacts-mobile-cards.png');
    await page.tap('.art-card');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-frame', { timeout: 10000 });
    await settle(page);
    await shot(page, 'artifacts-mobile-viewer.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    await page.tap('.msg-img');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-img', { timeout: 10000 });
    await settle(page);
    await shot(page, 'artifacts-mobile-image.png');
    await page.tap('#viewerBack');
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 10000 });
    return { ok: true };
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
    await page.click('#mic'); await settle(page);
    out.micOn = await page.$eval('#mic', b => b.className + '|' + b.getAttribute('aria-pressed'));
    await shot(page, 'voice-recording.png');
    await page.evaluate(() => { const r = window.__recs[0]; const res = (t, f) => { const a = [{ transcript: t }]; a.isFinal = f; return a; };
      r.onresult({ resultIndex: 0, results: [res('there team', true), res(' this is int', false)] }); });
    out.afterInterim = await page.$eval('#text', t => t.value);
    await page.evaluate(() => { const r = window.__recs[0]; const res = (t, f) => { const a = [{ transcript: t }]; a.isFinal = f; return a; };
      r.onresult({ resultIndex: 1, results: [res('there team', true), res(' this is dictated.', true)] }); });
    out.afterFinal = await page.$eval('#text', t => t.value);
    await page.keyboard.press('Enter'); await settle(page);
    out.posted = await page.$eval('#msgs .msg:last-child .text', e => e.textContent);
    out.micAfterSend = await page.$eval('#mic', b => b.className);
    out.textAfterSend = await page.$eval('#text', t => t.value);
    await page.hover('#msgs .msg[data-id="3"]');
    await page.click('#msgs .msg[data-id="3"] .speak'); await settle(page);
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
    await page.click('#mic'); await settle(page);
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
      await page.click('#send'); await settle(page);
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

  // --- board actions and reactions ---
  await run('actions', {}, async (page, S, calls) => {
    const out = {};
    await page.fill('#text', 'Hello from the test'); await page.keyboard.press('Enter'); await settle(page);
    out.lastMsg = await page.$eval('#msgs .msg:last-child .text', e => e.textContent);
    await page.click('.tab[data-tab="questions"]'); await settle(page);
    // Board guards: Delete is a borderless quiet button, and relative
    // times never pluralize ("5 hr ago").
    const qMeta = await page.$eval('#qList', e => e.textContent);
    if (qMeta.includes('hrs ago')) throw new Error('rel() pluralized hours: ' + qMeta.slice(0, 200));
    if (!qMeta.includes('5 hr ago')) throw new Error('question meta missing "5 hr ago": ' + qMeta.slice(0, 200));
    const delCls = await page.$eval('#qList .btn.danger', b => b.className);
    if (!delCls.includes('quiet')) throw new Error('board Delete is not the quiet variant: ' + delCls);
    await page.fill('#qInput', 'New question from UI'); await page.click('#qForm button[type=submit]'); await settle(page);
    out.qAfterAdd = await page.$$eval('#qList .card-title', e => e.map(x => x.textContent));
    await page.click('#qList .card:first-child button:has-text("Claim")'); await settle(page);
    await page.click('#qList .card:first-child button:has-text("Resolve")'); await settle(page);
    await shot(page, 'action-resolve-form.png');
    // Edit forms: fields are .field columns and the control spans the
    // card (a bare <label> left the textarea at intrinsic width,
    // floating over its label).
    const rfShape = await page.$eval('#qList form.edit', f => { const ta = f.querySelector('textarea'); const lab = ta.closest('label'); return { field: !!lab && lab.classList.contains('field'), ratio: ta.getBoundingClientRect().width / f.getBoundingClientRect().width, cancel: Array.from(f.querySelectorAll('button')).map(b => b.textContent + ':' + b.className).join('|') }; });
    if (!rfShape.field || rfShape.ratio < 0.8) throw new Error('resolve edit-form layout diverges: ' + JSON.stringify(rfShape));
    if (!rfShape.cancel.includes('Cancel:btn sm')) throw new Error('edit-form Cancel is not plain btn sm: ' + rfShape.cancel);
    await page.fill('#qList .card:first-child textarea', 'Henry will book it.'); await page.click('#qList .card:first-child button:has-text("Mark resolved")'); await settle(page);
    await page.click('[data-qf="resolved"]'); await settle(page);
    out.resolved = await page.$$eval('#qList .card-title', e => e.map(x => x.textContent));
    await page.click('.tab[data-tab="decisions"]'); await settle(page);
    await page.click('#dcList .card:last-child button:has-text("Sign")'); await settle(page);
    out.signers1 = S.dc[0].signers;
    await page.click('.tab[data-tab="constitution"]'); await settle(page);
    await page.click('#conBody button:has-text("Edit")'); await settle(page);
    await shot(page, 'action-const-edit.png');
    const ceShape = await page.$eval('#conBody form.edit', f => { const ta = f.querySelector('textarea'); const lab = ta.closest('label'); return { field: !!lab && lab.classList.contains('field'), ratio: ta.getBoundingClientRect().width / f.getBoundingClientRect().width }; });
    if (!ceShape.field || ceShape.ratio < 0.8) throw new Error('constitution edit-form layout diverges: ' + JSON.stringify(ceShape));
    await page.fill('#conBody textarea', 'Purpose v3'); await page.click('#conBody button:has-text("Save as version 3")'); await settle(page);
    out.conVersion = S.con.version;
    await page.click('.tab[data-tab="stakes"]'); await settle(page);
    await page.fill('#sTitle', 'Buy gift'); await page.fill('#sDate', ymd(3)); await page.click('#sForm button[type=submit]'); await settle(page);
    out.stakes = await page.$$eval('#sList .card-title', e => e.map(x => x.textContent));
    await page.click('.tab[data-tab="memory"]'); await settle(page);
    await page.fill('#dInput', 'Test digest'); await page.click('#dForm button[type=submit]'); await settle(page);
    out.digests = S.dg.length;
    page.once('dialog', d => d.accept());
    await page.click('.tab[data-tab="decisions"]'); await settle(page);
    await page.click('#dcList .card:first-child button:has-text("Delete")'); await settle(page);
    out.decisionsAfterDelete = S.dc.length;
    await page.click('[data-theme-set="dark"]'); await settle(page);
    await page.reload(); await settle(page);
    out.themeAfterReload = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    out.tabAfterReload = await page.evaluate(() => document.querySelector('.tab[aria-current="page"]').dataset.tab);
    out.writes = calls.filter(c => !c.startsWith('GET')).map(c => c.split(' ').slice(0, 2).join(' '));
    return out;
  });
  // An open edit form holds the board: someone else resolves the question
  // being answered, the reload is held, and a later unrelated room_state
  // change must not let it through. Each such change rebuilt the board api,
  // which ran the hold's cleanup, and the form vanished with its text.
  await run('board-edit-held', {}, async (page, S, calls) => {
    S.streamRetry = 150;
    await page.reload(); await settle(page);
    await page.click('.tab[data-tab="questions"]'); await settle(page);
    const card = '#qList .card:has-text("Who books the dinner")';
    await page.click(card + ' button:has-text("Resolve")'); await settle(page);
    await page.fill(card + ' textarea', 'Half-written answer');
    const from = calls.length;
    const q = S.q.shift(); q.status = 'resolved'; q.resolved_by = 'Henry'; q.resolution = 'Henry booked it.'; S.qr.unshift(q);
    // the board part of room_state moved: the reload runs and is held
    for (let i = 0; i < 100 && !calls.slice(from).some((c) => /^GET .*\/questions/.test(c)); i++) await new Promise((r) => setTimeout(r, 50));
    must(calls.slice(from).some((c) => /^GET .*\/questions/.test(c)), 'the board reloaded after the room_state change');
    await settle(page);
    // then room_state changes again (any change rebuilt the api)
    S.con.version += 1;
    const seen = calls.length;
    for (let i = 0; i < 100 && calls.slice(seen).filter((c) => /\/stream/.test(c)).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await settle(page);
    const typed = await page.$eval('#qList form.edit textarea', (t) => t.value).catch(() => null);
    must(typed === 'Half-written answer', 'the open form and its text survive: ' + typed);
    S.streamRetry = 0;
    return { typed };
  });
  await run('reactions', {}, async (page, S, calls) => {
    const out = {};
    const chips = (id) => page.$$eval('.msg[data-id="' + id + '"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    out.initial = await chips(3);
    const box = await page.$eval('.msg[data-id="1"] .text', e => { const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; });
    // hold until the bar opens, then let go (a fixed hold races the app's
    // 450 ms timer, which runs late under load)
    await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.waitForSelector('.rx-bar', { timeout: 5000 }).catch(() => {}); await page.mouse.up(); await settle(page);
    out.barOpen = await page.$$eval('.rx-bar button.rx', b => b.map(x => x.textContent).join(''));
    // The quick bar's shape: six reactions ending in Angry, a
    // plain-plus "More reactions" button, and a text-only Copy (an icon
    // Copy wraps the mobile bar to two rows).
    const barShape = await page.$$eval('.rx-bar button', bs => bs.map(b => ({ t: b.title || '', txt: b.textContent, cls: b.className, svg: !!b.querySelector('svg') })));
    if (!barShape.some(b => b.t === 'Angry')) throw new Error('reaction bar lacks the Angry quick reaction: ' + JSON.stringify(barShape));
    if (!barShape.some(b => b.cls.includes('rx-plus') && b.t === 'More reactions')) throw new Error('reaction bar plus button diverges: ' + JSON.stringify(barShape));
    const copyBtn = barShape.find(b => b.txt === 'Copy');
    if (!copyBtn || copyBtn.svg) throw new Error('reaction bar Copy must be text-only: ' + JSON.stringify(barShape));
    await shot(page, 'reactions-bar.png');
    await page.click('.rx-bar button[title="Love"]'); await settle(page);
    out.afterLove = await chips(1); out.barClosed = !(await page.$('.rx-bar'));
    await page.click('.msg[data-id="1"] .text'); await settle(page);
    out.quickClickNoBar = !(await page.$('.rx-bar'));
    await page.hover('.msg[data-id="1"]'); await page.click('.msg[data-id="1"] .react-btn'); await settle(page);
    await page.click('.rx-bar button[title="Haha"]'); await settle(page);
    out.afterHaha = await chips(1);
    await page.click('.msg[data-id="1"] .rx-chip.mine'); await settle(page);
    out.afterRemove = await chips(1);
    await page.click('.msg[data-id="3"] .rx-chip:not(.mine)'); await settle(page);
    out.msg3 = await chips(3);
    out.titles = await page.$$eval('.msg[data-id="3"] .rx-chip', cs => cs.map(c => c.title));
    await page.click('.msg[data-id="3"] .react-btn', { force: true }); await settle(page);
    await page.keyboard.press('Escape'); out.escCloses = !(await page.$('.rx-bar'));
    out.posts = calls.filter(c => c.includes('/reactions')).map(c => c.replace('POST /api/rooms/demo/messages/', ''));
    await page.hover('.msg[data-id="3"]'); await shot(page, 'reactions-chips.png');
    return out;
  });
  /* The quick reaction bar fits a 360px phone whole, Copy and + included
     (at ~365px wide they can clip). */
  await run('reactions-bar-narrow', { w: 360, h: 760, touch: true }, async (page) => {
    const box = await page.$eval('.msg[data-id="1"] .text', e => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; });
    await settle(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    // hold until the bar opens, then lift (as in 'reactions')
    await page.waitForSelector('.rx-bar', { timeout: 5000 }).catch(() => {});
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(page);
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
     its pointer on it (not over the message above, 40px in from the
     row's edge), with the chip outlined; Escape closes it and clears the
     outline. Desktop and phone. */
  for (const [label, o] of [['reactions-who-anchored', {}], ['reactions-who-anchored-mobile', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, o, async (page) => {
      await page.waitForSelector('.rx-chip', { timeout: 10000 });
      const chips = await page.$$('.rx-chip');
      const chip = chips[chips.length - 1];
      const cb = await chip.boundingBox();
      const x = cb.x + cb.width / 2, y = cb.y + cb.height / 2;
      if (o.touch) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForSelector('.rx-who', { timeout: 5000 }).catch(() => {});
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        // hold until the popover opens, then let go (as in 'reactions')
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForSelector('.rx-who', { timeout: 5000 }).catch(() => {});
        await page.mouse.up();
      }
      await page.waitForSelector('.rx-who[data-side]', { timeout: 10000 });
      await settle(page);
      const wb = await (await page.$('.rx-who')).boundingBox();
      const out = { side: await page.$eval('.rx-who', e => e.dataset.side), gap: Math.round(cb.y - (wb.y + wb.height)), offCentre: Math.round(Math.abs(wb.x + wb.width / 2 - x)) };
      out.held = await chip.evaluate(e => e.classList.contains('rx-held'));
      if (out.side !== 'above' || out.gap < 4 || out.gap > 16) throw new Error('who reacted should sit just above the held chip: ' + JSON.stringify(out));
      if (out.offCentre > 2) throw new Error('who reacted should be centred on the held chip: ' + JSON.stringify(out));
      if (!out.held) throw new Error('the held chip should be outlined while its popover is open');
      await shot(page, label + '.png');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.rx-who') && !document.querySelector('.rx-chip.rx-held'), null, { timeout: 10000 });
      return out;
    });
  }
  await run('reactions-hold-noclick', {}, async (page, S, calls) => {
    // Regression guard: the hold brings up the bar, but the selection
    // must take on the first tap. A real touch long-press release often
    // produces NO click event, so the swallow flag set when the bar
    // opens must not outlive the gesture: the app clears it 120ms after
    // pointerup and exempts clicks inside the popover. Without both
    // guards the first deliberate tap is eaten. Synthetic pointer events
    // model the no-click release exactly (no native click follows them).
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
    await settle(page);
    await page.click('.rx-bar button[title="Love"]'); await settle(page);
    out.afterLove = await chips(1);
    if (JSON.stringify(out.afterLove) !== JSON.stringify(['\u2764\uFE0F1*'])) throw new Error('first tap after a no-click hold-release was eaten: ' + JSON.stringify(out));
    // Phase 2: immediate tap after a no-click release (in-popover
    // exemption path - the tap lands before any expiry could run).
    await holdOpen(3);
    out.bar2 = !!(await page.$('.rx-bar'));
    await page.click('.rx-bar button[title="Wow"]'); await settle(page);
    out.afterWow = await chips(3);
    if (!out.afterWow.some(c => c === '\u{1F62E}1*')) throw new Error('immediate tap after a no-click hold-release was eaten: ' + JSON.stringify(out));
    out.posts = calls.filter(c => c.includes('/reactions')).map(c => c.replace('POST /api/rooms/demo/messages/', ''));
    return out;
  });
  await run('reactions-picker', {}, async (page, S, calls) => {
    const out = {};
    await page.hover('.msg[data-id="1"]'); await page.click('.msg[data-id="1"] .react-btn'); await settle(page);
    await page.click('.rx-bar .rx-plus'); await settle(page);
    out.sections = await page.$$eval('.rx-picker .rx-sec', s => s.map(x => x.textContent));
    out.cells = await page.$$eval('.rx-picker .rx-cell', c => c.length);
    await shot(page, 'reactions-picker.png');
    await page.fill('.rx-picker .rx-search', 'unicorn'); await settle(page);
    out.search = await page.$$eval('.rx-picker .rx-cell', c => c.map(x => x.textContent).join(''));
    await page.click('.rx-picker .rx-cell'); await settle(page);
    out.chips1 = await page.$$eval('.msg[data-id="1"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    out.pickerClosed = !(await page.$('.rx-picker'));
    out.post = calls.filter(c => c.includes('/reactions')).slice(-1)[0];
    await page.hover('.msg[data-id="1"]'); await page.click('.msg[data-id="1"] .react-btn'); await settle(page);
    out.barMine = await page.$$eval('.rx-bar button.rx.on', b => b.map(x => x.textContent));
    await page.click('.rx-bar .rx-plus'); await settle(page);
    out.recent = await page.$eval('.rx-picker .rx-sec', s => s.textContent + ':' + s.nextElementSibling.textContent);
    // The picker highlights your current reaction's cell (.on) — the
    // unicorn just picked on this message.
    const pickerOn = await page.$$eval('.rx-picker .rx-cell.on', cs => cs.map(c => c.textContent));
    // The app marks the mine emoji wherever it renders (Recent
    // row AND its home category), so: at least one, all the unicorn.
    if (!pickerOn.length || pickerOn.some(e => e !== '\u{1F984}')) throw new Error('picker mine-highlight diverges: ' + JSON.stringify(pickerOn));
    await page.click('.rx-picker .rx-tab[title="Food & Drink"]'); await settle(page);
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
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle(page);
    await shot(page, 'reactions-bar-mobile-dark.png');
    await page.tap('.rx-bar .rx-plus'); await settle(page);
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
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle(page);
    out.stillOpenAfterRelease = !!(await page.$('.rx-bar'));
    out.barInView = await page.$eval('.rx-bar', b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; });
    await page.tap('.rx-bar button[title="Wow"]'); await settle(page);
    out.chips = await page.$$eval('.msg[data-id="3"] .rx-chip', cs => cs.map(c => c.textContent + (c.classList.contains('mine') ? '*' : '')));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y + 60 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x, y: r.y + 10 }] });
    await page.waitForTimeout(650);
    out.dragNoBar = !(await page.$('.rx-bar'));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return out;
  });

  // The stream cursor is each message frame's SSE id: line, its delivery
  // number. A message sent again (here: a file landed on row 8) comes
  // under its old id with a number past the newest id; the reconnect must
  // ask for after= that number. Before, the cursor was the highest id seen,
  // so the reconnect asked for less and got row 8 again after every drop.
  await run('stream-cursor-delivery', { state: { artifacts: true }, hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    const m8 = S.msgs.find((m) => m.id === 8);
    const top = Math.max(...S.msgs.map((m) => m.id));
    const dn = top + 40;
    S.live = [{ msg: Object.assign({}, m8, { file: { type: 'application/zip', bytes: 2048, name: 'extra.zip', url: '/api/rooms/demo/messages/8/file?exp=2&sig=x' } }), dn }];
    S.streamRetry = 300;
    S.streamSent = {};
    const from = calls.length;
    await page.reload();
    const streams = () => calls.slice(from).filter((c) => /^GET \/api\/rooms\/demo\/stream\?/.test(c));
    await page.waitForSelector('.msg[data-id="8"] .file-card', { timeout: 5000 });
    for (let i = 0; i < 50 && streams().length < 2; i++) await page.waitForTimeout(100);
    S.streamRetry = 0;
    const out = { top, dn, streams: streams().slice(0, 2).map((c) => c.split('?')[1].split('&')[0]) };
    must(out.streams.length === 2, 'the stream reconnected: ' + JSON.stringify(out));
    must(out.streams[1] === 'after=' + dn, 'the reconnect resumes after the frame\'s id: line: ' + JSON.stringify(out));
    must((await page.$$('.msg[data-id="8"]')).length === 1, 'the re-sent row is shown once');
    // the fake stream replays what was delivered after its cursor, as the
    // server's does: from the right cursor row 8 is not sent again
    out.sent8 = S.streamSent[8];
    must(out.sent8 === 1, 'the reconnect does not deliver row 8 again: ' + JSON.stringify(out));
    await settle(page);
    return out;
  });

  // An image replaced on a live message arrives as the whole message again
  // under the same id: the feed shows the new picture at once. Before, only
  // a copy with a media field the row lacked was taken, so the old image
  // stayed until a reload. As on the server, a replacement in the same hour
  // has the same exp and sig, and here the same type and size too: only
  // the file version (v=) tells the two copies apart.
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('live-image-replaced' + tag, { state: { artifacts: true }, hash: '#invite=tok_Anthony', w, h, touch: !!tag }, async (page, S) => {
      let release;
      const gate = new Promise((r) => (release = r));
      let opened = 0;
      await page.route('**/stream*', async (route) => {
        opened++;
        if (opened > 1) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 600000\n\n' });
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: await gate });
      });
      const m8 = S.msgs.find((m) => m.id === 8);
      m8.image = { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/8/image?exp=9&sig=same&v=1' };
      await page.route(/\/messages\/8\/image\?.*&v=1$/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: require('fs').readFileSync(TESTS + '/../../tests/fixtures/photo.png') }));
      await page.route(/\/messages\/8\/image\?.*&v=2$/, (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: require('fs').readFileSync(TESTS + '/../../tests/fixtures/henry.gif') }));
      await page.reload();
      await settle(page);
      const shown = () => {
        const i = document.querySelector('.msg[data-id="8"] img.msg-img');
        if (i) i.scrollIntoView({ block: 'center' });
        return !!i && i.complete && i.naturalWidth > 0;
      };
      const pic = () => page.$eval('.msg[data-id="8"] img.msg-img', (i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight }));
      await page.waitForFunction(shown, null, { timeout: 5000 });
      const before = await pic();
      const plainEl = await page.$('.msg[data-id="2"]');
      const next = Object.assign({}, m8, { image: Object.assign({}, m8.image, { url: m8.image.url.replace('v=1', 'v=2') }) });
      const m2 = S.msgs.find((m) => m.id === 2);
      // the image replaced, and an unchanged row sent again alongside it
      release('retry: 600000\n\nid: 140\nevent: message\ndata: ' + JSON.stringify(next) + '\n\nid: 141\nevent: message\ndata: ' + JSON.stringify(m2) + '\n\n');
      await page.waitForFunction(() => /v=2$/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 5000 })
        .catch(async () => { throw new Error('the new image never showed: ' + JSON.stringify(await pic())); });
      await page.waitForFunction(shown, null, { timeout: 5000 });
      await settle(page);
      const after = await pic();
      must(before.w !== after.w || before.h !== after.h, 'the picture changed: ' + JSON.stringify({ before, after }));
      must(await plainEl.evaluate((e) => e.isConnected), 'the unchanged row stays mounted');
      must((await page.$$('.msg[data-id="8"]')).length === 1, 'the row is shown once');
      await page.evaluate(() => document.querySelector('.msg[data-id="8"]').scrollIntoView({ block: 'start' }));
      await shot(page, 'live-image-replaced' + tag + '.png');
      return { before, after };
    });
  }

  // With the mention menu open, the Enter that confirms an IME conversion
  // belongs to the IME (it picked the first member and rewrote the text),
  // and Ctrl+Enter sends the message (the menu took it as a pick).
  await run('composer-ime-mention', {}, async (page, S, calls) => {
    const out = {};
    await page.click('#text');
    await page.keyboard.type('@He');
    await page.waitForSelector('.mentionMenu', { timeout: 4000 });
    for (const how of [{ isComposing: true }, { keyCode: 229 }]) await page.$eval('#text', (e, how) => e.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }, how))), how);
    await settle(page);
    out.composing = await page.$eval('#text', (t) => t.value);
    if (out.composing !== '@He') throw new Error('an IME-confirming Enter must not pick a member: ' + JSON.stringify(out.composing));
    if (!(await page.$('.mentionMenu'))) throw new Error('the menu stays open through the composition');
    const before = calls.length;
    await page.keyboard.press('Control+Enter');
    await settle(page);
    out.posts = calls.slice(before).filter((c) => /^POST \/api\/rooms\/demo\/messages(\?|\s|$)/.test(c));
    if (out.posts.length !== 1 || !/"text":"@He"/.test(out.posts[0])) throw new Error('Ctrl+Enter sends the message, menu or not: ' + JSON.stringify(out));
    return out;
  });

  done('chat');
})();
