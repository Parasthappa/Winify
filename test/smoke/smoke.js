// Smoke test against the real Spotify account: `npm run smoke`.
//
// Runs the real Winify with your own sign-in and checks the core flows end to
// end: sign-in, a playlist from the picker, Next/Previous, the visualizer
// hearing the music, playing from search, and lyrics. It plays music out loud
// for about a minute, then pauses.
//
// Needs: Winify quit (it uses Winify's own settings and sign-in), a previous
// sign-in with "Remember me" on, Spotify Premium, and (for the visualizer)
// the Multi-Output Device as the Mac's sound output.
//
// Budget: at most 30 Web API requests per run (a 31st is refused, and the run
// fails), checked for a rate limit first; about a minute and a half. Every
// request is listed at the end.
//
// At startup Winify loads the whole list of whatever was playing last (Liked
// Songs alone can take 25 requests). That load is not a flow under test here
// (the picker step loads a small playlist instead), so it is held back: the
// window shows Spotify's Up Next meanwhile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs'), path = require('path');

const BUDGET = 30;
const TIME_LIMIT_MS = 120000;
const SEARCH = 'Blinding Lights The Weeknd';

app.setPath('userData', path.join(app.getPath('appData'), 'winify'));
const tokensFile = path.join(app.getPath('userData'), 'tokens.json');

