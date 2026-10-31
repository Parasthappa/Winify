// The packaged app's own port range, and sign-in through the shared callback.
//
//   npm run package -- --test test/package/ports.js
//   SMOKE_OUTPUT=test/.output dist/test/mac-arm64/Winify.app/Contents/MacOS/Winify
//
// Runs Winify's real main process from the packaged app with an empty settings
// folder and a made-up Client ID. Spotify is faked (fetch), the browser is not
// opened (shell.openExternal), so nothing leaves this Mac. Checks the page is
// served on 8909 (the development copy uses 8899), that sign-in sends Spotify
// the redirect http://127.0.0.1:8888/callback, and that the callback server
// there answers (with a wrong state, so no token is asked for).
const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

process.env.SPOTIFY_CLIENT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url === 'https://accounts.spotify.com/api/token') return J(400, { error: 'invalid_grant' });   // the Client ID check: known
  if (/spotify\.com/.test(url)) return J(404, { error: { message: 'not in this test' } });
  return realFetch(u, o);
};
let authUrl = null;
shell.openExternal = async (u) => { authUrl = u; };

require(path.join(__dirname, '..', '..', 'main.js'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'winify-ports-')));

const OUTPUT = process.env.SMOKE_OUTPUT || os.tmpdir();
const lines = [];
let fails = 0;
const say = (s) => { lines.push(s); console.log(s); };
const check = (label, ok, detail) => { if (!ok) fails++; say((ok ? 'PASS ' : 'FAIL ') + label + (detail ? '   ' + detail : '')); };
const finish = () => {
  say(fails ? fails + ' FAILED' : 'ALL PASSED');
  try { fs.mkdirSync(OUTPUT, { recursive: true }); fs.writeFileSync(path.join(OUTPUT, 'ports-packaged.log'), lines.join('\n') + '\n'); } catch (e) { /* console has it */ }
  app.exit(fails ? 1 : 0);
};
setTimeout(() => { say('TIMED OUT (60 s)'); fails++; finish(); }, 60000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  say('packaged: ' + app.isPackaged);
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0] || null; await wait(100); }
  if (!win) { check('a window', false); return finish(); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const page = new URL(win.webContents.getURL());
  check('the page is served on the packaged range (8909)', page.hostname === '127.0.0.1' && page.port === '8909', page.origin);

  await win.webContents.executeJavaScript('window.spotify.login()');
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
