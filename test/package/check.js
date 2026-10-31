// The packaged app's own checks: `npm run package:check` (builds a packaged
// test app starting here, and runs it).
//
// The test suite runs main.js in the development Electron, on the
// development copy's port; this runs the same code as Winify.app does: from
// inside the app bundle, packaged (its own port range and settings folder).
// Spotify and LRCLIB are faked in the main process and Spotify's player
// script is blocked, so nothing leaves this Mac and it works on any account.
// Checks: the page's port, the remembered sign-in, the playlist picker, a
// mix of playlists chosen together and its Remix, a lyrics lookup through
// Winify's LRCLIB route (and its User-Agent), and sign-in through
// http://127.0.0.1:8888/callback.
const { app, BrowserWindow, session, shell } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
process.env.SPOTIFY_CLIENT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const seen = [];
const J = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const PLAYLISTS = Array.from({ length: 3 }, (_, i) => ({ id: 'p' + i, name: 'Check playlist ' + (i + 1), uri: 'spotify:playlist:p' + i,
  owner: { id: 'checker' }, collaborative: false, snapshot_id: 's' + i, items: { total: 5 + i } }));
global.fetch = async (u, o = {}) => {
  const url = new URL(String(u));
  seen.push((o.method || 'GET') + ' ' + url.host + url.pathname + (url.host === 'lrclib.net' ? ' UA=' + ((o.headers || {})['User-Agent'] || '') : ''));
  if (url.host === 'accounts.spotify.com') {
    const b = new URLSearchParams(o.body);
    if (b.get('code') === 'winify-client-id-check') return J(400, { error: 'invalid_grant' });   // the Client ID is known
    return J(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: SCOPES });
  }
  if (url.host === 'api.spotify.com') {
    const p = url.pathname, n = +(url.searchParams.get('offset') || 0);
    if (p === '/v1/me') return J(200, { id: 'checker', product: 'premium', country: 'GB' });
    if (p === '/v1/me/tracks') return J(200, { total: 2, items: [{ added_at: '2026-10-31T00:00:00Z', track: null }], next: null });
    if (p === '/v1/me/playlists') return J(200, { total: PLAYLISTS.length, items: PLAYLISTS.slice(n, n + 50), next: null });
    const items = p.match(/^\/v1\/playlists\/p(\d)\/items$/);
    if (items) {
      const total = PLAYLISTS[+items[1]].items.total;
      const song = (k) => ({ is_local: false, item: { uri: 'spotify:track:check' + items[1] + k, name: 'Song ' + items[1] + '.' + k, type: 'track',
        duration_ms: 200000, is_playable: true, artists: [{ name: 'Check Artist' }], album: { name: 'Check Album' } } });
      return J(200, { total, items: Array.from({ length: Math.max(0, Math.min(50, total - n)) }, (_, k) => song(n + k)), next: null });
    }
    if (p.startsWith('/v1/me/player')) return J(204, null);
    return J(404, { error: { status: 404, message: 'not in this check' } });
  }
  if (url.host === 'lrclib.net') {
    if (url.pathname === '/api/get') return J(200, { id: 1, trackName: url.searchParams.get('track_name'), artistName: url.searchParams.get('artist_name'),
      albumName: url.searchParams.get('album_name'), duration: +url.searchParams.get('duration'), instrumental: false, plainLyrics: 'Line one\nLine two', syncedLyrics: '[00:01.00] Line one\n[00:02.00] Line two' });
    return J(200, []);
  }
  throw new Error('check: no network (' + url.host + ')');
};
let authUrl = null;
shell.openExternal = async (u) => { authUrl = u; };

