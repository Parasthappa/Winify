require('../lib/no-network');
// About Winify, in the real app with Spotify faked: from the menu-bar menu and the main menu, with the credits and the disclaimer.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-about-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
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
const shown = []; let answer = 0; const opened = [];
dialog.showMessageBox = async (o) => { shown.push(o); return { response: answer }; };
shell.openExternal = async (u) => { opened.push(u); };
let tray = []; const realBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (t) => { if (t.some((i) => i.label === 'Quit Winify')) tray = t; return realBuild(t); };
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 240) : '')); };
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 90000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
require(path.join(__dirname, '..', '..', 'main.js'));
app.whenReady().then(async () => {
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  for (let i = 0; i < 150 && !(await js('!!(window.WinifyWebamp && WinifyWebamp.isMounted())').catch(() => false)); i++) await wait(100);
  await wait(1500);

  console.log('1. The menu-bar menu');
  const item = tray.find((i) => i.label === 'About Winify...');
  check('has About Winify...', !!item);
  item.click(); await wait(100);
  const box = shown[0] || {}; const text = (box.message || '') + '\n' + (box.detail || '');
  check('names the version', /Winify \d+\.\d+\.\d+/.test(box.message || ''), box.message);
  for (const [what, re] of [['a fan project', /independent fan project/], ['Winamp, by Nullsoft', /Winamp, by Nullsoft/], ['Webamp, by Jordan Eldredge and contributors', /Webamp, by Jordan Eldredge and contributors/], ['the MIT License and its link', /MIT License[\s\S]*github\.com\/captbaritone\/webamp/], ['Butterchurn', /Butterchurn/], ['the preset authors', /Milkdrop preset authors/], ['the skin authors', /skin authors/], ['LRCLIB', /LRCLIB/], ['not affiliated with Winamp or Winamp Group', /not affiliated with or endorsed by Winamp or its owner, Winamp Group/]]) check('says ' + what, re.test(text));
  check('OK leaves the project page shut', opened.length === 0);
  answer = 1; item.click(); await wait(100);
  check('Project page opens it', opened[0] === require(path.join(__dirname, '..', '..', 'package.json')).homepage, opened[0]);
  answer = 0; shown.length = 0;

  console.log('2. The main menu');
  const r = await js(`(() => { const b = document.querySelector('#webamp #title-bar #option').getBoundingClientRect(); return { x: Math.round(b.left + 4), y: Math.round(b.top + 4) }; })()`);
  win.focus(); await wait(300);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y }); await wait(150);
  for (const type of ['mouseDown', 'mouseUp']) { win.webContents.sendInputEvent({ type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(40); }
  for (let i = 0; i < 30 && !(await js(`!!document.querySelector('#webamp-context-menu li > a')`)); i++) await wait(100);
  const link = await js(`(() => { const a = [...document.querySelectorAll('#webamp-context-menu li > a')].find((x) => /^Winify\\.\\.\\./.test(x.textContent.trim())); if (!a) return null; const b = a.getBoundingClientRect(); return { href: a.href, x: Math.round(b.left + 8), y: Math.round(b.top + b.height / 2) }; })()`);
  check('Winify... is there', !!link, JSON.stringify(link));
  if (link) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: link.x, y: link.y }); await wait(100);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: link.x, y: link.y, button: 'left', clickCount: 1 });
    await wait(400);
    check('it opens the About box', shown.length === 1);
    check('and not the browser', opened.length === 1);
  }
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED'); app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
