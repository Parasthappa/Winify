// The chassis's version label in the packaged app: does it show package.json's
// version?
//
//   npm run package -- --test test/package/version.js
//   SMOKE_OUTPUT=test/.output dist/test.noindex/mac-arm64/Winify.app/Contents/MacOS/Winify
//
// Runs Winify's real main process from the packaged app with an empty settings
// folder (no Client ID, so nothing goes to Spotify), reads the label on the
// welcome screen and quits.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');

require(path.join(__dirname, '..', '..', 'main.js'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'winify-version-')));

const OUTPUT = process.env.SMOKE_OUTPUT || os.tmpdir();
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const finish = (code) => {
  try { fs.mkdirSync(OUTPUT, { recursive: true }); fs.writeFileSync(path.join(OUTPUT, 'version-packaged.log'), lines.join('\n') + '\n'); } catch (e) { /* console has it */ }
  app.exit(code);
};
setTimeout(() => { say('TIMED OUT (no label in 30 s)'); finish(3); }, 30000);

app.whenReady().then(async () => {
  const expected = 'v' + require(path.join(__dirname, '..', '..', 'package.json')).version;
  say('packaged: ' + app.isPackaged + ', ' + process.execPath);
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0] || null; await new Promise((r) => setTimeout(r, 100)); }
  if (!win) { say('no window'); return finish(1); }
  let label = null;
  for (let i = 0; i < 100 && !label; i++) {
    label = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#login-screen div')].filter((d) => !d.children.length).map((d) => d.textContent.trim()).find((t) => /^v\\d/.test(t)) || null`).catch(() => null);
    if (!label) await new Promise((r) => setTimeout(r, 100));
  }
  say('label: ' + label + ', package.json: ' + expected);
  say(label === expected ? 'VERSION LABEL MATCHES' : 'VERSION LABEL DIFFERS');
  finish(label === expected ? 0 : 1);
});
