require('../lib/no-network');
// Real Winify (main.js) with Spotify faked: the player starts whether or not its window can be seen. A page loaded
// under a covering window used to count as hidden and get no frames, and start-up waited for a frame for good.
const { app, BrowserWindow } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-covered-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'test-client-id';
const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));
const realFetch = global.fetch;
global.fetch = async (u, o) => { const url = String(u); if (!/^https:\/\/(api|accounts)\.spotify\.com\//.test(url)) return realFetch(u, o);
  const p = new URL(url).pathname; const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (p === '/api/token') return J({ access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: SCOPES });
  if (p === '/v1/me') return J({ id: 'tester', product: 'premium', country: 'GB', display_name: 'Tester' });
  return J({ error: { status: 404, message: 'mock: not here' } }, 404); };
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 200) : '')); };
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cover = null;
const makeCover = () => { const { screen } = require('electron');
  cover = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, show: false, frame: false, backgroundColor: '#555555', hasShadow: false, alwaysOnTop: true }); cover.setAlwaysOnTop(true, 'screen-saver'); cover.showInactive(); };
app.whenReady().then(async () => {
  makeCover();
  let win; while (!(win = BrowserWindow.getAllWindows().find((w) => w !== cover))) await wait(50);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const mounted = async (ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js('!!(window.WinifyWebamp && WinifyWebamp.isMounted())').catch(() => false)) return true; await wait(100); } return false; };
  const shown = () => js(`new Promise((res) => { let n = 0; const f = () => { n++; requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => res({ hidden: document.hidden, frames: n, webamp: !!document.querySelector('#webamp #main-window') }), 500); })`);
  const drawing = (s) => !s.hidden && s.frames > 5 && s.webamp;

  console.log('1. Launched under a covering window');
  check('the player starts', await mounted());
  let s = await shown(); check('...and draws', drawing(s), JSON.stringify(s));
  cover.destroy(); cover = null; await wait(500);
  s = await shown(); check('uncovered: still drawing', drawing(s), JSON.stringify(s));

  console.log('2. The page loads again under a covering window');
  makeCover(); await wait(2000);
  win.webContents.reload(); await wait(800);
  check('the player comes back', await mounted());
  s = await shown(); check('...and draws', drawing(s), JSON.stringify(s));
  cover.destroy(); cover = null; await wait(500);
  s = await shown(); check('uncovered: still drawing', drawing(s), JSON.stringify(s));

  console.log('3. No frames at all');
  await js(`(() => { const raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; window.__raf = raf; WinifyWebamp.unmount(); })()`);
  const again = await js(`Promise.race([WinifyWebamp.mount('webamp-root').then((r) => r), new Promise((r) => setTimeout(() => r('no answer in 10 s'), 10000))])`);
  check('start-up finishes without a single frame', again === true, again);
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED'); app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
require(path.join(__dirname, '..', '..', 'main.js'));
