// Real main.js + real sign-in screen, isolated profile seeded with an old-scope token.
const { app, BrowserWindow } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-rescope'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const OLD = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state';
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: OLD }));
// Any request to Spotify would mean the old token was used; record them.
const net = []; app.on('ready', () => require('electron').session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.spotify.com/*'] }, (d, cb) => { net.push(d.url); cb({}); }));
const origFetch = global.fetch; global.fetch = (u, o) => { net.push(String(u)); return origFetch(u, o); };
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 60000);
app.whenReady().then(async () => {
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 4000));
  const ui = await win.webContents.executeJavaScript(`({
    loginShown: document.getElementById('login-screen').classList.contains('is-active'),
    appShown: document.getElementById('app-screen').classList.contains('is-active'),
    text: document.getElementById('login-screen').innerText.replace(/\\s+/g, ' '),
    remember: document.querySelector('#login-screen input[type=checkbox]').checked,
    webamp: !!(window.WinifyWebamp && WinifyWebamp.isMounted()) })`);
  const fails = [];
  const check = (l, ok, d) => { if (!ok) fails.push(l); console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + d : '')); };
  check('sign-in screen shown, Winamp view not', ui.loginShown && !ui.appShown && !ui.webamp);
  check('status line: NEW PERMISSIONS · SIGN IN AGAIN', /NEW PERMISSIONS · SIGN IN AGAIN/.test(ui.text), ui.text.slice(0, 200));
  check('button says Continue with Spotify (not Try again)', /Continue with Spotify/.test(ui.text) && !/Try again/.test(ui.text));
  check('Remember me stays lit', ui.remember === true);
  check('old token deleted from disk', !fs.existsSync(path.join(profile, 'tokens.json')));
  check('old token never used (no Spotify requests)', !net.some((u) => /accounts\.spotify\.com\/api\/token|api\.spotify\.com/.test(u)), JSON.stringify(net));
  const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, '..', '.output', 'rescope-screen.png'), img.toPNG());
  console.log(fails.length ? 'RESULT: ' + fails.length + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails.length ? 1 : 0);
});