const started = Date.now();
const stamp = () => ((Date.now() - started) / 1000).toFixed(1).padStart(5) + 's';
let fails = 0;
const check = (label, ok, detail) => {
  if (!ok) fails++;
  console.log((ok ? '  PASS ' : '  FAIL ') + stamp() + '  ' + label + (detail ? '   ' + String(detail).slice(0, 200) : ''));
  return ok;
};
// What was sent, grouped: "3x GET /v1/search".
function report() {
  const groups = {};
  sent.forEach((w) => { const k = w.replace(/\/(playlists|albums|tracks|artists)\/[A-Za-z0-9]{10,}/, '/$1/{id}'); groups[k] = (groups[k] || 0) + 1; });
  console.log('\nSpotify requests: ' + count.webApi + ' Web API (budget ' + BUDGET + ')' +
    (count.heldBack ? ', ' + count.heldBack + ' startup list loads held back (not sent)' : '') +
    (count.refused ? ', ' + count.refused + ' refused over budget (not sent)' : '') +
    '; ' + count.signIn + ' sign-in refresh; ' + count.player + ' from Spotify\'s own player library.');
  Object.entries(groups).forEach(([k, n]) => console.log('  ' + String(n).padStart(3) + 'x ' + k));
}
const stop = (message, code) => { console.log('\n' + message); report(); app.exit(code); throw new Error('stopped'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!app.requestSingleInstanceLock()) stop('Winify is running. Quit it (menu-bar icon > Quit Winify) and run the smoke test again.', 2);
let saved = null;
try { saved = JSON.parse(fs.readFileSync(tokensFile, 'utf8')); } catch (e) { /* none */ }
if (!saved || !saved.refreshToken) stop('No remembered sign-in. Start Winify, sign in with "Remember me" on, quit it, and run the smoke test again.', 2);

// Every request to Spotify, counted; the Web API ones against the budget.
const count = { webApi: 0, refused: 0, heldBack: 0, signIn: 0, player: 0 };
const sent = [];                       // "GET /v1/me/player" ...
let phase = 'startup';                 // 'startup' | 'flows'
const LIST_LOAD = /^GET \/v1\/(me\/tracks|playlists\/[^/]+\/items|albums\/[^/]+\/tracks)\b/;
let rateLimited = null;
app.on('ready', () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.spotify.com/*', 'https://*.scdn.co/*', 'wss://*.spotify.com/*'] }, (d, cb) => {
    if (d.url.startsWith('https://api.spotify.com/v1/')) {
      const what = d.method + ' ' + new URL(d.url).pathname;
      if (phase === 'startup' && LIST_LOAD.test(what)) { count.heldBack++; cb({ cancel: true }); return; }
      if (count.webApi >= BUDGET) { count.refused++; cb({ cancel: true }); return; }
      count.webApi++;
      sent.push(what);
    } else {
      count.player++;
    }
    cb({});
  });
  session.defaultSession.webRequest.onCompleted({ urls: ['https://api.spotify.com/*'] }, (d) => {
    if (d.statusCode === 429 && !rateLimited) {
      const h = d.responseHeaders || {};
      rateLimited = (h['retry-after'] || h['Retry-After'] || ['?'])[0];
    }
  });
});
// The main process's own requests (the sign-in refresh).
const realFetch = global.fetch;
global.fetch = (u, o) => {
  const url = String(u);
  if (url.startsWith('https://accounts.spotify.com/')) count.signIn++;
  else if (url.startsWith('https://api.spotify.com/v1/')) {
    if (count.webApi >= BUDGET) { count.refused++; return Promise.reject(new Error('smoke test budget reached')); }
    count.webApi++;
    sent.push(((o && o.method) || 'GET') + ' ' + new URL(url).pathname + ' (main)');
  }
  return realFetch(u, o);
};

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => stop('TIMED OUT after ' + TIME_LIMIT_MS / 1000 + ' s', 3), TIME_LIMIT_MS);

app.whenReady().then(async () => {
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (expr, ms) => {
    const t0 = Date.now(); let v;
    while (Date.now() - t0 < ms) {
      if (rateLimited) return null;
      v = await js(expr).catch(() => null);
      if (v) return v;
      await wait(200);
    }
    return v;
  };
  const guard = () => {
    if (rateLimited) stop('Spotify is rate-limiting this account (Retry-After ' + rateLimited + ' s, about ' +
      Math.ceil(Number(rateLimited) / 60) + ' min). Nothing is wrong with Winify; try again after that.', 4);
    if (count.refused) stop('Stopped: the run tried to use more than ' + BUDGET + ' Spotify requests.', 5);
  };
  const lyricsWasOpen = await js(`localStorage.getItem('winify.lyrics.open')`).catch(() => null);
  console.log('Winify smoke test (real Spotify, at most ' + BUDGET + ' Web API requests)\n');

  // 1. Sign-in
  const ready = await until(`!!(window.WinifyWebamp && WinifyWebamp.isMounted() && window.WinifyPlayer && WinifyPlayer.getDeviceId())`, 30000);
  guard();
  if (!check('signed in from the remembered session; Winify device ready', ready)) stop('Cannot continue without a session.', 1);

  // 2. A playlist from the picker: your smallest own playlist (fewest requests to list it)
  phase = 'flows';
  await js(`document.querySelector('#webamp #eject').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const rows = await until(`(() => { const r = [...document.querySelectorAll('.winify-picker .wp-row')]; return r.length > 1 ? r.map((x, i) => ({ i, name: x.querySelector('.wp-name').textContent, n: parseInt(x.querySelector('.wp-count').textContent, 10) })) : null; })()`, 15000);
  guard();
  const choice = rows && rows.filter((r) => r.i > 0 && r.n >= 3 && r.n <= 100).sort((a, b) => a.n - b.n)[0];
  if (!check('picker lists your playlists', !!choice, rows ? rows.length + ' rows' : 'none')) stop('Needs one playlist of your own with 3-100 tracks.', 1);
  await js(`document.querySelectorAll('.winify-picker .wp-row')[${choice.i}].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  let pl = await until(`(() => { const s = WinifyPlaylist.state(), n = WinifyControls.state(); return s.mode === 'list' && s.currentIndex === 1 && n.where === 'winify' && !n.paused ? { s, n } : null; })()`, 15000);
  guard();
  check('picker plays "' + choice.name + '" on Winify; the playlist window lists it, track 1 current', !!pl,
    pl ? pl.s.header + ' / ' + pl.s.current : JSON.stringify(await js('WinifyPlaylist.state()')).slice(0, 160));
  const p0 = await js('WinifyControls.state().positionMs'); await wait(2500); const p1 = await js('WinifyControls.state().positionMs');
  check('the music actually plays (position advanced ' + Math.round((p1 - p0) / 100) / 10 + ' s in 2.5 s)', p1 - p0 > 1500);

  // 3. Next / Previous
  const t1 = await js('WinifyControls.state().trackUri');
  await js(`document.querySelector('#webamp #next').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const n2 = await until(`(() => { const n = WinifyControls.state(); return n.trackUri && n.trackUri !== ${JSON.stringify(t1)} && WinifyPlaylist.state().currentIndex === 2 ? n.title : null; })()`, 10000);
  guard();
  check('Next: track 2 of the playlist', !!n2, n2);
  await js(`document.querySelector('#webamp #previous').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const n1 = await until(`WinifyControls.state().trackUri === ${JSON.stringify(t1)} && WinifyPlaylist.state().currentIndex === 1`, 10000);
  guard();
  check('Previous: back to track 1', !!n1);

  // 4. The visualizer hears the music
  await wait(1500);
  const level = await js(`(() => { const a = window.WinifyAudio && WinifyAudio.getAnalyser(); if (!a) return -1;
    const b = new Uint8Array(a.fftSize); let peak = 0; for (let k = 0; k < 5; k++) { a.getByteTimeDomainData(b); peak = Math.max(peak, Math.max(...b) - Math.min(...b)); } return peak; })()`);
  check('the visualizer receives the music', level > 10, level < 0 ? 'audio capture not running' : 'signal ' + level +
    (level <= 10 ? ' (silence: is the Multi-Output Device the sound output?)' : ''));

  // 5. Playing from search
  await js(`document.querySelector('#webamp #title-bar').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await js(`window.WinifySearch.open()`);
  await until(`!!document.querySelector('.winify-search .ws-query')`, 5000);
  await js(`(() => { const i = document.querySelector('.winify-search .ws-query'); i.value = ${JSON.stringify(SEARCH)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const results = await until(`WinifySearch.state().results > 0 ? WinifySearch.state().results : null`, 10000);
  guard();
  check('search finds "' + SEARCH + '"', !!results, results + ' results');
  await js(`document.querySelector('.winify-search .ws-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const playing = await until(`(() => { const n = WinifyControls.state(); return /blinding lights/i.test(n.title || '') && !n.paused ? n.title + ' - ' + n.artist : null; })()`, 12000);
  guard();
  check('Enter plays it on Winify', !!playing, playing);

  // 6. Lyrics for it
  await js(`document.querySelector('#webamp #button-i').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const lyr = await until(`(() => { const s = WinifyLyrics.state(); return s.entry && s.entry.state === 'found' && s.text && s.text.length > 200 ? s.entry.source : null; })()`, 20000);
  guard();
  check('lyrics found and shown for it (LRCLIB)', !!lyr, lyr ? 'via /api/' + lyr : JSON.stringify(await js('WinifyLyrics.state()')).slice(0, 160));
  await js(`WinifyLyrics.close(false)`);
  await js(`localStorage.setItem('winify.lyrics.open', ${JSON.stringify(lyricsWasOpen || '0')})`);

  // Done: pause, and report what it cost.
  await js(`WinifyPlayer.pause()`); await wait(500);
  guard();
  report();
  console.log(stamp().trim() + ' in all.\n' + (fails ? 'SMOKE: ' + fails + ' FAILED' : 'SMOKE: ALL PASSED'));
  app.exit(fails ? 1 : 0);
}).catch((err) => {
  if (err && err.message === 'stopped') return;
  console.log('\nSMOKE TEST ERROR: ' + (err && err.stack || err));
  report();
  app.exit(6);
});
