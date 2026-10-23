// The whole onboarding in the real app (main.js, preload, sign-in screen), Spotify faked on both sides.
const { app, BrowserWindow, shell, dialog, session } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-onboarding'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = '';
process.env.WINIFY_AUTH_TIMEOUT_MS = '3000';
const SHOTS = path.join(__dirname, '..', '.output', 'onboarding'); fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
const VALID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
let accountsMode = 'normal';
const opened = [], tokenChecks = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = global.fetch;
const J = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (url === 'https://accounts.spotify.com/api/token') {
    const b = new URLSearchParams(o.body);
    if (b.get('code') === 'winify-client-id-check') {
      tokenChecks.push(b.get('client_id'));
      if (accountsMode === 'down') throw new TypeError('fetch failed');
      const known = accountsMode !== 'all-invalid' && b.get('client_id') === VALID;
      return J(400, known ? { error: 'invalid_grant' } : { error: 'invalid_client', error_description: 'Failed to get client' });
    }
    await wait(700);   // "EXCHANGING AUTH TOKEN…"
    return J(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read' });
  }
  if (url.startsWith('https://api.spotify.com/v1/me/player')) { await wait(700); return J(204); }   // "SYNCING LIBRARY…"
  if (url === 'https://api.spotify.com/v1/me') { await wait(700); return J(200, { id: 'tester', product: 'premium' }); }   // "VERIFYING PREMIUM…"
  if (/spotify\.com/.test(url)) return J(404, { error: { message: 'not in this test' } });
  return realFetch(u, o);
};
shell.openExternal = async (u) => { opened.push(u); };
shell.openPath = async () => '';
dialog.showErrorBox = () => {};
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 260) : '')); };
app.whenReady().then(async () => {
  // The page talks to no Spotify server in this test (the player would, once shown).
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.spotify.com/*', 'wss://*.spotify.com/*'] }, (d, cb) => cb({ cancel: true }));
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const S = () => js(`(() => { const q = (s) => document.querySelector(s); const st = q('#login-screen [role=status]'); const cta = q('#login-screen .sa-cta');
    return { login: q('#login-screen').classList.contains('is-active'), status: st ? st.textContent.trim() : null, cta: cta ? cta.textContent.trim() : null,
      input: !!q('#sa-client-id'), live: !!q('#login-screen .sa-live'), remember: !!q('#login-screen .sa-checkwrap'),
      links: [...document.querySelectorAll('#login-screen .sa-link')].map((b) => b.textContent.trim()) }; })()`).catch(() => ({}));
  const until = async (fn, ms = 8000, every = 60) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await S(); if (fn(v)) return v; await wait(every); } return v; };
  // Screenshots are for looking at, not checks: under load the compositor can
  // fail one (UnknownVizError), so retry once, then note it and carry on.
  const shot = async (name) => {
    for (let i = 0; i < 2; i++) {
      try { fs.writeFileSync(path.join(SHOTS, name + '.png'), (await win.webContents.capturePage()).toPNG()); return; }
      catch (e) { if (i) console.log('  (screenshot ' + name + ' not saved: ' + e.message + ')'); else await wait(500); }
    }
  };
  const enter = async (value) => {
    await js(`(() => { const i = document.getElementById('sa-client-id'); i.focus(); i.value = ''; })()`);
    for (const ch of value) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await wait(6); }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  };
  const click = async (sel, text) => { const r = await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => !${JSON.stringify(text || '')} || x.textContent.includes(${JSON.stringify(text || '')})); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    if (!r) return false; win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(150); return true; };

  console.log('First run');
  let v = await until((x) => /WELCOME/.test(x.status || ''));
  check('1 welcome: "Get started"', v.cta === 'Get started' && !v.input, JSON.stringify(v)); await shot('01-welcome');
  await click('#login-screen .sa-cta');
  v = await until((x) => x.input); check('2 Client ID step', v.status === 'PASTE YOUR SPOTIFY CLIENT ID' && v.cta === 'Save Client ID', JSON.stringify(v)); await shot('02-client-id');
  await enter('hello'); v = await until((x) => /NOT A CLIENT ID/.test(x.status || '')); check('3 not a Client ID', !!v.input, v.status); await shot('03-not-a-client-id');
  await enter('ffffffffffffffffffffffffffffffff'); v = await until((x) => /DOES NOT KNOW/.test(x.status || '')); check('4 unknown to Spotify', !!v.input, v.status); await shot('04-unknown-client-id');
  accountsMode = 'down'; await enter(VALID); v = await until((x) => /COULD NOT REACH/.test(x.status || '')); check('5 Spotify unreachable', !!v.input, v.status); await shot('05-spotify-unreachable');
  accountsMode = 'normal'; await enter(VALID);
  v = await until((x) => /SIGNING YOU IN/.test(x.status || ''));
  check('6 saved: "CLIENT ID SAVED · SIGNING YOU IN…", button busy, no "Continue with Spotify" to press', v.status === 'CLIENT ID SAVED · SIGNING YOU IN…' && v.cta === 'Connecting…' && !v.input, JSON.stringify(v)); await shot('06-saved-signing-in');
  v = await until((x) => /HANDSHAKE/.test(x.status || ''), 4000);
  check('7 ...then sign-in starts by itself: browser opened, handshake', /HANDSHAKE/.test(v.status) && opened.length === 1 && opened[0].includes('client_id=' + VALID), JSON.stringify([v.status, opened.length]));
  await shot('07-waiting-for-browser');
  // You approve in the browser: Spotify calls Winify back.
  const state = new URL(opened[0]).searchParams.get('state');
  realFetch('http://127.0.0.1:8888/callback?code=test-code&state=' + state).catch(() => {});
  v = await until((x) => /EXCHANGING/.test(x.status || '')); check('8 exchanging the token', /EXCHANGING AUTH TOKEN/.test(v.status), v.status); await shot('08-exchanging-token');
  v = await until((x) => /VERIFYING/.test(x.status || '')); check('9 verifying Premium', /VERIFYING PREMIUM/.test(v.status), v.status); await shot('09-verifying-premium');
  v = await until((x) => /SYNCING/.test(x.status || '')); check('10 syncing', /SYNCING LIBRARY/.test(v.status), v.status); await shot('10-syncing-library');
  v = await until((x) => x.status === 'CONNECTED', 4000, 20); await wait(250);
  v = await S();
  check('11 connected: "CONNECTED", EQ dancing, red "Disconnect"', v.status === 'CONNECTED' && v.live && v.cta === 'Disconnect', JSON.stringify(v)); await shot('11-connected');
  v = await until((x) => x.login === false, 4000);
  check('...then the player', v.login === false); await wait(1500); await shot('12-player');

  console.log('Second time: relaunch, signed out (Remember me was off)');
  win.webContents.reload(); await wait(600);
  v = await until((x) => x.login && x.status, 8000);
  await wait(500); v = await S();
  check('13 returning user: "Continue with Spotify" and Remember me, no welcome, no Client ID step', v.cta === 'Continue with Spotify' && v.remember && !v.input && !/WELCOME/.test(v.status || '') && v.links.includes('CHANGE CLIENT ID ›'), JSON.stringify(v));
  await shot('13-returning-user');
  const before = opened.length;
  check('...nothing starts by itself', (await wait(1500), opened.length === before));
  await click('#login-screen .sa-cta');
  v = await until((x) => /REDIRECT/.test(x.status || ''), 8000);
  check('14 browser never answers: check the redirect URI', /NO REPLY/.test(v.status), v.status); await shot('14-no-reply-redirect-uri');
  await click('#login-screen .sa-link', 'CHANGE CLIENT ID');
  v = await until((x) => x.input); check('15 changing it later: straight to the Client ID step', v.input && !/WELCOME/.test(v.status || ''), JSON.stringify(v)); await shot('15-change-client-id');
  const before2 = opened.length;
  await enter(VALID); v = await until((x) => /READY TO SIGN IN/.test(x.status || ''));
  await wait(2000);
  check('16 changed (not a first run): saved, "Continue with Spotify", no automatic sign-in', /READY TO SIGN IN/.test(v.status) && v.cta === 'Continue with Spotify' && opened.length === before2, JSON.stringify([v.status, v.cta, opened.length - before2]));
  await shot('16-changed-ready-to-sign-in');
  accountsMode = 'all-invalid'; await click('#login-screen .sa-cta');
  v = await until((x) => x.input && /DOES NOT KNOW/.test(x.status || ''));
  check('17 a stored ID Spotify no longer knows: back to the Client ID step', v.input && /DOES NOT KNOW/.test(v.status), v.status); await shot('17-stored-id-no-longer-known');
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
});
