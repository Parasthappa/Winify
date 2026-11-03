// Real Winify (main.js, sign-in screen, player.js), a remembered sign-in, Spotify and its player library faked:
// Change Spotify Client ID, to the same one or another, returns to the sign-in screen, and Play works straight after
// signing in. The fake library's second player in one page never gets a device: an assumption that fits the "nothing
// plays" report, not something seen of Spotify's real library, so this proves the page starts over, not the real cause.
require('../lib/no-network');
const { app, BrowserWindow, shell } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-clientid-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = '';
const FIRST = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', OTHER = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';
const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
const tokenFile = path.join(profile, 'tokens.json');
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ clientId: FIRST }));
fs.writeFileSync(tokenFile, JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));

let expiresIn = 3600, refreshDelay = 0;
const opened = [], transfers = [], plays = [];
const J = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (!/^https:\/\/(api|accounts)\.spotify\.com\//.test(url)) return realFetch(u, o);
  const p = new URL(url).pathname, method = o.method || 'GET';
  if (p === '/api/token') {
    const b = new URLSearchParams(o.body);
    if (b.get('code') === 'winify-client-id-check') return J({ error: 'invalid_grant' }, 400);
    if (b.get('grant_type') === 'refresh_token' && refreshDelay) await new Promise((r) => setTimeout(r, refreshDelay));
    return J({ access_token: 'fake', token_type: 'Bearer', expires_in: expiresIn, refresh_token: 'fake-refresh', scope: SCOPES });
  }
  if (p === '/v1/me') return J({ id: 'tester', product: 'premium', country: 'GB', display_name: 'Tester' });
  if (method === 'PUT' && p === '/v1/me/player') { transfers.push(JSON.parse(o.body).device_ids[0]); return J(null, 204); }
  if (method === 'PUT' && p === '/v1/me/player/play') { plays.push(new URL(url).searchParams.get('device_id')); return J(null, 204); }
  if (method === 'GET' && /^\/v1\/me\/player/.test(p)) return J(null, 204);
  if (method === 'GET') return J({ error: { status: 404, message: 'mock: not here' } }, 404);
  return J(null, 204);
};
shell.openExternal = async (u) => { opened.push(String(u)); };

