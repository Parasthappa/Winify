// Real Winify app, a remembered sign-in, Spotify faked locally: the chassis's now-playing display (cover, title,
// artist, Spotify's logo and a link back, per Spotify's Developer Policy and design guidelines) and the tagline.
require('../lib/no-network');
const electron = require('electron'); const { app, BrowserWindow, session, net } = electron; const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-nowplaying-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'test-client-id';
const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));
// Album art in three sizes, as Spotify gives it (here as pictures with their size written on them).
const art = (w, colour) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"><rect width="${w}" height="${w}" fill="${colour}"/><text x="50%" y="55%" font-size="${w / 5}" text-anchor="middle" fill="#fff">${w}</text></svg>`);
const BL = { uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b', id: '0VjIjW4GlUZAMYd2vXMi3b', name: 'Blinding Lights', type: 'track', duration_ms: 200040,
  artists: [{ name: 'The Weeknd', uri: 'spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ' }],
  album: { name: 'After Hours', uri: 'spotify:album:4yP0hdKOZPNshxUOjY0cZj', images: [{ url: art(640, '#a02020'), width: 640, height: 640 }, { url: art(300, '#c0392b'), width: 300, height: 300 }, { url: art(64, '#e74c3c'), width: 64, height: 64 }] }, is_playable: true };
