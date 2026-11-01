// Real Winify (main.js, preload, sign-in screen), fresh profile, no Client ID; Spotify's accounts service faked.
const { app, BrowserWindow, shell, dialog } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-setup-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = '';            // as a fresh install: no .env Client ID (existing vars are not overridden)
process.env.WINIFY_AUTH_TIMEOUT_MS = '3000';
const VALID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
let accountsMode = 'normal';                   // 'normal' | 'down' | 'all-invalid'
const tokenChecks = [], opened = [], openedPaths = [], dialogs = [], spotifyOther = [];
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (url === 'https://accounts.spotify.com/api/token') {
    const body = new URLSearchParams(o.body); tokenChecks.push(body.get('client_id'));
    if (accountsMode === 'down') throw new TypeError('fetch failed');
    const known = accountsMode !== 'all-invalid' && body.get('client_id') === VALID;
    return new Response(JSON.stringify(known ? { error: 'invalid_grant', error_description: 'Invalid authorization code' } : { error: 'invalid_client', error_description: 'Failed to get client' }), { status: 400 });
  }
  if (/spotify\.com/.test(url)) { spotifyOther.push(url); return new Response('{}', { status: 500 }); }
  return realFetch(u, o);
};
shell.openExternal = async (u) => { opened.push(u); };
shell.openPath = async (p) => { openedPaths.push(p); return ''; };
dialog.showErrorBox = (...a) => { dialogs.push(a); };
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 90000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
app.whenReady().then(async () => {
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  // What the sign-in screen shows.
  const S = () => js(`(() => { const q = (s) => document.querySelector(s); const st = q('#login-screen [role=status]');
    const cta = q('#login-screen .sa-cta'); const input = q('#sa-client-id');
    return { status: st ? st.textContent.trim() : null, cta: cta ? cta.textContent.trim() : null, ctaDisabled: cta ? cta.disabled : null,
      input: !!input, focused: document.activeElement === input, placeholder: input ? input.placeholder : null,
      text: q('#login-screen').innerText.replace(/\\s+/g, ' '), links: [...document.querySelectorAll('#login-screen .sa-link')].map((b) => b.textContent.trim()) }; })()`);
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await S(); if (fn(v)) return v; await wait(150); } return v; };
  const enter = async (value) => {
    await js(`(() => { const i = document.getElementById('sa-client-id'); i.focus(); i.value = ''; })()`);
    win.webContents.focus();
    for (const ch of value) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await wait(8); }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  };
  const clickSel = async (sel, text) => { const r = await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => !${JSON.stringify(text || '')} || x.textContent.includes(${JSON.stringify(text || '')})); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    if (!r) return false; win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(200); return true; };

  console.log('1. First run: no Client ID');
  let v = await until((x) => /WELCOME/.test(x.status || ''));
  check('first run: the welcome screen, "WELCOME · FIRST-TIME SETUP", "Get started", no field yet', v.status === 'WELCOME · FIRST-TIME SETUP' && v.cta === 'Get started' && !v.input && !v.links.includes('CHANGE CLIENT ID ›'), JSON.stringify(v).slice(0, 220));
  check('...with the logo, as the usual sign-in screen', await js(`!!document.querySelector('#login-screen img[src="assets/winify-logo.svg"]')`));
  check('no native error box any more', dialogs.length === 0, JSON.stringify(dialogs));
  await clickSel('#login-screen .sa-cta');
  v = await until((x) => x.input && /PASTE/.test(x.status || ''));
  check('Get started: the Client ID step, "PASTE YOUR SPOTIFY CLIENT ID", "Save Client ID"', v.input && v.status === 'PASTE YOUR SPOTIFY CLIENT ID' && v.cta === 'Save Client ID', JSON.stringify(v).slice(0, 220));
  check('...with the setup guide link and the field focused', v.links.includes('SETUP GUIDE ↗') && v.focused, JSON.stringify([v.links, v.focused]));
  check('nothing was asked of Spotify yet', tokenChecks.length === 0, JSON.stringify(tokenChecks));

  console.log('2. Checking what is pasted');
  await enter('hello there');
  v = await until((x) => /NOT A CLIENT ID/.test(x.status || ''));
  check('not 32 letters/digits: "NOT A CLIENT ID · 32 LETTERS AND DIGITS", Spotify not even asked', v.status === 'NOT A CLIENT ID · 32 LETTERS AND DIGITS' && tokenChecks.length === 0, JSON.stringify([v.status, tokenChecks]));
  await enter('ffffffffffffffffffffffffffffffff');
  v = await until((x) => /DOES NOT KNOW/.test(x.status || ''));
  check('unknown to Spotify: "SPOTIFY DOES NOT KNOW THIS CLIENT ID"', v.status === 'SPOTIFY DOES NOT KNOW THIS CLIENT ID' && v.input, v.status);
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'setup-invalid.png'), (await win.webContents.capturePage()).toPNG());
  check('...and nothing stored', !fs.existsSync(path.join(profile, 'config.json')));
  accountsMode = 'down'; await enter(VALID);
  v = await until((x) => /COULD NOT REACH/.test(x.status || ''));
  check('Spotify unreachable: "COULD NOT REACH SPOTIFY · TRY AGAIN", nothing stored', v.status === 'COULD NOT REACH SPOTIFY · TRY AGAIN' && !fs.existsSync(path.join(profile, 'config.json')), v.status);
  accountsMode = 'normal'; await enter(VALID);
  v = await until((x) => /SAVED/.test(x.status || ''));
  const stored = fs.existsSync(path.join(profile, 'config.json')) && JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  const mode = stored ? (fs.statSync(path.join(profile, 'config.json')).mode & 0o777).toString(8) : null;
  check('known to Spotify, first run: saved, "CLIENT ID SAVED · SIGNING YOU IN…" (sign-in follows by itself)', v.status === 'CLIENT ID SAVED · SIGNING YOU IN…' && v.cta === 'Connecting…' && !v.input, JSON.stringify(v).slice(0, 200));
  check('stored locally in Winify\'s settings (config.json, owner-only)', stored && stored.clientId === VALID && mode === '600', JSON.stringify([stored, mode]));

  console.log('3. Signing in with it (started by itself on a first run); the browser never answers');
  v = await until((x) => /HANDSHAKE/.test(x.status || ''));
  await wait(400);
  check('Spotify\'s sign-in opens in the browser with this Client ID and Winify\'s redirect URI', opened.length === 1 && opened[0].includes('client_id=' + VALID) && opened[0].includes('redirect_uri=http%3A%2F%2F127.0.0.1%3A8888%2Fcallback'), opened[0]);
  v = await S();
  check('while waiting: "Try again" on the button, and a Cancel link', v.cta === 'Try again' && v.links.includes('CANCEL'), JSON.stringify(v));
  v = await until((x) => /REDIRECT/.test(x.status || ''), 8000);
  check('no answer: "NO REPLY · CHECK THE REDIRECT URI", with what to add and the guide', v.status === 'NO REPLY · CHECK THE REDIRECT URI' && /http:\/\/127\.0\.0\.1:8888\/callback/.test(v.text) && /Invalid redirect URI/.test(v.text) && v.links.includes('SETUP GUIDE ↗'), JSON.stringify([v.status, v.text.slice(0, 260)]));
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'setup-redirect.png'), (await win.webContents.capturePage()).toPNG());
  await clickSel('#login-screen .sa-link', 'SETUP GUIDE');
  check('the setup guide opens (README)', openedPaths.length === 1 && /README\.md$/.test(openedPaths[0]), JSON.stringify(openedPaths));

  console.log('4. Changing it later');
  await clickSel('#login-screen .sa-link', 'CHANGE CLIENT ID');
  v = await until((x) => x.input);
  check('"CHANGE CLIENT ID ›": back to the setup step, showing the current one masked', v.input && v.placeholder === 'now: a1b2…8f90', JSON.stringify([v.input, v.placeholder]));
  check('...the full Client ID is never shown on screen', !v.text.includes(VALID));
  await enter(VALID); await until((x) => /SAVED/.test(x.status || ''));

  console.log('5. A stored Client ID Spotify no longer knows');
  accountsMode = 'all-invalid'; const before = opened.length;
  await clickSel('#login-screen .sa-cta');
  v = await until((x) => x.input && /DOES NOT KNOW/.test(x.status || ''));
  check('sign-in goes back to the setup step with "SPOTIFY DOES NOT KNOW THIS CLIENT ID", no browser opened', v.input && v.status === 'SPOTIFY DOES NOT KNOW THIS CLIENT ID' && opened.length === before, JSON.stringify([v.status, opened.length - before]));
  check('no Web API request was made at any point', spotifyOther.length === 0, JSON.stringify(spotifyOther));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
});
