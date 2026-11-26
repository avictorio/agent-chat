// UI scenarios: invites, avatars, uploads and the media shelf.
// Run alone: node -r ./tests/system-chromium.js tests/ui/people-media.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { heldStream, settle, FIXTURES, TESTS, done, must, run, shot } = require('./harness');

(async () => {
  await run('invites', {}, async (page, S, calls) => {
    await shot(page, 'kinds-chat.png');
    const tags = await page.$$eval('#msgs .msg-head', hs => hs.map(h => Array.from(h.querySelectorAll('.tag')).map(t => t.textContent).join('+') + ':' + h.querySelector('.who').textContent));
    await page.click('.tab[data-tab="members"]'); await settle(page);
    const formShown = await page.$eval('#invForm', f => !f.hidden);
    const instrCount = await page.$$eval('button', bs => bs.filter(b => b.textContent === 'Copy w/ Instructions').length);
    await shot(page, 'members-desktop.png');
    await page.fill('#invName', 'Matheo'); await page.click('[data-kind="human"]'); await page.click('#invForm button[type=submit]'); await settle(page);
    await shot(page, 'invite-human.png');
    const humanFields = await page.$$eval('#invResult input', i => i.map(x => x.value));
    const humanBtns = await page.$$eval('#invResult button', b => b.map(x => x.textContent));
    await page.fill('#invName', 'Scout'); await page.click('[data-kind="agent"]'); await page.click('#invForm button[type=submit]'); await settle(page);
    await shot(page, 'invite-agent.png');
    const agentFields = await page.$$eval('#invResult input', i => i.map(x => x.value));
    const agentBtns = await page.$$eval('#invResult button', b => b.map(x => x.textContent));
    await page.fill('#invName', 'Ada'); await page.click('#invForm button[type=submit]'); await settle(page);
    const dupToast = await page.$eval('#toast', t => t.hidden ? '' : t.textContent);
    const posts = calls.filter(c => c.startsWith('POST') && c.includes('/invites')).map(c => c.split(' ').slice(2).join(' '));
    return { tags, formShown, instrCount, humanFields, agentFields, humanBtns, agentBtns, dupToast, posts };
  });
  await run('invite-card-mobile-dark', { scheme: 'dark', w: 390, h: 844, hash: '#members' }, async (page) => {
    await page.fill('#invName', 'Scout'); await page.click('[data-kind="agent"]'); await page.click('#invForm button[type=submit]'); await settle(page);
    await shot(page, 'invite-agent-mobile-dark.png');
    return { btns: await page.$$eval('#invResult button', b => b.map(x => x.textContent)) };
  });
  await run('invites-dark-mobile', { scheme: 'dark', w: 390, h: 844, hash: '#members' }, async (page) => { await shot(page, 'members-mobile-dark.png'); });
  /* Leave room: the caller's own row in Members has the control, and its
     dialog says what leaving does. Here the other members leave just
     before (othersLeave), so the server answers the first Leave room with
     409 last_member, which changes nothing: the dialog asks the deletion
     question instead, on a list read again that shows their rows as
     "Left <date>". The second button sends delete_room; then the device
     forgets the room as Home's Forget does (every per-room key, another
     room's kept) and goes home. Each viewport and scheme looks at the
     control, both confirmations and the Left rows. */
  const DEMO_KEYS = ['chat-invite:demo', 'chat-you:demo', 'chat-push-mode:/api/rooms/demo', 'ac-members:demo', 'ac:agent-app:demo', 'chat-upl:demo', 'chat-draft:demo:Anthony'];
  // once per tab (sessionStorage), not again on the home page it ends on
  const seedRoomKeys = () => {
    try {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      for (const [k, v] of [['chat-invite:demo', 'tok_Anthony'], ['chat-you:demo', 'Anthony'], ['chat-push-mode:/api/rooms/demo', 'all'], ['ac:agent-app:demo', '1'], ['chat-upl:demo', '{}'], ['chat-draft:demo:Anthony', 'unsent'], ['chat-invite:lima', 'tok_lima'], ['chat-you:lima', 'Ann']]) localStorage.setItem(k, v);
    } catch { /* the scenario fails visibly */ }
  };
  const leaveText = (page) => page.$eval('#leaveDlg', (d) => d.innerText.replace(/\s+/g, ' ').trim());
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) for (const scheme of ['light', 'dark']) {
    const tag = vp.tag + '-' + scheme;
    await run('leave-room-' + tag, { scheme, w: vp.w, h: vp.h, touch: vp.touch, hash: '#members', init: seedRoomKeys, state: { othersLeave: true } }, async (page, S, calls) => {
      await page.waitForSelector('#mList .card.member', { timeout: 10000 });
      await settle(page);
      const rows = await page.$$eval('#mList .card.member', (cs) => cs.map((c) => c.querySelector('.card-title').textContent + '|' + !!c.querySelector('#leaveRoom')));
      must(rows.filter((r) => r.endsWith('|true')).length === 1 && rows.includes('Anthony (you)|true'), 'Leave room is on the caller\'s own row only: ' + JSON.stringify(rows));
      await page.$eval('#leaveRoom', (b) => b.scrollIntoView({ block: 'center' }));
      await shot(page, 'leave-control-' + tag + '.png');
      await page.click('#leaveRoom');
      await page.waitForSelector('#leaveDlg[open] #leaveYes', { timeout: 4000 });
      const ask = await leaveText(page);
      for (const want of ['Leave demo?', 'You leave the room for good, as Anthony.', 'Your invite link stops working, on every device.', 'Your notifications, wake setups and pending uploads for this room stop.', 'Your picture and your voice are deleted.', 'Your messages and what you wrote on the board stay.', 'Questions you claimed go back to open, and matches waiting for you to accept are called off.', 'Games in progress play out on the clock.', 'Your name can be invited again.']) must(ask.includes(want), 'the dialog says: ' + want + ' / ' + ask);
      const fit = await page.$eval('#leaveDlg', (d) => { const r = d.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), vw: window.innerWidth, doc: document.documentElement.scrollWidth }; });
      must(fit.l >= 0 && fit.r <= fit.vw && fit.doc <= fit.vw + 1, 'the dialog fits the window: ' + JSON.stringify(fit));
      await shot(page, 'leave-ask-' + tag + '.png');
      await page.click('#leaveNo');
      must(await page.$eval('#leaveDlg', (d) => !d.open), 'Cancel closes it');
      must(!(S.leaves || []).length, 'Cancel sends nothing');
      await page.click('#leaveRoom');
      await page.waitForSelector('#leaveDlg[open] #leaveYes', { timeout: 4000 });
      await page.click('#leaveYes');
      await page.waitForSelector('#leaveDlg[open] #leaveDelete', { timeout: 6000 });
      await settle(page);
      const last = await leaveText(page);
      must(last.includes('Delete demo?') && last.includes('You are the last member of demo who has joined. Leaving deletes the room and everything in it, for good: every message, file, board item and game. The 1 invite not yet opened stops working too.') && last.includes('This can\'t be undone.'), 'the deletion question: ' + last);
      must(JSON.stringify(S.leaves) === '[{"confirm":"demo"}]', 'the first press sent no delete_room: ' + JSON.stringify(S.leaves));
      await shot(page, 'leave-last-' + tag + '.png');
      // behind the dialog the list was read again: the members who left show "Left <date>", the owner's removal "Access removed <date>"
      const subs = await page.$$eval('#mList .card.member', (cs) => cs.map((c) => c.querySelector('.card-title').textContent + ': ' + c.querySelector('.card-meta').textContent + ' [' + c.querySelector(':scope > .pill').textContent + ']'));
      must(subs.some((x) => /^Henry: Left \S/.test(x) && x.endsWith('[Left]')) && subs.some((x) => /^Ada: Left \S/.test(x)) && subs.some((x) => /^Old bot: Access removed \S/.test(x) && x.endsWith('[Removed]')), 'the Left rows: ' + JSON.stringify(subs));
      await page.click('#leaveNo');
      await page.$eval('#mList', (l) => [...l.querySelectorAll('.card.member')].find((c) => c.textContent.startsWith('Henry')).scrollIntoView({ block: 'center' }));
      await settle(page);
      await shot(page, 'leave-left-rows-' + tag + '.png');
      await page.click('#leaveRoom');
      await page.waitForSelector('#leaveDlg[open] #leaveDelete', { timeout: 4000 });
      await Promise.all([page.waitForURL('https://chat.victorio.cloud/', { timeout: 10000 }), page.click('#leaveDelete')]);
      await page.waitForSelector('#view-rooms:not([hidden]) #roomlist', { timeout: 10000 });
      await settle(page);
      must(JSON.stringify(S.leaves.slice(-1)) === '[{"confirm":"demo","delete_room":true}]', 'the second button sends delete_room: ' + JSON.stringify(S.leaves));
      const kept = await page.evaluate((keys) => ({ demo: keys.filter((k) => localStorage.getItem(k) !== null), lima: [localStorage.getItem('chat-invite:lima'), localStorage.getItem('chat-you:lima')], rows: [...document.querySelectorAll('#roomlist .rn')].map((e) => e.textContent) }), DEMO_KEYS);
      must(!kept.demo.length, 'every key of the room is gone: ' + JSON.stringify(kept.demo));
      must(kept.lima[0] === 'tok_lima' && kept.lima[1] === 'Ann' && JSON.stringify(kept.rows) === '["lima"]', 'another room stays: ' + JSON.stringify(kept));
      must(!calls.some((c) => c.includes('/push/unsubscribe')), 'nothing asks the room to unsubscribe: the leave dropped the registrations');
      if (vp.tag === 'desktop' && scheme === 'light') await shot(page, 'leave-home.png');
      return { rows: rows.length, leaves: S.leaves.length };
    });
  }
  /* The list on screen shows nobody else who has joined: Leave room asks
     the deletion question at once, and its button sends delete_room. A
     person using an agent's invite in the web app finds the control on
     that invite's row. */
  await run('leave-room-alone', { hash: '#members', init: seedRoomKeys }, async (page, S) => {
    for (const x of S.mb.members) if (x.name !== 'Anthony' && x.status === 'active') Object.assign(x, { status: 'unused', joined: null, last_seen: null });
    await page.reload();
    await page.waitForSelector('#mList .card.member', { timeout: 10000 });
    await settle(page);
    await page.click('#leaveRoom');
    await page.waitForSelector('#leaveDlg[open] #leaveDelete', { timeout: 4000 });
    const t = await leaveText(page);
    must(t.includes('The 3 invites not yet opened stop working too.') && !(await page.$('#leaveYes')), 'asked the deletion question at once: ' + t);
    await shot(page, 'leave-alone.png');
    await Promise.all([page.waitForURL('https://chat.victorio.cloud/', { timeout: 10000 }), page.click('#leaveDelete')]);
    must(JSON.stringify(S.leaves) === '[{"confirm":"demo","delete_room":true}]', 'one call, with delete_room: ' + JSON.stringify(S.leaves));
    return { leaves: S.leaves };
  });
  await run('leave-room-agent-invite', { hash: '#members', state: { agentYou: true }, init: () => { try { localStorage.setItem('chat-invite:demo', 'tok_Probe'); localStorage.setItem('ac:agent-app:demo', '1'); } catch { /* the scenario fails visibly */ } } }, async (page) => {
    await page.waitForSelector('#mList .card.member', { timeout: 10000 });
    await settle(page);
    const rows = await page.$$eval('#mList .card.member', (cs) => cs.filter((c) => c.querySelector('#leaveRoom')).map((c) => c.querySelector('.card-title').textContent));
    must(JSON.stringify(rows) === '["Probe (you)"]', 'the control is on the agent invite\'s own row: ' + JSON.stringify(rows));
    return { rows };
  });
  // An agent's invite card says under Copy w/ Instructions what it copies
  // and what the agent needs; a person's card and the members rows' own
  // Copy w/ Instructions have no such line. Both copies toast "Invite note
  // copied". (The clipboard takes what is copied: window.__copied.)
  const HINT = 'Copies a short note for your agent: its token and the address to start from. Your agent needs a tool that can send an HTTP header (curl, an HTTP client, or an MCP client with custom headers); an assistant that can only be given a link cannot join.';
  const fakeClipboard = () => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); };
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) for (const scheme of ['light', 'dark']) {
    await run('invite-card-hint-' + vp.tag + '-' + scheme, { scheme, w: vp.w, h: vp.h, touch: vp.touch, hash: '#members', init: fakeClipboard }, async (page) => {
      await page.waitForSelector('#mList .card.member', { timeout: 10000 });
      await page.fill('#invName', 'Matheo'); await page.click('[data-kind="human"]'); await page.click('#invForm button[type=submit]'); await settle(page);
      must(await page.$('#invResult .invite-result') && !(await page.$('#invNoteHint')), 'a person\'s invite card has no hint');
      await page.fill('#invName', 'Scout'); await page.click('[data-kind="agent"]'); await page.click('#invForm button[type=submit]'); await settle(page);
      const hint = await page.$eval('#invNoteHint', (e) => e.textContent.trim());
      must(hint === HINT, 'the hint: ' + hint);
      const pos = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('#invResult button')].find((x) => x.textContent === 'Copy w/ Instructions').getBoundingClientRect();
        const h = document.getElementById('invNoteHint').getBoundingClientRect();
        const card = document.querySelector('#invResult .invite-result').getBoundingClientRect();
        return { btnBottom: Math.round(btn.bottom), hintTop: Math.round(h.top), hintRight: Math.round(h.right), cardRight: Math.round(card.right), doc: document.documentElement.scrollWidth, vw: window.innerWidth };
      });
      must(pos.hintTop >= pos.btnBottom - 1 && pos.hintRight <= pos.cardRight && pos.doc <= pos.vw + 1, 'the hint sits under the button, inside the card: ' + JSON.stringify(pos));
      const hints = await page.evaluate((t) => document.body.innerText.split(t).length - 1, HINT);
      must(hints === 1, 'one hint on the page, the card\'s: ' + hints);
      await page.$eval('#invResult .invite-result', (e) => e.scrollIntoView({ block: 'center' }));
      await settle(page);
      await shot(page, 'invite-card-hint-' + vp.tag + '-' + scheme + '.png');
      // each copy's toast is its own: wait out any toast showing first
      const toastGone = () => page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 8000 });
      await toastGone();
      await page.click('#invResult button:text-is("Copy w/ Instructions")');
      await page.waitForFunction(() => /Invite note copied/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 4000 });
      const card = await page.evaluate(() => window.__copied);
      must(/X-Invite-Token: tok_Scout /.test(card) && card.split('\n').length === 5, 'the card copies the new invite\'s note: ' + card.slice(0, 120));
      // a members row's own Copy w/ Instructions: the same toast, no hint
      await toastGone();
      await page.evaluate(() => { window.__copied = null; });
      await page.click('#mList .card.member button:text-is("Copy w/ Instructions")');
      await page.waitForFunction(() => window.__copied && /Invite note copied/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 4000 });
      const row = await page.evaluate(() => window.__copied);
      must(/X-Invite-Token: tok_/.test(row), 'the row copies its agent\'s note: ' + row.slice(0, 120));
      return { hint: hint.length, pos };
    });
  }
  /* A reload paints avatars at once: the roster is remembered
     per room on the device, so the chat shows each picture before
     /members answers (here held back 3 s) instead of initials. */
  await run('avatars-instant-reload', {}, async (page) => {
    await page.waitForSelector('#msgs .msg .gutter .avatar.img img', { timeout: 10000 });
    const first = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.filter(a => a.querySelector('img')).length);
    await page.route(/\/api\/rooms\/[^/]+\/members(\?|$)/, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.fallback(); });
    await page.reload();
    await page.waitForSelector('#msgs .msg', { timeout: 10000 });
    await settle(page);
    const early = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.filter(a => a.querySelector('img')).length);
    if (!first || early !== first) throw new Error('after a reload, avatars should show before /members answers: ' + early + ' of ' + first);
    return { first, early };
  });
  await run('avatars', {}, async (page, S, calls) => {
    const out = {};
    out.chatAvatars = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.map(a => a.className + (a.querySelector('img') ? ':img' : a.querySelector('svg') ? ':svg' : ':' + a.textContent)));
    await shot(page, 'avatars-chat.png');
    await page.click('.tab[data-tab="members"]'); await settle(page);
    out.before = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Add a photo")')]);
    await fc.setFiles(FIXTURES + 'photo.png'); await settle(page);
    out.upload = calls.filter(c => c.startsWith('PUT') && c.includes('/avatar'));
    out.after = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    out.myAvatarImg = await page.$eval('#mList .card.member .avatar img', i => i.complete && i.naturalWidth + 'x' + i.naturalHeight).catch(() => 'none');
    out.uploadedSize = S.av.anthony ? S.av.anthony.buf.length : 0;
    await shot(page, 'avatars-members.png');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Change photo")')]);
    await fc2.setFiles(FIXTURES + 'henry.gif'); await settle(page);
    out.gifUpload = calls.filter(c => c.startsWith('PUT') && c.includes('/avatar')).slice(-1)[0];
    const [fc3] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Change photo")')]);
    await fc3.setFiles(FIXTURES + 'notimage.png'); await settle(page);
    out.badToast = await page.$eval('#toast', t => t.textContent);
    await page.click('#mList .photo-actions button:has-text("Remove photo")'); await settle(page);
    out.afterRemove = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    await page.click('.tab[data-tab="chat"]'); await settle(page);
    return out;
  });
  await run('avatars-dark-mobile', { scheme: 'dark', w: 390, h: 844 }, async (page) => { await shot(page, 'avatars-mobile-dark.png'); });
  for (const [label, o] of [['avatar-dialog', {}], ['avatar-dialog-dark-mobile', { scheme: 'dark', w: 390, h: 844 }]]) {
    await run(label, o, async (page) => {
      const out = {};
      await page.click('#msgs .msg[data-id="1"] .avatar'); await settle(page);
      out.henry = await page.evaluate(() => ({ open: document.getElementById('avDlg').open, name: document.getElementById('avName').textContent, kind: document.getElementById('avKind').textContent, img: (document.querySelector('#avBig img') || {}).naturalWidth, size: document.querySelector('#avBig .avatar').getBoundingClientRect().width }));
      // Name and kind pill sit on one .title-row line in the current
      // app; stacked block divs are a divergence.
      const avRow = await page.evaluate(() => { const n = document.getElementById('avName'), k = document.getElementById('avKind'); return !!(n && k && n.parentElement && n.parentElement.classList.contains('title-row') && k.parentElement === n.parentElement); });
      if (!avRow) throw new Error('avatar dialog name/kind are not on one title-row');
      await shot(page, label + '-gif.png');
      await page.keyboard.press('Escape'); await settle(page);
      out.closedByEsc = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.click('#msgs .msg[data-id="4"] .avatar'); await settle(page);
      out.claude = await page.evaluate(() => ({ name: document.getElementById('avName').textContent, kind: document.getElementById('avKind').textContent, svg: !!document.querySelector('#avBig svg') }));
      // There is no in-room bot: "claude" is an ordinary name, so a
      // non-member sender by that name gets no Bot pill and no bot glyph.
      if (out.claude.kind !== '' || out.claude.svg) throw new Error('claude should render as an ordinary sender, got ' + JSON.stringify(out.claude));
      await shot(page, label + '-claude.png');
      await page.mouse.click(5, 5); await settle(page);
      out.closedByBackdrop = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.click('#msgs .msg[data-id="3"] .avatar'); await settle(page);
      out.ada = await page.evaluate(() => ({ text: document.querySelector('#avBig .avatar').textContent, kind: document.getElementById('avKind').textContent }));
      await shot(page, label + '-initials.png');
      await page.click('#avClose'); await settle(page);
      out.closedByButton = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.focus('#msgs .msg[data-id="5"] .avatar'); await page.keyboard.press('Enter'); await settle(page);
      out.keyboard = await page.evaluate(() => document.getElementById('avDlg').open && document.getElementById('avName').textContent);
      return out;
    });
  }
  await run('upload-file', { state: { files: true }, hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    const out = {};
    const fc = page.locator('.file-card').first();
    await fc.waitFor({ timeout: 4000 });
    out.dl = await fc.getAttribute('download');
    out.href = await fc.getAttribute('href');
    out.fcText = (await fc.textContent()).replace(/\s+/g, ' ').trim();
    must(out.dl === 'lima-survey-2026.zip' && /\/messages\/60\/file\?/.test(out.href) && /ZIP/.test(out.fcText) && /700 MB/.test(out.fcText), 'file card: ' + JSON.stringify(out));
    out.bigImgCards = await page.locator('.big-img-card').count();
    out.inlineBig = await page.locator('img.msg-img[src*="/61/"]').count();
    must(out.bigImgCards === 1 && out.inlineBig === 0, 'a very large image should be a card: ' + JSON.stringify(out));
    S.partDelay = 120;
    S.failOnce = 3;
    await page.setInputFiles('#anyFile', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(300000, 7) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    out.chip = await page.textContent('#fileName');
    must(/report\.pdf \(293 KB\)/.test(out.chip), 'file chip: ' + out.chip);
    await shot(page, 'upload-armed.png');
    await page.fill('#text', 'Quarterly report');
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => /\d+% · .+ of 293 KB/.test((document.querySelector('#uplMeta') || {}).textContent || ''), null, { timeout: 10000 });
    out.meta = await page.textContent('#uplMeta');
    await shot(page, 'upload-progress.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
    const card = page.locator('.file-card', { hasText: 'report.pdf' });
    await card.waitFor({ timeout: 4000 });
    const seq = calls.map((c) => c.split(' ').slice(0, 2).join(' '));
    const at = (re) => seq.findIndex((c) => re.test(c));
    out.parts = seq.filter((c) => /PUT .*\/messages\/101\/file\/part\?n=/.test(c)).length;
    out.part3 = seq.filter((c) => /\/file\/part\?n=3$/.test(c)).length;
    out.order = [at(/^POST .*\/messages$/), at(/\/101\/file\/start$/), at(/\/101\/file\/finish$/), at(/\/101\/publish$/)];
    must(out.parts === 6 && out.part3 === 2, 'five parts, part 3 retried once: ' + JSON.stringify(out));
    must(out.order.every((x, i) => x >= 0 && (i === 0 || x > out.order[i - 1])), 'draft, start, finish, publish in order: ' + JSON.stringify(out.order));
    out.chipGone = await page.$eval('#fileChip', (e) => e.hidden);
    out.textCleared = (await page.inputValue('#text')) === '';
    must(out.chipGone && out.textCleared, 'composer cleared after the send: ' + JSON.stringify(out));
    out.resumeNote = await page.locator('#uplResume').count();
    must(out.resumeNote === 0, 'no interrupted-upload note after a clean send');
    await shot(page, 'upload-file.png');
    return { meta: out.meta, parts: out.parts };
  });
  await run('upload-file-dark', { state: { files: true }, hash: '#invite=tok_Anthony', scheme: 'dark', w: 390, h: 844, touch: true }, async (page) => {
    const fc = page.locator('.file-card').first();
    await fc.waitFor({ timeout: 4000 });
    await fc.scrollIntoViewIfNeeded();
    const box = await fc.boundingBox();
    must(box && box.x >= 0 && box.x + box.width <= 390, 'file card fits the phone: ' + JSON.stringify(box));
    await shot(page, 'upload-file-dark-phone.png');
    return { w: Math.round(box.width) };
  });
  await run('upload-direct', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    // Parts straight to storage: presigned addresses, no credential on the
    // storage request, an expired address signed again and retried.
    S.direct = true;
    const r2 = [];
    let refused = false;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'ETag' };
    await page.route('https://acct.r2.cloudflarestorage.com/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const u = new URL(req.url());
      const n = +u.searchParams.get('partNumber');
      r2.push({ n, token: req.headers()['x-invite-token'] || null, len: (req.postDataBuffer() || []).length, sig: u.searchParams.get('X-Amz-Signature') });
      if (n === 2 && !refused) { refused = true; return route.fulfill({ status: 403, headers: Object.assign({ 'content-type': 'application/xml' }, cors), body: '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>' }); }
      const seg = u.pathname.split('/');
      const up = S.ups[seg[3] + ':' + seg[4]];
      if (up) up.got.add(n);
      return route.fulfill({ status: 200, headers: Object.assign({ etag: '"e' + n + '"' }, cors), body: '' });
    });
    await page.setInputFiles('#anyFile', { name: 'archive.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(200000, 9) });
    await page.click('#send');
    await page.locator('.file-card', { hasText: 'archive.tar' }).waitFor({ timeout: 20000 });
    const viaSite = calls.filter((c) => /\/file\/part\?n=/.test(c)).length;
    const startBody = calls.find((c) => /\/101\/file\/start /.test(c)) || '';
    const part2 = r2.filter((x) => x.n === 2);
    must(/"direct":true/.test(startBody), 'the client asks for direct: ' + startBody.slice(-120));
    must(viaSite === 0, 'no part went through the site: ' + viaSite);
    must(r2.length === 5 && r2.every((x) => x.token === null), 'four parts plus one retry, none carrying the invite: ' + JSON.stringify(r2));
    must(part2.length === 2 && part2[0].sig !== part2[1].sig && (S.signs || 0) >= 2, 'the refused part was signed again: ' + JSON.stringify({ part2, signs: S.signs }));
    must(calls.some((c) => /\/101\/file\/finish/.test(c)) && calls.some((c) => /\/101\/publish/.test(c)), 'finished and published');
    return { r2: r2.length, signs: S.signs };
  });
  await run('upload-direct-switched-off', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    // Direct uploads are switched off mid-flight: the first sign gives part
    // 1's address only, the next answers 409 naming /part, as the server
    // does. The upload carries on through the site from part 2 instead of
    // failing, and part 1 (already in storage) is not sent again.
    S.direct = true;
    const r2 = [];
    const signs = [];
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'ETag' };
    await page.route('https://acct.r2.cloudflarestorage.com/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const u = new URL(req.url());
      const n = +u.searchParams.get('partNumber');
      r2.push(n);
      const seg = u.pathname.split('/');
      const up = S.ups[seg[3] + ':' + seg[4]];
      if (up) up.got.add(n);
      return route.fulfill({ status: 200, headers: Object.assign({ etag: '"e' + n + '"' }, cors), body: '' });
    });
    await page.route('**/messages/101/file/sign', async (route) => {
      signs.push(JSON.parse(route.request().postData() || '{}').parts);
      if (signs.length > 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Direct uploads are turned off: send this upload\'s remaining parts through the site (PUT each one to its /part?n=N); the parts already in storage count' }) });
      const body = { room: 'demo', id: 101, kind: 'file', method: 'PUT', urls: { 1: 'https://acct.r2.cloudflarestorage.com/victorio-chat-media/demo/101/file?partNumber=1&uploadId=up1&X-Amz-Signature=s1' }, expires_at: new Date(Date.now() + 3600e3).toISOString() };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.setInputFiles('#anyFile', { name: 'switch.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(200000, 3) });
    await page.click('#send');
    await page.locator('.file-card', { hasText: 'switch.tar' }).waitFor({ timeout: 20000 });
    const viaSite = calls.filter((c) => /\/101\/file\/part\?n=/.test(c)).map((c) => +c.split('n=')[1].split(' ')[0]).sort();
    const starts = calls.filter((c) => /\/101\/file\/start /.test(c)).length;
    must(r2.length === 1 && r2[0] === 1, 'part 1 went to storage once: ' + JSON.stringify(r2));
    must(JSON.stringify(viaSite) === '[2,3,4]', 'the other parts went through the site, once each: ' + JSON.stringify(viaSite));
    must(signs.length === 2 && starts === 1, 'no sign after the 409 and no restart: ' + JSON.stringify({ signs, starts }));
    must(calls.some((c) => /\/101\/publish/.test(c)), 'finished and published');
    return { r2, viaSite, signs: signs.length };
  });
  // The draft-creating post's answer is lost: the upload's retry sends it
  // again with the same client_msg_id and gets the same draft back, so one
  // draft is made and the file posts once. Before, the retry made a second
  // draft, and the first stayed behind.
  await run('upload-draft-answer-lost', { hash: '#invite=tok_Anthony', allowConsole: /ERR_FAILED/ }, async (page, S, calls) => {
    S.postAnswers = ['lost'];
    const from = calls.length;
    await page.setInputFiles('#anyFile', { name: 'once.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(150000, 6) });
    await page.click('#send');
    await page.locator('.file-card', { hasText: 'once.bin' }).waitFor({ timeout: 20000 });
    const drafts = calls.slice(from).filter((c) => /^POST \/api\/rooms\/demo\/messages \{/.test(c) && /"draft":true/.test(c)).map((c) => JSON.parse(c.slice(c.indexOf('{'))).client_msg_id);
    must(drafts.length === 2 && drafts[0] && drafts[1] === drafts[0], 'the draft post is retried with the same id: ' + JSON.stringify(drafts));
    must(S.nid === 101 && (S.drafts || []).length === 0, 'one draft, published: ' + JSON.stringify({ nid: S.nid, drafts: S.drafts }));
    must((await page.$$('.file-card')).length === 1, 'the file shows once');
    return { drafts: drafts.length };
  });

  await run('upload-finish-names-file',{ hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    // Every finish, the retry after a lost answer included, names the file
    // by the size and fingerprint start gave, so the server can refuse one
    // whose upload another file has replaced.
    const finishes = [];
    await page.route('**/messages/101/file/finish', async (route) => {
      finishes.push(JSON.parse(route.request().postData() || '{}'));
      if (finishes.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream connect error"}' });
      return route.fallback();
    });
    await page.setInputFiles('#anyFile', { name: 'ledger.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(150000, 5) });
    await page.click('#send');
    await page.locator('.file-card', { hasText: 'ledger.bin' }).waitFor({ timeout: 20000 });
    const startCall = calls.find((c) => /^POST .*\/101\/file\/start /.test(c)) || '';
    const start = JSON.parse(startCall.slice(startCall.indexOf('{')));
    must(typeof start.fingerprint === 'string' && start.size === 150000, 'start names the file: ' + startCall);
    must(finishes.length === 2 && finishes.every((f) => f.size === start.size && f.fp === start.fingerprint), 'each finish carries start\'s size and fingerprint: ' + JSON.stringify({ start, finishes }));
    return { finishes: finishes.length };
  });
  await run('upload-replaced', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    // Another file took this upload's place and finished first: finish is
    // refused, and the status (complete, but of another size) must not be
    // read as this file being done, or the message goes out with that file.
    S.replacedBy = 4321;
    await page.setInputFiles('#anyFile', { name: 'mine.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100000, 4) });
    await page.fill('#text', 'my file');
    await page.click('#send');
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /replaced by a different file/.test(t.textContent || ''); }, null, { timeout: 10000 });
    const toast = await page.$eval('#toast', (t) => t.textContent || '');
    const published = calls.some((c) => /\/messages\/101\/publish/.test(c));
    const resent = calls.filter((c) => /\/101\/file\/part\?n=/.test(c)).length;
    must(!published, 'nothing is published with the other file: ' + toast);
    must(resent === 2, 'no part is sent into the other file\'s upload: ' + resent);
    return { toast };
  });
  await run('upload-cancel', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    S.partDelay = 900;
    await page.setInputFiles('#anyFile', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(400000, 1) });
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    await page.click('#uplCancel');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /cancelled/i.test(t.textContent || ''); }, null, { timeout: 3000 });
    await settle(page);
    const aborted = calls.some((c) => /^POST .*\/messages\/101\/file\/abort/.test(c));
    const deleted = calls.some((c) => /^DELETE .*\/messages\/101\?draft_only=1$/.test(c));
    const published = calls.some((c) => /\/publish/.test(c));
    must(aborted && deleted && !published, 'cancel aborts the upload and deletes the draft: ' + JSON.stringify({ aborted, deleted, published }));
    must(await page.locator('#fileChip').isVisible(), 'the file stays armed after a cancel');
    must((await page.locator('#uplResume').count()) === 0, 'a cancelled upload leaves no interrupted note');
    return { aborted, deleted };
  });
  // Resending one file finds its earlier draft by fingerprint. That draft
  // also holds a photo sent with it the first time (finished, then removed
  // from the composer): it must not be taken over, or its publish posts the
  // photo too. A draft holding only this file is taken over and resumed.
  for (const [label, withPhoto] of [['upload-resume-other-kinds', true], ['upload-resume-adopts', false]]) {
    await run(label, { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
      const ts = S.msgs[S.msgs.length - 1].ts + 1000;
      S.drafts = [{ id: 77, ts, from: 'Anthony', text: 'Photo and survey' }];
      S.ups = { '77:file': { size: 300000, name: 'survey.bin', type: 'application/octet-stream', ps: 65536, parts: 5, got: new Set([1, 2]) } };
      if (withPhoto) {
        S.ups['77:image'] = { size: 4000, type: 'image/png', ps: 65536, parts: 1, got: new Set([1]), done: true };
        S.drafts[0].image = { type: 'image/png', bytes: 4000, url: '/api/rooms/demo/messages/77/image?exp=1&sig=x' };
      }
      S.resume = { found: true, id: 77, kind: 'file', received: [1, 2] };
      await page.setInputFiles('#anyFile', { name: 'survey.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300000, 3) });
      await page.fill('#text', 'Just the survey');
      await page.click('#send');
      await page.locator('#uplCard').waitFor({ timeout: 3000 });
      await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
      await settle(page);
      const published = calls.filter((c) => /^POST .*\/messages\/\d+\/publish/.test(c)).map((c) => +c.match(/messages\/(\d+)\/publish/)[1]);
      const live = S.msgs.find((x) => x.text === 'Just the survey');
      if (withPhoto) {
        must(published.length === 1 && published[0] !== 77, 'a new draft is published, not the one with the photo: ' + JSON.stringify(published));
        must(live && !live.image && S.drafts.some((x) => x.id === 77), 'the photo stays out of the post: ' + JSON.stringify(live));
      } else {
        must(published.length === 1 && published[0] === 77, 'the draft holding only this file is resumed: ' + JSON.stringify(published));
        must(!calls.some((c) => /^POST .*\/messages ./.test(c) && /"draft":true/.test(c)), 'no new draft is made');
      }
      return { published };
    });
  }
  // A blip at Send (offline, or the lookup answering 503 once) must not
  // skip the resume lookups: the send waits or retries, then resumes the
  // earlier draft. Falling through to a new draft sent every part again and
  // left the old draft and its parts behind with nothing pointing at them.
  for (const [label, offline] of [['upload-resume-offline', true], ['upload-resume-blip', false]]) {
    await run(label, { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
      const ts = S.msgs[S.msgs.length - 1].ts + 1000;
      S.drafts = [{ id: 77, ts, from: 'Anthony', text: 'Survey' }];
      S.ups = { '77:file': { size: 300000, name: 'survey.bin', type: 'application/octet-stream', ps: 65536, parts: 5, got: new Set([1, 2]) } };
      S.resume = { found: true, id: 77, kind: 'file', received: [1, 2] };
      let down = offline;
      let failed = 0;
      await page.route('**/upload/resume', (route) => {
        if (down) return route.abort('internetdisconnected');
        if (!offline && !failed++) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream connect error"}' });
        return route.fallback();
      });
      const online = (on) => page.evaluate((v) => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => v }), on);
      await page.setInputFiles('#anyFile', { name: 'survey.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300000, 3) });
      await page.fill('#text', 'The survey');
      if (offline) await online(false);
      await page.click('#send');
      await page.locator('#uplCard').waitFor({ timeout: 3000 });
      if (offline) {
        await page.waitForFunction(() => /Offline/.test((document.querySelector('#uplCard') || {}).textContent || ''), null, { timeout: 3000 });
        await page.waitForTimeout(400);
        must(!calls.some((c) => /"draft":true/.test(c)), 'no new draft while offline');
        down = false;
        await online(true);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
      }
      await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
      await settle(page);
      const published = calls.filter((c) => /^POST .*\/messages\/\d+\/publish/.test(c)).map((c) => +c.match(/messages\/(\d+)\/publish/)[1]);
      must(published.length === 1 && published[0] === 77, 'the earlier draft is resumed and published: ' + JSON.stringify(published));
      must(!calls.some((c) => /"draft":true/.test(c)), 'no new draft is made');
      return { published };
    });
  }
  // A video never rides inline: base64 of up to 25 MB in one JSON post cost
  // the Worker hundreds of MB to decode, and beside a photo and a clip it
  // passed the room's 32 MiB hand-off and failed with a bare 500. Even a
  // small one goes up through the engine, and the photo with it.
  for (const [label, phone] of [['upload-video-small', false], ['upload-video-small-phone', true]]) {
    await run(label, Object.assign({ hash: '#invite=tok_Anthony' }, phone ? { w: 390, h: 844, touch: true } : {}), async (page, S, calls) => {
      S.partDelay = 700;
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(150000, 2)]);
      await page.setInputFiles('#vidFile', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4 });
      await page.locator('#vidChip:not([hidden])').waitFor({ timeout: 3000 });
      await page.setInputFiles('#imgFile', require('path').join(TESTS, '../../tests/fixtures/photo.png'));
      await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
      await page.fill('#text', 'Short clip');
      await page.click('#send');
      await page.locator('#uplCard').waitFor({ timeout: 3000 });
      await page.waitForFunction(() => /\d+% ·/.test((document.querySelector('#uplMeta') || {}).textContent || ''), null, { timeout: 10000 });
      await shot(page, label + '.png');
      await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
      await settle(page);
      const inline = calls.filter((c) => /^POST .*\/messages /.test(c) && /"(video|image)":"data:/.test(c));
      must(!inline.length, 'nothing rides inline: ' + inline.map((c) => c.slice(0, 120)).join(' | '));
      must(calls.some((c) => /\/101\/video\/start/.test(c)) && calls.some((c) => /\/101\/video\/finish/.test(c)), 'the video goes up through the engine');
      must(calls.some((c) => /\/101\/image\/start/.test(c)), 'the photo rides along through the engine');
      const live = S.msgs.find((x) => x.text === 'Short clip');
      must(live && live.video && live.image, 'one post with both: ' + JSON.stringify(live));
      must(await page.$eval('#vidChip', (e) => e.hidden), 'the video chip clears after the send');
      return { id: live.id };
    });
  }
  // A message that goes up through the engine cannot carry a page or a
  // document (a draft takes media only), and since every video goes that
  // way a small clip beside an HTML page posts the clip and leaves the
  // page in the composer. The person is told so as the send starts, and
  // the page goes out as its own message after.
  for (const [label, phone] of [['upload-video-leaves-page', false], ['upload-video-leaves-page-phone', true]]) {
    await run(label, Object.assign({ hash: '#invite=tok_Anthony' }, phone ? { w: 390, h: 844, touch: true } : {}), async (page, S, calls) => {
      S.partDelay = 700;
      await page.evaluate(() => {
        window.__toasts = [];
        const t = document.querySelector('#toast');
        new MutationObserver(() => { if (!t.hidden && t.textContent) window.__toasts.push(t.textContent); }).observe(t, { attributes: true, childList: true, subtree: true, characterData: true });
      });
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(150000, 2)]);
      await page.setInputFiles('#vidFile', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4 });
      await page.locator('#vidChip:not([hidden])').waitFor({ timeout: 3000 });
      await page.setInputFiles('#artFile', { name: 'notes.html', mimeType: 'text/html', buffer: Buffer.from('<h1>Notes</h1><p>For the clip.</p>') });
      await page.locator('#artChip:not([hidden])').waitFor({ timeout: 3000 });
      await page.fill('#text', 'Clip and notes');
      await page.click('#send');
      await page.locator('#uplCard').waitFor({ timeout: 3000 });
      await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /page is still here/.test(t.textContent || ''); }, null, { timeout: 3000 });
      const said = await page.$eval('#toast', (t) => t.textContent || '');
      await shot(page, label + '.png');
      await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
      await settle(page);
      const live = S.msgs.find((x) => x.text === 'Clip and notes');
      must(live && live.video, 'the clip is posted: ' + JSON.stringify(live));
      must(!calls.some((c) => /^POST .*\/messages /.test(c) && /"html"/.test(c)), 'the page did not ride the upload');
      must(await page.$eval('#artChip', (e) => !e.hidden && /notes\.html/.test(e.textContent)), 'the page is still in the composer');
      const toasts = await page.evaluate(() => window.__toasts);
      must(toasts.some((t) => /The page is still here: send it as its own message/.test(t)), 'the person is told: ' + JSON.stringify(toasts));
      await shot(page, label + '-after.png');
      // and it goes out on the next send, inline as before
      await page.click('#send');
      await page.waitForFunction(() => document.querySelector('#artChip').hidden, null, { timeout: 5000 });
      must(calls.some((c) => /^POST .*\/messages /.test(c) && /"html":"<h1>Notes/.test(c)), 'the page is posted on its own');
      return { said, toasts };
    });
  }
  await run('upload-interrupted', {
    hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true,
    init: () => { try { localStorage.setItem('chat-upl:demo', JSON.stringify([{ key: 'chat-draft:demo:x', id: 77, names: ['holiday.mp4'], total: 5e9, kinds: ['video'], ts: Date.now() - 3600e3 }])); } catch {} },
  }, async (page, S, calls) => {
    const note = page.locator('#uplResume');
    await note.waitFor({ timeout: 4000 });
    const text = (await note.textContent()).replace(/\s+/g, ' ');
    must(/holiday\.mp4 didn't finish uploading/.test(text), 'interrupted note: ' + text);
    await shot(page, 'upload-interrupted-phone.png');
    await page.click('#uplDiscard');
    await note.waitFor({ state: 'detached', timeout: 3000 });
    must(calls.some((c) => /^POST .*\/messages\/77\/video\/abort/.test(c)) && calls.some((c) => /^DELETE .*\/messages\/77\?draft_only=1$/.test(c)), 'discard aborts and deletes the draft, and only a draft');
    const stored = await page.evaluate(() => localStorage.getItem('chat-upl:demo'));
    must(stored === null, 'discard forgets the note: ' + stored);
    return { ok: true };
  });
  await run('upload-discard-posted', {
    // the note is this browser's, but another device picked the draft up
    // by fingerprint and published it: Discard must not delete it
    hash: '#invite=tok_Anthony',
    init: () => { try { localStorage.setItem('chat-upl:demo', JSON.stringify([{ key: 'chat-draft:demo:x', id: 77, names: ['holiday.mp4'], total: 5e9, kinds: ['video'], ts: Date.now() - 3600e3 }])); } catch {} },
  }, async (page, S, calls) => {
    S.msgs.push({ id: 77, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Anthony', text: 'from the laptop' });
    const note = page.locator('#uplResume');
    await note.waitFor({ timeout: 4000 });
    await page.click('#uplDiscard');
    await note.waitFor({ state: 'detached', timeout: 3000 });
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /already posted/.test(t.textContent || ''); }, null, { timeout: 3000 });
    const toastText = await page.$eval('#toast', (t) => t.textContent || '');
    must(calls.some((c) => /^DELETE .*\/messages\/77\?draft_only=1$/.test(c)), 'discard asks for a draft-only delete');
    must(S.msgs.some((x) => x.id === 77), 'the live message is still in the room');
    must(/holiday\.mp4 was already posted/.test(toastText), 'the person is told it was posted: ' + toastText);
    const stored = await page.evaluate(() => localStorage.getItem('chat-upl:demo'));
    must(stored === null, 'the note is forgotten: ' + stored);
    await shot(page, 'upload-discard-posted.png');
    return { toastText };
  });
  await run('upload-cancel-after-publish', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    // the publish lands but its answer is lost: the engine retries, and a
    // Cancel then must not delete what is already live
    S.publishLost = true;
    await page.setInputFiles('#anyFile', { name: 'notes.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100000, 2) });
    await page.fill('#text', 'the notes');
    await page.click('#send');
    await page.waitForFunction(() => /Connection trouble/.test((document.querySelector('#uplMeta') || {}).textContent || ''), null, { timeout: 10000 });
    await page.click('#uplCancel');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /already posted/.test(t.textContent || ''); }, null, { timeout: 3000 });
    await settle(page);
    const out = {};
    out.toast = await page.$eval('#toast', (t) => t.textContent || '');
    out.live = S.msgs.some((x) => x.id === 101);
    out.draftOnly = calls.some((c) => /^DELETE .*\/messages\/101\?draft_only=1$/.test(c));
    out.chipGone = await page.$eval('#fileChip', (e) => e.hidden);
    out.textCleared = (await page.inputValue('#text')) === '';
    out.note = await page.locator('#uplResume').count();
    must(out.live && out.draftOnly, 'the live message stays: ' + JSON.stringify(out));
    must(!/nothing was posted/.test(out.toast), 'no claim that nothing was posted: ' + out.toast);
    must(out.chipGone && out.textCleared && out.note === 0, 'what was posted leaves the composer: ' + JSON.stringify(out));
    await shot(page, 'upload-cancel-after-publish.png');
    return out;
  });
  await run('upload-pick-during-send', { hash: '#invite=tok_Anthony' }, async (page, S) => {
    // A photo and a second file picked while a send uploads are for the
    // next message: the send must not wipe them when it finishes, and the
    // file being uploaded is not "replaced".
    S.partDelay = 400;
    await page.setInputFiles('#anyFile', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(300000, 7) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    await page.fill('#text', 'the report');
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    const out = {};
    out.fileRemoveHidden = await page.$eval('#fileRemove', (e) => e.hidden);
    await page.setInputFiles('#imgFile', FIXTURES + 'photo.png');
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    await page.setInputFiles('#anyFile', { name: 'next.txt', mimeType: 'text/plain', buffer: Buffer.from('for later') });
    await page.waitForFunction(() => /next\.txt/.test((document.querySelector('#fileName') || {}).textContent || ''), null, { timeout: 3000 });
    out.toast = await page.$eval('#toast', (t) => t.textContent || '');
    out.nextFileRemove = await page.$eval('#fileRemove', (e) => !e.hidden);
    await shot(page, 'upload-pick-during-send.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 30000 });
    await page.locator('.file-card', { hasText: 'report.pdf' }).waitFor({ timeout: 4000 });
    await settle(page);
    const last = S.msgs[S.msgs.length - 1];
    out.posted = { text: last.text, file: last.file && last.file.name, image: !!last.image };
    out.imgKept = !(await page.$eval('#attachRow', (e) => e.hidden));
    out.fileKept = await page.textContent('#fileName');
    must(out.fileRemoveHidden, 'the uploading file has no Remove: ' + JSON.stringify(out));
    must(/next\.txt attaches to your next message - report\.pdf is still uploading/.test(out.toast), 'no false "replaces": ' + out.toast);
    must(out.posted.file === 'report.pdf' && !out.posted.image, 'the send posted what it was sent with: ' + JSON.stringify(out.posted));
    must(out.imgKept && /next\.txt/.test(out.fileKept), 'what was picked meanwhile stays for the next message: ' + JSON.stringify(out));
    must(out.nextFileRemove, 'the next file can be removed');
    return out;
  });
  await run('upload-remove-during-send', { hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page, S) => {
    // What a send is carrying can't be removed mid-send: Remove hid the
    // chip while the send posted the image anyway.
    S.partDelay = 400;
    await page.setInputFiles('#imgFile', FIXTURES + 'photo.png');
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    await page.setInputFiles('#anyFile', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(300000, 7) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    const out = {};
    out.imgRemoveVisible = await page.locator('#imgRemove').isVisible();
    out.fileRemoveVisible = await page.locator('#fileRemove').isVisible();
    await shot(page, 'upload-remove-during-send-phone.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 30000 });
    await settle(page);
    const last = S.msgs[S.msgs.length - 1];
    out.posted = !!(last && last.image && last.file);
    out.cleared = await page.$eval('#attachRow', (e) => e.hidden) && await page.$eval('#fileChip', (e) => e.hidden);
    must(!out.imgRemoveVisible && !out.fileRemoveVisible, 'no Remove on what is being sent: ' + JSON.stringify(out));
    must(out.posted && out.cleared, 'both posted, both cleared after: ' + JSON.stringify(out));
    return out;
  });
  await run('upload-route-phone', { hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page) => {
    // a photo through the paperclip lands in the image slot
    await page.setInputFiles('#anyFile', require('path').join(TESTS, '../../tests/fixtures/photo.png'));
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    // a photo type the chat can't show attaches as a file, with a note
    await page.setInputFiles('#imgFile', { name: 'IMG_0042.heic', mimeType: 'image/heic', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(5000, 3)]) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    const chip = await page.textContent('#fileName');
    const toastText = await page.$eval('#toast', (t) => t.textContent || '');
    must(/IMG_0042\.heic/.test(chip) && /can't be shown/.test(toastText), 'routing: ' + chip + ' | ' + toastText);
    await shot(page, 'upload-route-phone.png');
    // and the progress card at phone width
    return { chip };
  });
  await run('upload-progress-phone', { hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page, S) => {
    S.partDelay = 2500;
    await page.setInputFiles('#anyFile', { name: 'site-survey-final-version-2.dwg', mimeType: 'application/acad', buffer: Buffer.alloc(260000, 5) });
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => /\d+% ·/.test((document.querySelector('#uplMeta') || {}).textContent || ''), null, { timeout: 10000 });
    const box = await page.locator('#uplCard').boundingBox();
    must(box && box.width <= 390 && box.x >= 0, 'progress card fits the phone: ' + JSON.stringify(box));
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    must(sw <= 390, 'no horizontal scroll: ' + sw);
    await shot(page, 'upload-progress-phone.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
    return { box: Math.round(box.width) };
  });
  // The voice dialog reads the server's refusals: an upload whose clone was
  // refused (the daily cap, a provider failure) still stored the sample,
  // and it said only "Upload failed.", then "being prepared" for a clone
  // nothing would ever make.
  const voiceTake = { name: 'take.webm', mimeType: 'audio/webm', buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]) };
  const voiceUpload = async (page) => {
    await page.setInputFiles('#voiceFile', voiceTake);
    await page.click('#voiceUpload');
    await page.waitForFunction(() => document.querySelector('#voiceStatus').textContent !== 'Uploading…', null, { timeout: 5000 });
    await settle(page);
    return { status: await page.$eval('#voiceStatus', (e) => e.textContent), toast: await page.$eval('#toast', (e) => e.textContent || '') };
  };
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('voice-clone-refused' + tag, { hash: '#invite=tok_Anthony', w, h, touch: !!tag, allowConsole: /status of 429/ }, async (page, S, calls) => {
      S.voiceSample = { status: 429, body: { error: 'You can clone a voice up to 5 times a day. Try again tomorrow.', retry_after: 3600, voice: { provider: 'cartesia', voice_id: null, sample: true, updated: 1 }, cloned: false, sample_stored: true } };
      if (tag) { await page.tap('#menu'); await settle(page); }
      await page.click('#voiceBtn'); await settle(page);
      const out = await voiceUpload(page);
      out.retry = await page.locator('#voiceReclone').isVisible();
      await shot(page, 'voice-clone-refused' + tag + '.png');
      must(/stored, but it was not cloned: You can clone a voice up to 5 times a day\. Try again tomorrow\.$/.test(out.status), 'the cap and the stored sample are named: ' + out.status);
      must(/5 times a day/.test(out.toast) && out.retry, 'toast gives the reason, Retry clone offered: ' + JSON.stringify(out));
      await page.click('#voiceClose'); await settle(page);
      await page.click('#voiceBtn'); await settle(page);
      out.reopened = await page.$eval('#voiceStatus', (e) => e.textContent);
      must(!/being prepared/.test(out.reopened) && /not cloned yet/.test(out.reopened) && await page.locator('#voiceReclone').isVisible(), 'reopened: no promise of a clone in the works: ' + out.reopened);
      S.voiceSample = null;
      await page.click('#voiceReclone');
      await page.waitForFunction(() => /Your voice is set/.test(document.querySelector('#voiceStatus').textContent), null, { timeout: 5000 });
      out.recloned = calls.some((c) => /^POST .*\/voice\/reclone/.test(c));
      out.retryAfter = await page.locator('#voiceReclone').isVisible();
      must(out.recloned && !out.retryAfter, 'Retry clone posts reclone and goes away once cloned: ' + JSON.stringify(out));
      return out;
    });
  }
  // Retry clone and Upload sample wait for the call that is out: a double
  // tap on Retry clone sent two clones, two of the day's five for one sample.
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('voice-busy' + tag, { hash: '#invite=tok_Anthony', w, h, touch: !!tag }, async (page, S, calls) => {
      S.voice = { provider: 'cartesia', voice_id: null, sample: true, updated: 1 };
      S.voiceDelay = 2500;
      if (tag) { await page.tap('#menu'); await settle(page); }
      await page.click('#voiceBtn'); await settle(page);
      await page.waitForSelector('#voiceReclone:not([hidden])', { timeout: 5000 });
      // two taps in one go, before the disabled state can render
      await page.$eval('#voiceReclone', (b) => { b.click(); b.click(); });
      await page.waitForSelector('#voiceReclone:disabled', { timeout: 2000 }).catch(() => {});
      const out = { busy: await page.$eval('#voiceReclone', (b) => b.disabled), uploadBusy: await page.$eval('#voiceUpload', (b) => b.disabled) };
      await shot(page, 'voice-busy' + tag + '.png');
      await page.waitForFunction(() => /Your voice is set/.test(document.querySelector('#voiceStatus').textContent), null, { timeout: 5000 });
      await settle(page);
      out.reclones = calls.filter((c) => /^POST .*\/voice\/reclone/.test(c)).length;
      out.uploadAfter = await page.$eval('#voiceUpload', (b) => b.disabled);
      // an upload holds both too
      S.voice = { provider: 'cartesia', voice_id: null, sample: true, updated: 1 };
      S.voiceSample = { status: 429, body: { error: 'You can clone a voice up to 5 times a day. Try again tomorrow.', voice: S.voice, cloned: false, sample_stored: true } };
      await page.setInputFiles('#voiceFile', voiceTake);
      await page.$eval('#voiceUpload', (b) => { b.click(); b.click(); });
      out.uploadBusy2 = await page.waitForSelector('#voiceUpload:disabled', { timeout: 2000 }).then(() => true, () => false);
      await page.waitForFunction(() => !/Uploading/.test(document.querySelector('#voiceStatus').textContent), null, { timeout: 5000 });
      await settle(page);
      out.uploads = calls.filter((c) => /^PUT .*\/voice\/sample/.test(c)).length;
      out.retryAfterUpload = await page.$eval('#voiceReclone', (b) => !b.hidden && !b.disabled);
      must(out.busy && out.uploadBusy && out.reclones === 1, 'one clone for a double tap, both buttons held while it runs: ' + JSON.stringify(out));
      must(!out.uploadAfter && out.uploadBusy2 && out.uploads === 1 && out.retryAfterUpload, 'the buttons come back; an upload holds them too: ' + JSON.stringify(out));
      return out;
    });
  }
  await run('voice-upload-refused', { hash: '#invite=tok_Anthony', allowConsole: /status of (415|502)/ }, async (page, S) => {
    S.voiceSample = { status: 502, body: { error: 'Cartesia clone failed (400): audio too short', sample_stored: true } };
    await page.click('#voiceBtn'); await settle(page);
    const failed = await voiceUpload(page);
    must(/stored, but it was not cloned: Cartesia clone failed \(400\): audio too short\.$/.test(failed.status), 'a failed clone: ' + failed.status);
    S.voiceSample = { status: 415, body: { error: 'Samples must be MP3, WAV, M4A, OGG or WebM audio' } };
    const wrong = await voiceUpload(page);
    must(wrong.status === 'Upload failed: Samples must be MP3, WAV, M4A, OGG or WebM audio.' && /MP3, WAV/.test(wrong.toast), 'a refused upload says why: ' + JSON.stringify(wrong));
    return { failed: failed.status, wrong: wrong.status };
  });
  await run('media-shelf', { state: { artifacts: true, shelf: true }, hash: '#invite=tok_Anthony' }, async (page) => {
    await page.click('.tab[data-tab="media"]');
    await page.waitForSelector('.media-tile', { timeout: 10000 });
    const out = {};
    out.tiles = await page.$$eval('.media-tile', ts => ts.length);
    out.allCount = await page.$eval('.media-bar .seg button[aria-pressed="true"] .media-n', e => e.textContent).catch(() => null);
    await shot(page, 'media-grid.png');
    await page.click('.media-bar .seg button:nth-child(2)');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 1);
    out.photosOnly = await page.$$eval('.media-tile', ts => ts.length);
    await page.click('.media-bar .seg button:nth-child(1)');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 5);
    await page.selectOption('.media-from', 'Anthony');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 1);
    out.senderKinds = await page.$$eval('.media-tile .media-kind', ts => ts.map(t => t.textContent));
    await page.selectOption('.media-from', '');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 5);
    out.tileRef = await page.$eval('.media-tile .media-ref', e => e.textContent);
    await page.click('.media-tile:has(img)');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-img', { timeout: 10000 });
    out.viewerOpen = true;
    out.capRef = await page.$eval('.media-cap-ref code', e => e.textContent);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('.media-cap-ref .btn');
    await page.waitForFunction(() => document.querySelector('.media-cap-ref .btn').textContent === 'Copied', null, { timeout: 10000 });
    out.clipboard = await page.evaluate(() => navigator.clipboard.readText());
    await shot(page, 'media-viewer.png');
    await page.click('.media-cap .media-jump');
    await page.waitForFunction(() => document.querySelector('#viewer').hidden, null, { timeout: 10000 });
    out.backInChat = await page.$eval('#view-chat', e => !e.hidden);
    await page.waitForFunction(() => { const el = document.querySelector('.msg[data-id="8"]'); return !!el && el.classList.contains('flash'); }, null, { timeout: 5000 });
    out.flashed = true;
    return out;
  });
  await run('media-shelf-mobile', { state: { artifacts: true, shelf: true }, hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page) => {
    await page.tap('#menu');
    await settle(page);
    await page.tap('.tab[data-tab="media"]');
    await page.waitForSelector('.media-tile', { timeout: 10000 });
    await settle(page); // let the drawer finish closing before the shot
    const tiles = await page.$$eval('.media-tile', ts => ts.length);
    const overflow = await page.evaluate(() => {
      const seg = document.querySelector('.media-bar .seg');
      return {
        doc: document.documentElement.scrollWidth - window.innerWidth,
        bar: seg ? seg.getBoundingClientRect().right - window.innerWidth : 0,
      };
    });
    if (overflow.doc > 0 || overflow.bar > 0) throw new Error('media bar overflows the viewport: ' + JSON.stringify(overflow));
    await shot(page, 'media-grid-mobile.png');
    return { tiles, overflow };
  });

  // The renewal's reads: reads by id (GET /messages?ids=).
  const renewReads = (calls, from) => calls.slice(from || 0).filter((c) => /^GET \/api\/rooms\/demo\/messages\?ids=/.test(c));
  // Page reads other than the boot load (limit=200) and the stream's
  // recheck (limit=1): the renewal sends none.
  const pageReads = (calls, from) => calls.slice(from || 0).filter((c) => /^GET \/api\/rooms\/demo\/messages\?/.test(c) && !/\?ids=/.test(c) && !/[?&]limit=(1|200)$/.test(c));
  // The ids one read by id asked for.
  const idsOf = (c) => (c.match(/[?&]ids=([\d,]+)/) || [null, ''])[1].split(',').filter(Boolean).map(Number);
  // Moves the page's clock on by ms from the real time (not stacked).
  const skew = (page, ms) => page.evaluate((d) => { if (!window.__realNow) window.__realNow = Date.now; Date.now = () => window.__realNow.call(Date) + d; }, ms);
  const nudge = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // n text rows from id 200 on, newer than everything in the fixture
  const chatter = (S, n) => { const base = S.msgs[S.msgs.length - 1].ts; for (let i = 0; i < n; i++) S.msgs.push({ id: 200 + i, ts: base + 1000 * (i + 1), from: i % 2 ? 'Henry' : 'Ada', kind: 'agent', text: 'Catching up, line ' + (i + 1) + '.' }); };

  // Signed media links die one to two hours after they are minted, and the
  // feed gets each row once. A tab left open past 50 minutes (or brought
  // back into view after one) re-reads the rows that carry media and
  // swaps in their new links: the same elements, the same scroll, and
  // no other row touched. Before, nothing renewed them and an afternoon
  // later the images, clips, documents and downloads answered 403.
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('media-links-renew' + tag, { state: { artifacts: true, files: true }, hash: '#invite=tok_Anthony', w, h, touch: !!tag }, async (page, S, calls) => {
      const reads = () => renewReads(calls);
      const fresh = (u) => u.split('?')[0] + '?exp=2&sig=fresh';
      const img = await page.$('.msg[data-id="8"] img.msg-img');
      const plain = await page.$('.msg[data-id="2"]');
      must(img && plain, 'the image row and a plain row are on screen');
      await page.evaluate(() => { const l = document.querySelector('#list'); l.scrollTop = Math.max(0, l.scrollHeight - l.clientHeight - 150); });
      const top0 = await page.$eval('#list', (l) => l.scrollTop);
      // a look back too soon reads nothing
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await settle(page);
      must(reads().length === 0, 'no re-read before the links are old: ' + JSON.stringify(reads()));
      // the server now mints new links; the tab's clock moves 51 minutes on
      for (const m of S.msgs) for (const k of ['image', 'html', 'doc', 'file']) if (m[k]) m[k] = Object.assign({}, m[k], { url: fresh(m[k].url) });
      await page.evaluate(() => { const real = Date.now; Date.now = () => real.call(Date) + 51 * 60e3; });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => /sig=fresh/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 5000 });
      await settle(page);
      const out = {
        reads: reads(),
        sameImg: await img.evaluate((e) => e.isConnected),
        plainKept: await plain.evaluate((e) => e.isConnected),
        file: await page.$eval('.msg[data-id="60"] .file-card', (a) => a.getAttribute('href')),
        frame: await page.$eval('.msg[data-id="8"] .art-frame', (f) => f.getAttribute('src')),
        scroll: [top0, await page.$eval('#list', (l) => l.scrollTop)],
      };
      must(out.reads.length === 1 && [8, 60, 61].every((id) => idsOf(out.reads[0]).includes(id)), 'one read, by id, of the rows with media: ' + JSON.stringify(out.reads));
      must(pageReads(calls).length === 0, 'no page is read: ' + JSON.stringify(pageReads(calls)));
      must(out.sameImg && out.plainKept, 'the rows stay mounted: ' + JSON.stringify(out));
      must(/sig=fresh/.test(out.file) && /sig=fresh/.test(out.frame), 'the download and the page preview carry the new links: ' + JSON.stringify(out));
      must(Math.abs(out.scroll[0] - out.scroll[1]) < 2, 'the scroll position holds: ' + JSON.stringify(out.scroll));
      // renewed just now: the next look reads nothing
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await settle(page);
      must(reads().length === 1, 'renewed rows are not read again at once: ' + JSON.stringify(reads()));
      await img.evaluate((e) => e.scrollIntoView({ block: 'start' }));
      await settle(page);
      must(await img.evaluate((e) => e.complete && e.naturalWidth > 0), 'the renewed image shows');
      await shot(page, 'media-links-renew' + tag + '.png');
      return out;
    });
  }
  // A media element that fails to load (its link died while the device
  // slept) asks for its row again and retries once, with the new link;
  // one that keeps failing is not retried in a loop.
  await run('media-links-retry', { state: { artifacts: true }, hash: '#invite=tok_Anthony', allowConsole: /status of 403/ }, async (page, S, calls) => {
    const hits = { image: [], doc: [], gone: 0 };
    const dead = '?exp=1&sig=dead';
    S.msgs.find((m) => m.id === 8).image.url += dead;
    S.msgs.find((m) => m.id === 8).doc.url += dead;
    S.msgs.push({ id: 90, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Ada', kind: 'agent', text: 'This photo is gone for good.', image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/90/image?exp=1&sig=gone' } });
    await page.route(/\/messages\/(8\/(image|doc)|90\/image)\?/, (route) => {
      const u = new URL(route.request().url());
      const kind = u.pathname.split('/').pop();
      if (/\/90\//.test(u.pathname)) { hits.gone++; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' }); }
      hits[kind].push(u.searchParams.get('sig'));
      if (u.searchParams.get('sig') === 'dead') {
        // the server signs anew from here on
        const m = S.msgs.find((x) => x.id === 8);
        m[kind] = Object.assign({}, m[kind], { url: m[kind].url.replace('sig=dead', 'sig=live') });
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' });
      }
      return route.fallback();
    });
    await page.reload();
    await page.waitForFunction(() => {
      const i = document.querySelector('.msg[data-id="8"] img.msg-img');
      return i && /sig=live/.test(i.getAttribute('src')) && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 8000 });
    await page.waitForFunction(() => /Probe doc/.test(document.querySelector('.msg[data-id="8"] .doc-body').textContent), null, { timeout: 8000 });
    await page.evaluate(() => document.querySelector('.msg[data-id="90"]').scrollIntoView());
    await page.waitForFunction(() => document.querySelector('.msg[data-id="90"] img.msg-img').complete, null, { timeout: 5000 });
    await settle(page);
    await page.waitForTimeout(300);
    await settle(page);
    const out = { hits, reads: renewReads(calls) };
    must(out.hits.image.join() === 'dead,live' && out.hits.doc.join() === 'dead,live', 'each retried once, with the new link: ' + JSON.stringify(out.hits));
    must(out.hits.gone === 2, 'a link that keeps failing is retried once, not in a loop: ' + JSON.stringify(out.hits));
    must(out.reads.length >= 1 && out.reads.length <= 3, 'failures share re-reads: ' + JSON.stringify(out.reads));
    return out;
  });

  // A row whose upload finished in a busy room goes live after every
  // message sent meanwhile: here row 8 goes live after 800 newer rows, so
  // it is neither among the newest 500 by id nor near its id in delivery
  // order. Its link dies; one read by id renews it, and so does the hourly
  // renewal. Before reads by id, the renewal walked forward from just
  // under its id at full pages, and before that it never reached it.
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('media-links-late-row' + tag, { state: { artifacts: true }, hash: '#invite=tok_Anthony', w, h, touch: !!tag, allowConsole: /status of 403/ }, async (page, S, calls) => {
      chatter(S, 800);
      const m8 = S.msgs.find((m) => m.id === 8);
      // the boot load (the newest 200) does not have it; it goes live now
      S.live = [{ msg: Object.assign({}, m8, { image: Object.assign({}, m8.image, { url: m8.image.url + '?exp=1&sig=dead' }) }), dn: 1000 }];
      const sigs = [];
      await page.route(/\/messages\/8\/image\?/, (route) => {
        const sig = new URL(route.request().url()).searchParams.get('sig');
        sigs.push(sig);
        if (sig !== 'dead') return route.fallback();
        // the server signs anew from here on
        const row = S.msgs.find((m) => m.id === 8);
        row.image = Object.assign({}, row.image, { url: row.image.url.replace('sig=dead', 'sig=live') });
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' });
      });
      const from = calls.length;
      await page.reload();
      await settle(page);
      await page.waitForSelector('.msg[data-id="8"] img.msg-img', { state: 'attached', timeout: 5000 });
      await page.evaluate(() => document.querySelector('.msg[data-id="8"]').scrollIntoView({ block: 'center' }));
      await page.waitForFunction(() => /sig=live/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 8000 })
        .catch(() => { throw new Error('the late row\'s image never got its new link: ' + JSON.stringify({ sigs, reads: renewReads(calls, from) })); });
      await page.evaluate(() => document.querySelector('.msg[data-id="8"] img.msg-img').scrollIntoView({ block: 'center' }));
      await page.waitForFunction(() => { const i = document.querySelector('.msg[data-id="8"] img.msg-img'); return i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
      await settle(page);
      const first = renewReads(calls, from);
      must(sigs.join() === 'dead,live', 'the image is retried once, with the new link: ' + JSON.stringify(sigs));
      must(first.length === 1 && idsOf(first[0]).includes(8), 'the late row is read by id, once: ' + JSON.stringify(first));
      await page.evaluate(() => document.querySelector('.msg[data-id="8"]').scrollIntoView({ block: 'start' }));
      await shot(page, 'media-links-late-row' + tag + '.png');
      // an hour on, the renewal finds the late row the same way
      const row = S.msgs.find((m) => m.id === 8);
      row.image = Object.assign({}, row.image, { url: row.image.url.replace('sig=live', 'sig=fresh') });
      const mark = calls.length;
      await skew(page, 51 * 60e3);
      await nudge(page);
      await page.waitForFunction(() => /sig=fresh/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 5000 })
        .catch(() => { throw new Error('the renewal missed the late row: ' + JSON.stringify(renewReads(calls, mark))); });
      await settle(page);
      const later = renewReads(calls, mark);
      must(later.length === 1 && idsOf(later[0]).includes(8), 'the renewal reads it by id, once: ' + JSON.stringify(later));
      must(pageReads(calls, mark).length === 0, 'and reads no page: ' + JSON.stringify(pageReads(calls, mark)));
      return { first, later };
    });
  }

  // A row delivered far later than its id (here 2,100 rows on) and then
  // deleted without the tab hearing of it (no delete frame came): the
  // read by id leaves it out, it counts as covered, and the next minutes
  // send nothing. Before reads by id, such a row cost a bounded walk of
  // page reads, and before that the same walk every minute.
  await run('media-links-gone-row', { state: { artifacts: true }, hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    chatter(S, 2100);
    const m8 = S.msgs.find((m) => m.id === 8);
    S.live = [{ msg: m8, dn: 2400 }];
    await page.reload();
    await settle(page);
    await page.waitForSelector('.msg[data-id="8"]', { timeout: 5000 });
    S.msgs = S.msgs.filter((m) => m.id !== 8);
    const from = calls.length;
    await skew(page, 51 * 60e3);
    await nudge(page);
    for (let i = 0; i < 50 && !renewReads(calls, from).length; i++) await page.waitForTimeout(100);
    await settle(page);
    const first = renewReads(calls, from);
    const mark = calls.length;
    await skew(page, 52 * 60e3);
    await nudge(page);
    await page.waitForTimeout(800);
    await skew(page, 53 * 60e3);
    await nudge(page);
    await page.waitForTimeout(800);
    const again = renewReads(calls, mark);
    must(first.length === 1 && idsOf(first[0]).includes(8), 'one read by id: ' + JSON.stringify(first));
    must(pageReads(calls, from).length === 0, 'no page is read: ' + JSON.stringify(pageReads(calls, from)));
    must(again.length === 0, 'the next minutes send nothing: ' + JSON.stringify(again));
    return { first, again };
  });

  // Images that fail while a re-read is under way wait for it, or join it:
  // one read at a time, and each image ends with its new link. Before, a
  // failed image started its own walk over the same pages beside the one
  // already running.
  await run('media-links-error-burst', { state: { artifacts: true }, hash: '#invite=tok_Anthony', allowConsole: /status of 403/ }, async (page, S, calls) => {
    const base = S.msgs[S.msgs.length - 1].ts;
    const pics = [300, 340];
    for (let i = 0; i < 41; i++) {
      const id = 300 + i;
      S.msgs.push(pics.includes(id)
        ? { id, ts: base + 1000 * (i + 1), from: 'Ada', kind: 'agent', text: 'Photo ' + id + '.', image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/' + id + '/image?exp=1&sig=dead' } }
        : { id, ts: base + 1000 * (i + 1), from: 'Henry', kind: 'agent', text: 'Line ' + id + '.' });
    }
    let inflight = 0;
    let most = 0;
    await page.route(/\/messages\?/, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== '/api/rooms/demo/messages' || /^(1|200)$/.test(u.searchParams.get('limit') || '')) return route.fallback();
      inflight++;
      most = Math.max(most, inflight);
      await new Promise((r) => setTimeout(r, 700));
      inflight--;
      return route.fallback();
    });
    await page.route(/\/messages\/(300|340)\/image\?/, (route) => {
      const u = new URL(route.request().url());
      const id = +u.pathname.split('/')[5];
      if (u.searchParams.get('sig') !== 'dead') return route.fulfill({ status: 200, contentType: 'image/png', body: require('fs').readFileSync(TESTS + '/../../tests/fixtures/photo.png') });
      const row = S.msgs.find((m) => m.id === id);
      row.image = Object.assign({}, row.image, { url: row.image.url.replace('sig=dead', 'sig=live') });
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' });
    });
    const from = calls.length;
    await page.reload();
    await page.waitForSelector('.msg[data-id="340"] img.msg-img', { state: 'attached', timeout: 5000 });
    // the newest photo failed at the bottom and its re-read is under way;
    // the older one, scrolled into view now, fails during it
    const busy = () => inflight > 0;
    for (let i = 0; i < 100 && !busy(); i++) await page.waitForTimeout(50);
    must(inflight === 1, 'the newest photo\'s re-read is under way: ' + JSON.stringify({ imgs: calls.slice(from).filter((c) => /\/image/.test(c)), reads: renewReads(calls, from) }));
    await page.evaluate(() => document.querySelector('.msg[data-id="300"]').scrollIntoView({ block: 'center' }));
    for (const id of pics) {
      await page.evaluate((i) => document.querySelector('.msg[data-id="' + i + '"]').scrollIntoView({ block: 'center' }), id);
      await page.waitForFunction((i) => /sig=live/.test(document.querySelector('.msg[data-id="' + i + '"] img.msg-img').getAttribute('src')), id, { timeout: 8000 })
        .catch(() => { throw new Error('photo ' + id + ' never got its new link: ' + JSON.stringify(renewReads(calls, from))); });
    }
    await settle(page);
    const reads = renewReads(calls, from);
    must(most === 1, 'one re-read at a time: ' + JSON.stringify({ most, reads }));
    must(reads.length <= 2, 'the failures share at most two reads: ' + JSON.stringify(reads));
    return { most, reads };
  });

  // A room with steady media: a photo lands every four minutes for two
  // hours. Each row has its own link time, so a few cross 50 minutes at
  // every check; renewing every row past 30 minutes with the one that is
  // due spaces the re-reads about twenty minutes apart, each a read by id
  // of just those rows. Before, every check from the 50th minute began its
  // own read of 500 rows.
  await run('media-links-batched', { state: { artifacts: true }, hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    S.streamRetry = 150;
    await page.reload();
    await settle(page);
    const from = calls.length;
    let id = 400;
    for (let t = 2; t <= 120; t += 2) {
      await skew(page, t * 60e3);
      if (t % 4 === 0) {
        const n = id++;
        S.msgs.push({ id: n, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Ada', kind: 'agent', text: 'Photo ' + n + '.', image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/' + n + '/image?exp=1&sig=x' } });
        await page.waitForSelector('.msg[data-id="' + n + '"]', { state: 'attached', timeout: 5000 });
      }
      await nudge(page);
      await settle(page);
    }
    S.streamRetry = 0;
    const reads = renewReads(calls, from);
    const sizes = reads.map((c) => idsOf(c).length);
    const media = S.msgs.filter((m) => m.image || m.html || m.doc || m.file || m.audio || m.video).length;
    must(reads.length >= 3 && reads.length <= 6, 'renewals come in batches, about twenty minutes apart: ' + JSON.stringify(reads));
    must(sizes.every((n) => n > 0 && n <= media), 'each reads only rows with media, by id: ' + JSON.stringify(sizes));
    must(!calls.slice(from).some((c) => /^GET \/api\/rooms\/demo\/messages\?after=/.test(c) && !/[?&]limit=1$/.test(c)), 'no forward walk: ' + JSON.stringify(pageReads(calls, from)));
    return { reads: reads.length, sizes };
  });

  // With the network gone, the minute's check sends nothing while the
  // browser says it is offline and runs when it comes back; with the
  // network failing behind an online browser, each failed read doubles
  // the wait before the next. A failed image still retries at once.
  // Before, every check failed at its first read and the next went out a
  // minute later, for as long as the tab was open.
  await run('media-links-offline', { state: { artifacts: true }, hash: '#invite=tok_Anthony', allowConsole: /status of 403|ERR_INTERNET_DISCONNECTED/ }, async (page, S) => {
    let down = false;
    const tried = [];
    await page.route(/\/api\/rooms\/demo\/messages\?/, (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== '/api/rooms/demo/messages' || /^(1|200)$/.test(u.searchParams.get('limit') || '')) return route.fallback();
      tried.push(u.search);
      return down ? route.abort('internetdisconnected') : route.fallback();
    });
    // the room's stream goes down with the network, as in a real outage
    // (a stream that opens re-reads the feed)
    await page.route(/\/stream\?/, (route) => (down ? route.abort('internetdisconnected') : route.fallback()));
    await page.route(/\/messages\/95\/image\?/, (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get('sig') !== 'dead') return route.fallback();
      const row = S.msgs.find((m) => m.id === 95);
      row.image = Object.assign({}, row.image, { url: row.image.url.replace('sig=dead', 'sig=live') });
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' });
    });
    S.streamRetry = 150;
    await page.reload();
    await settle(page);
    const online = (on) => page.evaluate((v) => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => v }), on);
    const src = () => page.$eval('.msg[data-id="8"] img.msg-img', (i) => i.getAttribute('src'));
    // the browser says it is offline: three checks send nothing (counted
    // from here: the stream's reopens before it re-sync the feed)
    const startOff = tried.length;
    await online(false);
    down = true;
    for (const t of [51, 52, 53]) {
      await skew(page, t * 60e3);
      await nudge(page);
      await settle(page);
    }
    const offline = tried.length;
    must(offline === startOff, 'nothing is sent while the browser is offline: ' + JSON.stringify(tried.slice(startOff)));
    // back online: the check runs at once, with no wait for the next minute
    for (const m of S.msgs) for (const k of ['image', 'html', 'doc']) if (m[k]) m[k] = Object.assign({}, m[k], { url: m[k].url.split('?')[0] + '?exp=2&sig=fresh' });
    down = false;
    await online(true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => /sig=fresh/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 5000 })
      .catch(() => { throw new Error('coming back online did not renew: ' + JSON.stringify(tried)); });
    await settle(page);
    const back = tried.length;
    // an hour on, the network fails behind an online browser: a check a
    // minute for eleven minutes reads at 0, +2 and +6 minutes
    down = true;
    const failFrom = tried.length;
    for (let t = 104; t <= 114; t++) {
      await skew(page, t * 60e3);
      await nudge(page);
      await settle(page);
    }
    const failing = tried.slice(failFrom);
    must(failing.length >= 2 && failing.length <= 4, 'failed reads back off: ' + JSON.stringify(failing));
    // still within the wait: a photo whose link is dead retries at once
    down = false;
    const retryFrom = tried.length;
    S.msgs.push({ id: 95, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Ada', kind: 'agent', text: 'A late photo.', image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/95/image?exp=1&sig=dead' } });
    await page.waitForSelector('.msg[data-id="95"] img.msg-img', { state: 'attached', timeout: 5000 });
    await page.evaluate(() => document.querySelector('.msg[data-id="95"]').scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => /sig=live/.test(document.querySelector('.msg[data-id="95"] img.msg-img').getAttribute('src')), null, { timeout: 8000 })
      .catch(() => { throw new Error('the failed photo was not retried during the wait: ' + JSON.stringify(tried.slice(retryFrom))); });
    S.streamRetry = 0;
    must(/sig=fresh/.test(await src()), 'row 8 kept its renewed link');
    return { offline: offline - startOff, back: back - offline, failing: failing.length, retry: tried.length - retryFrom };
  });

  // Reads that failed behind an online browser (the server down, a captive
  // wifi) hold the minute's check; the room's stream opening again says the
  // server answers, so the hold ends and the due links renew at once.
  // Before, only an online event ended it, which never comes when the
  // browser never thought it was offline, and links stayed dead for up to
  // ten minutes after the room was back.
  await run('media-links-hold-ends-on-reopen', { state: { artifacts: true }, hash: '#invite=tok_Anthony', init: heldStream, allowConsole: /ERR_FAILED/ }, async (page, S) => {
    let down = false;
    const tried = [];
    await page.route(/\/api\/rooms\/demo\/messages\?/, (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== '/api/rooms/demo/messages' || /^(1|200)$/.test(u.searchParams.get('limit') || '')) return route.fallback();
      tried.push(u.search);
      return down ? route.abort('failed') : route.fallback();
    });
    S.streamRetry = 300;
    await page.reload();
    await settle(page);
    const src = () => page.$eval('.msg[data-id="8"] img.msg-img', (i) => i.getAttribute('src'));
    // minute 51: the renewal's read fails, and the check holds
    down = true;
    await skew(page, 51 * 60e3);
    await nudge(page);
    for (let i = 0; i < 40 && !tried.length; i++) await page.waitForTimeout(50);
    await settle(page);
    must(tried.length === 1, 'the due renewal tried once: ' + JSON.stringify(tried));
    // minute 52, inside the hold: the server is back and the stream reopens
    down = false;
    for (const m of S.msgs) for (const k of ['image', 'html', 'doc']) if (m[k]) m[k] = Object.assign({}, m[k], { url: m[k].url.split('?')[0] + '?exp=2&sig=fresh' });
    await skew(page, 52 * 60e3);
    await page.evaluate(() => window.__streams[0].end());
    await page.waitForFunction(() => /sig=fresh/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 5000 })
      .catch(() => { throw new Error('the reopened stream did not end the hold: ' + JSON.stringify(tried)); });
    S.streamRetry = 0;
    return { tried, src: await src() };
  });

  // A feed holding 250 rows with media renews them in three reads by id,
  // of at most 100 ids each, one after another, and reads no page. Before,
  // the renewal read the latest page and walked forward page by page.
  await run('media-links-by-id-250', { state: { artifacts: true }, hash: '#invite=tok_Anthony', init: heldStream }, async (page, S, calls) => {
    const photo = (id, ts) => ({ id, ts, from: 'Ada', kind: 'agent', text: 'Photo ' + id + '.', image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/' + id + '/image?exp=1&sig=x' } });
    const base = S.msgs[S.msgs.length - 1].ts;
    // the boot load takes the newest 200; 50 more come over the stream
    for (let i = 0; i < 200; i++) S.msgs.push(photo(1000 + i, base + 1000 * (i + 1)));
    await page.reload();
    await settle(page);
    const late = [];
    for (let i = 0; i < 50; i++) late.push(photo(1200 + i, base + 1000 * (201 + i)));
    S.msgs.push(...late);
    await page.evaluate((rows) => window.__streams[0].send(rows.map((m) => 'id: ' + m.id + '\nevent: message\ndata: ' + JSON.stringify(m) + '\n\n').join('')), late);
    await page.waitForSelector('.msg[data-id="1249"]', { state: 'attached', timeout: 5000 });
    await settle(page);
    const held = await page.$$eval('.msg img.msg-img', (is) => is.length);
    must(held === 250, 'the feed holds 250 photos: ' + held);
    for (const m of S.msgs) if (m.image) m.image = Object.assign({}, m.image, { url: m.image.url.split('?')[0] + '?exp=2&sig=fresh' });
    const from = calls.length;
    await skew(page, 51 * 60e3);
    await nudge(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.msg img.msg-img')].every((i) => /sig=fresh/.test(i.getAttribute('src'))), null, { timeout: 8000 })
      .catch(() => { throw new Error('not every photo was renewed: ' + JSON.stringify(renewReads(calls, from))); });
    await settle(page);
    const reads = renewReads(calls, from);
    const sizes = reads.map((c) => idsOf(c).length);
    must(reads.length === 3 && sizes.every((n) => n <= 100) && sizes.reduce((a, b) => a + b, 0) === 250, 'three reads by id of at most 100: ' + JSON.stringify(sizes));
    must(pageReads(calls, from).length === 0, 'no page is read: ' + JSON.stringify(pageReads(calls, from)));
    return { sizes };
  });

  done('people-media');
})();
