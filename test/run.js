// Winify's test suite: `npm test` (everything), or `npm test -- picker lyrics` (by name).
//
// Mock suites (test/mock) drive Winify's player against a fake Spotify in a
// page; app suites (test/app) run the real main process with Spotify faked.
// Neither sends anything to Spotify. Mock suites run three at a time, each
// with its own port and settings folder; app suites share Winify's sign-in
// port, so they run one after another alongside.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..');
const MOCK_LANES = Number(process.env.TEST_LANES) || 3;
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;
for (const dir of ['.profiles', '.output']) fs.mkdirSync(path.join(__dirname, dir), { recursive: true });

const pick = process.argv.slice(2);
const list = (dir) => fs.readdirSync(path.join(__dirname, dir)).filter((f) => f.endsWith('.test.js'))
  .map((f) => ({ name: dir + '/' + f.replace('.test.js', ''), file: path.join(__dirname, dir, f) }))
  .filter((s) => !pick.length || pick.some((p) => s.name.includes(p)));
const mock = list('mock');
const appSuites = list('app');

function run(suite, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = [];
    const child = spawn(electron, [suite.file], { cwd: ROOT, env: Object.assign({}, process.env, { TEST_PORT: String(port) }) });
    const timer = setTimeout(() => { out.push('TIMED OUT'); child.kill('SIGKILL'); }, SUITE_TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    child.on('exit', (code) => {
      clearTimeout(timer);
      const text = out.join('');
      const passed = (text.match(/^ {2}PASS /gm) || []).length;
      const failed = text.split('\n').filter((l) => /^ {2}FAIL |HARNESS ERROR|WATCHDOG|TIMED OUT|threw an error/.test(l));
      const ok = code === 0 && failed.length === 0 && /RESULT: ALL PASSED/.test(text);
      fs.writeFileSync(path.join(__dirname, '.output', suite.name.replace('/', '-') + '.log'), text);
      console.log((ok ? 'ok   ' : 'FAIL ') + suite.name.padEnd(22) + String(passed).padStart(4) + ' checks  ' + Math.round((Date.now() - started) / 1000) + 's');
      failed.slice(0, 8).forEach((l) => console.log('       ' + l.trim().slice(0, 220)));
      resolve({ suite, ok, passed });
    });
  });
}

async function lane(queue, port) {
  const results = [];
  for (let s = queue.shift(); s; s = queue.shift()) results.push(await run(s, port));
  return results;
}

(async () => {
  const t0 = Date.now();
  console.log('Winify tests: ' + mock.length + ' mock suites, ' + appSuites.length + ' app suites (no Spotify requests)\n');
  const queue = mock.slice();
  const lanes = Array.from({ length: MOCK_LANES }, (_, i) => lane(queue, 18899 + i));
  lanes.push(lane(appSuites.slice(), 18899 + MOCK_LANES));
  const results = (await Promise.all(lanes)).flat();
  const bad = results.filter((r) => !r.ok);
  const checks = results.reduce((n, r) => n + r.passed, 0);
  console.log('\n' + (bad.length ? bad.length + ' of ' + results.length + ' suites FAILED' : 'All ' + results.length + ' suites passed') +
    ' (' + checks + ' checks, ' + Math.round((Date.now() - t0) / 60000) + ' min). Logs: test/.output/');
  process.exit(bad.length ? 1 : 0);
})();
