// Real Winify app, a remembered sign-in, Spotify faked: where Winify's window sits among other apps' windows.
// The window level is read back from macOS itself (test/lib/window-layers.swift).
require('../lib/no-network');
const electron = require('electron'); const { app, BrowserWindow, session, net } = electron; const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const profile = path.join(__dirname, '..', '.profiles', 'app-levels-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'test-client-id';
const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));
// Remembered from last time: always on top.
const SAVED_ID = '0123456789abcdef0123456789abcdef';   // a made-up Client ID, saved alongside
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ clientId: SAVED_ID, windowLevel: 'top' }));
function spotify(method, url) {
  const p = new URL(url).pathname;
  const J = (status, body) => ({ status, body });
  if (p === '/api/token') return J(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: SCOPES });
  if (method === 'GET' && p === '/v1/me') return J(200, { id: 'tester', product: 'premium', country: 'GB', display_name: 'Tester' });
  if (method === 'GET' && p === '/v1/me/player') return J(204, null);
  if (method === 'GET' && p === '/v1/me/player/devices') return J(200, { devices: [] });
  if (method === 'GET') return J(404, { error: { status: 404, message: 'mock: not here' } });
  return J(204, null);
}
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (/^https:\/\/(api|accounts)\.spotify\.com\//.test(url)) { const r = spotify(o.method || 'GET', url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
  return realFetch(u, o);
};
// The menu-bar menu, as main.js builds it (its items are clicked here).
let trayMenu = null;
const realSetMenu = electron.Tray.prototype.setContextMenu;
electron.Tray.prototype.setContextMenu = function (menu) { trayMenu = menu; return realSetMenu.call(this, menu); };
const trayItem = (label) => trayMenu && trayMenu.items.find((i) => i.label === label);
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 150000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
// The macOS window level ("layer") of Winify's big window: the largest window this app (this process: other
// suites' Electron windows may be open at the same time) has on screen.
function layer() {
  const out = execFileSync('swift', [path.join(__dirname, '..', 'lib', 'window-layers.swift'), String(process.pid)], { encoding: 'utf8' });
  const rows = out.trim().split('\n').map((l) => { const m = l.match(/\| layer (-?\d+) \| \S+ \S+ (\d+)x(\d+)$/); return m ? { layer: +m[1], area: +m[2] * +m[3] } : null; }).filter(Boolean);
  rows.sort((a, b) => b.area - a.area);
  return rows.length ? rows[0].layer : null;
}
const config = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
// Waited for (not a fixed time: under load the page and macOS take longer): the level to become `want`.
async function settle(want, ms = 4000) { const end = Date.now() + ms; let l; while (Date.now() < end) { l = layer(); if (l === want) return l; await new Promise((r) => setTimeout(r, 250)); } return l; }
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', async (req) => {
    if (new URL(req.url).host === 'api.spotify.com') { const r = spotify(req.method, req.url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const until = async (expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await js(expr).catch(() => null); if (v) return v; await wait(150); } return v; };
  const click = async (sel) => { const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y }); await wait(150); win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(40); win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(500); };
  await until('!!(window.WinifyWebamp && WinifyWebamp.isMounted())'); await wait(1200);

  console.log('1. Always on top: remembered, and the A button');
  const l0 = await settle(3);
  check('remembered from last time: on top at launch (macOS floating level, 3), A lit', win.isAlwaysOnTop() && l0 === 3 && (await js(`document.querySelector('#webamp #button-a').classList.contains('selected')`)), String(layer()));
  await click('#webamp #main-window #button-a');
  const l1 = await settle(0);
  check('A: an ordinary window again (level 0), remembered, A not lit', !win.isAlwaysOnTop() && l1 === 0 && config().windowLevel === 'normal' && !(await js(`document.querySelector('#webamp #button-a').classList.contains('selected')`)), JSON.stringify({ layer: layer(), config: config() }));
  await click('#webamp #main-window #button-a');
  const l1b = await settle(3);
  check('A again: on top (3), remembered', win.isAlwaysOnTop() && l1b === 3 && config().windowLevel === 'top', JSON.stringify({ layer: layer(), config: config() }));
  check('the rest of config.json is kept (the saved Client ID)', config().clientId === SAVED_ID, JSON.stringify(config()));

  console.log('2. Behind other apps: the menu-bar menu');
  let item = trayItem('Keep behind other apps');
  check('menu-bar menu: "Keep behind other apps", unticked while on top', !!item && item.type === 'checkbox' && !item.checked, JSON.stringify(item && { type: item.type, checked: item.checked }));
  item.click();
  const lb = await settle(-1);
  check('ticked: one level below other apps\' windows (-1), remembered; always on top turned off (A not lit)', lb === -1 && config().windowLevel === 'behind' && trayItem('Keep behind other apps').checked &&
    !(await js(`document.querySelector('#webamp #button-a').classList.contains('selected')`)), JSON.stringify({ layer: layer(), config: config() }));
  // A click on Winify (the main window) brings Winify's app forward, not its window: it stays at -1.
  await click('#webamp #main-window #title-bar');
  win.focus(); await wait(400);
  const lc = await settle(-1);
  check('clicked and focused: still behind (-1)', lc === -1, String(lc));
  await click('#webamp #main-window #button-a');
  const la = await settle(3);
  check('A while behind: always on top (3), "Keep behind" unticked', la === 3 && config().windowLevel === 'top' && !trayItem('Keep behind other apps').checked, JSON.stringify({ layer: layer(), config: config() }));
  trayItem('Keep behind other apps').click();
  const l2 = await settle(-1); await until(`!document.querySelector('#webamp #button-a').classList.contains('selected')`, 4000);
  check('the menu item again while on top: behind (-1), A not lit', l2 === -1 && !(await js(`document.querySelector('#webamp #button-a').classList.contains('selected')`)), JSON.stringify({ layer: l2, config: config() }));

  console.log('3. Full screen (Milkdrop) while behind');
  win.webContents.emit('enter-html-full-screen');
  const l3 = await settle(0);
  check('full screen: an ordinary window while it lasts (0), not stuck under other apps', l3 === 0 && win.isSimpleFullScreen(), String(l3));
  win.webContents.emit('leave-html-full-screen');
  const l4 = await settle(-1);
  check('left: behind again (-1), back on its usual area', l4 === -1 && !win.isSimpleFullScreen(), String(l4));
  trayItem('Keep behind other apps').click();
  const lu = await settle(0);
  check('unticked: an ordinary window (0)', lu === 0 && config().windowLevel === 'normal', String(layer()));

  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
