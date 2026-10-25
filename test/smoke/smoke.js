// Smoke test against the real Spotify account: `npm run smoke`.
//
// Runs the real Winify with your own sign-in and checks the core flows end to
// end: sign-in, a playlist from the picker, Next/Previous, the visualizer
// hearing the music, playing from search, lyrics, and a random mix (its end
// too with SMOKE_MIX_END=1, which needs higher caps). It plays music out loud
// for about a minute, then pauses.
//
// Starts from Winify's default window layout, window positions and lyrics
// setting, with Spotify's shuffle and repeat off, and puts yours back at the
// end (known-state.js).
//
// Needs: Winify quit (it uses Winify's own settings and sign-in), a previous
// sign-in with "Remember me" on, Spotify Premium, and (for the visualizer)
// the Multi-Output Device as the Mac's sound output.
//
// Budget per run: at most 30 Web API requests by Winify itself and 60 by
// Spotify's player library, preflights included (one more is refused, and the
// run fails); checked for a rate limit first; about a minute and a half. Every
// request is listed at the end.
//
// At startup Winify loads the whole list of whatever was playing last (Liked
// Songs alone can take 25 requests). That load is not a flow under test here
// (the picker step loads a small playlist instead), so it is held back: the
// window shows Spotify's Up Next meanwhile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs'), path = require('path');

// Two budgets: Winify's own Web API calls, and those Spotify's player library
// (the Web Playback SDK) makes to play the music. Preflights count in both.
// SMOKE_BUDGET raises Winify's cap for one run (only with the user's say-so).
const BUDGET = Number(process.env.SMOKE_BUDGET) || 30;
const PLAYER_BUDGET = 60;
const PLAYER_PATH = /^\/v1\/(melody|track-playback|storage-resolve|widevine-license)\//;
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
  const pGroups = {};
  playerSent.forEach((w) => { const k = w.replace(/\/(devices|interactive\/\d+)\/[0-9a-f]{20,}/, '/$1/{id}'); pGroups[k] = (pGroups[k] || 0) + 1; });
  console.log('\nWinify\'s own Web API requests: ' + count.webApi + ' (budget ' + BUDGET + ')' +
    (count.heldBack ? ', ' + count.heldBack + ' startup list loads held back (not sent)' : '') +
    (count.refused ? ', ' + count.refused + ' refused over budget (not sent)' : ''));
  Object.entries(groups).forEach(([k, n]) => console.log('  ' + String(n).padStart(3) + 'x ' + k));
  console.log('Spotify\'s player library, Web API requests: ' + count.playerApi + ' (budget ' + PLAYER_BUDGET + ')' +
    (count.playerRefused ? ', ' + count.playerRefused + ' refused over budget (not sent)' : ''));
  Object.entries(pGroups).forEach(([k, n]) => console.log('  ' + String(n).padStart(3) + 'x ' + k));
  console.log('Also: ' + count.signIn + ' sign-in refresh; ' + count.player + ' to Spotify\'s audio servers and live connection (not the Web API).');
}
// Your own layout, window positions and lyrics setting, put back (see known-state.js).
let restoreState = async () => {};
const stop = (message, code) => {
  console.log('\n' + message); report();
  Promise.resolve().then(() => restoreState()).catch(() => {}).finally(() => app.exit(code));
  throw new Error('stopped');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!app.requestSingleInstanceLock()) stop('Winify is running. Quit it (menu-bar icon > Quit Winify) and run the smoke test again.', 2);
let saved = null;
try { saved = JSON.parse(fs.readFileSync(tokensFile, 'utf8')); } catch (e) { /* none */ }
if (!saved || !saved.refreshToken) stop('No remembered sign-in. Start Winify, sign in with "Remember me" on, quit it, and run the smoke test again.', 2);