let playing = false;
const started = Date.now();
function spotify(method, url) {
  const p = new URL(url).pathname;
  const J = (status, body) => ({ status, body });
  if (p === '/api/token') return J(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: SCOPES });
  if (method === 'GET' && p === '/v1/me') return J(200, { id: 'tester', product: 'premium', country: 'GB', display_name: 'Tester' });
  if (method === 'GET' && p === '/v1/me/player') return playing ? J(200, { device: { id: 'phone1', name: 'Phone', type: 'Smartphone', is_active: true, volume_percent: 50 },
    item: BL, is_playing: true, progress_ms: 30000 + (Date.now() - started), timestamp: Date.now(), context: null, shuffle_state: false, repeat_state: 'off', currently_playing_type: 'track' }) : J(204, null);
  if (method === 'GET' && p === '/v1/me/player/queue') return J(200, { currently_playing: playing ? BL : null, queue: [] });
  if (method === 'GET' && p === '/v1/me/player/devices') return J(200, { devices: [] });
  if (method === 'GET') return J(404, { error: { status: 404, message: 'mock: not here' } });
  return J(204, null);
}
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (/^https:\/\/(api|accounts)\.spotify\.com\//.test(url)) { const r = spotify(o.method || 'GET', url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
  if (/^https:\/\/lrclib\.net\//.test(url)) return new Response('{}', { status: 404 });
  return realFetch(u, o);
};
// The Spotify app, there or not; and what Winify asks macOS to open.
let installed = true;
const opened = [];
app.getApplicationNameForProtocol = () => (installed ? 'Spotify' : '');
electron.shell.openExternal = async (u) => { opened.push(String(u)); };
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', async (req) => {
    if (new URL(req.url).host === 'api.spotify.com') { const r = spotify(req.method, req.url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const errors = []; win.webContents.on('console-message', (e) => { if (/Uncaught|TypeError|ReferenceError|SyntaxError/.test(e.message || '')) errors.push(e.message); });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const R = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; })()`);
  const until = async (expr, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await js(expr).catch(() => null); if (v) return v; await wait(150); } return v; };
  const click = async (sel) => { const r = await R(sel); const x = Math.round(r.x + r.w / 2), y = Math.round(r.y + r.h / 2);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await wait(150); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await wait(40); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await wait(300); };
  const shot = async (name) => { const r = await R('#login-screen'); const img = await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });
    fs.mkdirSync(path.join(__dirname, '..', '.output'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '..', '.output', name), img.toPNG()); };
  await until('!!(window.WinifyWebamp && WinifyWebamp.isMounted())', 15000); await wait(1500);

  console.log('1. Signed in, nothing playing: the wordmark, the new tagline');
  check('the Winify wordmark and "BUILT FOR SPOTIFY PREMIUM"; no now-playing display', !!(await R('#login-screen img[alt="Winify"]')) && /BUILT FOR\s*SPOTIFY PREMIUM/.test(await js(`document.querySelector('#login-screen').innerText`)) && !(await R('#login-screen .sa-np-cover')));
  check('tagline "Make Your Player Yours Again" (not "SPOTIFY & WINAMP REMASTERED")', /Make Your Player Yours Again/.test(await js(`document.querySelector('#login-screen').textContent`)) && !/REMASTERED/.test(await js(`document.querySelector('#login-screen').textContent`)));
  await shot('nowplaying-1-wordmark.png');

  console.log('2. A track playing: cover, title, artist, Spotify\'s logo and a link back');
  playing = true; await js('WinifyControls.refresh()');
  check('now-playing shown in place of the wordmark', await until(`!!document.querySelector('#login-screen .sa-np-cover') && !document.querySelector('#login-screen img[alt="Winify"]')`));
  const np = await js(`(() => { const q = (s) => document.querySelector('#login-screen ' + s); const c = q('.sa-np-cover'); const cs = getComputedStyle(c);
    return { cover: c.getAttribute('src'), alt: c.alt, fit: cs.objectFit, radius: cs.borderRadius, title: q('.sa-np-title').textContent, artist: q('.sa-np-artist').textContent, link: q('.sa-np-link').textContent.trim(),
      logoSrc: q('.sa-np-logo').getAttribute('src'), logoAlt: q('.sa-np-logo').alt }; })()`);
  check('the album cover: Spotify\'s 300 px image (the smallest of its sizes at least 200 wide), with alt text', np.cover === BL.album.images[1].url && np.alt === 'Album cover: After Hours', JSON.stringify({ alt: np.alt, cover: np.cover.slice(0, 60) }));
  check('...whole and uncropped (object-fit: contain), with rounded corners', np.fit === 'contain' && parseFloat(np.radius) > 0, JSON.stringify({ fit: np.fit, radius: np.radius }));
  check('title and artist', np.title === 'Blinding Lights' && np.artist === 'The Weeknd', JSON.stringify(np));
  const logo = await R('#login-screen .sa-np-logo'), cover = await R('#login-screen .sa-np-cover'), screen = await R('#login-screen .sa-np-cover');
  check('Spotify\'s white full logo, at least 70 px wide on screen (Spotify\'s minimum)', np.logoSrc === 'assets/spotify-logo-white.svg' && np.logoAlt === 'Spotify' && logo.w >= 70, JSON.stringify(logo));
  // Clear space: half the icon's height (the icon is the logo's full height) on every side.
  const zone = { x: logo.x - logo.h / 2, y: logo.y - logo.h / 2, r: logo.r + logo.h / 2, b: logo.b + logo.h / 2 };
  const near = [];
  for (const sel of ['.sa-np-cover', '.sa-np-title', '.sa-np-artist', '.sa-np-link', '[role=status]']) {
    const b = await R('#login-screen ' + sel);
    if (b && b.x < zone.r && b.r > zone.x && b.y < zone.b && b.b > zone.y) near.push(sel);
  }
  check('...with its clear space (half the icon\'s height) free of everything else', near.length === 0, JSON.stringify({ near, logo, zone }));
  check('link reads "PLAY ON SPOTIFY" (the Spotify app is installed)', /^PLAY ON SPOTIFY/.test(np.link), np.link);
  await click('#login-screen .sa-np-link');
  check('...and opens the track in the Spotify app', opened[opened.length - 1] === 'spotify:track:' + BL.id, JSON.stringify(opened));
  await shot('nowplaying-2-playing.png');

  console.log('3. Without the Spotify app');
  installed = false;
  await click('#login-screen .sa-np-link');
  check('the link opens Spotify\'s download page', opened[opened.length - 1] === 'https://www.spotify.com/download/', JSON.stringify(opened));
  await js(`window.dispatchEvent(new CustomEvent('winify:now-playing', { detail: null }))`); await wait(200);
  await js('WinifyControls.refresh()'); await wait(300);
  await js(`window.dispatchEvent(new CustomEvent('winify:now-playing', { detail: { uri: 'spotify:track:1234567890123456789012', title: 'Another', artist: 'Someone', album: 'Else', cover: null } }))`);
  const label = await until(`(() => { const l = document.querySelector('#login-screen .sa-np-link'); return l && /GET SPOTIFY FREE/.test(l.textContent) ? l.textContent.trim() : null; })()`);
  check('...and, at the next track, reads "GET SPOTIFY FREE"', !!label, label);
  check('a track without a cover: a plain dark square in its place, the layout unchanged', /^data:image\/svg\+xml/.test(await js(`document.querySelector('#login-screen .sa-np-cover').getAttribute('src')`)) && JSON.stringify(await R('#login-screen .sa-np-cover')) === JSON.stringify(cover));
  installed = true;

  console.log('3b. Nothing covers it: the chassis is drawn above every window');
  await js(`WinifyLyrics.open()`); await wait(600);
  // The lyrics panel moved right over the cover (as a drag there would leave it).
  await js(`(() => { const c = document.querySelector('#login-screen .sa-np-cover').getBoundingClientRect(); const l = document.querySelector('#webamp .winify-lyrics');
    l.style.left = Math.round(c.left - 40) + 'px'; l.style.top = Math.round(c.top - 40) + 'px'; return true; })()`); await wait(200);
  const onTop = await js(`(() => { const c = document.querySelector('#login-screen .sa-np-cover').getBoundingClientRect(); const l = document.querySelector('#webamp .winify-lyrics').getBoundingClientRect();
    const covers = l.left < c.right && l.right > c.left && l.top < c.bottom && l.bottom > c.top;
    const e = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return { covers, hit: e && e.className }; })()`);
  check('a panel moved over the cover art: the cover stays in front of it', onTop.covers && /sa-np-cover/.test(onTop.hit || ''), JSON.stringify(onTop));
  await js(`WinifyLyrics.close()`); await wait(300);

  console.log('4. Music stops: the wordmark again');
  playing = false; await js(`window.dispatchEvent(new CustomEvent('winify:now-playing', { detail: null }))`); await js('WinifyControls.refresh()');
  check('nothing playing: back to the wordmark', await until(`!document.querySelector('#login-screen .sa-np-cover') && !!document.querySelector('#login-screen img[alt="Winify"]')`));

  check('no page errors', errors.length === 0, JSON.stringify(errors));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
