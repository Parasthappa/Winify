// `npm run package:check`: builds a packaged test app that starts at
// test/package/check.js (into dist/test.noindex, never for sharing) and runs it.
// Offline: Spotify and LRCLIB are faked inside it. Exit code 0 = all passed.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'build.js'), '--test', 'test/package/check.js'], { cwd: ROOT, stdio: 'inherit' });
const OUT = path.join(ROOT, 'dist', 'test.noindex');
const bin = path.join(OUT, 'mac-arm64', 'Winify.app', 'Contents', 'MacOS', 'Winify');
const run = spawnSync(bin, [], { cwd: ROOT, env: Object.assign({}, process.env, { SMOKE_OUTPUT: path.join(ROOT, 'test', '.output') }), encoding: 'utf8', timeout: 120000 });
const out = (run.stdout || '').split('\n').filter((l) => /^(Winify\.app checks|\s+(PASS|FAIL)|RESULT)/.test(l));
console.log('\n' + out.join('\n'));
fs.rmSync(OUT, { recursive: true, force: true });   // not left around as a second Winify.app
if (run.status !== 0) {
  console.error('\nPackaged checks failed (log: test/.output/package-check.log).' + (run.error ? ' ' + run.error.message : ''));
  process.exit(1);
}
