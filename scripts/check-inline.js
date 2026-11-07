// Static checks the UI suite can't make:
//  1. Every inline <script> in both pages parses (node --check).
//  2. No literal \uXXXX escapes in the pages' static markup - they render
//     as raw text there (the Your voice dialog shipped them to users on
//     2026-11-07). Escapes inside <script> are fine and ignored.
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
let bad = 0;
for (const f of ['src/chat.html', 'src/home.html']) {
  const src = fs.readFileSync(f, 'utf8');
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((code, i) => {
    const tmp = path.join(os.tmpdir(), 'inline-' + path.basename(f) + '-' + i + '.js');
    fs.writeFileSync(tmp, code);
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { bad++; console.error(f + ' script #' + i + ' does not parse:\n' + e.stderr); }
    fs.unlinkSync(tmp);
  });
  const markup = src.replace(/<script>[\s\S]*?<\/script>/g, '');
  const hits = markup.match(/\\u[0-9a-fA-F]{4}/g);
  if (hits) { bad++; console.error(f + ': literal escape sequences in static markup: ' + [...new Set(hits)].join(' ')); }
}
if (bad) { console.error('check-inline: ' + bad + ' problem(s)'); process.exit(1); }
console.log('check-inline: inline scripts parse; no literal escapes in markup');
