// UI scenarios: the chat: markdown, voice and dictation, message actions, artifacts and reactions.
// Run alone: node -r ./tests/system-chromium.js tests/ui/chat.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { heldStream, settle, done, must, run, shot, ymd, TESTS } = require('./harness');

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
  // Addresses with parentheses (Wikipedia's Mercury_(planet)) used to be
  // cut at the ")" in chat and on the board and opened a missing page; the
  // punctuation after an address still stays out of it.
  for (const vp of [{ tag: '', w: 1280, h: 860 }, { tag: '-phone', w: 390, h: 844, touch: true }]) await run('paren-links' + vp.tag, { state: { parenLinks: true }, w: vp.w, h: vp.h, touch: vp.touch }, async (page) => {
    await settle(page);
    const links = (sel) => page.$$eval(sel + ' a', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    const text = (sel) => page.$eval(sel, (e) => e.textContent);
    const out = { chat: await links('.msg[data-id="36"] .text'), chatText: await text('.msg[data-id="36"] .text') };
    await shot(page, 'paren-links-chat' + vp.tag + '.png');
    if (vp.tag) await page.click('#menu');
    await page.click('.tab[data-tab="decisions"]'); await settle(page);
    out.board = await page.$$eval('#view-decisions a[target=_blank]', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    await shot(page, 'paren-links-board' + vp.tag + '.png');
    const W = 'https://en.wikipedia.org/wiki/';
    must(JSON.stringify(out.chat) === JSON.stringify([['Mercury', W + 'Mercury_(planet)'], [W + 'Venus_(planet)', W + 'Venus_(planet)'], ['https://example.com/a', 'https://example.com/a'], ['https://example.com/b_(c)_d', 'https://example.com/b_(c)_d']]), 'chat links: ' + JSON.stringify(out));
    must(out.chatText === 'See Mercury and ' + W + 'Venus_(planet). Also (https://example.com/a) and https://example.com/b_(c)_d, done.', 'chat text: ' + JSON.stringify(out));
    must(JSON.stringify(out.board) === JSON.stringify([[W + 'Lima_(city)', W + 'Lima_(city)'], ['www.example.com/x_(y)', 'https://www.example.com/x_(y)'], ['https://example.com/z', 'https://example.com/z']]), 'board links: ' + JSON.stringify(out));
    return out;
  });
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
  // A board whose first load failed: opening a board tab loads it again,
  // a second failure says why with a Retry, and Retry brings the board.
  // Before, a failed boot load left every board tab blank for the session
  // and opening a tab sent nothing.
  for (const [label, o] of [['board-load-retry', {}], ['board-load-retry-phone', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, Object.assign({ state: { digestsFail: 2 } }, o), async (page, S, calls) => {
      must(S.digestsFail === 1, 'the boot load asked once and failed: ' + S.digestsFail);
      const from = calls.length;
      if (o.w) { await page.click('#menu'); await settle(page); }
      await page.click('.tab[data-tab="decisions"]'); await settle(page);
      must(calls.slice(from).some((c) => /^GET .*\/decisions/.test(c)), 'opening the tab loads the board again');
      const pending = page.locator('#dcList .board-pending');
      await pending.waitFor({ timeout: 4000 });
      const text = (await pending.textContent()).replace(/\s+/g, ' ');
      must(/Couldn't load the board/.test(text) && /Retry/.test(text), 'the failure is said, with a Retry: ' + text);
      await shot(page, label + '.png');
      await page.click('#dcList .board-pending button:has-text("Retry")'); await settle(page);
      const titles = await page.$$eval('#dcList .card-title', (e) => e.map((x) => x.textContent));
      must(titles.length === S.dc.length && !(await page.locator('#dcList .board-pending').count()), 'Retry brings the board: ' + JSON.stringify(titles));
      return { text, titles: titles.length };
    });
  }
  // Board writes from a stale copy. Every edit form and card action
  // sends base_updated, the updated of the copy on screen; the server
  // (staleRefusing, below, plays its part) refuses one whose item someone
  // else changed first with 409 and the item as it is now. Before, the
  // app sent no base, so an edit form opened before another member's
  // edit saved over it unseen.
  const staleRefusing = async (page, S, calls) => {
    await page.route(/\/api\/rooms\/demo\/(decisions|questions)\/(\d+)$/, (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const [, kind, id] = req.url().match(/\/(decisions|questions)\/(\d+)$/);
      const body = JSON.parse(req.postData() || '{}');
      const item = (kind === 'decisions' ? S.dc : S.q.concat(S.qr)).find((x) => x.id === +id);
      if (item && body.base_updated !== undefined && body.base_updated !== item.updated) {
        const key = kind === 'decisions' ? 'decision' : 'question';
        calls.push('POST ' + new URL(req.url()).pathname + ' ' + req.postData());
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'That ' + key + ' changed since you read it.', [key]: item }) });
      }
      // a write moves updated, a signature does not (as the server)
      if (item && !(kind === 'decisions' && body.action !== 'edit')) item.updated += 1;
      return route.fallback();
    });
  };
  for (const [label, o] of [['board-stale-edit', {}], ['board-stale-edit-phone', { w: 390, h: 844, touch: true }]]) {
    await run(label, o, async (page, S, calls) => {
      await staleRefusing(page, S, calls);
      if (o.w) { await page.click('#menu'); await settle(page); }
      await page.click('.tab[data-tab="decisions"]'); await settle(page);
      const card = '#dcList .card:has-text("Huaca Pucllana")';
      await page.click(card + ' button:has-text("Edit")'); await settle(page);
      // an open form shows its text in fields, which has-text does not read
      const form = '#dcList .card:has(form.edit)';
      await page.fill(form + ' textarea', 'Then a ceviche lunch in Miraflores.');
      // meanwhile Henry rewrites the note
      const base = S.dc[0].updated;
      S.dc[0].note = 'Henry: dinner moved to Barranco at 8.'; S.dc[0].updated = base + 50;
      const from = calls.length;
      await page.click(form + ' button:has-text("Save changes")');
      await page.waitForSelector(form + ' .stale-note', { timeout: 5000 });
      await settle(page);
      const first = calls.slice(from).find((c) => /^POST .*\/decisions\/1 /.test(c)) || '';
      must(first.includes('"base_updated":' + base), 'the edit sends the copy\'s updated: ' + first);
      const line = (await page.textContent(form + ' .stale-note')).replace(/\s+/g, ' ');
      must(/changed this while you were editing/.test(line) && line.includes('Henry: dinner moved to Barranco at 8.'), 'the form says so and shows their text: ' + line);
      const typed = await page.$eval(form + ' textarea', (t) => t.value);
      must(typed === 'Then a ceviche lunch in Miraflores.', 'the typed text is kept: ' + typed);
      must(S.dc[0].note === 'Henry: dinner moved to Barranco at 8.', 'nothing was written over theirs');
      await shot(page, label + '.png');
      // saving again goes on top of theirs, from its updated
      const again = calls.length;
      await page.click(form + ' button:has-text("Save changes")');
      await page.waitForSelector('#dcList form.edit', { state: 'detached', timeout: 5000 });
      await settle(page);
      const second = calls.slice(again).find((c) => /^POST .*\/decisions\/1 /.test(c)) || '';
      must(second.includes('"base_updated":' + (base + 50)), 'the second save sends the new base: ' + second);
      const note = await page.textContent(card + ' .card-text');
      must(note === 'Then a ceviche lunch in Miraflores.' && S.dc[0].note === note, 'the second save went through: ' + note);
      return { line, typed, note };
    });
  }
  // A sign from a stale copy: the decision was reworded after the card was
  // drawn. The sign is refused, nothing is signed, and the card shows the
  // decision as it is now with a line saying why; signing again then works.
  for (const [label, o] of [['board-stale-sign', {}], ['board-stale-sign-phone', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, o, async (page, S, calls) => {
      await staleRefusing(page, S, calls);
      if (o.w) { await page.click('#menu'); await settle(page); }
      await page.click('.tab[data-tab="decisions"]'); await settle(page);
      const card = '#dcList .card:has-text("Digests rotate")';
      const base = S.dc[1].updated;
      S.dc[1].title = 'Digests rotate by who posted last'; S.dc[1].note = 'Changed after the vote.'; S.dc[1].updated = base + 70;
      const from = calls.length;
      await page.click(card + ' button:has-text("Sign")');
      await page.waitForSelector('#dcList .card .stale-note', { timeout: 5000 });
      await settle(page);
      const post = calls.slice(from).find((c) => /^POST .*\/decisions\/2 /.test(c)) || '';
      must(post.includes('"base_updated":' + base), 'the sign sends the copy\'s updated: ' + post);
      must(S.dc[1].signers.length === 0, 'nothing was signed: ' + JSON.stringify(S.dc[1].signers));
      const fresh = page.locator('#dcList .card:has(.stale-note)');
      const title = await fresh.locator('.card-title').textContent();
      must(title === 'Digests rotate by who posted last', 'the card shows the decision as it is now: ' + title);
      await shot(page, label + '.png');
      await fresh.locator('button:has-text("Sign")').click(); await settle(page);
      must(S.dc[1].signers.includes('Anthony'), 'signing the fresh card goes through');
      must(!(await page.locator('#dcList .stale-note').count()), 'the line clears once a write goes through');
      return { title, signers: S.dc[1].signers };
    });
  }
  // The resolve form's stale box: a resolution does not replace the
  // question's text, so it says what saving again does instead (it used
  // the edit form's "put it in place of theirs").
  for (const [label, o] of [['board-stale-resolve', {}], ['board-stale-resolve-phone', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run(label, o, async (page, S, calls) => {
      S.q[0].updated = S.dc[0].updated;
      await staleRefusing(page, S, calls);
      await page.reload(); await settle(page);
      if (o.w) { await page.click('#menu'); await settle(page); }
      await page.click('.tab[data-tab="questions"]'); await settle(page);
      const card = '#qList .card:has-text("Who books the dinner")';
      await page.click(card + ' button:has-text("Resolve")'); await settle(page);
      const form = '#qList .card:has(form.edit)';
      await page.fill(form + ' textarea', 'Henry booked it for 8.');
      // meanwhile Ada rewords the question
      S.q[0].text = 'Who books the dinner reservation in Barranco?'; S.q[0].updated += 40;
      await page.click(form + ' button:has-text("Mark resolved")');
      await page.waitForSelector(form + ' .stale-note', { timeout: 5000 });
      await settle(page);
      const line = (await page.textContent(form + ' .stale-note')).replace(/\s+/g, ' ');
      must(line.includes('Who books the dinner reservation in Barranco?'), 'the box shows the question as it reads now: ' + line);
      must(line.includes('Save again to resolve it as it now reads, or cancel.') && !/in place of theirs/.test(line), 'the box says what saving again does: ' + line);
      must(S.q[0].status === 'open', 'nothing was resolved');
      await page.evaluate((f) => document.querySelector(f).scrollIntoView({ block: 'center' }), form);
      await shot(page, label + '.png');
      await page.click(form + ' button:has-text("Mark resolved")');
      await page.waitForSelector('#qList form.edit', { state: 'detached', timeout: 5000 });
      must(S.qr[0].id === 1 && S.qr[0].resolution === 'Henry booked it for 8.', 'saving again resolves it: ' + JSON.stringify(S.qr[0]));
      return { line };
    });
  }
  // The card's "This is how it reads now" line describes the copy a
  // refusal brought back. When a later edit by someone else reaches the
  // board (a board reload), the card shows that instead and the line
  // goes. Before, it stayed until a write from this tab went through.
  await run('board-stale-line-clears', {}, async (page, S, calls) => {
    S.boardRev = 4;
    S.streamRetry = 150;
    await staleRefusing(page, S, calls);
    await page.reload(); await settle(page);
    await page.click('.tab[data-tab="decisions"]'); await settle(page);
    const base = S.dc[1].updated;
    S.dc[1].title = 'Digests rotate by who posted last'; S.dc[1].updated = base + 70;
    await page.click('#dcList .card:has-text("Digests rotate") button:has-text("Sign")');
    await page.waitForSelector('#dcList .card .stale-note', { timeout: 5000 });
    await settle(page);
    // Henry edits it again; the board reloads on board_rev
    S.dc[1].title = 'Digests rotate weekly'; S.dc[1].updated = base + 90;
    S.boardRev = 5;
    await page.waitForFunction(() => /Digests rotate weekly/.test(document.getElementById('dcList').textContent), null, { timeout: 8000 }).catch(() => { throw new Error('the board did not reload'); });
    await settle(page);
    const out = { lines: await page.locator('#dcList .stale-note').count() };
    must(out.lines === 0, 'the line goes once the board has a newer copy: ' + JSON.stringify(out));
    S.streamRetry = 0;
    return out;
  });
  // A text-only edit by someone else (a decision's note, which no list in
  // room_state carries) shows on an open board when room_state's board_rev
  // moves. Before, the board reloaded only when its room_state lists
  // changed, so the old note stayed until a reload. A room object from
  // before board_rev sends none: the lists still key the reload then.
  await run('board-rev-reload', {}, async (page, S, calls) => {
    S.boardRev = 4;
    S.streamRetry = 150;
    await page.reload(); await settle(page);
    await page.click('.tab[data-tab="decisions"]'); await settle(page);
    const card = '#dcList .card:has-text("Huaca Pucllana")';
    const from = calls.length;
    S.dc[0].note = 'Edited elsewhere: lunch at noon.';
    S.boardRev = 5;
    await page.waitForFunction(() => /Edited elsewhere/.test(document.getElementById('dcList').textContent), null, { timeout: 8000 }).catch(() => {});
    const note = await page.textContent(card + ' .card-text');
    must(note === 'Edited elsewhere: lunch at noon.', 'the open board shows the edited note: ' + note);
    must(calls.slice(from).some((c) => /^GET .*\/decisions/.test(c)), 'board_rev reloaded the board');
    S.streamRetry = 0;
    return { note };
  });
  await run('board-rev-absent', {}, async (page, S) => {
    S.streamRetry = 150;
    await page.reload(); await settle(page);
    await page.click('.tab[data-tab="questions"]'); await settle(page);
    S.q[0].text = 'Who books the dinner, and for how many?';
    await page.waitForFunction(() => /for how many/.test(document.getElementById('qList').textContent), null, { timeout: 8000 }).catch(() => {});
    const titles = await page.$$eval('#qList .card-title', (e) => e.map((x) => x.textContent));
    must(titles.includes('Who books the dinner, and for how many?'), 'without board_rev the lists still reload the board: ' + JSON.stringify(titles));
    S.streamRetry = 0;
    return { titles };
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

  // The room's stream stays open (heldStream) and goes silent, as a
  // half-open connection does after a phone sleeps or changes networks.
  // Moves the page's clock on by ms from the real time (not stacked).
  const skew = (page, ms) => page.evaluate((d) => { if (!window.__realNow) window.__realNow = Date.now; Date.now = () => window.__realNow.call(Date) + d; }, ms);
  const streams = (page) => page.evaluate(() => window.__streams.map((x) => (x.open ? 'open' : x.aborted ? 'aborted' : 'ended')));
  const waitStreams = async (page, n, ms) => { for (let t = 0; t < ms / 50 && (await streams(page)).length < n; t++) await page.waitForTimeout(50); return streams(page); };

  // A stream that has said nothing for three of the server's pings is
  // dropped and reopened from its cursor, and a message posted meanwhile
  // shows. Back in view after a long silence (the device slept, so the
  // check had not run) or back online, it reopens at once; a tab that was
  // only hidden for a moment keeps its stream, and several wake-ups at
  // once reopen it once. Before, nothing watched the stream: the room said
  // "live" while nothing arrived until a reload.
  await run('stream-stall-reopens', { init: heldStream }, async (page, S, calls) => {
    S.streamRetry = 300;
    await page.reload(); await settle(page);
    must(JSON.stringify(await streams(page)) === '["open"]', 'one stream, open: ' + JSON.stringify(await streams(page)));
    S.msgs.push({ id: 120, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Ada', kind: 'agent', text: 'Posted while the line was dead.' });
    // 50 s of silence: the stall check (every 5 s) drops it
    await skew(page, 50e3);
    await page.waitForSelector('.msg[data-id="120"]', { state: 'attached', timeout: 9000 }).catch(() => { throw new Error('the silent stream was never reopened: ' + JSON.stringify(calls.filter((c) => /stream/.test(c)))); });
    const afterStall = await streams(page);
    must(JSON.stringify(afterStall) === '["aborted","open"]', 'the dead stream is dropped and one reopens: ' + JSON.stringify(afterStall));
    must((await page.$$('.msg[data-id="120"]')).length === 1, 'the message shows once');
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('live'), null, { timeout: 3000 });
    // a moment hidden: the stream is fresh and stays
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(700);
    must((await streams(page)).length === 2, 'a short hide keeps the stream: ' + JSON.stringify(await streams(page)));
    // back in view after 30 s of silence (under the stall check's 45)
    await skew(page, 80e3);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const woke = await waitStreams(page, 3, 2500);
    must(JSON.stringify(woke) === '["aborted","aborted","open"]', 'waking after a long silence reopens it: ' + JSON.stringify(woke));
    // back online, three times at once: one reopen
    await page.waitForTimeout(300);
    await page.evaluate(() => { for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('online')); });
    await waitStreams(page, 4, 2500);
    await page.waitForTimeout(800);
    const online = await streams(page);
    must(JSON.stringify(online) === '["aborted","aborted","aborted","open"]', 'online reopens it once: ' + JSON.stringify(online));
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('live'), null, { timeout: 3000 });
    S.streamRetry = 0;
    return { streams: online.length };
  });

  // Reactions, members and matches that changed while the stream was down
  // show once it reopens: reaction, members and game frames are live only,
  // and the reconnect replays only messages. A reaction frame that lands
  // while the re-read is out wins over the read. Before, the chips kept
  // their old counts and the avatar its old picture until a reload.
  await run('stream-resync-after-drop', { init: heldStream, state: { game: true } }, async (page, S, calls) => {
    S.streamRetry = 300;
    await page.reload(); await settle(page);
    const chips = (id) => page.$$eval('.msg[data-id="' + id + '"] .rx-chip', (bs) => bs.map((b) => b.dataset.rx + b.textContent.replace(/\D/g, '')).join(' '));
    const before = { m3: await chips(3), m5: await chips(5) };
    // while the stream is down: two votes, a new avatar, and the match moves
    S.msgs.find((m) => m.id === 5).reactions = { '🎉': ['Ada', 'Henry'] };
    S.msgs.find((m) => m.id === 3).reactions = { '👍': ['Henry'] };
    S.mb.members.find((m) => m.name === 'Henry').avatar = 'https://chat.victorio.cloud/api/rooms/demo/avatars/Henry?v=2';
    // the re-read is held until a reaction frame has landed on row 3
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = [];
    await page.route(/\/api\/rooms\/demo\/messages\?/, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== '/api/rooms/demo/messages' || u.searchParams.has('after') || /^(1|200)$/.test(u.searchParams.get('limit') || '')) return route.fallback();
      held.push(u.search);
      await gate;
      return route.fallback();
    });
    const from = calls.length;
    await page.evaluate(() => window.__streams[0].end());
    for (let i = 0; i < 100 && !held.length; i++) await page.waitForTimeout(50);
    must(held.length === 1, 'the reopen re-reads the rows on screen: ' + JSON.stringify(calls.slice(from)));
    const frame = { type: 'reaction', room: 'demo', id: 3, reactions: { '👍': ['Henry', 'Ada'], '🔥': ['Ada'] } };
    await page.evaluate((f) => window.__streams[window.__streams.length - 1].send('event: reaction\ndata: ' + JSON.stringify(f) + '\n\n'), frame);
    await page.waitForFunction(() => !!document.querySelector('.msg[data-id="3"] .rx-chip[data-rx="🔥"]'), null, { timeout: 3000 });
    release();
    await page.waitForFunction(() => !!document.querySelector('.msg[data-id="5"] .rx-chip[data-rx="🎉"]'), null, { timeout: 5000 }).catch(() => { throw new Error('the vote from the gap never showed: ' + JSON.stringify(calls.slice(from))); });
    await settle(page);
    const after = { m3: await chips(3), m5: await chips(5) };
    must(after.m5 === '🎉2', 'row 5 shows the read reactions: ' + after.m5);
    must(after.m3 === '👍2 🔥1', 'row 3 keeps the newer frame, not the read: ' + after.m3);
    const avatar = await page.$eval('.msg .avatar[data-name="Henry"] img', (i) => i.getAttribute('src')).catch(() => null);
    must(/v=2/.test(avatar || ''), 'the new avatar shows: ' + avatar);
    const later = calls.slice(from);
    must(later.some((c) => /^GET \/api\/rooms\/demo\/members/.test(c)), 'the members are read again: ' + JSON.stringify(later));
    must(later.some((c) => /^GET \/api\/rooms\/demo\/games\/1\b/.test(c)), 'the live match is read again: ' + JSON.stringify(later));
    S.streamRetry = 0;
    return { before, after, read: held[0] };
  });

  // The person's own tap wins over a re-sync read that was sent before it
  // and answered after it. The tap and its POST's answer did not mark the
  // row, so the read put the old chips back over the new reaction.
  await run('stream-resync-keeps-own-tap', { init: heldStream }, async (page, S, calls) => {
    S.streamRetry = 300;
    await page.reload(); await settle(page);
    const chips = (id) => page.$$eval('.msg[data-id="' + id + '"] .rx-chip', (bs) => bs.map((b) => b.dataset.rx + b.textContent.replace(/\D/g, '') + (b.classList.contains('mine') ? '*' : '')).join(' '));
    const before = await chips(3);
    must(before === '👍2* ❤️1 🦄1', 'row 3 as loaded: ' + before);
    // the re-read is held, and answers with the rows as they were when it
    // was sent, before the tap
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = [];
    await page.route(/\/api\/rooms\/demo\/messages\?/, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== '/api/rooms/demo/messages' || u.searchParams.has('after') || /^(1|200)$/.test(u.searchParams.get('limit') || '')) return route.fallback();
      const then = JSON.parse(JSON.stringify(S.msgs)).sort((a, b) => a.id - b.id).slice(-Number(u.searchParams.get('limit') || 50));
      held.push(u.search);
      await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ room: 'demo', messages: then, you: 'Anthony', you_kind: 'human' }) });
    });
    const from = calls.length;
    await page.evaluate(() => window.__streams[0].end());
    for (let i = 0; i < 100 && !held.length; i++) await page.waitForTimeout(50);
    must(held.length === 1, 'the reopen re-reads the rows on screen: ' + JSON.stringify(calls.slice(from)));
    await page.click('.msg[data-id="3"] .rx-chip[data-rx="🦄"]');
    await page.waitForFunction(() => { const c = document.querySelector('.msg[data-id="3"] .rx-chip[data-rx="🦄"]'); return c && c.classList.contains('mine'); }, null, { timeout: 3000 });
    for (let i = 0; i < 100 && !calls.slice(from).some((c) => /^POST \/api\/rooms\/demo\/messages\/3\/reactions/.test(c)); i++) await page.waitForTimeout(50);
    await settle(page);
    const tapped = await chips(3);
    release();
    // the read lands (the members re-read runs beside it)
    await page.waitForTimeout(800);
    await settle(page);
    const after = await chips(3);
    must(tapped === '👍1 ❤️1 🦄2*', 'the tap shows: ' + tapped);
    must(after === tapped, 'the held read does not put the old chips back: ' + after);
    S.streamRetry = 0;
    return { before, tapped, after };
  });

  // A stream that fails right after the page's first load and then opens
  // re-syncs too: "the first open" used to be the first that answered, so
  // the page came up without the reactions, members and matches that
  // changed while the stream was failing.
  await run('stream-resync-after-failed-first-open', { init: heldStream }, async (page, S, calls) => {
    S.streamRetry = 300;
    let fails = 1;
    await page.route(/\/api\/rooms\/demo\/stream\?/, (route) => (fails-- > 0 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"overloaded"}' }) : route.fallback()));
    const from = calls.length;
    await page.reload();
    await page.waitForSelector('.msg[data-id="5"]', { timeout: 5000 });
    // a vote while the stream is failing
    S.msgs.find((m) => m.id === 5).reactions = { '🎉': ['Ada', 'Henry'] };
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('live'), null, { timeout: 8000 }).catch(() => { throw new Error('the stream never opened: ' + JSON.stringify(calls.slice(from))); });
    must(fails < 0, 'the first stream failed');
    await page.waitForFunction(() => !!document.querySelector('.msg[data-id="5"] .rx-chip[data-rx="🎉"]'), null, { timeout: 5000 }).catch(() => { throw new Error('the vote from the failing spell never showed: ' + JSON.stringify(calls.slice(from))); });
    const later = calls.slice(from);
    const opened = later.map((c) => /\/stream\?/.test(c)).lastIndexOf(true);
    must(later.slice(opened).some((c) => /^GET \/api\/rooms\/demo\/members/.test(c)), 'the members are read again once it opens: ' + JSON.stringify(later));
    S.streamRetry = 0;
    return { streams: later.filter((c) => /\/stream\?/.test(c)).length };
  });

  // A message deleted while the tab watches (or while it was away: a
  // delete frame replays with the messages) leaves the feed, its clip and
  // its reading aloud stop, its reaction bar closes, and a reconnect
  // resumes after the delete's own number. Before, the stream sent no
  // delete and the row stayed on every open screen until a reload.
  await run('stream-delete-frame', { init: heldStream }, async (page, S, calls) => {
    const base = S.msgs[S.msgs.length - 1];
    S.msgs.push({ id: 40, ts: base.ts + 1000, from: 'Ada', kind: 'agent', text: 'A voice note.', audio: { type: 'audio/mpeg', bytes: 22100, url: '/api/rooms/demo/messages/40/audio?exp=1&sig=x' } });
    // the reconnect delay the stream hands out, read when it opens
    S.streamRetry = 200;
    await page.reload(); await settle(page);
    await page.waitForSelector('.msg[data-id="40"] audio', { state: 'attached', timeout: 5000 });
    // the clip "plays" and the row is being read aloud
    await page.evaluate(() => {
      window.__paused = 0; window.__cancels = 0;
      const a = document.querySelector('.msg[data-id="40"] audio');
      Object.defineProperty(a, 'paused', { configurable: true, get: () => false });
      a.pause = () => { window.__paused++; };
      // a headless browser has no voice and fails the utterance at once:
      // here it is taken and "spoken" until cancelled
      if (window.speechSynthesis) { window.speechSynthesis.speak = () => {}; window.speechSynthesis.cancel = () => { window.__cancels++; }; }
    });
    const speak = await page.$('.msg[data-id="40"] button.speak');
    // read aloud where this browser has a voice (headless ones may not)
    if (speak) await speak.click();
    const speaking = !!(await page.waitForSelector('.msg[data-id="40"] button.speak.on', { timeout: 1500 }).catch(() => null));
    await page.hover('.msg[data-id="40"]'); await page.click('.msg[data-id="40"] .react-btn'); await settle(page);
    must(await page.$('.rx-bar'), 'the reaction bar is open on the row');
    const cancels0 = await page.evaluate(() => window.__cancels);
    S.msgs = S.msgs.filter((m) => m.id !== 40);
    const frame = { type: 'delete', room: 'demo', from: 'Ada', kind: 'agent', targets: [], id: 40 };
    await page.evaluate((f) => window.__streams[0].send('id: 57\nevent: delete\ndata: ' + JSON.stringify(f) + '\n\n'), frame);
    await page.waitForSelector('.msg[data-id="40"]', { state: 'detached', timeout: 3000 }).catch(() => { throw new Error('the deleted row stayed on screen'); });
    await settle(page);
    const out = { paused: await page.evaluate(() => window.__paused), cancels: (await page.evaluate(() => window.__cancels)) - cancels0, bar: !!(await page.$('.rx-bar')), speaking };
    must(out.paused >= 1, 'its clip stopped: ' + JSON.stringify(out));
    must(speaking && out.cancels >= 1, 'its reading aloud stopped: ' + JSON.stringify(out));
    must(!out.bar, 'the reaction bar on it closed: ' + JSON.stringify(out));
    must(await page.$('.msg[data-id="5"]'), 'the other rows stay');
    // the reconnect resumes after the delete's own number
    S.streamRetry = 200;
    const from = calls.length;
    await page.evaluate(() => window.__streams[0].end());
    for (let i = 0; i < 60 && !calls.slice(from).some((c) => /\/stream\?/.test(c)); i++) await page.waitForTimeout(50);
    const reopen = calls.slice(from).filter((c) => /\/stream\?/.test(c));
    must(reopen.length >= 1 && /[?&]after=57&/.test(reopen[0]), 'the reconnect asks after the delete: ' + JSON.stringify(reopen));
    must(/events=[^&\s]*delete/.test(reopen[0]) && /events=[^&\s]*gap/.test(reopen[0]), 'the stream asks for delete and gap frames: ' + reopen[0]);
    S.streamRetry = 0;
    return out;
  });

  // A tab whose cursor is older than what the room keeps gets a gap frame:
  // the newest page is read again, the rows it brings show under one quiet
  // divider, and a held row the read no longer returns (deleted while the
  // tab was away) leaves. Before, the old history was joined straight
  // onto the new with no sign of the hole.
  for (const [tag, w, h, scheme] of [['', 1280, 860, 'light'], ['-phone', 390, 844, 'dark']]) {
    await run('stream-gap-divider' + tag, { init: heldStream, w, h, scheme, touch: !!tag }, async (page, S, calls) => {
      // the reconnect delay the stream hands out, read when it opens
      S.streamRetry = 200;
      await page.reload(); await settle(page);
      const top = Math.max(...(await page.$$eval('.msg', (rs) => rs.map((r) => +r.dataset.id))));
      // the tab slept and its stream dropped: the gap comes on the reconnect
      // (a gap on the boot's own stream, before any frame, is ignored:
      // stream-gap-at-boot)
      await page.evaluate(() => window.__streams[0].end());
      await page.waitForFunction(() => window.__streams.length >= 2 && window.__streams[1].open, null, { timeout: 5000 });
      S.streamRetry = 0;
      await settle(page);
      const sid = await page.evaluate(() => window.__streams.length - 1);
      // while the tab slept: row 2 was deleted and many messages came; the
      // room keeps the newest, from 1500 on
      S.msgs = S.msgs.filter((m) => m.id !== 2);
      const base = S.msgs[S.msgs.length - 1].ts;
      for (let i = 0; i < 6; i++) S.msgs.push({ id: 1500 + i, ts: base + 60e3 * (i + 1), from: i % 2 ? 'Henry' : 'Ada', kind: 'agent', text: 'Back on line ' + (i + 1) + '.' });
      const from = calls.length;
      const gap = 'event: gap\ndata: ' + JSON.stringify({ type: 'gap', room: 'demo', from: null, kind: null, targets: [], after: top, through: 1499 }) + '\n\n';
      await page.evaluate(([t, i]) => window.__streams[i].send(t), [gap, sid]);
      await page.waitForSelector('.msg[data-id="1505"]', { state: 'attached', timeout: 5000 }).catch(() => { throw new Error('the gap did not re-read the newest page: ' + JSON.stringify(calls.slice(from))); });
      await page.waitForSelector('.gap-sep', { timeout: 3000 });
      await settle(page);
      // the feed in page order, the divider as "|"
      const order = () => page.$$eval('.msg, .gap-sep', (rs) => rs.map((r) => (r.classList.contains('gap-sep') ? '|' : r.dataset.id)).join(' '));
      const seps = () => page.$$eval('.gap-sep', (rs) => rs.map((r) => r.textContent));
      const first = { order: await order(), seps: await seps() };
      const reads = calls.slice(from).filter((c) => /^GET \/api\/rooms\/demo\/messages\?limit=200$/.test(c));
      must(first.seps.length === 1 && first.seps[0] === 'Some earlier messages were not loaded', 'one divider: ' + JSON.stringify(first));
      must(first.order.includes(' ' + top + ' | 1500 '), 'the divider sits between the rows the tab had and the rows it read: ' + JSON.stringify(first));
      must(!/(^| )2 /.test(first.order), 'the row deleted while away leaves: ' + JSON.stringify(first));
      must(reads.length === 1, 'the newest page is read again, once: ' + JSON.stringify(calls.slice(from)));
      await page.evaluate(() => document.querySelector('.gap-sep').scrollIntoView({ block: 'center' }));
      await settle(page);
      await shot(page, 'stream-gap-divider' + tag + '.png');
      // another long sleep, another gap: still one divider, at the new hole
      for (let i = 0; i < 3; i++) S.msgs.push({ id: 1600 + i, ts: base + 60e3 * (i + 20), from: 'Ada', kind: 'agent', text: 'Later still ' + (i + 1) + '.' });
      await page.evaluate(([t, i]) => window.__streams[i].send(t), [gap.replace('"through":1499', '"through":1599'), sid]);
      await page.waitForSelector('.msg[data-id="1602"]', { state: 'attached', timeout: 5000 });
      await settle(page);
      const second = { order: await order(), seps: await seps() };
      must(second.seps.length === 1 && second.order.includes(' 1505 | 1600 '), 'one divider, at the newest hole: ' + JSON.stringify(second));
      return { first: first.order, second: second.order };
    });
  }

  // A gap on a feed with no rows (an empty room that once dropped
  // something) has nothing out of date: no read, no divider.
  await run('stream-gap-empty-feed', { init: heldStream }, async (page, S, calls) => {
    S.msgs = [];
    await page.route(/\/api\/rooms\/demo\/messages\?limit=200$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ room: 'demo', messages: [], last_id: 0, you: 'Anthony', you_kind: 'human' }) }));
    await page.reload(); await settle(page);
    await page.waitForSelector('.chat-empty', { timeout: 5000 });
    const from = calls.length;
    const gap = 'event: gap\ndata: ' + JSON.stringify({ type: 'gap', room: 'demo', from: null, kind: null, targets: [], after: 0, through: 1200 }) + '\n\n';
    await page.evaluate((t) => window.__streams[window.__streams.length - 1].send(t), gap);
    await page.waitForTimeout(500);
    await settle(page);
    const out = { seps: (await page.$$('.gap-sep')).length, empty: !!(await page.$('.chat-empty')), reads: calls.slice(from).filter((c) => /^GET \/api\/rooms\/demo\/messages/.test(c)) };
    must(out.seps === 0 && out.empty && out.reads.length === 0, 'the gap is ignored: ' + JSON.stringify(out));
    return out;
  });

  // A gap as the first frame of the stream opened right after the boot
  // read is not a hole: the boot page is the room's newest page. The
  // server sends one there when over 1,000 messages after the newest live
  // one were posted and deleted (its forgotten mark sits above the boot's
  // last_id). Before, every page load drew a false divider and read the
  // page again. After a message frame, a gap still marks the hole.
  await run('stream-gap-at-boot', { init: heldStream }, async (page, S, calls) => {
    await page.reload(); await settle(page);
    const top = Math.max(...(await page.$$eval('.msg', (rs) => rs.map((r) => +r.dataset.id))));
    const gap = (through) => 'event: gap\ndata: ' + JSON.stringify({ type: 'gap', room: 'demo', from: null, kind: null, targets: [], after: top, through }) + '\n\n';
    const reads = (from) => calls.slice(from).filter((c) => /^GET \/api\/rooms\/demo\/messages\?limit=200$/.test(c));
    const from = calls.length;
    await page.evaluate((t) => window.__streams[0].send(t), gap(top + 1001));
    await page.waitForTimeout(600);
    await settle(page);
    const boot = { seps: (await page.$$('.gap-sep')).length, reads: reads(from).length };
    must(boot.seps === 0 && boot.reads === 0, 'a gap right after the boot read is ignored: ' + JSON.stringify(boot));
    // a message frame, then a gap: the cursor has moved, the hole is real
    const m = { id: top + 1, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Ada', kind: 'agent', text: 'Fresh after boot.' };
    S.msgs.push(m);
    await page.evaluate((t) => window.__streams[0].send(t), 'id: ' + m.id + '\nevent: message\ndata: ' + JSON.stringify(m) + '\n\n');
    await page.waitForSelector('.msg[data-id="' + m.id + '"]', { timeout: 3000 });
    const from2 = calls.length;
    await page.evaluate((t) => window.__streams[0].send(t), gap(top + 2001));
    await page.waitForSelector('.gap-sep', { timeout: 5000 }).catch(() => { throw new Error('a gap after a message frame drew no divider'); });
    await settle(page);
    const later = { seps: (await page.$$('.gap-sep')).length, reads: reads(from2).length };
    must(later.seps === 1 && later.reads === 1, 'a gap after a message frame still marks the hole: ' + JSON.stringify(later));
    return { boot, later };
  });

  // A delete frame that lands while a gap's re-read is out: the answer,
  // built before the delete, still carries the row. Before, the merge put
  // it back and it stayed until a reload.
  await run('stream-gap-merge-deleted', { init: heldStream }, async (page, S) => {
    await page.reload(); await settle(page);
    const ids = await page.$$eval('.msg', (rs) => rs.map((r) => +r.dataset.id));
    const top = Math.max(...ids);
    const victim = ids[ids.length - 2];
    // a message frame first: the gap below is a real hole (stream-gap-at-boot)
    const m = { id: top + 1, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Ada', kind: 'agent', text: 'Before the gap.' };
    S.msgs.push(m);
    await page.evaluate((t) => window.__streams[0].send(t), 'id: ' + m.id + '\nevent: message\ndata: ' + JSON.stringify(m) + '\n\n');
    await page.waitForSelector('.msg[data-id="' + m.id + '"]', { timeout: 3000 });
    // the re-read's answer is built when it is asked for (the row still
    // there), then held back
    let release; const gate = new Promise((r) => { release = r; });
    const asked = { n: 0 };
    await page.route(/\/api\/rooms\/demo\/messages\?limit=200$/, async (route) => {
      asked.n++;
      const rows = [...S.msgs].sort((a, b) => a.id - b.id).slice(-200);
      const body = JSON.stringify({ room: 'demo', messages: rows, last_id: rows[rows.length - 1].id, you: 'Anthony', you_kind: 'human' });
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    const gap = 'event: gap\ndata: ' + JSON.stringify({ type: 'gap', room: 'demo', from: null, kind: null, targets: [], after: top, through: top + 1001 }) + '\n\n';
    await page.evaluate((t) => window.__streams[0].send(t), gap);
    for (let i = 0; i < 100 && !asked.n; i++) await page.waitForTimeout(30);
    must(asked.n === 1, 'the gap re-reads the newest page');
    await page.waitForTimeout(200);
    // the delete frame, while the read is out
    S.msgs = S.msgs.filter((x) => x.id !== victim);
    const frame = { type: 'delete', room: 'demo', from: 'Ada', kind: 'agent', targets: [], id: victim };
    await page.evaluate((t) => window.__streams[0].send(t), 'id: ' + (top + 2002) + '\nevent: delete\ndata: ' + JSON.stringify(frame) + '\n\n');
    await page.waitForSelector('.msg[data-id="' + victim + '"]', { state: 'detached', timeout: 3000 });
    release();
    await page.waitForSelector('.gap-sep', { timeout: 5000 });
    await page.waitForTimeout(300);
    await settle(page);
    const out = { back: !!(await page.$('.msg[data-id="' + victim + '"]')), rows: (await page.$$('.msg')).length };
    must(!out.back, 'the deleted row stays gone after the merge: ' + JSON.stringify(out));
    return out;
  });

  // Every send carries one client_msg_id that stays with the unsent
  // message through its retries. The posts sent so far, as [id, text].
  const posts = (calls, from) => calls.slice(from || 0).filter((c) => /^POST \/api\/rooms\/demo\/messages \{/.test(c)).map((c) => { const b = JSON.parse(c.slice(c.indexOf('{'))); return [b.client_msg_id, b.text]; });
  const rowsWith = (page, t) => page.$$eval('.msg', (rs, tx) => rs.filter((r) => r.textContent.includes(tx)).length, t);
  const idle = (page) => page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 15000 });

  // The post lands but its answer is lost: the composer sends it again
  // with the same id, the server answers with the first post (repeat),
  // and the message shows once. Before, there was no id: the error
  // showed, and sending again posted it twice.
  await run('send-answer-lost', { allowConsole: /ERR_FAILED/ }, async (page, S, calls) => {
    S.postAnswers = ['lost'];
    const from = calls.length;
    await page.fill('#text', 'Only once, please.');
    await page.click('#send');
    await idle(page);
    await settle(page);
    const out = { posts: posts(calls, from), rows: await rowsWith(page, 'Only once, please.'), err: await page.$eval('#err', (e) => (e.hidden ? '' : e.textContent)), box: await page.$eval('#text', (t) => t.value) };
    must(out.posts.length === 2 && out.posts[0][0] && out.posts.every((x) => x[0] === out.posts[0][0]), 'the retry carries the same id: ' + JSON.stringify(out.posts));
    must(out.rows === 1 && !out.err && out.box === '', 'one row, no error, the box clears: ' + JSON.stringify(out));
    return out;
  });

  // Every automatic try is lost: the error shows and the text stays.
  // Pressing Send again carries the same id and gets the first post back:
  // one row. A new message then gets a new id.
  await run('send-again-same-id', { allowConsole: /ERR_FAILED/ }, async (page, S, calls) => {
    S.postAnswers = ['lost', 'lost', 'lost', 'lost'];
    const from = calls.length;
    await page.fill('#text', 'Sent through a bad line.');
    await page.click('#send');
    await page.waitForSelector('#err:not([hidden])', { timeout: 15000 });
    await idle(page);
    const failed = { posts: posts(calls, from).length, box: await page.$eval('#text', (t) => t.value) };
    must(failed.posts === 4 && failed.box === 'Sent through a bad line.', 'four tries, the text kept: ' + JSON.stringify(failed));
    await page.click('#send');
    await idle(page);
    await settle(page);
    await page.fill('#text', 'A different message.');
    await page.click('#send');
    await idle(page);
    await settle(page);
    const all = posts(calls, from);
    const out = { ids: all.map((x) => x[0]), rows: await rowsWith(page, 'Sent through a bad line.'), err: await page.$eval('#err', (e) => e.hidden) };
    must(all.length === 6 && out.ids.slice(0, 5).every((id) => id === out.ids[0]), 'Send again keeps the id: ' + JSON.stringify(all));
    must(out.ids[5] && out.ids[5] !== out.ids[0], 'a new message gets a new id: ' + JSON.stringify(all));
    must(out.rows === 1 && out.err, 'the message shows once and the error is gone: ' + JSON.stringify(out));
    return { tries: all.length };
  });

  // A post with inline media is held while its files store: a 409 naming
  // the id's first post waits and asks again with the same id, and the
  // next answer posts it.
  await run('send-409-media-retried', {}, async (page, S, calls) => {
    S.postAnswers = ['409'];
    const from = calls.length;
    await page.setInputFiles('#imgFile', TESTS + '/../../tests/fixtures/photo.png');
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    await page.fill('#text', 'Waiting on storage.');
    await page.click('#send');
    await idle(page);
    await settle(page);
    const out = { posts: posts(calls, from), rows: await rowsWith(page, 'Waiting on storage.'), err: await page.$eval('#err', (e) => (e.hidden ? '' : e.textContent)) };
    must(out.posts.length === 2 && out.posts[1][0] === out.posts[0][0], 'the same id, asked again: ' + JSON.stringify(out.posts));
    must(out.rows === 1 && !out.err, 'one row, no error: ' + JSON.stringify(out));
    return out;
  });

  // A text post is never held, so a 409 naming its id's first post can
  // only mean that post went live and was deleted since. Pressing Send on
  // text that is not in the room posts it once, under a new id, at once.
  // Before, each Send waited about 7.5 s through four retries and then
  // showed the server's sentence about client_msg_id.
  await run('send-409-gone-text', { allowConsole: /ERR_FAILED/ }, async (page, S, calls) => {
    S.postAnswers = ['lost', 'lost', 'lost', 'lost'];
    await page.fill('#text', 'Posted, then deleted.');
    await page.click('#send');
    await page.waitForSelector('#err:not([hidden])', { timeout: 15000 });
    await idle(page);
    // the first copy landed; someone deletes it
    const firstId = S.msgs[S.msgs.length - 1].id;
    must(S.msgs[S.msgs.length - 1].text === 'Posted, then deleted.', 'the first copy landed');
    S.msgs = S.msgs.filter((m) => m.id !== firstId);
    const from = calls.length;
    const t0 = Date.now();
    await page.click('#send');
    await idle(page);
    const took = Date.now() - t0;
    await settle(page);
    const out = { posts: posts(calls, from), took, rows: await rowsWith(page, 'Posted, then deleted.'), err: await page.$eval('#err', (e) => (e.hidden ? '' : e.textContent)), box: await page.$eval('#text', (t) => t.value) };
    must(out.posts.length === 2 && out.posts[1][0] && out.posts[1][0] !== out.posts[0][0], 'posted once more under a new id: ' + JSON.stringify(out.posts));
    must(took < 3000, 'no wait through retries: ' + took + ' ms');
    must(out.rows === 1 && !out.err && out.box === '', 'one row, no error, the box clears: ' + JSON.stringify(out));
    must(S.msgs.filter((m) => m.text === 'Posted, then deleted.').length === 1, 'the room holds it once');
    return out;
  });

  // A post with files whose first copy is still being stored when the
  // waits run out is not posted again under a new id: that showed the
  // message twice and stored its files twice once the first copy went
  // live. The composer says the files are still being stored and keeps the
  // id, so Send again asks for the same message.
  await run('send-409-media-still-storing', {}, async (page, S, calls) => {
    S.postAnswers = ['409', '409', '409', '409', '409'];
    const from = calls.length;
    await page.setInputFiles('#imgFile', TESTS + '/../../tests/fixtures/photo.png');
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    await page.fill('#text', 'A slow picture.');
    await page.click('#send');
    await page.waitForSelector('#err:not([hidden])', { timeout: 20000 });
    await idle(page);
    const first = { posts: posts(calls, from), err: await page.$eval('#err', (e) => e.textContent), box: await page.$eval('#text', (t) => t.value) };
    must(first.posts.length === 5 && first.posts.every((x) => x[0] && x[0] === first.posts[0][0]), 'five asks, one id: ' + JSON.stringify(first.posts));
    must(/still being stored/.test(first.err) && !/client_msg_id/.test(first.err), 'a plain line: ' + first.err);
    must(first.box === 'A slow picture.', 'the text stays in the box');
    await page.click('#send');
    await idle(page);
    await settle(page);
    const out = { first, posts: posts(calls, from), rows: await rowsWith(page, 'A slow picture.'), err: await page.$eval('#err', (e) => (e.hidden ? '' : e.textContent)) };
    must(out.posts.length === 6 && out.posts[5][0] === out.posts[0][0], 'Send again keeps the id: ' + JSON.stringify(out.posts));
    must(out.rows === 1 && !out.err, 'one row, no error: ' + JSON.stringify(out));
    return out;
  });

  // A room object still on older code sends no code with these 409s: a
  // post with no files is never held, so its 409 can only mean "gone".
  await run('send-409-gone-text-no-code', { allowConsole: /ERR_FAILED/ }, async (page, S, calls) => {
    S.noPostCodes = true;
    S.postAnswers = ['lost', 'lost', 'lost', 'lost'];
    await page.fill('#text', 'Old code, deleted.');
    await page.click('#send');
    await page.waitForSelector('#err:not([hidden])', { timeout: 15000 });
    await idle(page);
    const firstId = S.msgs[S.msgs.length - 1].id;
    S.msgs = S.msgs.filter((m) => m.id !== firstId);
    const from = calls.length;
    await page.click('#send');
    await idle(page);
    await settle(page);
    const out = { posts: posts(calls, from), rows: await rowsWith(page, 'Old code, deleted.'), err: await page.$eval('#err', (e) => (e.hidden ? '' : e.textContent)) };
    must(out.posts.length === 2 && out.posts[1][0] && out.posts[1][0] !== out.posts[0][0], 'posted once more under a new id: ' + JSON.stringify(out.posts));
    must(out.rows === 1 && !out.err, 'one row, no error: ' + JSON.stringify(out));
    return out;
  });

  done('chat');
})();
