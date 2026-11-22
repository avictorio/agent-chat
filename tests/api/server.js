// A hermetic local Worker for tests: wrangler dev on its own port, with its
// own state directory (removed afterwards), the test owner key and
// TEST_HOOKS on. Nothing here touches the real site.
//
// The API suite uses start(); a one-off script (a bug repro, a probe) runs
// against its own instance with
//
//   node tests/api/server.js run path/to/script.js [args...]
//
// which starts a server on a free port, runs the script with BASE (the
// server's URL) and OWNER (the test owner key) in its environment, stops the
// server and exits with the script's status. Several can run side by side.
//
// The Worker's values go in with --var, so no .dev.vars is written. A
// developer's own .dev.vars would be loaded as well and could bring real
// keys into a test run: when one exists it is moved aside for the run and
// put back after (one run at a time in that case; a cloud sandbox has none).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OWNER = 'api-test-owner-key';
const DEV_VARS = path.join(ROOT, '.dev.vars');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** Starts wrangler dev and waits until it answers.
 *  @param opts {port?: number} - default: API_PORT from the environment, else a free port
 *  @returns {{ base: string, port: number, owner: string, stop: () => void }} */
async function start(opts) {
  opts = opts || {};
  if (!fs.existsSync(path.join(ROOT, 'web', 'app', 'dist', 'index.html'))) {
    throw new Error('the local Worker needs the web build: run `npm run build` first');
  }
  const port = opts.port || Number(process.env.API_PORT) || await freePort();
  const inspector = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apitest-state-'));
  const aside = fs.existsSync(DEV_VARS) ? DEV_VARS + '.aside-' + process.pid : null;
  if (aside) fs.renameSync(DEV_VARS, aside);
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', stateDir,
    // a mail key so room creation counts as set up; under TEST_HOOKS no mail is sent (routes/rooms.ts)
    '--var', 'OWNER_KEY:' + OWNER, '--var', 'RESEND_API_KEY:re_fake_for_tests', '--var', 'TEST_HOOKS:1'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    if (aside) { try { fs.renameSync(aside, DEV_VARS); } catch {} }
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  };
  // a killed or interrupted run still stops its server and restores .dev.vars
  process.once('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { stop(); process.exit(130); });
  const base = 'http://localhost:' + port;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(base + '/api'); if (r.status) return { base, port, owner: OWNER, stop }; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error('wrangler dev did not come up on port ' + port);
}

module.exports = { start, OWNER, ROOT };

if (require.main === module) {
  const [cmd, script, ...rest] = process.argv.slice(2);
  if (cmd !== 'run' || !script) {
    console.error('usage: node tests/api/server.js run path/to/script.js [args...]');
    process.exit(2);
  }
  (async () => {
    const s = await start();
    const c = spawn(process.execPath, [path.resolve(script), ...rest], { stdio: 'inherit', env: Object.assign({}, process.env, { BASE: s.base, OWNER: s.owner }) });
    c.on('exit', (code, sig) => { s.stop(); process.exit(sig ? 1 : code || 0); });
  })().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
}