require(path.join(__dirname, '..', '..', 'main.js'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'winify-check-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));

const OUTPUT = process.env.SMOKE_OUTPUT || os.tmpdir();
const lines = [];
let fails = 0;
const say = (s) => { lines.push(s); console.log(s); };
const check = (label, ok, detail) => { if (!ok) fails++; say((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + String(detail).slice(0, 300) : '')); };
const finish = () => {
  say(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  try { fs.mkdirSync(OUTPUT, { recursive: true }); fs.writeFileSync(path.join(OUTPUT, 'package-check.log'), lines.join('\n') + '\n'); } catch (e) { /* console has it */ }
  app.exit(fails ? 1 : 0);
};
setTimeout(() => { check('finished within 90 s', false); finish(); }, 90000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  // Spotify's player script and live connection: not loaded (no network).
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.spotify.com/*', 'wss://*.spotify.com/*', 'https://*.scdn.co/*'] }, (d, cb) => cb({ cancel: true }));
  say('Winify.app checks (packaged: ' + app.isPackaged + ')');
  let win = null;
  for (let i = 0; i < 150 && !win; i++) { win = BrowserWindow.getAllWindows()[0] || null; await wait(100); }
  if (!win) { check('a window', false); return finish(); }
  const js = (c) => win.webContents.executeJavaScript(c, true);
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const page = new URL(win.webContents.getURL());
  check('the page is served on the packaged range (8909-8913)', page.hostname === '127.0.0.1' && +page.port >= 8909 && +page.port <= 8913, page.origin);

  let mounted = false;
  for (let i = 0; i < 150 && !(mounted = await js('!!(window.WinifyWebamp && WinifyWebamp.isMounted())').catch(() => false)); i++) await wait(100);
  check('signed in from the remembered session: the player is shown', mounted);

  await js('WinifyPicker.open()');
  let st = null;
  for (let i = 0; i < 50; i++) { st = await js('WinifyPicker.state()'); if (st.complete || !st.open) break; await wait(200); }
  const rows = await js(`[...document.querySelectorAll('.winify-picker .wp-row .wp-name')].map((r) => r.textContent)`);
  check('the playlist picker lists Liked Songs and the playlists', st.open && st.complete && rows.includes('1. Liked Songs') && rows.some((r) => /Check playlist 3$/.test(r)), JSON.stringify({ st, rows }));
  await js('WinifyPicker.close()');

  // Playlists chosen together: saved as a mix, named and remembered; remixed
  // from the index with no request. (Spotify's player is blocked here, so
  // nothing plays: what is checked is what is saved.)
  const chosen = PLAYLISTS.slice(0, 2).map((p) => ({ uri: p.uri, name: p.name, snapshot: p.snapshot_id }));
  await js(`WinifyMix.makeFrom(${JSON.stringify(chosen)}, 10, true)`);
  let mixes = await js('WinifyMix.saved()');
  const made = mixes[0];
  check('playlists chosen together: saved as "2 PLAYLISTS · 10 each · <day>", with its playlists', !!made && /^2 PLAYLISTS · 10 each · \d{1,2} [A-Z][a-z]{2}$/.test(made.name) &&
    made.tracks.length === 11 && JSON.stringify(made.sources.map((x) => x.name)) === JSON.stringify(['Check playlist 1', 'Check playlist 2']), made && JSON.stringify({ name: made.name, n: made.tracks.length }));
  const before = seen.length;
  await js(`WinifyMix.remix(${JSON.stringify(made && made.id)})`);
  mixes = await js('WinifyMix.saved()');
  const fresh = seen.slice(before).filter((x) => /api\.spotify\.com/.test(x) && !/\/me\/player/.test(x));
  check('Remix: a new mix of the same playlists, 10 each, with no request to make it', mixes.length === 2 && mixes[0].id !== made.id && mixes[0].tracks.length === 11 &&
    JSON.stringify(mixes[0].sources) === JSON.stringify(made.sources) && fresh.length === 0, JSON.stringify({ n: mixes.length, fresh }));
  check('hovering a saved mix names its playlists', JSON.stringify(await js(`WinifyMix.fromNames(${JSON.stringify(made && made.id)})`)) === JSON.stringify(['Check playlist 1', 'Check playlist 2']));

  const found = await js(`WinifyLyrics.find({ name: 'Check Song', artist: 'Check Artist', album: 'Check Album', durationS: 200 }).then((r) => r.state, (e) => 'threw ' + e.message)`);
  const lrc = seen.filter((s) => s.includes('lrclib.net'));
  check('lyrics: looked up through Winify\'s LRCLIB route and found', found === 'found' && lrc.length >= 1, found + ' ' + JSON.stringify(lrc));
  check('...with Winify\'s User-Agent, naming its project page', lrc.length && lrc.every((s) => /UA=Winify\/\d+\.\d+\.\d+ \(.*https:\/\/github\.com\/Parasthappa\/Winify\)$/.test(s)), JSON.stringify(lrc));

  await js('window.spotify.disconnect()'); await wait(500);
  await js('window.spotify.login()');
  for (let i = 0; i < 50 && !authUrl; i++) await wait(100);
  const redirect = authUrl && new URL(authUrl).searchParams.get('redirect_uri');
  check('sign-in sends Spotify the redirect http://127.0.0.1:8888/callback', redirect === 'http://127.0.0.1:8888/callback', redirect);
  const answer = await new Promise((resolve) => {
    http.get('http://127.0.0.1:8888/callback?code=x&state=wrong', (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', (e) => resolve({ status: 0, body: e.message }));
  });
  check('the callback server on 8888 answers (a wrong state is refused)', answer.status === 400 && /Sign-in failed/.test(answer.body), answer.status + ' ' + answer.body);
  finish();
});