// Every request to Spotify, counted; the Web API ones against the budget.
const count = { webApi: 0, refused: 0, heldBack: 0, signIn: 0, player: 0, playerApi: 0, playerRefused: 0 };
const sent = [];                       // "GET /v1/me/player" ...
const playerSent = [];
let phase = 'startup';                 // 'startup' | 'flows'
const LIST_LOAD = /^GET \/v1\/(me\/tracks|playlists\/[^/]+\/items|albums\/[^/]+\/tracks)\b/;
let rateLimited = null;
app.on('ready', () => {
  // Start from Winify's defaults, whatever state Winify was left in.
  session.defaultSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'known-state.js') });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.spotify.com/*', 'https://*.scdn.co/*', 'wss://*.spotify.com/*'] }, (d, cb) => {
    if (d.url.startsWith('https://api.spotify.com/v1/')) {
      const what = d.method + ' ' + new URL(d.url).pathname;
      if (PLAYER_PATH.test(new URL(d.url).pathname)) {
        if (count.playerApi >= PLAYER_BUDGET) { count.playerRefused++; cb({ cancel: true }); return; }
        count.playerApi++;
        playerSent.push(what);
        cb({});
        return;
      }
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
// Everything the run prints is also kept in test/.output/smoke-last.log, so
// the request list can be read afterwards without running it again.
const LAST_LOG = path.join(__dirname, '..', '.output', 'smoke-last.log');
fs.mkdirSync(path.dirname(LAST_LOG), { recursive: true });
fs.writeFileSync(LAST_LOG, '');
for (const level of ['log', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => { try { fs.appendFileSync(LAST_LOG, args.join(' ') + '\n'); } catch (e) { /* keep going */ } original(...args); };
}
// One line per run, for the runs-per-day limit (CLAUDE.md).
fs.mkdirSync(path.join(__dirname, '..', '.output'), { recursive: true });
fs.appendFileSync(path.join(__dirname, '..', '.output', 'smoke-runs.log'), new Date().toLocaleString('sv-SE') + '\n');

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
    if (count.refused) stop('Stopped: Winify tried to use more than ' + BUDGET + ' Web API requests.', 5);
    if (count.playerRefused) stop('Stopped: Spotify\'s player library tried to use more than ' + PLAYER_BUDGET + ' Web API requests.', 5);
  };
  restoreState = () => js(`(() => { const s = localStorage.getItem('winify.smoke.saved'); if (s == null) return;
    const snap = JSON.parse(s); for (const k in snap) { if (snap[k] == null) localStorage.removeItem(k); else localStorage.setItem(k, snap[k]); }
    localStorage.removeItem('winify.smoke.saved'); return Object.keys(snap).filter((k) => snap[k] != null).length; })()`);
  console.log('Winify smoke test (real Spotify, at most ' + BUDGET + ' Web API requests by Winify and ' + PLAYER_BUDGET + ' by Spotify\'s player library)\n');

  // 1. Sign-in
  const ready = await until(`!!(window.WinifyWebamp && WinifyWebamp.isMounted() && window.WinifyPlayer && WinifyPlayer.getDeviceId())`, 30000);
  guard();
  if (!check('signed in from the remembered session; Winify device ready', ready)) stop('Cannot continue without a session.', 1);

  // 2. A playlist from the picker: your smallest own playlist (fewest requests to list it)
  phase = 'flows';
  await js(`document.querySelector('#webamp #eject').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  // Section labels and Winify's own mixes are passed over.
  const rows = await until(`(() => { const r = [...document.querySelectorAll('.winify-picker .wp-row')]; return r.length > 1 ? r.map((x, i) => ({ i,
    playlist: !x.classList.contains('wp-label') && !x.dataset.mix && !!x.querySelector('.wp-name') && !!x.querySelector('.wp-count'),
    name: x.querySelector('.wp-name') ? x.querySelector('.wp-name').textContent : '', n: x.querySelector('.wp-count') ? parseInt(x.querySelector('.wp-count').textContent, 10) : 0 })) : null; })()`, 15000);
  guard();
  const choice = rows && rows.filter((r) => r.playlist && r.name !== 'Liked Songs' && r.n >= 3 && r.n <= 100).sort((a, b) => a.n - b.n)[0];
  if (!check('picker lists your playlists', !!choice, rows ? rows.length + ' rows' : 'none')) stop('Needs one playlist of your own with 3-100 tracks.', 1);
  await js(`document.querySelectorAll('.winify-picker .wp-row')[${choice.i}].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  let pl = await until(`(() => { const s = WinifyPlaylist.state(), n = WinifyControls.state(); return s.mode === 'list' && s.currentIndex === 1 && n.where === 'winify' && !n.paused ? { s, n } : null; })()`, 15000);
  guard();
  check('picker plays "' + choice.name + '" on Winify; the playlist window lists it, track 1 current', !!pl,
    pl ? pl.s.header + ' / ' + pl.s.current : JSON.stringify(await js('WinifyPlaylist.state()')).slice(0, 160));
  // The DRM failure this guards against played some tracks for 5-7 s before
  // they stopped, so look about 10 s in: the same track, still playing, still
  // moving. The player's own state (read locally: no Spotify requests).
  const sdk = `WinifyPlayer.getState().then((s) => s && { uri: s.track_window.current_track.uri, paused: s.paused, pos: s.position })`;
  const s0 = await js(sdk);
  let s1 = null;
  for (const end = Date.now() + 15000; Date.now() < end;) {
    s1 = await js(sdk);
    if (!s1 || s1.uri !== (s0 && s0.uri) || s1.paused || s1.pos >= 10000) break;
    await wait(500);
  }
  await wait(2000); const s2 = await js(sdk);
  const steady = !!(s0 && s1 && s2) && s1.uri === s0.uri && s2.uri === s0.uri && !s1.paused && !s2.paused && s1.pos >= 10000 && s2.pos - s1.pos >= 1500;
  check('the music actually plays: the same track still playing and moving about 10 s in', steady,
    s1 && s2 ? (s1.uri === (s0 && s0.uri) ? 'same track' : 'track changed') + ', at ' + Math.round(s1.pos / 100) / 10 + ' s' + (s1.paused ? ' (paused)' : '') +
      ', then ' + Math.round((s2.pos - s1.pos) / 100) / 10 + ' s further in 2 s' : 'no player state');

  // Spotify's shuffle and repeat are your account's, not Winify's: off for the
  // run (a request each, only if on), and back afterwards.
  const spotifyWas = await js(`(() => { const n = WinifyControls.state(); return { shuffle: !!n.shuffle, repeat: n.repeat || 'off' }; })()`);
  if (spotifyWas.shuffle || spotifyWas.repeat !== 'off') {
    if (spotifyWas.shuffle) await js(`window.spotify.api('PUT', '/me/player/shuffle?state=false')`);
    if (spotifyWas.repeat !== 'off') await js(`window.spotify.api('PUT', '/me/player/repeat?state=off')`);
    await js('WinifyControls.refresh()'); await wait(500);
  }

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

  // 5b. The chassis shows it: cover (loaded from Spotify's image server), title, artist, Spotify's
  // logo and the link back. From the player's own state: no Web API requests. Photographed.
  const np = await until(`(() => { const q = (s) => document.querySelector('#login-screen ' + s); const c = q('.sa-np-cover');
    return c && c.complete && c.naturalWidth > 0 && /^https:/.test(c.src) && /blinding lights/i.test(q('.sa-np-title').textContent) && q('.sa-np-logo').getBoundingClientRect().width >= 70
      ? { title: q('.sa-np-title').textContent, artist: q('.sa-np-artist').textContent, cover: c.naturalWidth + 'x' + c.naturalHeight, link: q('.sa-np-link').textContent.trim() } : null; })()`, 10000);
  check('the chassis shows it: album cover, title, artist, Spotify logo, link back', !!np, np ? np.title + ' - ' + np.artist + ', cover ' + np.cover + ', "' + np.link + '"' : 'not shown');
  try {
    const r = await js(`(() => { const b = document.querySelector('#login-screen').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
    fs.writeFileSync(path.join(__dirname, '..', '.output', 'smoke-chassis.png'), (await win.webContents.capturePage(r)).toPNG());
  } catch (e) { console.log('       (no chassis photo: ' + e.message + ')'); }

  // 6. Lyrics for it
  // The I button toggles, and Winify reopens lyrics if they were open last time.
  if (!(await js(`WinifyLyrics.isOpen()`))) await js(`document.querySelector('#webamp #button-i').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const lyr = await until(`(() => { const s = WinifyLyrics.state(); return s.entry && s.entry.state === 'found' && s.text && s.text.length > 200 ? s.entry.source : null; })()`, 20000);
  guard();
  check('lyrics found and shown for it (LRCLIB)', !!lyr, lyr ? 'via /api/' + lyr : JSON.stringify(await js('WinifyLyrics.state()')).slice(0, 160));
  await js(`WinifyLyrics.close(false)`);

  // 7. A random mix (the Winamp logo makes one of 10 playlists; 3 here, to
  // keep within the budget, unless SMOKE_MIX_PLAYLISTS says otherwise). With
  // SMOKE_MIX_END=1, also its end: does Spotify's Autoplay follow a list of
  // songs? Played from 8 s before the end of its last song. That costs more
  // than the player library's 60 allows alongside the other steps, so it is
  // left out by default.
  const MIX_PLAYLISTS = Number(process.env.SMOKE_MIX_PLAYLISTS) || 3;
  const before = count.webApi;
  await js(`WinifyMix.make({ playlists: ${MIX_PLAYLISTS} })`);
  const mixed = await until(`(() => { const s = WinifyPlaylist.state(), m = WinifyMix.state(), n = WinifyControls.state();
    return m.last && s.mix && s.mix.started && s.mode === 'list' && s.currentIndex === 1 && n.where === 'winify' && !n.paused ? { s, m: m.last } : null; })()`, 20000);
  guard();
  check('a mix of ' + MIX_PLAYLISTS + ' of your playlists plays on Winify, as its own list (all its songs in one play request)', !!mixed && (await js('WinifyMix.saved()[0].tracks.length')) === mixed.m.songs,
    mixed ? mixed.s.header + ' / ' + mixed.m.songs + ' songs, ' + mixed.m.requests + ' requests (' + (count.webApi - before) + ' counted)' : JSON.stringify(await js('WinifyMix.state()')).slice(0, 160));
  if (mixed && process.env.SMOKE_MIX_END) {
    const tracks = await js(`WinifyMix.saved()[0].tracks`);
    const lastSong = tracks[tracks.length - 1];
    await js(`window.spotify.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(WinifyPlayer.getDeviceId()), ${JSON.stringify({
      uris: tracks.map((t) => t.uri), offset: { position: tracks.length - 1 }, position_ms: Math.max(0, lastSong.durationMs - 8000) })})`);
    const atLast = await until(`WinifyControls.state().trackUri === ${JSON.stringify(lastSong.uri)} && WinifyPlaylist.state().currentIndex === ${tracks.length}`, 10000);
    guard();
    check('the mix\'s last song, as its last row', !!atLast);
    const end = await until(`(() => { const s = WinifyPlaylist.state(), n = WinifyControls.state(), uris = ${JSON.stringify(tracks.map((t) => t.uri))};
      if (s.mix && s.mix.done && n.paused) return 'stopped';
      if (n.trackUri && !uris.includes(n.trackUri) && !n.paused) return 'autoplay';
      return null; })()`, 25000);
    guard();
    const note = await js(`WinifyWebamp.getInstance().store.getState().userInput.userMessage`);
    console.log('       After the mix: ' + (end === 'autoplay' ? 'Spotify\'s Autoplay carried on (' + await js('WinifyControls.state().title') + ')'
      : end === 'stopped' ? 'Autoplay did not follow; playback stopped' : 'unclear (neither within 25 s)'));
    check('at its end: Autoplay carries on, or it stops cleanly with "Mix finished"', end === 'autoplay' || (end === 'stopped' && (note === 'Mix finished' || await js('WinifyPlaylist.state().mix.done'))), end + ' / ' + note);
  }

  // Done: your shuffle and repeat back, pause, your settings back, and what it cost.
  if (spotifyWas.shuffle) await js(`window.spotify.api('PUT', '/me/player/shuffle?state=true')`).catch(() => {});
  if (spotifyWas.repeat && spotifyWas.repeat !== 'off') await js(`window.spotify.api('PUT', '/me/player/repeat?state=${spotifyWas.repeat}')`).catch(() => {});
  await js(`WinifyPlayer.pause()`); await wait(800);   // after Winify's own last saves
  const restored = await restoreState();
  console.log('Your own settings put back: ' + (restored == null ? 'nothing was set aside' : restored + ' of 5 (the others were Winify\'s defaults already)'));
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
