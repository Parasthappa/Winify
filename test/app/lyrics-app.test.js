// Real Winify app (main.js, preload, page, CSP), isolated profile, Spotify faked locally ("Blinding Lights"
// playing on another device), everything else real - including LRCLIB through the main process.
const { app, BrowserWindow, session, net, protocol } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-lyrics-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'test-client-id';
const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));
const BL = { uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b', id: '0VjIjW4GlUZAMYd2vXMi3b', name: 'Blinding Lights', type: 'track', duration_ms: 200040,
  artists: [{ name: 'The Weeknd', uri: 'spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ' }], album: { name: 'After Hours', uri: 'spotify:album:4yP0hdKOZPNshxUOjY0cZj', images: [] }, is_playable: true };
const started = Date.now();
function spotify(method, url) {
  const p = new URL(url).pathname;
  const J = (status, body) => ({ status, body });
  if (p === '/api/token') return J(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: SCOPES });
  if (method === 'GET' && p === '/v1/me') return J(200, { id: 'tester', product: 'premium', country: 'GB', display_name: 'Tester' });
  if (method === 'GET' && p === '/v1/me/player') return J(200, { device: { id: 'phone1', name: 'Phone', type: 'Smartphone', is_active: true, volume_percent: 50 },
    item: BL, is_playing: true, progress_ms: 30000 + (Date.now() - started), timestamp: Date.now(), context: null, shuffle_state: false, repeat_state: 'off', currently_playing_type: 'track' });
  if (method === 'GET' && p === '/v1/me/player/queue') return J(200, { currently_playing: BL, queue: [] });
  if (method === 'GET' && p === '/v1/me/player/devices') return J(200, { devices: [{ id: 'phone1', name: 'Phone', type: 'Smartphone', is_active: true }] });
  if (method === 'GET' && p === '/v1/tracks/' + BL.id) return J(200, BL);
  if (method === 'GET') return J(404, { error: { status: 404, message: 'mock: not here' } });
  return J(204, null);
}
const lrclibSeen = [];
const terminal = []; const realLog = console.log; console.log = (...a) => { const t = a.join(' '); if (t.startsWith('[winify/lyrics]')) terminal.push(t); realLog(...a); };
// Main process: Node fetch.
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (/^https:\/\/(api|accounts)\.spotify\.com\//.test(url)) { const r = spotify(o.method || 'GET', url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
  if (/^https:\/\/lrclib\.net\//.test(url)) {
    const res = await realFetch(u, o);
    lrclibSeen.push({ url, status: res.status, ua: o.headers && o.headers['User-Agent'] });
    return res;
  }
  return realFetch(u, o);
};
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 400) : '')); };
app.whenReady().then(async () => {
  // Page: Spotify's Web API faked, everything else (the SDK script, fonts) real.
  session.defaultSession.protocol.handle('https', async (req) => {
    if (new URL(req.url).host === 'api.spotify.com') { const r = spotify(req.method, req.url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const logs = [];
  win.webContents.on('console-message', (e) => { const m = e.message || ''; logs.push(m); if (/lyrics|lrclib|error|Error|CSP|Content Security|Refused/i.test(m)) console.log('   page: ' + m.slice(0, 300)); });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  for (let i = 0; i < 150 && !(await js('!!(window.WinifyWebamp && WinifyWebamp.isMounted())').catch(() => false)); i++) await wait(100);
  check('player shown (Webamp mounted) in the real app', await js('WinifyWebamp.isMounted()'));
  for (let i = 0; i < 80 && !(await js('WinifyControls.state().trackUri').catch(() => null)); i++) await wait(150);
  const now = await js('WinifyControls.state()');
  check('Winify sees the playing track (on another device)', now.trackUri === BL.uri, JSON.stringify({ where: now.where, title: now.title, artist: now.artist }));
  win.focus(); await wait(300);
  const click = async (sel) => { const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    if (!r) return false; win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y }); win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(40); win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(100); return true; };
  const L = () => js('WinifyLyrics.state()');
  const untilL = async (fn, ms = 15000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await L(); if (fn(v)) return v; await wait(200); } return v; };

  // Each way in, from closed: the lyrics must be on screen, read from the window itself.
  const onScreen = () => js(`(() => { const b = document.querySelector('.winify-lyrics .wl-body'); if (!b) return null; const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 20, r.top + 60); return { text: b.innerText, visible: r.width > 100 && r.height > 100 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, hitInside: !!(hit && b.contains(hit)) }; })()`);
  const shown = async () => { const t0 = Date.now(); let v; while (Date.now() - t0 < 15000) { v = await onScreen(); if (v && /tryna call/i.test(v.text) && v.visible) return v; await wait(200); } return v; };
  const closed = async () => { for (let i = 0; i < 20 && (await L()).open; i++) await wait(100); return !(await L()).open; };

  console.log('LYRIC button');
  await click('#playlist-window');
  check('the playlist window\'s LYRIC (MISC) button exists', await click('#webamp #playlist-misc-menu'));
  let v = await shown();
  check('LYRIC: window open, Blinding Lights lyrics on screen (visible, not covered)', v && v.visible && v.hitInside && /^Blinding Lights\s+The Weeknd/.test(v.text) && /tryna call/i.test(v.text), JSON.stringify(v && { visible: v.visible, hit: v.hitInside, text: v.text.slice(0, 90) }));
  check('LRCLIB request went out from the main process and came back 200, with Winify\'s User-Agent', lrclibSeen.some((x) => x.status === 200 && /^Winify\/1\.0\.0 /.test(x.ua || '')), JSON.stringify(lrclibSeen));
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'lyrics-app.png'), (await win.webContents.capturePage()).toPNG());
  await click('#webamp #playlist-misc-menu');
  check('LYRIC again closes it', await closed());

  console.log('I button');
  await click('#webamp #button-i');
  v = await shown();
  check('I button: lyrics on screen', v && v.visible && v.hitInside && /tryna call/i.test(v.text), JSON.stringify(v && v.text.slice(0, 60)));
  await click('#webamp #button-i');
  check('I button again closes it', await closed());

  console.log('Option+3');
  await click('#title-bar');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '3', modifiers: ['alt'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '3', modifiers: ['alt'] }); await wait(300);
  v = await shown();
  check('Option+3: lyrics on screen', v && v.visible && v.hitInside && /tryna call/i.test(v.text), JSON.stringify(v && v.text.slice(0, 60)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '3', modifiers: ['alt'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '3', modifiers: ['alt'] }); await wait(300);
  check('Option+3 again closes it', await closed());
  check('lyrics log lines reach the terminal', terminal.some((l) => l.startsWith('[winify/lyrics]')), JSON.stringify(terminal.slice(0, 4)));
  const errs = logs.filter((m) => /Uncaught|TypeError|ReferenceError|Refused to connect|Content Security Policy/i.test(m));
  check('no page errors or CSP refusals', errs.length === 0, JSON.stringify(errs.slice(0, 5)));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
});