// The player library, for each page load: the first player gets a device, any later one in that page never does.
let pageLoads = 0;
const FAKE_SDK = (load) => `(() => { let made = 0; window.__players = () => made;
  window.Spotify = { Player: class { constructor(o) { this.o = o; this.at = {}; this.n = ++made; }
    addListener(e, f) { this.at[e] = f; return true; }
    connect() { if (this.n === 1) this.o.getOAuthToken(() => this.at.ready && this.at.ready({ device_id: 'device-${load}' })); return Promise.resolve(true); }
    disconnect() { setTimeout(() => this.at.not_ready && this.at.not_ready({ device_id: 'device-${load}' }), 0); }
    getCurrentState() { return Promise.resolve(null); } getVolume() { return Promise.resolve(0.5); }
    resume() { return Promise.resolve(); } pause() { return Promise.resolve(); } togglePlay() { return Promise.resolve(); } } };
  window.onSpotifyWebPlaybackSDKReady(); })()`;

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
app.whenReady().then(async () => {
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(50);
  win.webContents.on('dom-ready', () => { pageLoads++; win.webContents.executeJavaScript(FAKE_SDK(pageLoads), true).catch(() => {}); });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const S = () => js(`(() => { const q = (s) => document.querySelector(s); const st = q('#login-screen [role=status]'), cta = q('#login-screen .sa-cta'), input = q('#sa-client-id');
    return { login: q('#login-screen').classList.contains('is-active'), status: st ? st.textContent.trim() : null, cta: cta ? cta.textContent.trim() : null, input: !!input,
      placeholder: input ? input.placeholder : null, lamp: !!q('#login-screen input[type=checkbox]') && q('#login-screen input[type=checkbox]').checked,
      webamp: !!(window.WinifyWebamp && WinifyWebamp.isMounted()), device: window.WinifyPlayer ? WinifyPlayer.getDeviceId() : null }; })()`).catch(() => ({}));
  const until = async (fn, ms = 10000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await S(); if (fn(v)) return v; await wait(100); } return v; };
  const click = async (sel) => { const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!r) return false; win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); return true; };

  // One round: change the Client ID, sign in, press Play.
  const round = async (label, id, masked) => {
    console.log(label);
    const browserBefore = opened.length;
    await js('window.spotify.changeClientId()');
    let v = await until((x) => x.input && x.login);
    check('back on the sign-in screen, at the Client ID step, the player gone', v.input && v.login && !v.webamp && !v.device, JSON.stringify(v));
    check('...showing the current one masked', v.placeholder === 'now: ' + masked, v.placeholder);
    check('...the old sign-in is off the disk', !fs.existsSync(tokenFile));
    check('...Remember me still lit', v.lamp === true);
    await wait(300);   // the step clears and focuses its field just after it appears
    await js(`document.getElementById('sa-client-id').value = ${JSON.stringify(id)}`);
    await click('#login-screen .sa-cta');
    v = await until((x) => /READY TO SIGN IN/.test(x.status || ''));
    check('saved: "READY TO SIGN IN", "Continue with Spotify", and it waits for you', /READY TO SIGN IN/.test(v.status || '') && v.cta === 'Continue with Spotify' && opened.length === browserBefore, JSON.stringify(v));
    await click('#login-screen .sa-cta');
    const t0 = Date.now(); while (opened.length === browserBefore && Date.now() - t0 < 5000) await wait(50);
    check('Continue opens Spotify\'s sign-in with this Client ID', opened.length > browserBefore && opened[opened.length - 1].includes('client_id=' + id), opened[opened.length - 1]);
    const state = new URL(opened[opened.length - 1]).searchParams.get('state');
    await realFetch('http://127.0.0.1:8888/callback?code=fake-code&state=' + state);
    v = await until((x) => x.webamp && x.login === false);
    check('signed in: the player shows', v.webamp && v.login === false, JSON.stringify(v));
    v = await until((x) => !!x.device, 3000);
    check('...and Winify has a playback device of this page', v.device === 'device-' + pageLoads, JSON.stringify([v.device, pageLoads]));
    check('...the sign-in is remembered again', fs.existsSync(tokenFile));
    const sent = transfers.length;
    await click('#webamp #play');
    const t1 = Date.now(); while (transfers.length === sent && Date.now() - t1 < 18000) await wait(100);
    check('Play: playback moves to that device', transfers[sent] === 'device-' + pageLoads, JSON.stringify([transfers.slice(sent), await S()]));
  };

  console.log('1. Launch with a remembered sign-in');
  let v = await until((x) => x.webamp && x.device);
  check('restored, with a playback device', v.webamp && v.device === 'device-' + pageLoads, JSON.stringify(v));
  check('nothing was asked of the browser', opened.length === 0);

  await round('2. Change it to the same Client ID', FIRST, 'a1b2…8f90');
  await round('3. Change it to another Client ID', OTHER, 'a1b2…8f90');
  await round('4. And again to that same one', OTHER, '0f9e…b1a0');

  console.log('5. A token refresh under way when the Client ID is changed');
  // A refresh is due: the next sign-in hands out a token that is close to expiring.
  await js('window.spotify.changeClientId()');
  await until((x) => x.input); await wait(300);
  await js(`document.getElementById('sa-client-id').value = ${JSON.stringify(OTHER)}`);
  await click('#login-screen .sa-cta');
  await until((x) => /READY TO SIGN IN/.test(x.status || ''));
  expiresIn = 10; refreshDelay = 1200;
  await click('#login-screen .sa-cta');
  const before = opened.length; let t0 = Date.now(); while (opened.length === before && Date.now() - t0 < 5000) await wait(50);
  if (!opened.length) check('browser opened', false);
  await realFetch('http://127.0.0.1:8888/callback?code=fake-code&state=' + new URL(opened[opened.length - 1]).searchParams.get('state'));
  await until((x) => x.webamp);
  await wait(300);
  js('window.spotify.getToken()').catch(() => {});
  await wait(200);
  await js('window.spotify.changeClientId()');
  await until((x) => x.input);
  await wait(1800);
  check('its answer does not bring the old sign-in back onto the disk', !fs.existsSync(tokenFile));
  v = await S();
  check('...and the sign-in screen stays', v.input && v.login && !v.webamp, JSON.stringify(v));

  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
});
