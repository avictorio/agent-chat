// Preload for cloud sandboxes: point the repo-pinned Playwright at the
// preinstalled Chromium (/opt/pw-browsers/chromium) instead of downloading one.
//   cd web && node -r ./tests/system-chromium.js tests/ui.test.js
const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = orig.apply(this, arguments);
  if (id === 'playwright' && m && m.chromium && !m.chromium.__patched) {
    const launch = m.chromium.launch.bind(m.chromium);
    m.chromium.launch = (o) => launch(Object.assign({ executablePath: '/opt/pw-browsers/chromium' }, o || {}));
    m.chromium.__patched = true;
  }
  return m;
};
