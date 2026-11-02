require('../lib/no-network');
// Suites labelled "no Spotify requests" really send nothing: every way out is stopped, and every suite is guarded.
const { app, BrowserWindow, net } = require('electron'); const fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
app.setPath('userData', path.join(__dirname, '..', '.profiles', 'app-no-network'));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 200) : '')); };
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 60000);
const HOST = 'https://example.com/';   // not Spotify, in case the guard ever fails
const refused = (p) => p.then(() => false, () => true);
app.whenReady().then(async () => {
  for (const dir of ['app']) for (const f of fs.readdirSync(path.join(__dirname, '..', dir)).filter((n) => n.endsWith('.test.js'))) {
    check(dir + '/' + f + ' is guarded', /^require\('\.\.\/lib\/no-network'\);$/m.test(fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8')));
  }
  check('the mock suites and galleries are guarded (harness)', /^require\('\.\/no-network'\);$/m.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'harness.js'), 'utf8')));
  check('main process fetch stopped', await refused(fetch(HOST)));
  check('main process https stopped', await new Promise((r) => { https.get(HOST, () => r(false)).on('error', () => r(true)); }));
  check('Electron net.fetch stopped', await refused(net.fetch(HOST)));
  const server = http.createServer((q, s) => s.end('<title>local</title>ok')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const local = 'http://127.0.0.1:' + server.address().port + '/';
  check('local requests still work', (await (await fetch(local)).text()).endsWith('ok'));
  const win = new BrowserWindow({ show: false }); await win.loadURL(local);
  const page = (c) => win.webContents.executeJavaScript(c, true);
  check('page fetch stopped', await page(`fetch(${JSON.stringify(HOST)}, { mode: 'no-cors' }).then(() => false, () => true)`));
  check('page script (as the player library loads) stopped', await page(`new Promise((r) => { const s = document.createElement('script'); s.src = ${JSON.stringify(HOST + 'x.js')}; s.onload = () => r(false); s.onerror = () => r(true); document.head.append(s); })`));
  check('page WebSocket (as the player library connects, token in the address) stopped', await page(`new Promise((r) => { const w = new WebSocket('wss://example.com/?access_token=fake'); w.onopen = () => r(false); w.onerror = () => r(true); })`));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED'); app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
